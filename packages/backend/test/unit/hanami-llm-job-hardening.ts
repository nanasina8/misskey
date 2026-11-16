/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import * as Bull from 'bullmq';
import { acquireHanamiLocalLlmLock, clearHanamiLlmEventThrottle, HANAMI_LOCAL_CPU_LOCK_KEY, HANAMI_LOCAL_LLM_LOCK_KEY, HANAMI_LLM_EVENTS_KEY, recordHanamiLlmEvent, type HanamiLlmEvent } from '@/core/hanami/HanamiLocalLlmLock.js';
import { HanamiForYouBatchService, HANAMI_TREND_TOPIC_JUDGE_LAST_KEY, type HanamiNoteJudgeGpuOutput, type HanamiTrendTopicJudgeGpuOutput, type HanamiTrendTopicJudgeResult } from '@/core/hanami/HanamiForYouBatchService.js';
import { HanamiGpuQueueService } from '@/core/hanami/HanamiGpuQueueService.js';
import { HanamiTasteClusterBatchService } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';
import JudgeStatusEndpoint, { meta as statusMeta } from '@/server/api/endpoints/admin/hanami/judge-status.js';

const runtime = vi.hoisted(() => vi.fn(() => ({ available: true, device: 'cuda' })));
vi.mock('@/core/hanami/HanamiPythonRuntime.js', async importOriginal => ({
	...await importOriginal<typeof import('@/core/hanami/HanamiPythonRuntime.js')>(),
	probeHanamiNoteJudgeRuntime: runtime, peekHanamiNoteJudgeRuntime: runtime,
}));

// Exercise the actual Lua against an isolated, diskless Redis; no shared test data is touched.
let directory: string;
let server: ChildProcess;
let redis: Redis;
const log = { warn: vi.fn(), info: vi.fn(), succ: vi.fn() };
const queuedKey = 'hanami:note-judge:queued:v1';
const legacyKey = 'hanami:taste:tick:lock';
const settings = createDefaultHanamiNoteJudgeSettings();
const now = Date.parse('2026-10-29T12:00:00Z');
const topicData = {
	topics: [{ topicId: 'a', text: 'A' }, { topicId: 'b', text: 'B' }], dailyIds: ['a', 'b'], pairs: [{ a: 'a', b: 'b' }],
	titles: [{ topicId: 'a', posts: ['駅前に新しいパン屋が開いた', '焼きたてのパンを買って帰った', '週末のパン屋は大盛況だった'], noteIds: ['n1', 'n2', 'n3'] }],
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'hanami-llm-hardening-'));
	const socket = join(directory, 'redis.sock');
	server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.once('exit', code => { reject(new Error(`Test Redis exited: ${code}`)); });
		server.stdout!.on('data', chunk => { if (/ready to accept connections/i.test(String(chunk))) resolve(); });
	});
	redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 10 });
	redis.on('error', () => { /* Initial connect may precede socket creation. */ });
	await redis.connect();
});
afterAll(async () => {
	if (redis?.status === 'ready') await redis.quit();
	else redis?.disconnect();
	if (server?.exitCode == null) {
		const exited = once(server, 'exit');
		server.kill();
		await exited;
	}
	if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
	clearHanamiLlmEventThrottle();
	await redis.flushdb();
	vi.clearAllMocks();
	runtime.mockReturnValue({ available: true, device: 'cuda' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function batch(rows: unknown[] = []) {
	const query = vi.fn(async (sql: string, _parameters?: unknown[]) => sql.includes('AS settings') ? [{ settings }] : sql.includes('SELECT') ? rows : []);
	const runs = { insert: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };
	// 順番待ちは本物（この隔離した Redis の上）。判定係・配り役は動かさず、取り出しと受け取り係の呼び出しをテストが行う。
	const gpuQueue = new HanamiGpuQueueService(redis);
	const service = new HanamiForYouBatchService({ query } as never, runs as never, redis, { gen: () => 'run' } as never, {} as never, gpuQueue);
	return { service, query, runs, gpuQueue };
}

function processor(service: HanamiForYouBatchService, queue = {}) {
	return new HanamiCommonGenerationProcessorService({
		runCommonGeneration: async () => ({ kind: 'published', generationId: 'g' }), findDispatchableCommonGeneration: async () => null,
	} as never, queue as never, { logger: { createSubLogger: () => log } } as never, service);
}

const topicJob = (data: unknown = topicData, age = 60_000) => ({
	name: 'hanamiTrendTopicJudge', data, timestamp: Date.now() - age, token: 'worker',
	moveToDelayed: vi.fn(async () => undefined), updateProgress: vi.fn(async () => undefined),
});
const lastResult = async () => JSON.parse((await redis.get(HANAMI_TREND_TOPIC_JUDGE_LAST_KEY))!) as HanamiTrendTopicJudgeResult;
const events = async () => (await redis.lrange(HANAMI_LLM_EVENTS_KEY, 0, -1)).map(raw => JSON.parse(raw) as HanamiLlmEvent);

describe('local LLM lease', () => {
	test('ALS uses the CPU lease (not the GPU one the resident worker holds) and releases it when Python fails', async () => {
		const { service, query } = batch();
		query.mockImplementation(async sql => sql.includes('SELECT r."userId" AS u') ? [{ u: 'user', a: 'author', c: 5 }] : []);
		await redis.set(HANAMI_LOCAL_CPU_LOCK_KEY, 'busy');
		await expect(service.runAlsBatch(log as never)).resolves.toMatchObject({ status: 'failed' });
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('local LLM is busy'));
		expect(await redis.get(HANAMI_LOCAL_CPU_LOCK_KEY)).toBe('busy');
		// CPU の鍵の取り合いでは「GPU を待っている」目印を立てない（立てると判定係が降ろされる）。
		expect(await redis.exists('hanami:llm:wanted:als')).toBe(0);
		await redis.del(HANAMI_LOCAL_CPU_LOCK_KEY);
		// 常駐の判定係が GPU の鍵を持ったままでも、ALS は走れる。
		await redis.set(HANAMI_LOCAL_LLM_LOCK_KEY, 'gpuWorker:1:1:token');
		const script = join(directory, 'als.py');
		await writeFile(script, 'raise RuntimeError("ALS failed")\n');
		vi.stubEnv('HANAMI_FORYOU_ALS_SCRIPT', script);
		const set = vi.spyOn(redis, 'set');
		await expect(service.runAlsBatch(log as never)).resolves.toMatchObject({ status: 'failed' });
		expect(set).toHaveBeenCalledWith(HANAMI_LOCAL_CPU_LOCK_KEY, expect.any(String), 'EX', 90, 'NX');
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ALS failed'));
		expect(await redis.get(HANAMI_LOCAL_CPU_LOCK_KEY)).toBeNull();
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBe('gpuWorker:1:1:token');
	});
	test('acquires for 90 seconds, contends, renews every 30 seconds and stops in finally', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		const lease = await acquireHanamiLocalLlmLock(redis, 'noteJudge', { logger: log });
		expect(lease).not.toBeNull();
		expect(await redis.ttl(HANAMI_LOCAL_LLM_LOCK_KEY)).toBe(90);
		expect(await acquireHanamiLocalLlmLock(redis, 'noteJudge')).toBeNull();
		const evalSpy = vi.spyOn(redis, 'eval');
		try {
			await vi.advanceTimersByTimeAsync(29_999);
			expect(evalSpy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await redis.ping(); // Wait for the renewal's Redis response.
			expect(evalSpy).toHaveBeenCalledTimes(1);
			await redis.pexpire(HANAMI_LOCAL_LLM_LOCK_KEY, 1000);
			await vi.advanceTimersByTimeAsync(30_000);
			await redis.ping();
			expect(await redis.pttl(HANAMI_LOCAL_LLM_LOCK_KEY)).toBeGreaterThan(89_000);
			expect(evalSpy).toHaveBeenCalledTimes(2);
		} finally { await lease!.release(); }
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBeNull();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(evalSpy).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});
	test.each(['other-owner', null])('never renews or deletes a missing/stolen lease (%s)', async owner => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const lease = await acquireHanamiLocalLlmLock(redis, 'noteJudge', { logger: log });
		if (owner == null) await redis.del(HANAMI_LOCAL_LLM_LOCK_KEY);
		else await redis.set(HANAMI_LOCAL_LLM_LOCK_KEY, owner, 'PX', 5000);
		await vi.advanceTimersByTimeAsync(30_000);
		await redis.ping();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ownership lost'));
		await lease!.release();
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBe(owner);
		expect(await redis.pttl(HANAMI_LOCAL_LLM_LOCK_KEY)).toBeLessThanOrEqual(5000);
	});
	test('taste acquires in legacy/shared order, releases only its reservation on contention, and renews both', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		await redis.set(HANAMI_LOCAL_LLM_LOCK_KEY, 'busy');
		const set = vi.spyOn(redis, 'set');
		const keys = [legacyKey, HANAMI_LOCAL_LLM_LOCK_KEY];
		expect(await acquireHanamiLocalLlmLock(redis, 'noteJudge', { keys })).toBeNull();
		// 取れなかったので、最後に「GPU を待っている」目印を立てる。
		expect(set.mock.calls.map(call => call[0])).toEqual([...keys, 'hanami:llm:wanted:noteJudge']);
		expect(await redis.get(legacyKey)).toBeNull();
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBe('busy');
		await redis.del(HANAMI_LOCAL_LLM_LOCK_KEY);
		const lease = await acquireHanamiLocalLlmLock(redis, 'noteJudge', { keys });
		try {
			for (const key of keys) await redis.pexpire(key, 1000);
			await vi.advanceTimersByTimeAsync(30_000);
			await redis.ping();
			for (const key of keys) expect(await redis.pttl(key)).toBeGreaterThan(89_000);
			throw new Error('operation failed');
		} catch (error) { expect((error as Error).message).toBe('operation failed'); } finally { await lease!.release(); }
		expect(await redis.exists(...keys)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	test('renewal errors warn and a failed second acquisition releases the first key and its timer', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const lease = await acquireHanamiLocalLlmLock(redis, 'noteJudge', { logger: log });
		vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('Redis unavailable'));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('renewal failed'), expect.anything());
		await lease!.release();
		const originalSet = redis.set.bind(redis);
		vi.spyOn(redis, 'set').mockImplementation(((...args: unknown[]) => args[0] === HANAMI_LOCAL_LLM_LOCK_KEY
			? Promise.reject(new Error('connection lost')) : (originalSet as (...args: unknown[]) => unknown)(...args)) as never);
		await expect(acquireHanamiLocalLlmLock(redis, 'noteJudge', { keys: [legacyKey, HANAMI_LOCAL_LLM_LOCK_KEY] })).rejects.toThrow('connection lost');
		expect(await redis.get(legacyKey)).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('note judge queue reservations and interrupted runs', () => {
	test('runs date checks in the requested timezone', () => {
		if (process.env.HANAMI_EXPECT_TZ == null) return;
		expect(process.env.TZ).toBe(process.env.HANAMI_EXPECT_TZ);
		expect(new Date(now).getTimezoneOffset()).toBe(process.env.HANAMI_EXPECT_TZ === 'Asia/Tokyo' ? -540 : 0);
	});
	test('prepare/reconcile exclude the last 30 minutes before batching and sweep only older records', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const { service } = batch(Array.from({ length: 34 }, (_, i) => ({ id: `n${i}`, text: '運用に役立つ投稿です。', isBot: false, isReply: false })));
		await redis.zadd(queuedKey, now - 1, 'n0', now - 30 * 60_000, 'n1', now - 30 * 60_000 - 1, 'n2');
		const jobs = await service.prepareNoteJudgeJobs('g');
		expect(jobs.map(job => job.noteIds.length)).toEqual([16, 16]);
		expect(jobs.flatMap(job => job.noteIds)).toEqual(Array.from({ length: 32 }, (_, i) => `n${i + 2}`));
		expect(await redis.zscore(queuedKey, 'n2')).toBeNull();
		expect(await service.reconcileNoteJudgeJobs()).toEqual(jobs);
	});
	test('concurrent enqueue reservations admit each note once', async () => {
		const { service } = batch();
		const reservations = await Promise.all([service.reserveNoteJudgeNotes(['a', 'b']), service.reserveNoteJudgeNotes(['b', 'c'])]);
		expect(reservations.flat().sort()).toEqual(['a', 'b', 'c']);
		expect(await redis.zcard(queuedKey)).toBe(3);
	});
	test.each(['generation', 'reconcile'])('%s reserves before enqueue and rolls back a failed enqueue', async source => {
		const { service } = batch([{ id: 'n1', text: '役立つ情報です。', isBot: false, isReply: false }]);
		vi.spyOn(service, 'prepareTrendTopicJudgeJob').mockResolvedValue(null);
		const enqueue = vi.fn(async () => {
			expect(await redis.zscore(queuedKey, 'n1')).not.toBeNull();
			throw new Error('enqueue failed');
		});
		const worker = processor(service, { enqueueHanamiNoteJudge: enqueue });
		const job = { name: 'hanamiCommonGeneration', data: { generationId: 'g' }, log: async () => undefined, updateProgress: async () => undefined };
		await expect(source === 'generation' ? worker.processGeneration(job as never) : worker.processCommonReconcile(job as never)).rejects.toThrow('enqueue failed');
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(await redis.zcard(queuedKey)).toBe(0);
	});
	test.each(['empty', 'failed', 'noGpu', 'handedOff'])('the job clears reservations on %s, and keeps them only for notes handed to the GPU queue', async outcome => {
		const { service, query, runs, gpuQueue } = batch(outcome === 'handedOff' ? [{ id: 'n1', text: '役立つ運用情報です。', hasFiles: false, isBot: false, isReply: false }] : []);
		await service.reserveNoteJudgeNotes(['n1']);
		if (outcome === 'failed') query.mockRejectedValueOnce(new Error('DB unavailable'));
		if (outcome === 'noGpu') runtime.mockReturnValue({ available: false, device: 'cuda' });
		// 以前は GPU の鍵や「話題の判定が待っている」目印があると待たされた。いまは関係しない。
		await redis.set(HANAMI_LOCAL_LLM_LOCK_KEY, 'gpuWorker:1:1:token');
		await redis.set('hanami:llm:topic-judge-waiting:v1', '1');
		const run = service.runNoteJudgeJob({ noteIds: ['n1'], promptVersion: 1 }, log as never);
		if (outcome === 'failed') await expect(run).rejects.toThrow('DB unavailable');
		else await expect(run).resolves.toMatchObject({ status: 'ready', processedCount: 0, queuedCount: outcome === 'handedOff' ? 1 : 0 });
		expect(await redis.zcard(queuedKey)).toBe(outcome === 'handedOff' ? 1 : 0);
		expect(await gpuQueue.pending('noteJudge')).toBe(outcome === 'handedOff' ? 1 : 0);
		// ジョブはモデルを動かさない。実行の記録を作るのは「GPU なし」で飛ばしたときだけ。
		expect(runs.insert).toHaveBeenCalledTimes(outcome === 'noGpu' ? 1 : 0);
		expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "hanami_foryou_model_run"'))).toBe(false);
	});
	test('the handler closes interrupted runs before recording its own, with the exact ten-minute boundary', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const { service, query, runs } = batch();
		await service.handleNoteJudged([{ itemId: '1:n1', payload: { noteId: 'n1', promptVersion: 1 }, enqueuedAt: now - 1000, attempts: 0 }], new Map(), new Map(), 0);
		const [sql, parameters] = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "hanami_foryou_model_run"'))!;
		expect(sql).toContain('WHERE kind = \'note-judge\' AND status = \'pending\' AND "startedAt" < $2');
		expect(sql).toContain('COALESCE(params, \'{}\'::jsonb) || \'{"interrupted":true}\'::jsonb');
		expect(sql).toContain('"finishedAt" = $1');
		expect((parameters![0] as Date).getTime() - (parameters![1] as Date).getTime()).toBe(10 * 60_000);
		expect(query.mock.invocationCallOrder[query.mock.calls.findIndex(([sql]) => sql.startsWith('UPDATE'))]).toBeLessThan(runs.insert.mock.invocationCallOrder[0]);
	});
	test.skipIf(!process.env.HANAMI_ADMIN_TEST_DATABASE_URL)('only older pending note runs are interrupted, preserving params and the exact ten-minute boundary', async () => {
		const client = new Client({ connectionString: process.env.HANAMI_ADMIN_TEST_DATABASE_URL });
		try {
			await client.connect();
			await client.query('CREATE TEMP TABLE hanami_foryou_model_run (id text, kind text, status text, "startedAt" timestamptz, "finishedAt" timestamptz, params jsonb)');
			const cutoff = now - 10 * 60_000;
			for (const [id, kind, status, at] of [
				['old', 'note-judge', 'pending', cutoff - 1], ['boundary', 'note-judge', 'pending', cutoff],
				['recent', 'note-judge', 'pending', cutoff + 1], ['ready', 'note-judge', 'ready', cutoff - 1],
				['failed', 'note-judge', 'failed', cutoff - 1], ['als', 'als', 'pending', cutoff - 1],
			] as const) await client.query('INSERT INTO hanami_foryou_model_run VALUES ($1, $2, $3, $4, NULL, $5)', [id, kind, status, new Date(at), { model: 'preserved' }]);
			vi.spyOn(Date, 'now').mockReturnValue(now);
			const { service, query } = batch();
			query.mockImplementation(async (sql, parameters) => {
				if (sql.startsWith('UPDATE "hanami_foryou_model_run"')) return (await client.query(sql, parameters)).rows;
				return sql.includes('AS settings') ? [{ settings }] : [];
			});
			await service.handleNoteJudged([{ itemId: '1:n1', payload: { noteId: 'n1', promptVersion: 1 }, enqueuedAt: now - 1000, attempts: 0 }], new Map(), new Map(), 0);
			const rows = (await client.query('SELECT * FROM hanami_foryou_model_run ORDER BY id')).rows;
			expect(rows.find(row => row.id === 'old')).toMatchObject({ status: 'failed', finishedAt: new Date(now), params: { model: 'preserved', interrupted: true } });
			for (const row of rows.filter(row => row.id !== 'old')) {
				expect(row.finishedAt).toBeNull();
				expect(row.params).toEqual({ model: 'preserved' });
				expect(row.status).toBe(row.id === 'ready' || row.id === 'failed' ? row.id : 'pending');
			}
		} finally { await client.end(); }
	});
	test('a handed-off note is judged through the real queue: the handler saves it and only then frees the reservation', async () => {
		const { service, query, gpuQueue } = batch([{ id: 'n1', text: '役立つ運用情報です。', hasFiles: false, isBot: false, isReply: false }]);
		await service.reserveNoteJudgeNotes(['n1']);
		await expect(service.runNoteJudgeJob({ noteIds: ['n1'], promptVersion: 1 }, log as never)).resolves.toMatchObject({ status: 'ready', queuedCount: 1 });
		// 同じ投稿をもう一度頼んでも、順番待ちには 1 件だけ。
		await expect(service.runNoteJudgeJob({ noteIds: ['n1'], promptVersion: 1 }, log as never)).resolves.toMatchObject({ queuedCount: 0 });
		expect(await gpuQueue.pending('noteJudge')).toBe(1);
		expect(await redis.zcard(queuedKey)).toBe(1);

		// 配り役の代わりに取り出して、判定係の返事を受け取り係に渡す。
		const items = await gpuQueue.take('noteJudge', 8);
		expect(items).toEqual([expect.objectContaining({ itemId: '1:n1', payload: expect.objectContaining({ noteId: 'n1', promptVersion: 1, cleanedText: '役立つ運用情報です。', settings: { basis: settings.basis, examples: settings.examples } }) })]);
		const results = new Map<string, HanamiNoteJudgeGpuOutput>([['1:n1', { noteId: 'n1', ephemeralScore: 0.1, interest: 4, interestDist: [0, 0, 0, 1, 0], contentType: 2 }]]);
		await service.handleNoteJudged(items, results, new Map(), 500);
		await gpuQueue.complete('noteJudge', items.map(item => item.itemId));

		const upsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))!;
		expect(upsert[1]).toEqual(['n1', 'Qwen/Qwen3-4B-Instruct-2507', 1, 0.1, 4, [0, 0, 0, 1, 0], 2]);
		expect(await redis.zcard(queuedKey)).toBe(0);
		expect(await gpuQueue.pending('noteJudge')).toBe(0);
		expect((await events()).filter(row => row.job === 'noteJudge').map(row => row.event)).toEqual(expect.arrayContaining(['dispatched', 'finished']));
	});
});

describe('topic judge history and admin status', () => {
	test.each(['ok', 'partial', 'noGpu', 'nothingToDo', 'waiting', 'gaveUp', 'rejected', 'failed'] as const)('stores %s for seven days, truncates errors, and retains last success', async outcome => {
		const { service } = batch();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		await service.recordTrendTopicJudgeResult(topicData, 'ok');
		vi.setSystemTime(now + 60_000);
		await service.recordTrendTopicJudgeResult(topicData, outcome, { error: 'あ'.repeat(301), waitedMs: 60_000 });
		const record = await lastResult();
		expect(record).toEqual({
			at: new Date(now + 60_000).toISOString(), outcome, requested: { daily: 2, pairs: 1, titles: 1 }, saved: { daily: 0, same: 0, titles: 0 },
			rejectedTitles: 0, waitedMs: 60_000, error: 'あ'.repeat(300),
			lastSuccessAt: new Date(outcome === 'ok' || outcome === 'partial' || outcome === 'nothingToDo' ? now + 60_000 : now).toISOString(),
		});
		expect(await redis.ttl(HANAMI_TREND_TOPIC_JUDGE_LAST_KEY)).toBe(7 * 86400);
		const endpoint = new JudgeStatusEndpoint({ query: async () => [] } as never, redis);
		expect(await endpoint.exec({}, { id: 'admin' } as never, null)).toMatchObject({ trendTopicJudge: record });
		expect(statusMeta.res.properties.trendTopicJudge.properties.outcome.enum).toContain(outcome);
	});
	test('initial status is null; invalid payload is recorded and still rejected by Bull', async () => {
		const { service } = batch();
		expect(await new JudgeStatusEndpoint({ query: async () => [] } as never, redis).exec({}, { id: 'admin' } as never, null)).toMatchObject({ trendTopicJudge: null });
		await expect(processor(service).processTrendTopicJudge(topicJob(null) as never)).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		expect(await lastResult()).toMatchObject({ outcome: 'rejected', requested: { daily: 0, pairs: 0, titles: 0 }, lastSuccessAt: null, error: expect.stringContaining('Invalid payload') });
	});
	test('a busy GPU lock no longer delays the job: it is handed to the queue and reported as waiting', async () => {
		const { service, gpuQueue } = batch();
		await redis.set(HANAMI_LOCAL_LLM_LOCK_KEY, 'gpuWorker:1:1:token');
		const job = topicJob();
		await processor(service).processTrendTopicJudge(job as never);
		expect(job.moveToDelayed).not.toHaveBeenCalled();
		expect(await lastResult()).toMatchObject({ outcome: 'waiting', requested: { daily: 2, pairs: 1, titles: 1 } });
		expect(await gpuQueue.pending('topicJudge')).toBe(1);
		// 前の回が待っている間は、次の回を重ねて入れない。
		await processor(service).processTrendTopicJudge(topicJob() as never);
		expect(await gpuQueue.pending('topicJudge')).toBe(1);
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBe('gpuWorker:1:1:token');
		expect(await redis.exists('hanami:llm:wanted:topicJudge', 'hanami:llm:topic-judge-waiting:v1')).toBe(0);
	});
	test('records noGpu and cached/empty work without starting Python', async () => {
		const { service } = batch();
		runtime.mockReturnValue({ available: false, device: 'cuda' });
		await service.runTrendTopicJudgeJob(topicData, log as never);
		expect(await lastResult()).toMatchObject({ outcome: 'noGpu' });
		runtime.mockReturnValue({ available: true, device: 'cuda' });
		await service.runTrendTopicJudgeJob({ topics: [], dailyIds: [], pairs: [] }, log as never);
		expect(await lastResult()).toMatchObject({ outcome: 'nothingToDo', requested: { daily: 0, pairs: 0, titles: 0 } });
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBeNull();
	});
	test.each(['ok', 'partial', 'failed', 'invalidTitle'] as const)('the handler records the worker\'s %s results and saved/rejected counts', async mode => {
		const output: HanamiTrendTopicJudgeGpuOutput = {
			status: mode === 'failed' ? 'partial' : 'ok', error: mode === 'failed' ? 'model failed' : undefined,
			judgements: mode === 'failed' ? [] : [
				{ kind: 'daily', topicId: 'a', probability: 0.1 },
				...(mode === 'partial' ? [] : [{ kind: 'daily' as const, topicId: 'b', probability: 0.7 }, { kind: 'same' as const, a: 'a', b: 'b', probability: 0.8 }]),
			],
			titles: mode === 'failed' ? [] : [{ topicId: 'a', title: mode === 'invalidTitle' ? '' : 'パン屋' }],
		};
		const { service, gpuQueue } = batch();
		await service.runTrendTopicJudgeJob(topicData, log as never, 'topic-job');
		expect(await lastResult()).toMatchObject({ outcome: 'waiting' });
		const items = await gpuQueue.take('topicJudge', 1);
		expect(items).toHaveLength(1);
		await service.handleTrendTopicJudged(items, new Map([[items[0].itemId, output]]), new Map(), 1500);
		const record = await lastResult();
		expect(record.outcome).toBe(mode === 'invalidTitle' ? 'partial' : mode);
		expect(record.requested).toEqual({ daily: 2, pairs: 1, titles: 1 });
		expect(record.saved).toEqual(mode === 'failed' ? { daily: 0, same: 0, titles: 0 } : { daily: mode === 'partial' ? 1 : 2, same: mode === 'partial' ? 0 : 1, titles: mode === 'invalidTitle' ? 0 : 1 });
		expect(record.rejectedTitles).toBe(mode === 'invalidTitle' ? 1 : 0);
		expect(record.lastSuccessAt).toBe(mode === 'failed' ? null : record.at);
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBeNull();
		expect((await events()).filter(row => row.job === 'topicJudge').map(row => [row.event, row.jobId])).toEqual(expect.arrayContaining([['dispatched', 'topic-job'], [mode === 'failed' ? 'failed' : 'finished', 'topic-job']]));
	});
});

describe('LLM event history', () => {
	test('records repeated contention at most once per job family and event within the throttle window', async () => {
		await recordHanamiLlmEvent(redis, { job: 'noteJudge', event: 'waiting', jobId: '1', throttleMs: 200 });
		await recordHanamiLlmEvent(redis, { job: 'noteJudge', event: 'waiting', jobId: '2', throttleMs: 200 });
		await recordHanamiLlmEvent(redis, { job: 'noteJudge', event: 'lockBusy', jobId: '3', throttleMs: 200 });
		await recordHanamiLlmEvent(redis, { job: 'topicJudge', event: 'waiting', jobId: '4', throttleMs: 200 });
		await recordHanamiLlmEvent(redis, { job: 'noteJudge', event: 'finished', jobId: '5' });
		expect((await events()).map(row => row.jobId)).toEqual(['5', '4', '3', '1']);
		await new Promise(resolve => setTimeout(resolve, 250));
		await recordHanamiLlmEvent(redis, { job: 'noteJudge', event: 'waiting', jobId: '6', throttleMs: 200 });
		expect((await events())[0].jobId).toBe('6');
	});
	test('retains newest 2000 events for seven days and bounds Unicode error text', async () => {
		for (let n = 0; n < 2003; n++) await recordHanamiLlmEvent(redis, { job: 'generation', event: 'dispatched', jobId: String(n), counts: { jobs: 1, notes: n } });
		let rows = await events();
		expect(rows).toHaveLength(2000);
		expect(rows[0].jobId).toBe('2002');
		expect(rows[1999].jobId).toBe('3');
		expect(await redis.ttl(HANAMI_LLM_EVENTS_KEY)).toBeGreaterThanOrEqual(7 * 86400 - 1);
		await recordHanamiLlmEvent(redis, { job: 'topicJudge', event: 'failed', durationMs: 12.6, error: Object.assign(new TypeError('先頭' + '🌸'.repeat(600)), { stderr: '古いログ' + '🌸'.repeat(1100) + '末尾' }) });
		rows = await events();
		expect(rows[0]).toMatchObject({ job: 'topicJudge', event: 'failed', durationMs: 13, error: { name: 'TypeError', message: '先頭' + '🌸'.repeat(498), stderrTail: '🌸'.repeat(998) + '末尾' } });
		expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at);
	});
	test('records ownership, contention and release only once; successful renewals stay silent', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		vi.setSystemTime(now);
		const lease = await acquireHanamiLocalLlmLock(redis, 'judgeTrial', { jobId: 'j' });
		expect(lease!.token).toMatch(new RegExp(`^judgeTrial:${now}:\\d+:.+$`));
		await acquireHanamiLocalLlmLock(redis, 'als');
		await vi.advanceTimersByTimeAsync(30000); await redis.ping();
		await lease!.release(); await lease!.release();
		expect((await events()).map(row => row.event)).toEqual(['lockReleased', 'lockBusy', 'lockAcquired']);
		expect((await events())[0]).toMatchObject({ job: 'judgeTrial', jobId: 'j', durationMs: 30000 });
	});
	test.each(['processGeneration', 'processTick', 'processReconcile', 'processNoteJudge', 'processTrendTopicJudge'] as const)('retains malformedPayload rejections from %s', async method => {
		const { service } = batch();
		await expect(processor(service)[method]({ name: method, id: 'bad-job', data: null } as never)).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		expect(await events()).toEqual([expect.objectContaining({ event: 'rejected', jobId: 'bad-job', error: expect.objectContaining({ message: expect.stringContaining('Invalid payload') }) })]);
	});
	test.each(['chunk', 'ingest'])('retains swallowed taste %s errors without changing batch continuation', async failureAt => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('SELECT u.id AS id')) return [{ id: 'u', username: 'u', name: null }];
			if (sql.includes('GROUP BY 1 HAVING')) return [{ id: 'u', c: 100 }];
			if (sql.includes('SELECT "noteId", vector, src')) return Array.from({ length: 100 }, (_, n) => ({ noteId: `n${n}`, vector: Buffer.alloc(2), src: 'R' }));
			return [];
		});
		const service = new HanamiTasteClusterBatchService({ query } as never, redis, { gen: () => 'id' } as never, {} as never);
		const internal = service as unknown as { appendEvidence: () => Promise<void>; updateMeanVec: () => Promise<number[]>; clusterUserChunk: () => Promise<number>; ingestUserClusters: () => Promise<void> };
		internal.appendEvidence = vi.fn(async () => undefined);
		internal.updateMeanVec = vi.fn(async () => [0]);
		const error = Object.assign(new Error(`${failureAt} failed`), { stderr: 'taste stderr' });
		if (failureAt === 'chunk') internal.clusterUserChunk = vi.fn(async () => { throw error; });
		else {
			internal.ingestUserClusters = vi.fn(async () => { throw error; });
			const script = join(directory, 'taste.py');
			await writeFile(script, 'import json,sys\njson.dump({"users":[{"userId":"u"}]},open(sys.argv[3],"w"))\n');
			vi.stubEnv('HANAMI_TASTE_KMEANS_SCRIPT', script);
		}
		await expect(service.runTasteClusterBatch(log as never)).resolves.toEqual({ users: 0 });
		expect((await events()).filter(row => row.event === 'failed')).toEqual([expect.objectContaining({ job: 'tasteTick', error: { name: 'Error', message: `${failureAt} failed`, stderrTail: 'taste stderr' } })]);
		expect(await redis.get(HANAMI_LOCAL_LLM_LOCK_KEY)).toBeNull();
	});
	test('records the worker error for a topic job that returned nothing', async () => {
		const { service, gpuQueue } = batch();
		await service.runTrendTopicJudgeJob(topicData, log as never, 'topic-job');
		const items = await gpuQueue.take('topicJudge', 1);
		await service.handleTrendTopicJudged(items, new Map(), new Map([[items[0].itemId, 'RuntimeError: topic judge crashed']]), null);
		const failed = (await events()).filter(row => row.event === 'failed');
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ job: 'topicJudge', jobId: 'topic-job', error: { message: expect.stringContaining('topic judge crashed') } });
	});
});
