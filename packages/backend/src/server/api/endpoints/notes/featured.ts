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
import { CacheService } from '@/core/CacheService.js';
import { removeMutedUsersReactions } from '@/misc/reactions-mute.js';
import { QueryService } from '@/core/QueryService.js';

// スコア順ページングを安定させるスナップショットの保持時間。ここ一箇所で調整。
const FEATURED_RANKING_SNAPSHOT_TTL_SECONDS = 60 * 5;

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	allowGet: false,
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
				if (me) {
					// ログイン済み: パーソナライズランキング
					return this.featuredService.getPersonalizedNotesRanking(me.id, 100);
				}
				// 未ログイン（requireCredential のため通常到達しない）: グローバルランキング（3分キャッシュ）
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
			const snapshotKey = me ? `featuredNotesRankingSnapshot:${me.id}:${ps.channelId ?? 'global'}` : null;

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

			let noteIds: string[];
			if (ps.untilId) {
				// 固定済みスコア順配列内での位置をカーソルにする（スナップショットなので indexOf は安定）
				const index = ranked.indexOf(ps.untilId);
				noteIds = index >= 0 ? ranked.slice(index + 1) : [];
			} else {
				noteIds = ranked;
			}
			noteIds = noteIds.slice(0, ps.limit);

			if (noteIds.length === 0) {
				return [];
			}

			const [
				userIdsWhoMeMuting,
				userIdsWhoBlockingMe,
			] = me ? await Promise.all([
				this.cacheService.userMutingsCache.fetch(me.id),
				this.cacheService.userBlockedCache.fetch(me.id),
			]) : [new Set<string>(), new Set<string>()];

			const query = this.notesRepository.createQueryBuilder('note')
				.where('note.id IN (:...noteIds)', { noteIds: noteIds })
				.andWhere('note.userHost IS NULL')
				.andWhere('note.visibility = \'public\'') // home はランキングに混ざるが featured/explore には流さない（はなみTL専用）
				.innerJoinAndSelect('note.user', 'user')
				.leftJoinAndSelect('note.reply', 'reply')
				.leftJoinAndSelect('note.renote', 'renote')
				.leftJoinAndSelect('reply.user', 'replyUser')
				.leftJoinAndSelect('renote.user', 'renoteUser')
				.leftJoinAndSelect('note.channel', 'channel');

			this.queryService.generateBlockedHostQueryForNote(query);
			this.queryService.generateSuspendedUserQueryForNote(query);

			const fetchedNotes = (await query.getMany()).filter(note => {
				if (me && isUserRelated(note, userIdsWhoBlockingMe)) return false;
				if (me && isUserRelated(note, userIdsWhoMeMuting)) return false;

				return true;
			});

			// スコア順（ranked の順）を維持して返す
			const noteMap = new Map(fetchedNotes.map(n => [n.id, n]));
			const notes = noteIds.flatMap(id => {
				const n = noteMap.get(id);
				return n ? [n] : [];
			});

			const packedNotes = await this.noteEntityService.packMany(notes, me, { withReactionAndUserPairCache: true });
			await Promise.all(
				packedNotes.map(note => removeMutedUsersReactions(note, userIdsWhoMeMuting)),
			);
			return packedNotes;
		});
	}
}
