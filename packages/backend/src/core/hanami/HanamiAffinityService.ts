/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 関係値（affinity）: 自分と各ユーザーの直近90日のやりとりをスコア化する。
// 計算は要求時（キャッシュ 10分）。生成ジョブ・永続テーブルは持たず、先月比だけ日次スナップショットを Redis に残す。
// 設計: [[relationship-value-system-design]] / 指示書 hanami-widgets-wave-a-codex-brief-20260914.md §3

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { FollowingsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { CacheService } from '@/core/CacheService.js';
import { RedisKVCache } from '@/misc/cache.js';
import {
	AFFINITY,
	affinityBirthdayWithin,
	affinityDay,
	aggregateAffinity,
	outgoingEventsFromNote,
	selectLapsed,
} from './HanamiAffinityContracts.js';
import type {
	AffinityDirection,
	AffinityEntry,
	AffinityEvent,
	AffinityKind,
	AffinityLapsedEntry,
	AffinityPeer,
	AffinitySnapshot,
	OutgoingNoteRow,
} from './HanamiAffinityContracts.js';
import type { DataSource } from 'typeorm';

type SignalQuery = { kind: AffinityKind; direction: AffinityDirection; sql: string };

// $1 = me, $2 = 下限 id（排他）, $3 = 上限 id（排他）。createdAt 列は無いので id に埋まった時刻で窓を切る。
// 自分発の返信・リノート・メンションは自分のノートを1回走査して TS 側で展開する（3クエリに分けると同じノート集合を3回読む。ダンプ実測で 550ms→約200ms）。
const OUTGOING_NOTES_SQL = 'SELECT n.id, n."replyUserId", n."renoteUserId", n.mentions FROM note n WHERE n."userId" = $1 AND n.id > $2 AND n.id < $3 AND (n."replyUserId" IS NOT NULL OR n."renoteUserId" IS NOT NULL OR n.mentions <> \'{}\')';

const INCOMING_QUERIES: readonly SignalQuery[] = [
	{ kind: 'reply', direction: 'in', sql: 'SELECT n.id, n."userId" FROM note n WHERE n."replyUserId" = $1 AND n.id > $2 AND n.id < $3' },
	// 返信先が自分のノートは返信として数えるのでメンションからは除く
	{ kind: 'mention', direction: 'in', sql: 'SELECT n.id, n."userId" FROM note n WHERE n.mentions @> ARRAY[$1]::varchar[] AND n.id > $2 AND n.id < $3 AND n."replyUserId" IS DISTINCT FROM $1' },
	// 引用もリノートとして数える（返信には寄せない）
	{ kind: 'renote', direction: 'in', sql: 'SELECT n.id, n."userId" FROM note n WHERE n."renoteUserId" = $1 AND n.id > $2 AND n.id < $3' },
	// 被リアクションは著者が非正規化されていないので JOIN。me の反応を索引で先に絞る
	{ kind: 'reaction', direction: 'out', sql: 'SELECT r.id, n."userId" FROM note_reaction r INNER JOIN note n ON n.id = r."noteId" WHERE r."userId" = $1 AND r.id > $2 AND r.id < $3' },
	// 受信は「窓内の自分のノート × 窓内の reaction」に限定（古いノートへの新しい反応は落ちる。簡略化）
	{ kind: 'reaction', direction: 'in', sql: 'SELECT r.id, r."userId" FROM note n INNER JOIN note_reaction r ON r."noteId" = n.id WHERE n."userId" = $1 AND n.id > $2 AND n.id < $3 AND r.id > $2 AND r.id < $3' },
];

type SerializedEntry = Omit<AffinityEntry, 'lastInteractionAt' | 'lastOutAt' | 'lastInAt'> & { lastInteractionAt: string | null; lastOutAt: string | null; lastInAt: string | null };
type SerializedLapsed = Omit<AffinityLapsedEntry, 'latestNoteAt'> & { latestNoteAt: string | null };

@Injectable()
export class HanamiAffinityService {
	private topCache: RedisKVCache<AffinityEntry[]>;
	private lapsedCache: RedisKVCache<AffinityLapsedEntry[]>;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private idService: IdService,
		private cacheService: CacheService,
	) {
		this.topCache = new RedisKVCache<AffinityEntry[]>(this.redisClient, 'hanamiAffinityTop', {
			lifetime: AFFINITY.topTtlMs,
			memoryCacheLifetime: 1000 * 60,
			fetcher: (meId) => this.computeTopUncached(meId),
			toRedisConverter: (value) => JSON.stringify(value),
			fromRedisConverter: (value) => (JSON.parse(value) as SerializedEntry[]).map(entry => ({
				...entry,
				lastInteractionAt: entry.lastInteractionAt == null ? null : new Date(entry.lastInteractionAt),
				lastOutAt: entry.lastOutAt == null ? null : new Date(entry.lastOutAt),
				lastInAt: entry.lastInAt == null ? null : new Date(entry.lastInAt),
			})),
		});
		this.lapsedCache = new RedisKVCache<AffinityLapsedEntry[]>(this.redisClient, 'hanamiAffinityLapsed', {
			lifetime: AFFINITY.lapsedTtlMs,
			memoryCacheLifetime: 1000 * 60,
			fetcher: (meId) => this.computeLapsedUncached(meId),
			toRedisConverter: (value) => JSON.stringify(value),
			fromRedisConverter: (value) => (JSON.parse(value) as SerializedLapsed[]).map(entry => ({
				...entry,
				latestNoteAt: entry.latestNoteAt == null ? null : new Date(entry.latestNoteAt),
			})),
		});
	}

	/** 上位 topLimit 人（キャッシュ 10分）。呼び出し側で表示件数に切る */
	@bindThis
	public async computeTop(meId: MiUser['id']): Promise<AffinityEntry[]> {
		return await this.topCache.fetch(meId);
	}

	@bindThis
	public async computeLapsed(meId: MiUser['id']): Promise<AffinityLapsedEntry[]> {
		return await this.lapsedCache.fetch(meId);
	}

	/** 28〜35日前で最も古い日次スナップショット。無ければ null */
	@bindThis
	public async getComparisonSnapshot(meId: MiUser['id'], now = new Date()): Promise<AffinitySnapshot | null> {
		const { snapshotMaxDays, snapshotMinDays } = AFFINITY as { snapshotMaxDays: number; snapshotMinDays: number };
		for (let back = snapshotMaxDays; back >= snapshotMinDays; back--) {
			const day = affinityDay(new Date(now.getTime() - back * AFFINITY.dayMs));
			const raw = await this.redisClient.get(this.snapshotKey(meId, day));
			if (raw != null) return JSON.parse(raw) as AffinitySnapshot;
		}
		return null;
	}

	@bindThis
	private async computeTopUncached(meId: MiUser['id']): Promise<AffinityEntry[]> {
		const now = new Date();
		const start = now.getTime() - AFFINITY.windowDays * AFFINITY.dayMs;
		const events = await this.loadEvents(meId, start, now.getTime());
		const peers = await this.loadPeers(meId, events);
		const entries = aggregateAffinity(meId, events, peers, now).slice(0, AFFINITY.topLimit);
		await this.saveSnapshot(meId, entries, now);
		return entries;
	}

	@bindThis
	private async computeLapsedUncached(meId: MiUser['id']): Promise<AffinityLapsedEntry[]> {
		const now = new Date();
		const pastEnd = new Date(now.getTime() - AFFINITY.pastEndDays * AFFINITY.dayMs);
		const pastStart = now.getTime() - AFFINITY.pastStartDays * AFFINITY.dayMs;
		const pastEvents = await this.loadEvents(meId, pastStart, pastEnd.getTime());
		const peers = await this.loadPeers(meId, pastEvents);
		const past = aggregateAffinity(meId, pastEvents, peers, pastEnd);

		const recentEvents = await this.loadEvents(meId, now.getTime() - AFFINITY.lapsedQuietDays * AFFINITY.dayMs, now.getTime());
		const recentActive = new Set(recentEvents.map(event => event.userId));
		const lapsed = selectLapsed(past, recentActive, now);
		if (lapsed.length === 0) return [];

		const ids = lapsed.map(entry => entry.userId);
		// 「最近投稿あり」の判定にしか使わないので、直近 recentNoteDays 日の範囲だけ (userId, id DESC) 索引で読む。
		// 全ノートから max(id) を取ると followers-only ばかりのユーザーで全件舐める（ダンプ実測 3万行/460ms）
		const recentLower = this.idService.gen(now.getTime() - AFFINITY.recentNoteDays * AFFINITY.dayMs);
		const latestRows = await this.db.query(
			'SELECT u.id AS "userId", l.id FROM unnest($1::varchar[]) AS u(id) CROSS JOIN LATERAL (SELECT n.id FROM note n WHERE n."userId" = u.id AND n.id > $2 AND n.visibility IN (\'public\', \'home\') ORDER BY n.id DESC LIMIT 1) l',
			[ids, recentLower],
		) as { userId: string; id: string }[];
		const latestNoteAt = new Map(latestRows.map(row => [row.userId, this.idService.parse(row.id).date]));
		const profiles = await this.userProfilesRepository.find({ where: { userId: In(ids) }, select: ['userId', 'birthday'] });
		const birthdays = new Map(profiles.map(profile => [profile.userId, profile.birthday]));

		return lapsed.map(entry => ({
			...entry,
			latestNoteAt: latestNoteAt.get(entry.userId) ?? null,
			birthdayWithin14d: affinityBirthdayWithin(birthdays.get(entry.userId) ?? null, now),
		}));
	}

	@bindThis
	private async loadEvents(meId: string, startMs: number, endMs: number): Promise<AffinityEvent[]> {
		const lower = this.idService.gen(startMs);
		const upper = this.idService.gen(endMs);
		const events: AffinityEvent[] = [];

		const outgoing = await this.db.query(OUTGOING_NOTES_SQL, [meId, lower, upper]) as OutgoingNoteRow[];
		for (const row of outgoing) {
			const createdAt = this.idService.parse(row.id).date;
			for (const event of outgoingEventsFromNote(row, createdAt)) {
				if (event.userId !== meId) events.push(event);
			}
		}

		for (const query of INCOMING_QUERIES) {
			const rows = await this.db.query(query.sql, [meId, lower, upper]) as { id: string; userId: string }[];
			for (const row of rows) {
				if (row.userId === meId) continue;
				events.push({
					id: row.id,
					userId: row.userId,
					kind: query.kind,
					direction: query.direction,
					createdAt: this.idService.parse(row.id).date,
				});
			}
		}
		return events;
	}

	/** イベントに現れた相手のうち表示してよい人（ミュート/ブロック/凍結/削除を除外）と相互フォロー */
	@bindThis
	private async loadPeers(meId: string, events: readonly AffinityEvent[]): Promise<AffinityPeer[]> {
		const ids = [...new Set(events.map(event => event.userId))];
		if (ids.length === 0) return [];

		const [mutings, blocking, blocked] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(meId),
			this.cacheService.userBlockingCache.fetch(meId),
			this.cacheService.userBlockedCache.fetch(meId),
		]);
		const users = await this.usersRepository.find({
			where: { id: In(ids), isSuspended: false, isDeleted: false },
			select: ['id', 'isBot'],
		});
		const visible = users.filter(user => !mutings.has(user.id) && !blocking.has(user.id) && !blocked.has(user.id));
		if (visible.length === 0) return [];

		const visibleIds = visible.map(user => user.id);
		const [outgoing, incoming] = await Promise.all([
			this.followingsRepository.find({ where: { followerId: meId, followeeId: In(visibleIds) }, select: ['followeeId'] }),
			this.followingsRepository.find({ where: { followeeId: meId, followerId: In(visibleIds) }, select: ['followerId'] }),
		]);
		const followees = new Set(outgoing.map(row => row.followeeId));
		const followers = new Set(incoming.map(row => row.followerId));

		return visible.map(user => ({
			userId: user.id,
			isBot: user.isBot,
			mutualFollow: followees.has(user.id) && followers.has(user.id),
		}));
	}

	/** 同日2回目は上書きしない（SET NX） */
	@bindThis
	private async saveSnapshot(meId: string, entries: readonly AffinityEntry[], now: Date): Promise<void> {
		const snapshot: AffinitySnapshot = entries.map((entry, index) => [entry.userId, index + 1]);
		await this.redisClient.set(this.snapshotKey(meId, affinityDay(now)), JSON.stringify(snapshot), 'EX', AFFINITY.snapshotTtlSec, 'NX');
	}

	private snapshotKey(meId: string, day: string): string {
		return `hanami:affinity:snap:${meId}:${day}`;
	}
}
