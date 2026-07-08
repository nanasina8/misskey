/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { HanamiTasteClusterBatchService } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { HanamiForYouService } from '@/core/hanami/HanamiForYouService.js';
import { HANAMI_FORYOU_ACTIVE_KEY_PREFIX, HANAMI_TASTE_MATCH_KEY_PREFIX } from '@/core/hanami/HanamiForYouKeys.js';
import type { ForYouCandidate } from '@/core/hanami/HanamiForYouInterleave.js';

const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

type RedisOp = { kind: string; args: unknown[] };

class FakeRedisPipeline {
	public ops: RedisOp[] = [];

	constructor(private readonly redis: FakeRedis) {
	}

	public exists(key: string): this {
		this.ops.push({ kind: 'exists', args: [key] });
		return this;
	}

	public zadd(key: string, ...args: unknown[]): this {
		this.ops.push({ kind: 'zadd', args: [key, ...args] });
		return this;
	}

	public expire(key: string, ttl: number): this {
		this.ops.push({ kind: 'expire', args: [key, ttl] });
		return this;
	}

	public rename(from: string, to: string): this {
		this.ops.push({ kind: 'rename', args: [from, to] });
		return this;
	}

	public del(key: string): this {
		this.ops.push({ kind: 'del', args: [key] });
		return this;
	}

	public async exec(): Promise<[Error | null, unknown][]> {
		this.redis.pipelineExecs.push(this.ops);
		return this.ops.map(op => {
			if (op.kind === 'exists') {
				const key = op.args[0] as string;
				return [null, this.redis.activeKeys.has(key) ? 1 : 0];
			}
			return [null, 'OK'];
		});
	}
}

class FakeRedis {
	public activeKeys = new Set<string>();
	public lockOk = true;
	public setCalls: unknown[][] = [];
	public evalCalls: unknown[][] = [];
	public pipelineExecs: RedisOp[][] = [];
	public hsetCalls: unknown[][] = [];
	public expireCalls: unknown[][] = [];
	public hashes = new Map<string, Record<string, string>>();

	public pipeline(): FakeRedisPipeline {
		return new FakeRedisPipeline(this);
	}

	public async set(...args: unknown[]): Promise<'OK' | null> {
		this.setCalls.push(args);
		return this.lockOk ? 'OK' : null;
	}

	public async eval(...args: unknown[]): Promise<number> {
		this.evalCalls.push(args);
		return 1;
	}

	public async hset(key: string, fields: Record<string, string>): Promise<number> {
		this.hsetCalls.push([key, fields]);
		this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...fields });
		return Object.keys(fields).length;
	}

	public async hgetall(key: string): Promise<Record<string, string>> {
		return this.hashes.get(key) ?? {};
	}

	public async expire(...args: unknown[]): Promise<number> {
		this.expireCalls.push(args);
		return 1;
	}
}

function noteId(ageMs: number, suffix: string): string {
	return `${String(NOW - ageMs).padStart(13, '0')}-${suffix}`;
}

function unitVec(x: number): number[] {
	return [x, Math.sqrt(1 - x * x)];
}

function idService() {
	return {
		gen: (t: number) => `${String(t).padStart(13, '0')}-floor`,
		parse: (id: string) => ({ date: new Date(Number(id.slice(0, 13))) }),
	};
}

function logger() {
	return {
		info: jest.fn(),
		warn: jest.fn(),
	};
}

function dbWithResults(results: unknown[][]) {
	return {
		query: jest.fn(async () => {
			const next = results.shift();
			if (next == null) throw new Error('unexpected db.query');
			return next;
		}),
	};
}

function tasteBatchService(db: { query: ReturnType<typeof jest.fn> }, redis: FakeRedis): HanamiTasteClusterBatchService {
	return new HanamiTasteClusterBatchService(
		db as never,
		redis as never,
		idService() as never,
		{ clean: (text: string) => text } as never,
	);
}

function writePipelines(redis: FakeRedis): RedisOp[][] {
	return redis.pipelineExecs.filter(ops => ops.some(op => op.kind === 'zadd' || op.kind === 'del'));
}

function zaddScores(ops: RedisOp[]): Map<string, number> {
	const zadd = ops.find(op => op.kind === 'zadd');
	if (zadd == null) return new Map();
	const out = new Map<string, number>();
	for (let i = 1; i + 1 < zadd.args.length; i += 2) {
		out.set(zadd.args[i + 1] as string, zadd.args[i] as number);
	}
	return out;
}

function forYouService(db: { query: ReturnType<typeof jest.fn> }, redis: { zrevrange: ReturnType<typeof jest.fn> }): HanamiForYouService {
	return new HanamiForYouService(
		db as never,
		{} as never,
		redis as never,
		{} as never,
		{} as never,
		{} as never,
		idService() as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
	);
}

afterEach(() => {
	delete process.env.HANAMI_TASTE_REBUILD_CHUNK;
	jest.restoreAllMocks();
});

describe('HanamiTasteClusterBatchService reactionSimilar match', () => {
	test('runTasteTick で閾値・作者cap・鮮度・active・Redis置換順を守る', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const redis = new FakeRedis();
		redis.activeKeys.add(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + 'u-active');
		redis.activeKeys.add(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + 'u-empty');

		const cap1 = noteId(1 * HOUR, 'cap1');
		const cap2 = noteId(8 * HOUR, 'cap2');
		const cap3 = noteId(2 * HOUR, 'cap3');
		const cap4 = noteId(3 * HOUR, 'cap4');
		const oldWeight = noteId(13 * HOUR, 'old-weight');
		const lowCos = noteId(1 * HOUR, 'low-cos');
		const own = noteId(1 * HOUR, 'own');
		const db = dbWithResults([
			[],
			[
				{ uid: 'u-active', cid: 7, centroid: [1, 0] },
				{ uid: 'u-empty', cid: 8, centroid: [-1, 0] },
				{ uid: 'u-inactive', cid: 9, centroid: [1, 0] },
			],
			[{ meanVec: [0, 0] }],
			[
				{ nid: cap1, aid: 'author-cap', emb: unitVec(0.8) },
				{ nid: cap2, aid: 'author-cap', emb: unitVec(0.8) },
				{ nid: cap3, aid: 'author-cap', emb: unitVec(0.7) },
				{ nid: cap4, aid: 'author-cap', emb: unitVec(0.65) },
				{ nid: oldWeight, aid: 'author-old', emb: unitVec(0.8) },
				{ nid: lowCos, aid: 'author-low', emb: unitVec(0.4) },
				{ nid: own, aid: 'u-active', emb: unitVec(0.9) },
			],
		]);
		const log = logger();

		await tasteBatchService(db, redis).runTasteTick(log as never);

		expect(log.warn).not.toHaveBeenCalled();
		expect(db.query).toHaveBeenCalledTimes(4);
		expect(redis.setCalls[0]).toEqual(['hanami:taste:tick:lock', expect.any(String), 'EX', 35 * 60, 'NX']);
		expect(redis.evalCalls).toHaveLength(1);

		const writes = writePipelines(redis);
		const matchWrite = writes.find(ops => ops.some(op => op.kind === 'zadd'));
		expect(matchWrite).toBeDefined();
		expect(matchWrite!.map(op => op.kind)).toEqual(['zadd', 'expire', 'rename', 'expire']);
		const key = HANAMI_TASTE_MATCH_KEY_PREFIX + 'u-active';
		const tmp = matchWrite![0].args[0] as string;
		expect(matchWrite![1].args).toEqual([tmp, 600]);
		expect(matchWrite![2].args).toEqual([tmp, key]);
		expect(matchWrite![3].args).toEqual([key, 48 * 60 * 60]);

		const scores = zaddScores(matchWrite!);
		expect(scores.get(`${cap1}:author-cap:7`)).toBeCloseTo(0.8);
		expect(scores.get(`${cap2}:author-cap:7`)).toBeCloseTo(0.72);
		expect(scores.get(`${cap3}:author-cap:7`)).toBeCloseTo(0.7);
		expect(scores.get(`${oldWeight}:author-old:7`)).toBeCloseTo(0.6);
		expect([...scores.keys()]).not.toContain(`${cap4}:author-cap:7`);
		expect([...scores.keys()]).not.toContain(`${lowCos}:author-low:7`);
		expect([...scores.keys()]).not.toContain(`${own}:u-active:7`);

		const delWrite = writes.find(ops => ops.some(op => op.kind === 'del'));
		expect(delWrite?.[0]).toEqual({ kind: 'del', args: [HANAMI_TASTE_MATCH_KEY_PREFIX + 'u-empty'] });
		expect(writes.some(ops => ops.some(op => op.args.includes(HANAMI_TASTE_MATCH_KEY_PREFIX + 'u-inactive')))).toBe(false);
	});

	test('NXロック取得に失敗したら sweep も match も走らない', async () => {
		const redis = new FakeRedis();
		redis.lockOk = false;
		const db = dbWithResults([]);
		const log = logger();

		await tasteBatchService(db, redis).runTasteTick(log as never);

		expect(log.warn).toHaveBeenCalledWith('hanami taste tick: previous run still in progress, skip');
		expect(db.query).not.toHaveBeenCalled();
		expect(redis.pipelineExecs).toHaveLength(0);
		expect(redis.evalCalls).toHaveLength(0);
	});
});

describe('HanamiForYouService reactionSimilarCandidates', () => {
	test('zset memberをパースし、作者・窓・クラスタweightで除外して clusterId 付き候補を作る', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const valid = noteId(1 * HOUR, 'valid');
		const own = noteId(1 * HOUR, 'own');
		const followee = noteId(1 * HOUR, 'followee');
		const old = noteId(25 * HOUR, 'old');
		const mutedCluster = noteId(1 * HOUR, 'muted-cluster');
		const missingCluster = noteId(1 * HOUR, 'missing-cluster');
		const redis = {
			zrevrange: jest.fn(async () => [
				`${valid}:author-new:7`, '0.42',
				`${own}:me:7`, '0.99',
				`${followee}:followee-a:7`, '0.98',
				`${old}:author-old:7`, '0.97',
				`${mutedCluster}:author-muted:8`, '0.96',
				`${missingCluster}:author-missing:9`, '0.95',
			]),
		};
		const db = dbWithResults([
			[
				{ clusterId: 7, size: 10, userWeight: 1 },
				{ clusterId: 8, size: 10, userWeight: 0 },
			],
		]);
		const service = forYouService(db, redis);
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);
		const draw = jest.fn((
			buckets: Map<number | 'general', { fresh: { cand: ForYouCandidate; clusterId?: number }[]; shown: { cand: ForYouCandidate; clusterId?: number }[] }>,
		): ForYouCandidate[] => [...buckets.values()].flatMap(b => [...b.fresh, ...b.shown].map(it => ({ ...it.cand, clusterId: it.clusterId }))));
		(service as unknown as { drawClusterLottery: typeof draw }).drawClusterLottery = draw;

		const out = await (service as unknown as {
			reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).reactionSimilarCandidates('me', ['followee-a'], new Set(), new Set());

		expect(redis.zrevrange).toHaveBeenCalledWith(HANAMI_TASTE_MATCH_KEY_PREFIX + 'me', 0, 299, 'WITHSCORES');
		expect(out).toEqual([{ noteId: valid, userId: 'author-new', score: 0.42, clusterId: 7 }]);
		expect(draw).toHaveBeenCalledTimes(1);
		const buckets = draw.mock.calls[0][0];
		expect(buckets.get(7)?.fresh).toHaveLength(1);
		expect([...buckets.keys()]).toEqual([7]);
	});
});

describe('HanamiTasteClusterBatchService taste rebuild', () => {
	test('embeddingsチャンクでゲート落ちをpurgeし、DO UPDATEで再埋め込みしてcursorを進める', async () => {
		process.env.HANAMI_TASTE_REBUILD_CHUNK = '3';
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const redis = new FakeRedis();
		const valid = noteId(1 * HOUR, 'valid-rebuild');
		const junk = noteId(1 * HOUR, 'junk-rebuild');
		const missing = noteId(1 * HOUR, 'missing-rebuild');
		const db = {
			query: jest.fn(async (sql: string, params: unknown[]) => {
				if (sql.includes('FROM "hanami_note_embedding" e')) {
					expect(params[1]).toBeNull();
					return [
						{ id: valid, text: 'これは十分に長い本文テキストabc123' },
						{ id: junk, text: '😀😃😄😁😆😅' },
						{ id: missing, text: null },
					];
				}
				return [];
			}),
		};
		const service = tasteBatchService(db, redis);
		(service as unknown as {
			embedTexts: (texts: [string, string][], timeBudgetSec: number) => Promise<{ dim: number; processed: number; embeddings: [string, number[]][] }>;
		}).embedTexts = jest.fn(async (texts: [string, string][]) => ({
			dim: 2,
			processed: texts.length,
			embeddings: texts.map(([id]) => [id, [0.1, 0.2]] as [string, number[]]),
		}));

		const res = await service.runTasteRebuildChunk({
			phase: 'embeddings',
			cursor: null,
			stats: { reembedded: 0, purged: 0, evidenceUpdated: 0, evidencePurged: 0 },
			startedAt: NOW,
		}, logger() as never);

		expect(res).toMatchObject({
			action: 'continue',
			data: {
				phase: 'embeddings',
				cursor: missing,
				stats: { reembedded: 1, purged: 2 },
			},
		});
		const deleteCall = db.query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM "hanami_note_embedding"'));
		expect(deleteCall?.[1]?.[1]).toEqual(expect.arrayContaining([junk, missing]));
		const upsertSql = db.query.mock.calls.map(([sql]) => String(sql)).find(sql => sql.includes('ON CONFLICT ("noteId", model) DO UPDATE'));
		expect(upsertSql).toBeDefined();
		expect(redis.hsetCalls.length).toBeGreaterThan(0);
		expect(redis.evalCalls).toHaveLength(1);
	});

	test('rebuildロック取得に失敗したらDBもstatusも書かない', async () => {
		const redis = new FakeRedis();
		redis.lockOk = false;
		const db = { query: jest.fn(async () => []) };
		const log = logger();

		const res = await tasteBatchService(db, redis).runTasteRebuildChunk({
			phase: 'embeddings',
			cursor: null,
			stats: { reembedded: 0, purged: 0, evidenceUpdated: 0, evidencePurged: 0 },
			startedAt: NOW,
		}, log as never);

		expect(res).toMatchObject({ action: 'retry', delayMs: 60 * 1000 });
		expect(db.query).not.toHaveBeenCalled();
		expect(redis.hsetCalls).toHaveLength(0);
		expect(redis.evalCalls).toHaveLength(0);
	});
});
