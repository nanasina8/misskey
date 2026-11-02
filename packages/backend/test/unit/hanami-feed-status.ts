/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, test, vi as jest } from 'vitest';
import FeedStatusEndpoint, { meta } from '@/server/api/endpoints/admin/hanami/feed-status.js';
import type { SchemaType } from '@/misc/json-schema.js';
import { HANAMI_FEED_DAILY_KEY_PREFIX, HANAMI_FEED_EVENTS_KEY } from '@/core/hanami/HanamiFeedStockEvents.js';

const admin = { id: 'admin' } as never;

function fixture(options: { checkRows?: Array<{ sql: string; rows: unknown[] }>; failingCheck?: string; counts?: Record<string, string>; userRow?: unknown[] } = {}) {
	const query = jest.fn(async (sql: string): Promise<unknown[]> => {
		if (options.failingCheck != null && sql.includes(options.failingCheck)) throw new Error('relation "hanami_metrics_timeline" does not exist');
		for (const entry of options.checkRows ?? []) {
			if (sql.includes(entry.sql)) return entry.rows;
		}
		if (options.userRow != null && sql.includes('FROM "hanami_user_feed_state" s WHERE s."userId" = $1')) return options.userRow;
		return [];
	});
	const hgetall = jest.fn(async () => ({ ...(options.counts ?? {}) }));
	const redis = {
		hgetall,
		lrange: jest.fn(async () => [] as string[]),
		ttl: jest.fn(async () => -2),
	};
	const config = { hanamiGenerationSyncWaitMs: 8000 } as never;
	const endpoint = new FeedStatusEndpoint({ query } as never, redis as never, config);
	return {
		endpoint, query, hgetall,
		read: (params: Record<string, unknown> = {}): Promise<SchemaType<typeof meta.res>> => endpoint.exec(params, admin, null),
	};
}

describe('admin/hanami/feed-status', () => {
	test('is an admin queue read endpoint with descriptions on every response field', () => {
		expect(meta).toMatchObject({ requireCredential: true, requireAdmin: true, kind: 'read:admin:queue' });
		const visit = (schema: Record<string, unknown>) => {
			expect(schema.description).toEqual(expect.any(String));
			for (const child of Object.values(schema.properties ?? {})) visit(child as Record<string, unknown>);
			for (const key of ['items', 'additionalProperties']) if (typeof schema[key] === 'object') visit(schema[key] as Record<string, unknown>);
		};
		visit(meta.res);
	});

	test('reports a healthy empty snapshot with all checks ok and no issues', async () => {
		const f = fixture();
		const result = await f.read();
		expect(result.config).toMatchObject({ stockMaxAgeMinutes: 180, stockRefreshAfterMinutes: 60, sessionGapMinutes: 30, prewarmIntervalMinutes: 30, activeDays: 7, initialSyncWaitMs: 8000 });
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.user).toBeNull();
	});

	test('computes stockHitRate exactly from the fake Redis daily counts', async () => {
		const f = fixture({ counts: { 'open.stock': '80', 'open.pending': '20', 'refresh.stock': '0', 'refresh.pending': '0' } });
		const result = await f.read();
		expect(result.requests.day.stockHitRate).toBeCloseTo(0.8);
		expect(result.requests.day.counts['open.stock']).toBe(80);
		expect(result.requests.week.stockHitRate).toBeCloseTo(0.8);
	});

	test('surfaces an I1 violation and a stalePending as checks and issues', async () => {
		const f = fixture({
			checkRows: [
				{ sql: 'e."sequence" > s."latestSequence" AND e."batchId" IS DISTINCT FROM s."stockBatchId"', rows: [{ user_id: 'u1', batch_id: 'b1', total: '1' }] },
				{ sql: 'b."status" = \'pending\' AND b."availableAt" <', rows: [{ user_id: 'u2', batch_id: 'b2', total: '1' }] },
			],
		});
		const result = await f.read();
		const entry = result.checks.find((check) => check.code === 'entryAboveHeadNotStock')!;
		const stale = result.checks.find((check) => check.code === 'stalePending')!;
		expect(entry.ok).toBe(false);
		expect(entry.count).toBe(1);
		expect(stale.ok).toBe(false);
		expect(entry.samples[0]).toEqual({ userId: 'u1', batchId: 'b1', detail: expect.any(String) });
		expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['entryAboveHeadNotStock', 'stalePending']));
		expect(result.issues.find((issue) => issue.code === 'entryAboveHeadNotStock')!.level).toBe('error');
		expect(result.issues.find((issue) => issue.code === 'stalePending')!.level).toBe('warning');
	});

	test('counts every violation instead of capping the count at the five samples', async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({ user_id: `u${i}`, batch_id: `b${i}`, total: '7' }));
		const f = fixture({ checkRows: [{ sql: 'b."status" = \'generating\' AND b."leaseExpiresAt" <= clock_timestamp() - INTERVAL', rows }] });
		const result = await f.read();
		const lease = result.checks.find((check) => check.code === 'expiredLease')!;
		expect(lease).toMatchObject({ ok: false, count: 7, error: null });
		expect(lease.samples).toHaveLength(5);
		expect(result.issues.find((issue) => issue.code === 'expiredLease')).toMatchObject({ level: 'warning', count: 7 });
	});

	test('reports a check that could not run as failed, never as ok', async () => {
		const f = fixture({ failingCheck: 'FROM "hanami_metrics_timeline" t' });
		const result = await f.read();
		const check = result.checks.find((c) => c.code === 'activeUserWithoutStock')!;
		expect(check.ok).toBe(false);
		expect(check.error).toContain('hanami_metrics_timeline');
		expect(result.issues).toContainEqual(expect.objectContaining({ level: 'error', code: 'checkFailed' }));
	});

	test('pendingRate counts each request once and ignores rate-limited, expired and repeated tokens', async () => {
		const f = fixture({ counts: {
			'open.stock': '6', 'open.pending': '1', 'refresh.stock': '2', 'refresh.pending': '1', 'tuning.pending': '2',
			'refresh.rateLimited': '5', 'refresh.expired': '5', 'refresh.repeat': '5', 'open.head': '50',
		} });
		const result = await f.read();
		expect(result.requests.day.pendingRate).toBeCloseTo(4 / 12);
		expect(result.requests.day.stockHitRate).toBeCloseTo(8 / 10);
	});

	test('warns about generation failures only with at least 10 publications in 7 days', async () => {
		// 偽の Redis は 7 日すべてに同じ数を返すので、週の合計は 7 倍になる。
		const few = await fixture({ counts: { 'publish.failed': '1' } }).read();
		expect(few.issues.map((issue) => issue.code)).not.toContain('generationFailures');
		const many = await fixture({ counts: { 'publish.failed': '1', 'publish.head': '1' } }).read();
		expect(many.issues).toContainEqual(expect.objectContaining({ level: 'warning', code: 'generationFailures', count: 7 }));
	});

	test('fills the user detail when userId is given', async () => {
		const f = fixture({
			userRow: [{
				user_id: 'u1', epoch_id: 'e1', mode: 'personalized', initial_state: 'ready',
				latest_ready_batch_id: 'h1', generating_batch_id: null, stock_batch_id: null,
				stock_sequence: null, latest_sequence: '1', updated_at: '2026-11-02T00:00:00Z',
			}],
		});
		const result = await f.read({ userId: 'u1' });
		expect(result.user).toMatchObject({ state: { mode: 'personalized', epochId: 'e1', latestReadyBatchId: 'h1' } });
	});
});

describe('admin/hanami/feed-status key shape', () => {
	test('uses the documented Redis keys', () => {
		expect(HANAMI_FEED_DAILY_KEY_PREFIX).toBe('hanami:feed:daily:');
		expect(HANAMI_FEED_EVENTS_KEY).toBe('hanami:feed:events:v1');
	});
});
