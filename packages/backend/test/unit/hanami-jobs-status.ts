/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import JobsStatusEndpoint, { meta } from '@/server/api/endpoints/admin/hanami/jobs-status.js';
import type { SchemaType } from '@/misc/json-schema.js';
import { QueueService } from '@/core/QueueService.js';

const judge = vi.hoisted(() => vi.fn());
vi.mock('@/server/api/endpoints/admin/hanami/judge-status.js', () => ({ getHanamiJudgeStatus: judge }));
const now = Date.parse('2026-10-29T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const admin = { id: 'admin' } as never;
const status = () => ({ runtime: { available: true, device: 'cuda', deviceName: 'Test GPU', reason: null, probedAt: iso(now) }, backlog: 12, secPerNote: 2.5,
																								trendTopicJudge: { at: iso(now), outcome: 'ok', requested: { daily: 2, pairs: 1, titles: 1 }, saved: { daily: 2, same: 1, titles: 1 }, rejectedTitles: 0, lastSuccessAt: iso(now) } });

function fixture() {
	const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []);
	const redis = { eval: vi.fn(async () => [null, -2]), get: vi.fn(async () => null as string | null), lrange: vi.fn(async () => [] as string[]) };
	const queue = { getHanamiJobsStatus: vi.fn(async () => ({ jobs: [{ name: 'hanamiNoteJudge', active: 0, wait: 0, delayed: 0, failed: 0, oldestWaitingAt: null }], truncated: false })) };
	const endpoint = new JobsStatusEndpoint({ query } as never, redis as never, queue as never);
	return { query, redis, queue, endpoint, read: (params = {}): Promise<SchemaType<typeof meta.res>> => endpoint.exec(params, admin, null) };
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); judge.mockResolvedValue(status()); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Hanami jobs diagnostics', () => {
	test('is an admin queue read endpoint with descriptions and fixed machine-readable codes', () => {
		expect(meta).toMatchObject({ requireCredential: true, requireAdmin: true, kind: 'read:admin:queue' });
		const visit = (schema: Record<string, unknown>) => {
			expect(schema.description).toEqual(expect.any(String));
			for (const child of Object.values(schema.properties ?? {})) visit(child as Record<string, unknown>);
			for (const key of ['items', 'additionalProperties']) if (typeof schema[key] === 'object') visit(schema[key] as Record<string, unknown>);
		};
		visit(meta.res);
		expect(meta.res.properties.warnings.items.enum).toHaveLength(6);
		expect(meta.res.properties.topicJudge.properties.outcome.enum).toHaveLength(8);
		expect(meta.res.properties.events.items.properties.event.enum).toContain('rejected');
	});
	test('returns a healthy empty snapshot and the same judge inventory/runtime', async () => {
		const f = fixture();
		expect(await f.read()).toMatchObject({ gpu: status().runtime, noteJudge: { backlog: 12, secPerNote: 2.5 }, lock: { held: false, kind: null, acquiredAt: null, expiresInMs: null }, warnings: [], topicJudgeWaiting: false });
		expect(f.redis.eval).toHaveBeenCalledWith(expect.stringContaining('pttl'), 1, 'hanami:llm:exclusive:v1');
	});
	test.each(['noteJudge', 'topicJudge', 'als', 'tasteTick', 'judgeTrial'])('reads %s lock metadata and waiting marker', async kind => {
		const f = fixture();
		f.redis.eval.mockResolvedValue([`${kind}:${now - 1000}:123:nonce`, 89000] as never);
		f.redis.get.mockResolvedValue('1');
		expect(await f.read()).toMatchObject({ lock: { held: true, kind, acquiredAt: iso(now - 1000), expiresInMs: 89000 }, topicJudgeWaiting: true });
	});
	test.each(['old-uuid-token', 'other:1:123:nonce', 'noteJudge:NaN:123:nonce', `noteJudge:${now + 1}:123:nonce`, 'noteJudge:1:pid:nonce'])('keeps unreadable owner held: %s', async token => {
		const f = fixture();
		f.redis.eval.mockResolvedValue([token, -1] as never);
		expect(await f.read()).toMatchObject({ lock: { held: true, kind: null, acquiredAt: null, expiresInMs: null }, warnings: [] });
	});
	test.each([-1, 0, 1])('lock and topic warning boundaries offset %i ms', async offset => {
		const f = fixture();
		f.redis.eval.mockResolvedValue([`noteJudge:${now - 600000 + offset}:123:nonce`, 90000] as never);
		const input = status(); input.trendTopicJudge.lastSuccessAt = iso(now - 2400000 + offset); judge.mockResolvedValue(input);
		expect((await f.read()).warnings).toEqual(offset < 0 ? ['lockLong', 'topicJudgeStale'] : []);
	});
	test.each([{ available: false, device: null }, { available: true, device: 'cpu' }, { available: true, device: 'cuda' }])('missing topic success respects GPU probe %o', async runtime => {
		judge.mockResolvedValue({ ...status(), runtime: { ...status().runtime, ...runtime }, trendTopicJudge: null });
		expect((await fixture().read()).warnings).toEqual(runtime.device === 'cuda' ? ['topicJudgeStale'] : ['gpuUnavailable']);
	});
	test.each([29, 30, 31])('delayed warning boundary %i', async delayed => {
		const f = fixture(); f.queue.getHanamiJobsStatus.mockResolvedValue({ jobs: [{ name: 'hanamiNoteJudge', active: 100, wait: 100, delayed, failed: 0, oldestWaitingAt: null }], truncated: false });
		expect((await f.read()).warnings).toEqual(delayed >= 30 ? ['queueBacklog'] : []);
	});
	test('filters before limiting, defaults to 50, caps at 500, and ignores malformed events', async () => {
		const f = fixture();
		f.redis.lrange.mockResolvedValue(['{broken', 'null', ...Array.from({ length: 110 }, (_, n) => JSON.stringify({ at: iso(now - n), job: n % 2 ? 'noteJudge' : 'als', event: 'finished', counts: { processed: n } }))]);
		expect((await f.read()).events).toHaveLength(50);
		const result = await f.read({ eventsLimit: 30, eventJobs: ['noteJudge'] });
		expect(result.events).toHaveLength(30);
		expect(result.events.every(event => event.job === 'noteJudge')).toBe(true);
		expect(result.events[29].counts).toEqual({ processed: 59 });
		expect((await f.read({ eventsLimit: 500, eventJobs: [] })).events).toEqual([]);
		await expect(f.read({ eventsLimit: 501 })).rejects.toThrow();
		await expect(f.read({ eventJobs: ['unknown'] })).rejects.toThrow();
	});
});

describe('bounded queue sampling', () => {
	test.each([499, 500, 501])('counts by name/state and detects the cap at %i', async size => {
		const item = (name: string, offset: number) => ({ name, timestamp: now + offset });
		const getJobs = vi.fn(async ([state]: string[]) => state === 'active' ? Array.from({ length: size }, () => item('hanamiNoteJudge', -100))
			: state === 'wait' ? [item('hanamiNoteJudge', -200), item('other', -10)]
			: state === 'delayed' ? [item('hanamiNoteJudge', -300), item('hanamiTrendTopicJudge', -20)] : [item('hanamiNoteJudge', -999)]);
		const service = Object.create(QueueService.prototype) as QueueService;
		Object.defineProperty(service, 'getHanamiGenerationQueue', { value: () => ({ getJobs }) });
		const result = await service.getHanamiJobsStatus();
		expect(result.truncated).toBe(size > 500);
		expect(result.jobs.find(row => row.name === 'hanamiNoteJudge')).toEqual({ name: 'hanamiNoteJudge', active: Math.min(500, size), wait: 1, delayed: 1, failed: 1, oldestWaitingAt: iso(now - 300) });
		expect(result.jobs.find(row => row.name === 'other')).toMatchObject({ wait: 1, oldestWaitingAt: iso(now - 10) });
		for (const state of ['active', 'wait', 'delayed', 'failed']) expect(getJobs).toHaveBeenCalledWith([state], 0, 500, true);
	});
});

describe.skipIf(!process.env.HANAMI_ADMIN_TEST_DATABASE_URL)('model-run SQL against isolated PostgreSQL temp table', () => {
	let client: Client;
	beforeEach(async () => { client = new Client({ connectionString: process.env.HANAMI_ADMIN_TEST_DATABASE_URL }); await client.connect(); await client.query('CREATE TEMP TABLE hanami_foryou_model_run (id text, kind text, status text, "startedAt" timestamptz, "finishedAt" timestamptz, params jsonb)'); });
	afterEach(async () => { await client.end(); });

	async function insert(id: string, kind: string, status: string, at: number, params: Record<string, unknown>, finishedAt: number | null = at) {
		await client.query('INSERT INTO hanami_foryou_model_run VALUES ($1,$2,$3,$4,$5,$6)', [id, kind, status, new Date(at), finishedAt == null ? null : new Date(finishedAt), params]);
	}

	function read() { const f = fixture(); f.query.mockImplementation(async (sql, params) => (await client.query(sql, params)).rows); return f.read(); }

	test('latestWork survives empty latest; counts overlap, exclude old runs, and include the exact 24-hour boundary', async () => {
		await insert('work', 'note-judge', 'ready', now - 120000, { processedCount: 7 });
		await insert('empty', 'note-judge', 'ready', now - 1000, { processedCount: 0, skippedReason: 'alreadyJudged' });
		await insert('failure', 'note-judge', 'failed', now - 2000, { failure: 'あ'.repeat(250), interrupted: true });
		await insert('boundary', 'note-judge', 'ready', now - 86400000, { processedCount: 0 });
		await insert('old', 'note-judge', 'ready', now - 86400001, { processedCount: 0 });
		await insert('string', 'als', 'ready', now, { processedCount: '99' });
		const result = await read();
		expect(result.runs.find(run => run.kind === 'note-judge')).toMatchObject({ latest: { startedAt: iso(now - 1000), processedCount: 0, skippedReason: 'alreadyJudged' }, latestWork: { processedCount: 7 }, last24h: { ready: 3, failed: 1, interrupted: 1, empty: 2 } });
		expect(result.runs.find(run => run.kind === 'als')).toMatchObject({ latestWork: null });
		expect(result.runs.find(run => run.kind === 'embedding')).toMatchObject({ latest: null, latestWork: null, last24h: { ready: 0, failed: 0, interrupted: 0, empty: 0 } });
		expect(result.recentFailures[0].failure).toBe('あ'.repeat(200));
	});
	test.each([-1, 0, 1])('failure/pending warning boundaries offset %i ms', async offset => {
		await insert('fail', 'als', 'failed', now - 3600000 + offset, { failure: 'test' });
		await insert('pending', 'embedding', 'pending', now - 600000 + offset, {}, null);
		expect((await read()).warnings).toEqual([...(offset >= 0 ? ['recentFailures'] : []), ...(offset < 0 ? ['stuckPending'] : [])]);
	});
	test('returns only the ten newest failures and uses completion time for the time window', async () => {
		for (let n = 0; n < 12; n++) await insert(String(n), 'note-judge', 'failed', now - 2 * 86400000, { failure: String(n) }, now - n * 1000);
		await insert('old', 'als', 'failed', now - 86400001, { failure: 'old' });
		const result = await read();
		expect(result.recentFailures.map(row => row.failure)).toEqual(Array.from({ length: 10 }, (_, n) => String(n)));
		expect(result.warnings).toContain('recentFailures');
	});
});
