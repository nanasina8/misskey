/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { HanamiMetricsRollupService } from '@/core/hanami/HanamiMetricsRollupService.js';
import { METRICS_COHORT_CTE, METRICS_NORMAL_SQL, metricsCohortSql, metricsGenerationSql, rangeParameters } from '@/core/hanami/HanamiMetricsContracts.js';
import type { DataSource, EntityManager } from 'typeorm';

type Stored = { users: number; served: number; extra: object };

function mockDatabase() {
	const stored = new Map<string, Stored>();
	let dimensionRows = [{ key: 'small', users: 2, served: 4, seen: 1, reaction: 1, reply: 1, renote: 0 }];
	const query = jest.fn(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
		const prefix = params.slice(0, 3).join('/');
		if (sql.startsWith('SELECT pg_advisory')) return [];
		if (sql.startsWith('SELECT EXISTS')) return [{ exists: [...stored.keys()].some(key => key.startsWith(`${prefix}/`)) }];
		if (sql.startsWith('DELETE')) {
			for (const key of stored.keys()) if (key.startsWith(`${prefix}/`) && !(params[3] as string[]).includes(key.slice(prefix.length + 1))) stored.delete(key);
			return [];
		}
		if (sql.startsWith('INSERT')) {
			expect(sql).toContain('ON CONFLICT (day,scope,dimension,key) DO UPDATE');
			stored.set(`${prefix}/${String(params[3])}`, { users: Number(params[4]), served: Number(params[5]), extra: JSON.parse(String(params[10])) as object });
			return [];
		}
		if (sql.includes('top_terms AS')) return dimensionRows;
		if (sql.startsWith('WITH cohort')) return [{ ...dimensionRows[0], key: 'total' }];
		if (sql.startsWith('WITH normal')) return [{ key: 'normal', users: 2, served: 0, seen: 0, reaction: 2, reply: 0, renote: 0 }];
		if (sql.startsWith('WITH runs')) return [];
		if (sql.includes('FROM hanami_metrics_refresh')) return [{ users: 2, refreshes: 3, refreshUsers: 2 }];
		if (sql.includes('FROM hanami_metrics_diagnostic')) return [];
		if (sql.includes('FROM hanami_metrics_daily')) return [];
		if (sql.includes('FROM hanami_metrics_timeline')) return [];
		throw new Error(`Unexpected mock SQL: ${sql}`);
	});
	const manager = { query } as unknown as EntityManager;
	const transaction = jest.fn(async (callback: (manager: EntityManager) => Promise<void>) => callback(manager));
	return { db: { transaction } as unknown as DataSource, query, transaction, stored, setRows: (rows: typeof dimensionRows) => { dimensionRows = rows; } };
}

afterEach(() => { jest.useRealTimers(); });

describe('Hanami metrics cohort SQL contract', () => {
	test('served createdAt defines JST cohort and outcome attribution includes exactly day fourteen', () => {
		expect(METRICS_COHORT_CTE).toContain('s."createdAt" >= $1::timestamptz');
		expect(METRICS_COHORT_CTE).not.toContain('COALESCE(s."occurredAt"');
		expect(METRICS_COHORT_CTE).toContain('COALESCE(e."occurredAt", e."createdAt") >= s."createdAt"');
		// Elapsed hours avoid database-session DST changing the fourteen-day boundary.
		expect(METRICS_COHORT_CTE).toContain('COALESCE(e."occurredAt", e."createdAt") <= s."createdAt" + interval \'336 hours\'');
		expect(METRICS_COHORT_CTE).toContain('e."userId" = s."userId" AND e."noteId" = s."noteId"');
		expect(rangeParameters({ from: '2026-09-01', to: '2026-09-01' })).toEqual(['2026-09-01T00:00:00+09:00', '2026-09-02T00:00:00+09:00']);
	});

	test('duplicate outcomes are capped independently by type; reaction plus reply remains two', () => {
		for (const type of ['seen', 'reaction', 'reply', 'renote']) {
			expect(METRICS_COHORT_CTE).toContain(`MAX(CASE WHEN e."eventType" = '${type}' THEN 1 ELSE 0 END) AS ${type}`);
		}
		expect(METRICS_COHORT_CTE).toContain('LEFT JOIN LATERAL');
		expect(metricsCohortSql('total')).toContain('COUNT(DISTINCT "userId")');
	});

	test('captured dimensions support parameterized cross filters and deterministic range-wide top thirty', () => {
		const sql = metricsCohortSql('dimension');
		expect(sql).toContain('s.dimensions @> $3::jsonb');
		expect(sql).toContain('dimensions ->> $4::text');
		expect(sql).toContain('ORDER BY COUNT(*) DESC, raw_key LIMIT 30');
		expect(sql).toContain('THEN \'_other\'');
		expect(sql).not.toContain('hanami_user_feed_entry');
		expect(sql).not.toContain('hanami_note_judgement');
	});

	test('normal baseline deduplicates by JST day, user, note and event type without served', () => {
		expect(METRICS_NORMAL_SQL).toContain('SELECT DISTINCT');
		expect(METRICS_NORMAL_SQL).toContain('AS day, "userId", "noteId", "eventType"');
		expect(METRICS_NORMAL_SQL).toContain('source = \'normal\'');
		expect(METRICS_NORMAL_SQL).not.toContain('\'served\'');
	});

	test('duration quantiles operate on raw range runs, not daily percentile averages', () => {
		const sql = metricsGenerationSql();
		expect(sql).toContain('percentile_cont(0.5)');
		expect(sql).toContain('percentile_cont(0.95)');
		expect(sql).toContain('kind = \'note-judge\'');
		expect(sql).not.toContain('hanami_metrics_daily');
	});
});

describe('HanamiMetricsRollupService (pure manager/Redis mocks)', () => {
	test('writes raw low-user rows, uses separate transactions and is idempotent while removing stale keys', async () => {
		const mock = mockDatabase();
		const service = new HanamiMetricsRollupService(mock.db);
		await service.rollupDay('2026-09-01', { recompute: true });
		const first = new Map(mock.stored);
		expect(mock.stored.get('2026-09-01/engagement/source/small')).toMatchObject({ users: 2, served: 4 });
		expect(mock.transaction.mock.calls.length).toBeGreaterThan(8);
		await service.rollupDay('2026-09-01', { recompute: true });
		expect(mock.stored).toEqual(first);
		mock.setRows([{ key: 'new', users: 1, served: 9, seen: 1, reaction: 1, reply: 0, renote: 0 }]);
		await service.rollupDay('2026-09-01', { recompute: true });
		expect(mock.stored.has('2026-09-01/engagement/source/small')).toBe(false);
		expect(mock.stored.get('2026-09-01/engagement/source/new')).toMatchObject({ users: 1, served: 9 });
		expect(mock.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT pg_advisory')).length).toBe(mock.transaction.mock.calls.length);
	});

	test('non-recompute retains already written dimensions; missing Redis is unavailable, not zero', async () => {
		const mock = mockDatabase();
		const service = new HanamiMetricsRollupService(mock.db);
		await service.rollupDay('2026-09-01', { recompute: true });
		mock.setRows([{ key: 'replacement', users: 9, served: 100, seen: 1, reaction: 1, reply: 0, renote: 0 }]);
		await service.rollupDay('2026-09-01', { recompute: false });
		expect(mock.stored.has('2026-09-01/engagement/source/small')).toBe(true);
		expect(mock.stored.get('2026-09-01/usage/total/total')?.extra).toMatchObject({ rateLimited: null, rateLimitedAvailable: false });
		expect(mock.stored.get('2026-09-01/tuning/axisLevel/unavailable')?.extra).toMatchObject({ available: false });
	});

	test('reads instrumented 429 count from JST key without starting Redis', async () => {
		const mock = mockDatabase();
		const get = jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue('12');
		await new HanamiMetricsRollupService(mock.db, { get }).rollupDay('2026-09-01', { recompute: true });
		expect(get).toHaveBeenCalledWith('hanami:metrics:429:2026-09-01');
		expect(mock.stored.get('2026-09-01/usage/total/total')?.extra).toMatchObject({ rateLimited: 12 });
	});

	test('finalizes oldest cohort after its last whole outcome day and excludes today', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-09-20T18:30:00Z')); // Sep 21 JST
		const service = new HanamiMetricsRollupService(mockDatabase().db);
		const rollup = jest.spyOn(service, 'rollupDay').mockResolvedValue();
		await service.rollupRecent();
		expect(rollup).toHaveBeenCalledTimes(15);
		expect(rollup.mock.calls[0]).toEqual(['2026-09-06', { recompute: true }]);
		expect(rollup.mock.calls[14]).toEqual(['2026-09-20', { recompute: true }]);
	});
});
