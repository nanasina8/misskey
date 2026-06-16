/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { NotesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { DI } from '@/di-symbols.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { CacheService } from '@/core/CacheService.js';
import { removeMutedUsersReactions } from '@/misc/reactions-mute.js';
import { QueryService } from '@/core/QueryService.js';

// スコア順ページングを安定させるスナップショットの保持時間。ここ一箇所で調整。
const FEATURED_RANKING_SNAPSHOT_TTL_SECONDS = 60 * 5;
// 1ページ充足のために走査する候補IDの上限（ランキングは最大500件なので十分カバーできる）。
const FEATURED_FETCH_SCAN_LIMIT = 300;

export const meta = {
	tags: ['notes'],

	requireCredential: false,
	allowGet: true,
	cacheSec: 180,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		untilId: { type: 'string', format: 'misskey:id' },
		channelId: { type: 'string', nullable: true, format: 'misskey:id' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	private globalNotesRankingCache: string[] = [];
	private globalNotesRankingCacheLastFetchedAt = 0;

	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private cacheService: CacheService,
		private noteEntityService: NoteEntityService,
		private featuredService: FeaturedService,
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// ランキング取得（軸の選択）。スコア順をそのまま表示順にする。
			const computeRanked = async (): Promise<string[]> => {
				if (ps.channelId) {
					return this.featuredService.getInChannelNotesRanking(ps.channelId, 50);
				}
				// みつけるは完全グローバル: ログイン有無に関わらず全員同じ母集団・順位（差分はNSFW/ミュートのみ）。
				if (this.globalNotesRankingCacheLastFetchedAt !== 0 && (Date.now() - this.globalNotesRankingCacheLastFetchedAt < 1000 * 60 * 3)) {
					return this.globalNotesRankingCache;
				}
				const ids = await this.featuredService.getGlobalNotesRanking(500);
				this.globalNotesRankingCache = ids;
				this.globalNotesRankingCacheLastFetchedAt = Date.now();
				return ids;
			};

			// スナップショットカーソル: 先頭ページ（untilId なし）でランキングを固定し、
			// 続きページはその固定列から続きを返す。スコア順表示を保ちつつ、60秒ランキングキャッシュの
			// 変動による重複/飛び/途中終了を防ぐ。
			const snapshotKey = me ? `featuredNotesRankingSnapshot:${ps.channelId ?? 'global'}` : null;

			let ranked: string[];
			if (!ps.untilId) {
				ranked = await computeRanked();
				if (snapshotKey && ranked.length > 0) {
					await this.redisClient.set(snapshotKey, JSON.stringify(ranked), 'EX', FEATURED_RANKING_SNAPSHOT_TTL_SECONDS);
				}
			} else {
				// スナップショットがあればそれを使う。期限切れ時のみ最新ランキングにフォールバック。
				const snapshot = snapshotKey ? await this.redisClient.get(snapshotKey) : null;
				ranked = snapshot != null ? JSON.parse(snapshot) as string[] : await computeRanked();
			}

			// カーソル位置以降の候補（スナップショットなので indexOf は安定）。
			let candidateIds: string[];
			if (ps.untilId) {
				const index = ranked.indexOf(ps.untilId);
				candidateIds = index >= 0 ? ranked.slice(index + 1) : [];
			} else {
				candidateIds = ranked;
			}
			// home がランキングに混ざるため、slice 前に可視性で絞らないと public が少ないページが空になる。
			// 走査範囲を上限つきで取り、public のみ（リモート含む）を取得してから limit 件に詰める。
			candidateIds = candidateIds.slice(0, FEATURED_FETCH_SCAN_LIMIT);

			if (candidateIds.length === 0) {
				return [];
			}

			const [
				userIdsWhoMeMuting,
				userIdsWhoBlockingMe,
			] = me ? await Promise.all([
				this.cacheService.userMutingsCache.fetch(me.id),
				this.cacheService.userBlockedCache.fetch(me.id),
			]) : [new Set<string>(), new Set<string>()];

			const myProfile = me ? await this.cacheService.userProfileCache.fetch(me.id) : null;
			const userMutedInstances = myProfile ? new Set(myProfile.mutedInstances) : new Set<string>();
			const mediaFilter = myProfile ? myProfile.exploreMediaFilter : 'all';

			const query = this.notesRepository.createQueryBuilder('note')
				.where('note.id IN (:...noteIds)', { noteIds: candidateIds })
				.andWhere('note.visibility = \'public\'') // public のみ（リモート含む）。home はランキングに混ざるが explore には流さない（はなみTL専用）
				.innerJoinAndSelect('note.user', 'user')
				.leftJoinAndSelect('note.reply', 'reply')
				.leftJoinAndSelect('note.renote', 'renote')
				.leftJoinAndSelect('reply.user', 'replyUser')
				.leftJoinAndSelect('renote.user', 'renoteUser')
				.leftJoinAndSelect('note.channel', 'channel');

			this.queryService.generateBlockedHostQueryForNote(query);
			this.queryService.generateSuspendedUserQueryForNote(query);

			// みつけるのメディアフィルタ（ユーザー設定）。候補は最大300件に限定済みなので drive_file 参照でも安い。
			if (mediaFilter === 'hideMedia') {
				query.andWhere('NOT EXISTS (SELECT 1 FROM "drive_file" df WHERE df.id = ANY(note."fileIds") AND (df."type" LIKE \'image/%\' OR df."type" LIKE \'video/%\'))');
			} else if (mediaFilter === 'hideSensitive') {
				query
					.andWhere('NOT EXISTS (SELECT 1 FROM "drive_file" df WHERE df.id = ANY(note."fileIds") AND df."isSensitive" = true)')
					.andWhere('(channel."isSensitive" IS NULL OR channel."isSensitive" = false)');
			}

			const fetchedNotes = (await query.getMany()).filter(note => {
				if (me && isUserRelated(note, userIdsWhoBlockingMe)) return false;
				if (me && isUserRelated(note, userIdsWhoMeMuting)) return false;
				if (me && isInstanceMuted(note, userMutedInstances)) return false;

				return true;
			});

			// スコア順（ranked の順）を維持しつつ limit 件に詰める。
			const noteMap = new Map(fetchedNotes.map(n => [n.id, n]));
			const notes = candidateIds.flatMap(id => {
				const n = noteMap.get(id);
				return n ? [n] : [];
			}).slice(0, ps.limit);

			const packedNotes = await this.noteEntityService.packMany(notes, me, { withReactionAndUserPairCache: true });
			await Promise.all(
				packedNotes.map(note => removeMutedUsersReactions(note, userIdsWhoMeMuting)),
			);
			return packedNotes;
		});
	}
}
