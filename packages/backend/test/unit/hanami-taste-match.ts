/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { HanamiTasteClusterBatchService } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { HanamiForYouService } from '@/core/hanami/HanamiForYouService.js';
import { HANAMI_FORYOU_ACTIVE_KEY_PREFIX, HANAMI_RECENT_ACT_KEY_PREFIX, HANAMI_TASTE_MATCH_KEY_PREFIX, HANAMI_TASTE_MATCH_META_KEY_PREFIX } from '@/core/hanami/HanamiForYouKeys.js';
import type { ForYouCandidate } from '@/core/hanami/HanamiForYouInterleave.js';

const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

type RedisOp = { kind: string; args: unknown[] };
type ClusterLotteryShare = Map<number | 'general' | 'r', number>;
type DrawClusterLotteryMock = (_buckets: unknown, shareOf: ClusterLotteryShare) => ForYouCandidate[];

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

	public zrangebyscore(key: string, ...args: unknown[]): this {
		this.ops.push({ kind: 'zrangebyscore', args: [key, ...args] });
		return this;
	}

	public hset(key: string, fields: Record<string, string>): this {
		this.ops.push({ kind: 'hset', args: [key, fields] });
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
				return [null, this.redis.existsKey(key) ? 1 : 0];
			}
			if (op.kind === 'zrangebyscore') {
				const key = op.args[0] as string;
				const min = Number(op.args[1]);
				const maxArg = op.args[2];
				const max = maxArg === '+inf' ? Infinity : Number(maxArg);
				const zset = this.redis.zsets.get(key) ?? new Map();
				const out: string[] = [];
				for (const [member, score] of [...zset.entries()].sort((a, b) => a[1] - b[1])) {
					if (score >= min && score <= max) out.push(member, String(score));
				}
				return [null, out];
			}
			if (op.kind === 'zadd') {
				const key = op.args[0] as string;
				let zset = this.redis.zsets.get(key);
				if (zset == null) { zset = new Map(); this.redis.zsets.set(key, zset); }
				for (let i = 1; i + 1 < op.args.length; i += 2) zset.set(op.args[i + 1] as string, Number(op.args[i]));
			}
			if (op.kind === 'hset') {
				const key = op.args[0] as string;
				const fields = op.args[1] as Record<string, string>;
				this.redis.hashes.set(key, { ...(this.redis.hashes.get(key) ?? {}), ...fields });
			}
			if (op.kind === 'del') {
				const key = op.args[0] as string;
				this.redis.hashes.delete(key);
				this.redis.zsets.delete(key);
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
	public zsets = new Map<string, Map<string, number>>();

	public existsKey(key: string): boolean {
		return this.activeKeys.has(key) || this.zsets.has(key) || this.hashes.has(key);
	}

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

function addRecent(redis: FakeRedis, uid: string, targetNoteId: string, kind: 'r' | 'n' | 'p', actionMs = NOW): void {
	const key = HANAMI_RECENT_ACT_KEY_PREFIX + uid;
	let zset = redis.zsets.get(key);
	if (zset == null) { zset = new Map(); redis.zsets.set(key, zset); }
	zset.set(`${targetNoteId}:${kind}`, actionMs);
}

function unitVec(x: number): number[] {
	return [x, Math.sqrt(1 - x * x)];
}

function vec2(x: number, y: number): number[] {
	return [x, y];
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

function matchWriteFor(redis: FakeRedis, uid: string): RedisOp[] | undefined {
	const key = HANAMI_TASTE_MATCH_KEY_PREFIX + uid;
	return redis.pipelineExecs.find(ops => ops.some(op => (
		(op.kind === 'zadd' && String(op.args[0]).startsWith(`${key}:tmp:`)) ||
		(op.kind === 'rename' && op.args[1] === key) ||
		(op.kind === 'del' && op.args[0] === key)
	)));
}

function metaWriteFor(redis: FakeRedis, uid: string): RedisOp[] | undefined {
	const key = HANAMI_TASTE_MATCH_META_KEY_PREFIX + uid;
	return redis.pipelineExecs.find(ops => ops.some(op => op.args[0] === key && (op.kind === 'hset' || op.kind === 'del')));
}

function redisHashField(redis: FakeRedis, uid: string, field: string): string | undefined {
	return redis.hashes.get(HANAMI_TASTE_MATCH_META_KEY_PREFIX + uid)?.[field];
}

function forYouService(db: { query: ReturnType<typeof jest.fn> }, redis: { zrevrange?: ReturnType<typeof jest.fn>; hgetall?: ReturnType<typeof jest.fn> }): HanamiForYouService {
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
			[
				{ uid: 'u-active', cid: 7, centroid: [1, 0], userWeight: 1 },
				{ uid: 'u-empty', cid: 8, centroid: [-1, 0], userWeight: 1 },
				{ uid: 'u-inactive', cid: 9, centroid: [1, 0], userWeight: 1 },
			],
			[],
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
		expect(redis.hashes.has(HANAMI_TASTE_MATCH_META_KEY_PREFIX + 'u-active')).toBe(false);

		const delWrite = writes.find(ops => ops.some(op => op.kind === 'del'));
		expect(delWrite?.[0]).toEqual({ kind: 'del', args: [HANAMI_TASTE_MATCH_KEY_PREFIX + 'u-empty'] });
		expect(writes.some(ops => ops.some(op => op.args.includes(HANAMI_TASTE_MATCH_KEY_PREFIX + 'u-inactive')))).toBe(false);
	});

	test('短期作者capを埋め込み済み行動だけで計算し、recentVecはノート単位正規化後に平均する', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const redis = new FakeRedis();
		redis.activeKeys.add(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + 'u');

		const capNotes = [1, 2, 3, 4].map(i => noteId(i * HOUR, `recent-cap-${i}`));
		const missingEmbedding = noteId(1 * HOUR, 'recent-cap-missing');
		const other = noteId(1 * HOUR, 'recent-other');
		for (const id of capNotes) addRecent(redis, 'u', id, 'r');
		addRecent(redis, 'u', missingEmbedding, 'r');
		addRecent(redis, 'u', other, 'r');
		const recentOnly = noteId(1 * HOUR, 'recent-cap-r');
		const recentOnlyVec = vec2(0.4, Math.sqrt(0.84));
		const db = dbWithResults([
			[{ uid: 'u', cid: 7, centroid: [1, 0], userWeight: 1 }],
			[],
			[],
			[{ meanVec: [0, 0] }],
			[
				...capNotes.map(nid => ({ nid, aid: 'author-cap', emb: [2, 0] })),
				{ nid: missingEmbedding, aid: 'author-cap', emb: null },
				{ nid: other, aid: 'author-other', emb: [0, 1] },
			],
			[{ nid: recentOnly, aid: 'author-new', emb: recentOnlyVec }],
		]);

		await tasteBatchService(db, redis).runTasteTick(logger() as never);

		const meta = redis.hashes.get(HANAMI_TASTE_MATCH_META_KEY_PREFIX + 'u');
		expect(meta).toBeDefined();
		expect(meta?.hasRecentVec).toBe('1');
		expect(Number(meta?.totalHeat)).toBeCloseTo(3);
		expect(Number(meta?.['heat:7'])).toBeCloseTo(3);
		expect(metaWriteFor(redis, 'u')?.map(op => op.kind)).toEqual(['del', 'hset', 'expire']);
		expect(metaWriteFor(redis, 'u')?.[2].args).toEqual([HANAMI_TASTE_MATCH_META_KEY_PREFIX + 'u', 48 * 60 * 60]);

		const scores = zaddScores(matchWriteFor(redis, 'u')!);
		const expectedRecentCos = (3 * recentOnlyVec[0] + recentOnlyVec[1]) / Math.sqrt(10);
		expect(scores.get(`${recentOnly}:author-new:r`)).toBeCloseTo(expectedRecentCos);
	});

	test('RECENT_MIN_ACTIONS未満ではhasRecentVec=0でrメンバーを作らず、3件で有効化する', async () => {
		const run = async (count: number) => {
			jest.spyOn(Date, 'now').mockReturnValue(NOW);
			const redis = new FakeRedis();
			redis.activeKeys.add(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + 'u');
			const recentIds = Array.from({ length: count }, (_, i) => noteId((i + 1) * HOUR, `min-${count}-${i}`));
			for (const id of recentIds) addRecent(redis, 'u', id, 'r');
			const cand = noteId(1 * HOUR, `min-cand-${count}`);
			const db = dbWithResults([
				[{ uid: 'u', cid: 7, centroid: [1, 0], userWeight: 1 }],
				[],
				[],
				[{ meanVec: [0, 0] }],
				recentIds.map((nid, i) => ({ nid, aid: `author-${i}`, emb: [0, 1] })),
				[{ nid: cand, aid: 'author-new', emb: [0, 1] }],
			]);

			await tasteBatchService(db, redis).runTasteTick(logger() as never);
			jest.restoreAllMocks();
			return { redis, cand };
		};

		const two = await run(2);
		expect(redisHashField(two.redis, 'u', 'hasRecentVec')).toBe('0');
		expect([...zaddScores(matchWriteFor(two.redis, 'u') ?? []).keys()]).not.toContain(`${two.cand}:author-new:r`);

		const three = await run(3);
		expect(redisHashField(three.redis, 'u', 'hasRecentVec')).toBe('1');
		expect(zaddScores(matchWriteFor(three.redis, 'u')!).get(`${three.cand}:author-new:r`)).toBeCloseTo(1);
	});

	test('規則B: cluster採用はcluster bucket、cluster未満かつrecent以上はr、両方未満は不採用', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const redis = new FakeRedis();
		redis.activeKeys.add(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + 'u');
		const recentIds = [1, 2, 3].map(i => noteId(i * HOUR, `rule-recent-${i}`));
		for (const id of recentIds) addRecent(redis, 'u', id, 'r');
		const clusterWins = noteId(1 * HOUR, 'rule-cluster');
		const recentOnly = noteId(1 * HOUR, 'rule-recent-only');
		const rejected = noteId(1 * HOUR, 'rule-reject');
		const db = dbWithResults([
			[{ uid: 'u', cid: 7, centroid: [1, 0], userWeight: 1 }],
			[],
			[],
			[{ meanVec: [0, 0] }],
			recentIds.map((nid, i) => ({ nid, aid: `author-recent-${i}`, emb: [0, 1] })),
			[
				{ nid: clusterWins, aid: 'author-cluster', emb: [0.6, 0.8] },
				{ nid: recentOnly, aid: 'author-recent-only', emb: vec2(0.4, Math.sqrt(0.84)) },
				{ nid: rejected, aid: 'author-reject', emb: vec2(-0.9, -Math.sqrt(0.19)) },
			],
		]);

		await tasteBatchService(db, redis).runTasteTick(logger() as never);

		const keys = [...zaddScores(matchWriteFor(redis, 'u')!).keys()];
		expect(keys).toContain(`${clusterWins}:author-cluster:7`);
		expect(keys).toContain(`${recentOnly}:author-recent-only:r`);
		expect(keys).not.toContain(`${clusterWins}:author-cluster:r`);
		expect(keys).not.toContain(`${rejected}:author-reject:r`);
		expect(keys).not.toContain(`${rejected}:author-reject:7`);
	});

	test('hiddenクラスタ一致はcos_recentが高くてもvetoする', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const redis = new FakeRedis();
		redis.activeKeys.add(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + 'u');
		const recentIds = [1, 2, 3].map(i => noteId(i * HOUR, `veto-recent-${i}`));
		for (const id of recentIds) addRecent(redis, 'u', id, 'r');
		const vetoed = noteId(1 * HOUR, 'vetoed');
		const db = dbWithResults([
			[
				{ uid: 'u', cid: 7, centroid: [1, 0], userWeight: 1 },
				{ uid: 'u', cid: 8, centroid: [0, 1], userWeight: 0 },
			],
			[],
			[],
			[{ meanVec: [0, 0] }],
			recentIds.map((nid, i) => ({ nid, aid: `author-veto-${i}`, emb: [0, 1] })),
			[{ nid: vetoed, aid: 'author-new', emb: [0, 1] }],
		]);

		await tasteBatchService(db, redis).runTasteTick(logger() as never);

		expect(redisHashField(redis, 'u', 'hasRecentVec')).toBe('1');
		expect([...zaddScores(matchWriteFor(redis, 'u') ?? []).keys()]).not.toContain(`${vetoed}:author-new:r`);
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
		expect(out).toEqual([{ noteId: valid, userId: 'author-new', score: 0.42, bucket: 'cluster', clusterId: 7 }]);
		expect(draw).toHaveBeenCalledTimes(1);
		const buckets = draw.mock.calls[0][0];
		expect(buckets.get(7)?.fresh).toHaveLength(1);
		expect([...buckets.keys()]).toEqual([7]);
	});

	test('r memberをパースし、metaありtotalHeat>0ならrecentバケツから引く', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		jest.spyOn(Math, 'random').mockReturnValue(0);
		const recent = noteId(1 * HOUR, 'recent-pick');
		const cluster = noteId(1 * HOUR, 'cluster-pick');
		const redis = {
			zrevrange: jest.fn(async () => [
				`${recent}:author-recent:r`, '0.90',
				`${cluster}:author-cluster:7`, '0.80',
			]),
			hgetall: jest.fn(async () => ({ totalHeat: '12', hasRecentVec: '1' })),
		};
		const db = dbWithResults([
			[{ clusterId: 7, size: 10, userWeight: 1 }],
		]);
		const service = forYouService(db, redis);
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);

		const out = await (service as unknown as {
			reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).reactionSimilarCandidates('me', [], new Set(), new Set());

		expect(out[0]).toMatchObject({ noteId: recent, userId: 'author-recent', bucket: 'recent' });
		expect(out[0]).not.toHaveProperty('clusterId');
	});

	test('rのみのzsetでも有効metaならrecent候補を返す', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		jest.spyOn(Math, 'random').mockReturnValue(0);
		const recent = noteId(1 * HOUR, 'recent-only');
		const redis = {
			zrevrange: jest.fn(async () => [
				`${recent}:author-recent:r`, '0.90',
			]),
			hgetall: jest.fn(async () => ({ totalHeat: '12', hasRecentVec: '1' })),
		};
		const db = dbWithResults([
			[{ clusterId: 7, size: 10, userWeight: 1 }],
		]);
		const service = forYouService(db, redis);
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);

		const out = await (service as unknown as {
			reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).reactionSimilarCandidates('me', [], new Set(), new Set());

		expect(out).toEqual([{ noteId: recent, userId: 'author-recent', score: 1, bucket: 'recent' }]);
	});

	test('meta無しならrバケツshare=0で古いr memberを引かない', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		jest.spyOn(Math, 'random').mockReturnValue(0.99);
		const recent = noteId(1 * HOUR, 'recent-stale');
		const cluster = noteId(1 * HOUR, 'cluster-live');
		const redis = {
			zrevrange: jest.fn(async () => [
				`${recent}:author-recent:r`, '0.90',
				`${cluster}:author-cluster:7`, '0.80',
			]),
			hgetall: jest.fn(async () => ({})),
		};
		const db = dbWithResults([
			[{ clusterId: 7, size: 10, userWeight: 1 }],
		]);
		const service = forYouService(db, redis);
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);

		const out = await (service as unknown as {
			reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).reactionSimilarCandidates('me', [], new Set(), new Set());

		expect(out.map(c => c.noteId)).toEqual([cluster]);
		expect(out.some(c => c.noteId === recent)).toBe(false);
	});

	test('r shareはtotalHeat=HEAT_SAT以上で50%、半分で25%になる', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const run = async (totalHeat: number): Promise<number> => {
			const recent = noteId(1 * HOUR, `recent-share-${totalHeat}`);
			const cluster = noteId(1 * HOUR, `cluster-share-${totalHeat}`);
			const redis = {
				zrevrange: jest.fn(async () => [
					`${recent}:author-recent:r`, '0.90',
					`${cluster}:author-cluster:7`, '0.80',
				]),
				hgetall: jest.fn(async () => ({ totalHeat: String(totalHeat), hasRecentVec: '1' })),
			};
			const db = dbWithResults([
				[{ clusterId: 7, size: 10, userWeight: 1 }],
			]);
			const service = forYouService(db, redis);
			(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);
			const draw = jest.fn<DrawClusterLotteryMock>(() => []);
			(service as unknown as { drawClusterLottery: typeof draw }).drawClusterLottery = draw;

			await (service as unknown as {
				reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
			}).reactionSimilarCandidates('me', [], new Set(), new Set());

			const shareOf = draw.mock.calls[0][1];
			const clusterShare = shareOf.get(7) ?? 0;
			const recentShare = shareOf.get('r') ?? 0;
			return recentShare / (clusterShare + recentShare);
		};

		await expect(run(12)).resolves.toBeCloseTo(0.5);
		await expect(run(6)).resolves.toBeCloseTo(0.25);
	});

	test('heatが付いたクラスタのshareを1+2*heatNorm倍にする', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const c7 = noteId(1 * HOUR, 'heat-c7');
		const c8 = noteId(1 * HOUR, 'heat-c8');
		const redis = {
			zrevrange: jest.fn(async () => [
				`${c7}:author-c7:7`, '0.90',
				`${c8}:author-c8:8`, '0.90',
			]),
			hgetall: jest.fn(async () => ({ totalHeat: '10', 'heat:7': '10', hasRecentVec: '0' })),
		};
		const db = dbWithResults([
			[
				{ clusterId: 7, size: 10, userWeight: 1 },
				{ clusterId: 8, size: 10, userWeight: 1 },
			],
		]);
		const service = forYouService(db, redis);
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);
		const draw = jest.fn<DrawClusterLotteryMock>(() => []);
		(service as unknown as { drawClusterLottery: typeof draw }).drawClusterLottery = draw;

		await (service as unknown as {
			reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).reactionSimilarCandidates('me', [], new Set(), new Set());

		const shareOf = draw.mock.calls[0][1];
		expect(shareOf.get(7)).toBeCloseTo(30);
		expect(shareOf.get(8)).toBeCloseTo(10);
	});

	test('provenanceはrecent経由をreactionSimilar:r、cluster経由をreactionSimilar:c{k}にする', async () => {
		const recent = noteId(1 * HOUR, 'prov-recent');
		const cluster = noteId(1 * HOUR, 'prov-cluster');
		const service = forYouService(dbWithResults([]), {});
		const recordServed = jest.fn(async () => undefined);
		const recordShown = jest.fn(async () => undefined);
		const recordServedEvents = jest.fn(async () => undefined);
		const internals = service as unknown as {
			hanamiRecommendationService: { recordServed: typeof recordServed };
			hanamiUserRecommendationService: { recordShown: typeof recordShown };
			hanamiForYouProvenanceService: { recordServedEvents: typeof recordServedEvents };
			recordServed: (meId: string, notes: { id: string; userId: string }[], reasonOf: Map<string, unknown>) => Promise<void>;
		};
		internals.hanamiRecommendationService = { recordServed };
		internals.hanamiUserRecommendationService = { recordShown };
		internals.hanamiForYouProvenanceService = { recordServedEvents };

		await internals.recordServed('me', [
			{ id: recent, userId: 'author-recent' },
			{ id: cluster, userId: 'author-cluster' },
		], new Map<string, unknown>([
			[recent, { source: 'reactionSimilar', sources: ['reactionSimilar'], bucket: 'recent' }],
			[cluster, { source: 'reactionSimilar', sources: ['reactionSimilar'], bucket: 'cluster', clusterId: 7 }],
		]));

		expect(recordServedEvents).toHaveBeenCalledWith('me', [
			{ noteId: recent, source: 'reactionSimilar:r' },
			{ noteId: cluster, source: 'reactionSimilar:c7' },
		]);
	});
});

describe('HanamiForYouService taste cosNorm', () => {
	test('境界値と埋め込み無し固定値を仕様どおり写像する', () => {
		const service = forYouService(dbWithResults([]), { zrevrange: jest.fn() });
		const cosNorm = (service as unknown as {
			tasteCosNorm: (cos: number | null | undefined) => number;
		}).tasteCosNorm.bind(service);

		expect(cosNorm(0.15)).toBeCloseTo(0.1);
		expect(cosNorm(0.5)).toBeCloseTo(1.0);
		expect(cosNorm(0.675)).toBeCloseTo(1.5);
		expect(cosNorm(0.8)).toBeCloseTo(1.5);
		expect(cosNorm(null)).toBeCloseTo(0.25);
	});

	test('globalPopular 経路では同スコア同クラスタの低cos候補が高cos候補より引かれにくい', async () => {
		const low = noteId(1 * HOUR, 'global-low-cos');
		const high = noteId(1 * HOUR, 'global-high-cos');
		jest.spyOn(Math, 'random').mockReturnValue(0.4);
		const db = dbWithResults([
			[{ clusterId: 7, centroid: [1, 0], size: 10, userWeight: 1 }],
			[{ meanVec: [0, 0] }],
			[
				{ noteId: low, embedding: unitVec(0.3) },
				{ noteId: high, embedding: unitVec(0.5) },
			],
		]);
		const service = forYouService(db, { zrevrange: jest.fn() });
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);

		const out = await (service as unknown as {
			applyTasteClusterOrdering: (meId: string, candidates: ForYouCandidate[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).applyTasteClusterOrdering('me', [
			{ noteId: low, score: 1 },
			{ noteId: high, score: 1 },
		], new Set(), new Set());

		expect(out.map(c => c.noteId)).toEqual([high, low]);
	});

	test('reactionSimilar 経路では cosNorm を掛けず zset score の従来重みだけで抽選する', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		jest.spyOn(Math, 'random').mockReturnValue(0.25);
		const low = noteId(1 * HOUR, 'reaction-low-score');
		const high = noteId(1 * HOUR, 'reaction-high-score');
		const redis = {
			zrevrange: jest.fn(async () => [
				`${low}:author-low:7`, '0.30',
				`${high}:author-high:7`, '0.50',
			]),
		};
		const db = dbWithResults([
			[{ clusterId: 7, size: 10, userWeight: 1 }],
		]);
		const service = forYouService(db, redis);
		(service as unknown as { computeMediaOddsCalibration: () => Promise<null> }).computeMediaOddsCalibration = jest.fn(async () => null);

		const out = await (service as unknown as {
			reactionSimilarCandidates: (meId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>) => Promise<ForYouCandidate[]>;
		}).reactionSimilarCandidates('me', [], new Set(), new Set());

		expect(out.map(c => c.noteId)).toEqual([low, high]);
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
