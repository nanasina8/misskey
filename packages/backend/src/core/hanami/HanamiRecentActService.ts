/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { NotesRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { CacheService } from '@/core/CacheService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { HANAMI_RECENT_ACT_KEY_PREFIX } from '@/core/hanami/HanamiForYouKeys.js';
import type Logger from '@/logger.js';

export type HanamiRecentActKind = 'r' | 'n' | 'p';

export const RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;
export const RECENT_WINDOW_SEC = RECENT_WINDOW_MS / 1000;
export const RECENT_CAP = 500;

export const HANAMI_RECENT_ACT_REMOVE_LUA = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then
	return 0
end
if tonumber(score) <= tonumber(ARGV[2]) then
	if ARGV[3] ~= '' then
		return redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
	end
	return redis.call('ZREM', KEYS[1], ARGV[1])
end
return 0
`;

type RecentActUser = Pick<MiUser, 'id' | 'host'>;
type RecentActTarget = Pick<MiNote, 'id' | 'userId'>;
type MaybeTarget = { id: MiNote['id']; userId: MiUser['id'] | null };

@Injectable()
export class HanamiRecentActService {
	private logger: Logger;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private idService: IdService,
		private cacheService: CacheService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('hanami-recentact');
	}

	@bindThis
	public async recordReaction(user: RecentActUser, targetNote: RecentActTarget, reactionId: string): Promise<void> {
		await this.recordActionSafe(user, targetNote, 'r', reactionId);
	}

	@bindThis
	public async recordNoteAction(user: RecentActUser, actionNote: Pick<MiNote, 'id'>, targetNote: RecentActTarget, kind: 'n' | 'p'): Promise<void> {
		await this.recordActionSafe(user, targetNote, kind, actionNote.id);
	}

	@bindThis
	public async removeReaction(user: RecentActUser, targetNote: RecentActTarget, reactionId: string): Promise<void> {
		try {
			if (!this.shouldRemove(user, targetNote)) return;
			await this.removeAction(user.id, targetNote.id, 'r', this.actionMsFromId(reactionId), null);
		} catch (err) {
			this.logger.warn('hanami recentact: remove reaction failed', { e: err });
		}
	}

	@bindThis
	public async removeNoteAction(user: RecentActUser, deletedNote: Pick<MiNote, 'id'>, targetNote: MaybeTarget, kind: 'n' | 'p'): Promise<void> {
		try {
			if (!this.shouldRemove(user, targetNote)) return;
			const remainingMaxMs = await this.findRemainingMaxMs(user.id, targetNote.id, deletedNote.id, kind);
			await this.removeAction(user.id, targetNote.id, kind, this.actionMsFromId(deletedNote.id), remainingMaxMs);
		} catch (err) {
			this.logger.warn('hanami recentact: remove note action failed', { e: err });
		}
	}

	private async recordActionSafe(user: RecentActUser, targetNote: RecentActTarget, kind: HanamiRecentActKind, actionId: string): Promise<void> {
		try {
			if (!await this.shouldRecord(user, targetNote)) return;
			await this.addAction(user.id, targetNote.id, kind, this.actionMsFromId(actionId));
		} catch (err) {
			this.logger.warn('hanami recentact: record action failed', { e: err });
		}
	}

	private async shouldRecord(user: RecentActUser, targetNote: RecentActTarget): Promise<boolean> {
		if (user.host != null) return false;
		if (targetNote.userId === user.id) return false;
		const profile = await this.cacheService.userProfileCache.fetch(user.id);
		return profile.hanamiRecommendationEnabled === true;
	}

	private shouldRemove(user: RecentActUser, targetNote: MaybeTarget): boolean {
		if (user.host != null) return false;
		if (targetNote.userId === user.id) return false;
		return true;
	}

	private key(userId: MiUser['id']): string {
		return `${HANAMI_RECENT_ACT_KEY_PREFIX}${userId}`;
	}

	private member(noteId: MiNote['id'], kind: HanamiRecentActKind): string {
		return `${noteId}:${kind}`;
	}

	private actionMsFromId(id: string): number {
		return this.idService.parse(id).date.getTime();
	}

	private async addAction(userId: MiUser['id'], targetNoteId: MiNote['id'], kind: HanamiRecentActKind, actionMs: number): Promise<void> {
		const key = this.key(userId);
		const now = Date.now();
		const results = await this.redisClient.multi()
			.zadd(key, 'GT', 'CH', actionMs, this.member(targetNoteId, kind))
			.zremrangebyscore(key, 0, now - RECENT_WINDOW_MS)
			.zremrangebyrank(key, 0, -(RECENT_CAP + 1))
			.expire(key, RECENT_WINDOW_SEC)
			.exec();
		const err = results?.find(r => r[0] != null)?.[0];
		if (results == null || err != null) {
			this.logger.warn(`hanami recentact: zset record failed (${key})`, { e: err });
		}
	}

	private async removeAction(userId: MiUser['id'], targetNoteId: MiNote['id'], kind: HanamiRecentActKind, deletedActionMs: number, remainingMaxMs: number | null): Promise<void> {
		await this.redisClient.eval(
			HANAMI_RECENT_ACT_REMOVE_LUA,
			1,
			this.key(userId),
			this.member(targetNoteId, kind),
			String(deletedActionMs),
			remainingMaxMs == null ? '' : String(remainingMaxMs),
		);
	}

	private async findRemainingMaxMs(userId: MiUser['id'], targetNoteId: MiNote['id'], deletedNoteId: MiNote['id'], kind: 'n' | 'p'): Promise<number | null> {
		const targetColumn = kind === 'n' ? '"renoteId"' : '"replyId"';
		const rows = await this.notesRepository.query(
			`SELECT id FROM note
			 WHERE "userId" = $1 AND ${targetColumn} = $2 AND id <> $3
			 ORDER BY id DESC
			 LIMIT 1`,
			[userId, targetNoteId, deletedNoteId],
		) as { id: string }[];
		const id = rows[0]?.id;
		return id == null ? null : this.actionMsFromId(id);
	}
}
