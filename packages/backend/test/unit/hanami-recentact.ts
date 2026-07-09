/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { QueryFailedError } from 'typeorm';
import { ReactionService } from '@/core/ReactionService.js';
import {
	HANAMI_RECENT_ACT_REMOVE_LUA,
	HanamiRecentActService,
	RECENT_CAP,
	RECENT_WINDOW_MS,
	RECENT_WINDOW_SEC,
} from '@/core/hanami/HanamiRecentActService.js';
import { HANAMI_RECENT_ACT_KEY_PREFIX } from '@/core/hanami/HanamiForYouKeys.js';

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

type RedisOp = { kind: string; args: unknown[] };

class FakeRedisMulti {
	public ops: RedisOp[] = [];

	constructor(private readonly redis: FakeRedis) {
	}

	public zadd(key: string, ...args: unknown[]): this {
		this.ops.push({ kind: 'zadd', args: [key, ...args] });
		return this;
	}

	public zremrangebyscore(key: string, min: number, max: number): this {
		this.ops.push({ kind: 'zremrangebyscore', args: [key, min, max] });
		return this;
	}

	public zremrangebyrank(key: string, start: number, stop: number): this {
		this.ops.push({ kind: 'zremrangebyrank', args: [key, start, stop] });
		return this;
	}

	public expire(key: string, ttl: number): this {
		this.ops.push({ kind: 'expire', args: [key, ttl] });
		return this;
	}

	public async exec(): Promise<[Error | null, unknown][]> {
		this.redis.multiExecs.push(this.ops);
		for (const op of this.ops) this.redis.applyOp(op);
		return this.ops.map(() => [null, 1]);
	}
}

class FakeRedis {
	public multiExecs: RedisOp[][] = [];
	public evalCalls: unknown[][] = [];
	private readonly zsets = new Map<string, Map<string, number>>();

	public multi(): FakeRedisMulti {
		return new FakeRedisMulti(this);
	}

	public async eval(...args: unknown[]): Promise<number> {
		this.evalCalls.push(args);
		const key = args[2] as string;
		const member = args[3] as string;
		const deletedActionMs = Number(args[4]);
		const remainingMaxMs = args[5] as string;
		const current = this.zscore(key, member);
		if (current == null) return 0;
		if (current <= deletedActionMs) {
			if (remainingMaxMs !== '') {
				this.setZScore(key, member, Number(remainingMaxMs));
				return 0;
			}
			this.zsets.get(key)?.delete(member);
			return 1;
		}
		return 0;
	}

	public applyOp(op: RedisOp): void {
		if (op.kind === 'zadd') {
			const [key, ...args] = op.args as [string, ...unknown[]];
			const score = args[2] as number;
			const member = args[3] as string;
			const current = this.zscore(key, member);
			if (current == null || score > current) this.setZScore(key, member, score);
		} else if (op.kind === 'zremrangebyscore') {
			const [key, min, max] = op.args as [string, number, number];
			const zset = this.zsets.get(key);
			if (zset == null) return;
			for (const [member, score] of zset) {
				if (score >= min && score <= max) zset.delete(member);
			}
		} else if (op.kind === 'zremrangebyrank') {
			const [key, start, stop] = op.args as [string, number, number];
			const zset = this.zsets.get(key);
			if (zset == null) return;
			const entries = [...zset.entries()].sort((a, b) => a[1] - b[1]);
			const end = stop < 0 ? entries.length + stop : stop;
			for (let i = start; i <= end; i++) {
				const member = entries[i]?.[0];
				if (member != null) zset.delete(member);
			}
		}
	}

	public setZScore(key: string, member: string, score: number): void {
		const zset = this.zsets.get(key) ?? new Map<string, number>();
		zset.set(member, score);
		this.zsets.set(key, zset);
	}

	public zscore(key: string, member: string): number | undefined {
		return this.zsets.get(key)?.get(member);
	}
}

function idAt(ms: number, suffix = 'id'): string {
	return `${String(ms).padStart(13, '0')}-${suffix}`;
}

function idService() {
	return {
		gen: jest.fn(() => idAt(NOW, 'reaction')),
		parse: (id: string) => ({ date: new Date(Number(id.slice(0, 13))) }),
	};
}

function notesRepository(results: unknown[][] = []) {
	return {
		query: jest.fn(async () => results.shift() ?? []),
	};
}

function cacheService(enabledByUser: Record<string, boolean>) {
	return {
		userProfileCache: {
			fetch: jest.fn(async (userId: string) => ({
				hanamiRecommendationEnabled: enabledByUser[userId] ?? false,
			})),
		},
	};
}

function loggerService() {
	return {
		getLogger: jest.fn(() => ({
			warn: jest.fn(),
			error: jest.fn(),
		})),
	};
}

function recentActService(redis: FakeRedis, enabledByUser: Record<string, boolean>, rows: unknown[][] = []): HanamiRecentActService {
	return new HanamiRecentActService(
		redis as never,
		notesRepository(rows) as never,
		idService() as never,
		cacheService(enabledByUser) as never,
		loggerService() as never,
	);
}

function queryBuilder() {
	const qb = {
		update: jest.fn(() => qb),
		set: jest.fn(() => qb),
		where: jest.fn(() => qb),
		execute: jest.fn(async () => ({ affected: 1 })),
	};
	return qb;
}

function duplicateKeyError(): QueryFailedError {
	return new QueryFailedError('INSERT', [], { code: '23505' } as never);
}

afterEach(() => {
	jest.restoreAllMocks();
});

describe('HanamiRecentActService', () => {
	test('記録条件: リモートユーザー / For You OFF / 自分ノートは記録しない', async () => {
		const redis = new FakeRedis();
		const service = recentActService(redis, { localOn: true, localOff: false, self: true });
		const target = { id: 'target-note', userId: 'author' };

		await service.recordReaction({ id: 'remote', host: 'remote.example' }, target, idAt(NOW));
		await service.recordReaction({ id: 'localOff', host: null }, target, idAt(NOW));
		await service.recordReaction({ id: 'self', host: null }, { id: 'self-note', userId: 'self' }, idAt(NOW));

		expect(redis.multiExecs).toHaveLength(0);
	});

	test('ZADD GT CH で記録し、72h範囲削除・500件上限・expireを同じmultiで実行する', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const redis = new FakeRedis();
		const service = recentActService(redis, { u: true });

		await service.recordReaction({ id: 'u', host: null }, { id: 'target-note', userId: 'author' }, idAt(NOW - 10, 'reaction'));

		const key = `${HANAMI_RECENT_ACT_KEY_PREFIX}u`;
		expect(redis.multiExecs).toHaveLength(1);
		expect(redis.multiExecs[0]).toEqual([
			{ kind: 'zadd', args: [key, 'GT', 'CH', NOW - 10, 'target-note:r'] },
			{ kind: 'zremrangebyscore', args: [key, 0, NOW - RECENT_WINDOW_MS] },
			{ kind: 'zremrangebyrank', args: [key, 0, -(RECENT_CAP + 1)] },
			{ kind: 'expire', args: [key, RECENT_WINDOW_SEC] },
		]);
	});

	test('リアクション差し替えパスでは recentact の削除を呼ばず、insert 側だけ記録する', async () => {
		const duplicate = duplicateKeyError();
		const reactionId = idAt(NOW, 'reaction');
		const note = {
			id: idAt(NOW - 1000, 'target'),
			userId: 'author',
			userHost: 'remote.example',
			renoteId: null,
			reactionAcceptance: null,
			reactionAndUserPairCache: [],
			channelId: null,
			replyId: null,
			visibility: 'public',
			localOnly: true,
		};
		const user = { id: 'u', host: null, isBot: false };
		const noteReactionsRepository = {
			insert: jest.fn<() => Promise<void>>()
				.mockRejectedValueOnce(duplicate)
				.mockResolvedValueOnce(undefined),
			findOneByOrFail: jest.fn(async () => ({ id: idAt(NOW - 100, 'old-reaction'), reaction: '⭐' })),
			findOneBy: jest.fn(async () => ({ id: idAt(NOW - 100, 'old-reaction'), reaction: '⭐' })),
			delete: jest.fn(async () => ({ affected: 1 })),
		};
		const recentAct = {
			recordReaction: jest.fn(),
			removeReaction: jest.fn(),
		};
		const service = new ReactionService(
			{ enableReactionsBuffering: false, enableChartsForRemoteUser: false } as never,
			{} as never,
			{ createQueryBuilder: jest.fn(() => queryBuilder()), query: jest.fn(async () => []) } as never,
			noteReactionsRepository as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ isLocalUser: jest.fn(() => true) } as never,
			{ isVisibleForMe: jest.fn(async () => true) } as never,
			{ checkBlocked: jest.fn(async () => false) } as never,
			{} as never,
			{ gen: jest.fn(() => reactionId), parse: idService().parse } as never,
			{ updateGlobalNotesRanking: jest.fn(), updatePerUserNotesRanking: jest.fn(), updateInChannelNotesRanking: jest.fn() } as never,
			{ publishNoteStream: jest.fn() } as never,
			{} as never,
			{} as never,
			{} as never,
			{ update: jest.fn() } as never,
			{ recordEngagement: jest.fn() } as never,
			recentAct as never,
		);

		await service.create(user, note as never, '👍');

		expect(recentAct.removeReaction).not.toHaveBeenCalled();
		expect(recentAct.recordReaction).toHaveBeenCalledWith(user, note, reactionId);
	});

	test('Lua削除: zscore<=deleted かつ残存ありなら残存最新時刻へZADDする', async () => {
		const redis = new FakeRedis();
		const deletedMs = NOW;
		const remainingMs = NOW - 1000;
		const key = `${HANAMI_RECENT_ACT_KEY_PREFIX}u`;
		redis.setZScore(key, 'target-note:n', deletedMs);
		const rows = [[{ id: idAt(remainingMs, 'remaining') }]];
		const service = new HanamiRecentActService(
			redis as never,
			notesRepository(rows) as never,
			idService() as never,
			cacheService({}) as never,
			loggerService() as never,
		);

		await service.removeNoteAction({ id: 'u', host: null }, { id: idAt(deletedMs, 'deleted') }, { id: 'target-note', userId: 'author' }, 'n');

		expect(redis.evalCalls[0]).toEqual([
			HANAMI_RECENT_ACT_REMOVE_LUA,
			1,
			key,
			'target-note:n',
			String(deletedMs),
			String(remainingMs),
		]);
		expect(redis.zscore(key, 'target-note:n')).toBe(remainingMs);
	});

	test('Lua削除: zscore<=deleted かつ残存なしならZREMする', async () => {
		const redis = new FakeRedis();
		const deletedMs = NOW;
		const key = `${HANAMI_RECENT_ACT_KEY_PREFIX}u`;
		redis.setZScore(key, 'target-note:r', deletedMs);
		const service = recentActService(redis, {});

		await service.removeReaction({ id: 'u', host: null }, { id: 'target-note', userId: 'author' }, idAt(deletedMs, 'reaction'));

		expect(redis.evalCalls[0]).toEqual([
			HANAMI_RECENT_ACT_REMOVE_LUA,
			1,
			key,
			'target-note:r',
			String(deletedMs),
			'',
		]);
		expect(redis.zscore(key, 'target-note:r')).toBeUndefined();
	});

	test('Lua削除: zscore>deleted なら新しい記録を残してno-opにする', async () => {
		const redis = new FakeRedis();
		const deletedMs = NOW;
		const newerMs = NOW + 1000;
		const key = `${HANAMI_RECENT_ACT_KEY_PREFIX}u`;
		redis.setZScore(key, 'target-note:r', newerMs);
		const service = recentActService(redis, {});

		await service.removeReaction({ id: 'u', host: null }, { id: 'target-note', userId: 'author' }, idAt(deletedMs, 'reaction'));

		expect(redis.evalCalls[0]).toEqual([
			HANAMI_RECENT_ACT_REMOVE_LUA,
			1,
			key,
			'target-note:r',
			String(deletedMs),
			'',
		]);
		expect(redis.zscore(key, 'target-note:r')).toBe(newerMs);
		expect(HANAMI_RECENT_ACT_REMOVE_LUA).toContain('tonumber(score) <= tonumber(ARGV[2])');
	});
});
