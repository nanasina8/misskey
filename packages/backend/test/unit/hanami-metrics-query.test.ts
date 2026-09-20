/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HANAMI_METRICS_DIMENSIONS, METRICS_SUMMARY_USERS_SQL, metricsRangeUsersSql, jstDay, resolveRange, rangeDays, metricRatio, rangeParameters } from '@/core/hanami/HanamiMetricsContracts.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import type { HanamiNoteJudgeRuntimeStatus } from '@/core/hanami/HanamiPythonRuntime.js';
import type { HanamiMetricsDimension, MetricsAggregateRow, MetricsGenerationRow, MetricsNormalRow, MetricsSummaryUsersRow } from '@/core/hanami/HanamiMetricsContracts.js';
import type { DataSource } from 'typeorm';

const peekRuntime = jest.fn<() => HanamiNoteJudgeRuntimeStatus | null>();
const probeRuntime = jest.fn(() => { throw new Error('Metrics must never probe Python'); });
jest.unstable_mockModule('../../src/core/hanami/HanamiPythonRuntime.js', () => ({
	peekHanamiNoteJudgeRuntime: peekRuntime,
	probeHanamiNoteJudgeRuntime: probeRuntime,
}));
const { HanamiMetricsQueryService, metricsUserBucket, presentMetricsBreakdown, sanitizeMetricsFailure } = await import('@/core/hanami/HanamiMetricsQueryService.js');

const row = (key: string, users: number, served = 100, seen = 50, reaction = 10): MetricsAggregateRow => ({ key, users, served, seen, reaction, reply: 0, renote: 0 });
const empty = row('total', 0, 0, 0, 0);
const range = { from: '2026-09-01', to: '2026-09-03' };
const originalSalt = process.env.HANAMI_METRICS_SALT;

interface Fixture {
	startedAt: string | null;
	totals: MetricsAggregateRow[];
	daily: MetricsAggregateRow[];
	dimensions: MetricsAggregateRow[];
	genres: MetricsGenerationRow[];
	dailyGenres: MetricsGenerationRow[];
	normal: MetricsNormalRow[];
	refreshes: { day: string; users: number; refreshes: number }[];
	timeline: { key: string; users: number; requests: number }[];
	windows: { key: string; users: number; from: string }[];
	errors: { at: string; userId: string; kind: string; attempts: number; failureMessage?: string }[];
	settings: unknown;
	backlog: number | null;
	judgeRuns: { secondsPerItem?: unknown; wallDurationMs?: unknown; processedCount?: unknown; device?: unknown }[];
	diagnostics: { day: string; scope: 'dropped' | 'tuning' }[];
	gap: boolean | null;
}

function mockDatabase(input: Partial<Fixture> = {}, route?: (sql: string, params: unknown[]) => unknown[] | undefined) {
	const fixture: Fixture = { startedAt: '2026-07-01T00:00:00Z', totals: [empty], daily: [], dimensions: [], genres: [], dailyGenres: [], normal: [], refreshes: [], timeline: [], windows: [], errors: [], settings: null, backlog: null, judgeRuns: [], diagnostics: [], gap: null, ...input };
	const query = jest.fn(async (sql: string, params?: unknown[]): Promise<unknown[]> => {
		const routed = route?.(sql, params ?? []);
		if (routed !== undefined) return routed;
		if (sql.includes('FROM meta LIMIT 1')) return [{ settings: fixture.settings }];
		if (sql.startsWith('WITH latest_ready')) return fixture.backlog === null ? [] : [{ backlog: fixture.backlog }];
		if (sql.includes("params->'secondsPerItem'")) return fixture.judgeRuns;
		if (sql.includes('FROM hanami_metrics_diagnostic')) return fixture.diagnostics;
		if (sql.includes('FROM hanami_metrics_state')) return fixture.startedAt ? [{ startedAt: fixture.startedAt }] : [];
		if (sql.startsWith('WITH cohort')) {
			if (sql.includes('top_terms AS')) return fixture.dimensions;
			if (sql.includes('GROUP BY day')) return fixture.daily;
			return fixture.totals;
		}
		if (sql.startsWith('WITH runs')) return sql.includes('r.day') ? fixture.dailyGenres : fixture.genres;
		if (sql.startsWith('WITH normal')) return fixture.normal;
		if (sql === METRICS_SUMMARY_USERS_SQL) return [
			...fixture.totals.map(({ key, users }) => ({ scope: 'total', key, users, from: null })),
			...fixture.dimensions.map(({ key, users }) => ({ scope: 'source', key, users, from: null })),
			...fixture.windows.map(row => ({ ...row, scope: 'window' })),
		];
		if (sql.includes('FROM hanami_metrics_refresh')) return fixture.refreshes;
		if (sql.includes('FROM hanami_metrics_timeline')) return fixture.timeline;
		if (sql.includes('FROM hanami_metrics_gap')) return [{ gap: fixture.gap }];
		if (sql.includes('FROM hanami_metrics_daily')) {
			if (sql.includes("scope = 'generation'")) return fixture.dailyGenres;
			if (sql.includes("scope = 'engagement'")) return sql.includes('SUM(served)') ? (params?.[3] === 'total' ? fixture.totals : fixture.dimensions) : fixture.daily;
			return [];
		}
		if (sql.includes('FROM hanami_metrics_event')) return (params?.length === 3 ? fixture.dimensions : fixture.totals).map(({ key, users }) => ({ key, users }));
		if (sql.includes('FROM hanami_user_feed_batch')) return fixture.errors;
		if (sql.includes('FROM hanami_common_generation') || sql.includes('FROM hanami_foryou_model_run')) return [];
		throw new Error(`Unexpected mock SQL: ${sql}, ${JSON.stringify(params)}`);
	});
	return { query, service: new HanamiMetricsQueryService({ query } as unknown as DataSource) };
}

beforeEach(() => {
	jest.useFakeTimers().setSystemTime(new Date('2026-09-20T12:00:00Z'));
	peekRuntime.mockReset().mockReturnValue(null);
	probeRuntime.mockClear();
});
afterEach(() => {
	expect(probeRuntime).not.toHaveBeenCalled();
	jest.useRealTimers();
	if (originalSalt === undefined) delete process.env.HANAMI_METRICS_SALT;
	else process.env.HANAMI_METRICS_SALT = originalSalt;
});

describe('range and JST', () => {
	test('presets include endpoints and turn over at JST midnight', () => {
		expect(jstDay(new Date('2026-09-20T15:00:00Z'))).toBe('2026-09-21');
		expect(resolveRange({ days: 7 }, new Date('2026-09-20T15:00:00Z'))).toEqual({ from: '2026-09-15', to: '2026-09-21' });
		for (const days of [7, 14, 30, 90] as const) expect(rangeDays(resolveRange({ days })).length).toBe(days);
	});

	test.each([
		{ from: '2026-02-30', to: '2026-03-01' },
		{ from: '2026-9-01', to: '2026-09-03' },
		{ from: '2026-09-03', to: '2026-09-01' },
		{ from: '2026-06-21', to: '2026-09-20' },
		{ from: '2026-09-20', to: '2026-09-21' },
	])('rejects malformed, impossible, inverted, too long and future ranges %j', invalid => {
		expect(() => resolveRange(invalid)).toThrow(RangeError);
	});

	test('accepts exactly ninety dates and leap day', () => {
		expect(rangeDays(resolveRange({ from: '2026-06-23', to: '2026-09-20' }))).toHaveLength(90);
		expect(resolveRange({ from: '2024-02-29', to: '2024-02-29' })).toEqual({ from: '2024-02-29', to: '2024-02-29' });
	});
});

describe('breakdown', () => {
	test('suppresses 1–4 users and recomputes all denominators solely from visible rows', () => {
		const value = presentMetricsBreakdown([row('a', 5, 100, 50, 20), row('b', 8, 300, 150, 20), row('small', 4, 1000, 800, 300)]);
		expect(value.suppressed).toEqual(['small']);
		expect(value.rows).toHaveLength(2);
		expect(value.rows[0]).toMatchObject({ share: 0.25, engagementShare: 0.5, lift: 2, engagementRate: 0.2, seenRate: 0.5 });
		expect(value.rows[1].lift).toBeCloseTo(2 / 3);
		expect(value.denominator).toBe('visible');
		expect(metricRatio(0, 0)).toBeNull();
	});

	test('exact range users and cross-dimension filters come from facts, never daily sums', async () => {
		const mock = mockDatabase({ dimensions: [row('text', 5)] });
		const result = await mock.service.breakdown({ range, dimension: 'media', filter: { source: 'exploration', contentType: '2' } });
		expect(result.rows[0].users).toBe(5);
		const call = mock.query.mock.calls.find(([sql]) => sql.startsWith('WITH cohort'));
		expect(call?.[0]).toContain('COUNT(DISTINCT "userId")');
		expect(call?.[1]?.slice(2)).toEqual(['{"contentType":"2","source":"exploration"}', 'media']);
		expect(call?.[0]).not.toContain('hanami_metrics_daily');
		await expect(mock.service.breakdown({ range, dimension: 'media', filter: { media: 'text' } })).rejects.toThrow(RangeError);
	});

	test('empty coverage is explicit rather than an invented bucket', async () => {
		const result = await mockDatabase({ startedAt: null }).service.breakdown({ range, dimension: 'source' });
		expect(result.rows).toEqual([]);
		expect(result.coverage.status).toBe('unavailable');
	});
});

type ServedUser = { userId: string | null; at: number; dimensions: { source?: string } };

/** Storage double for the shared scan: evaluate the deduplicated keyed-user relation.
 * Tests compare this with independently filtered raw DISTINCT sets, including boundaries.
 */
function summaryUsers(events: ServedUser[], from: string, to: string): MetricsSummaryUsersRow[] {
	const end = Date.parse(to);
	const start = Date.parse(from);
	const lower = Math.min(start, end - 30 * 86_400_000);
	const keyed = new Map<string, { key: string; userId: string | null; maxAt: number; inRange: boolean }>();
	for (const event of events) {
		if (event.at < lower || event.at >= end) continue;
		const key = event.dimensions.source || 'unknown';
		const identity = JSON.stringify([key, event.userId]);
		const previous = keyed.get(identity);
		keyed.set(identity, { key, userId: event.userId, maxAt: Math.max(previous?.maxAt ?? -Infinity, event.at), inRange: (previous?.inRange ?? false) || event.at >= start });
	}
	const rows = [...keyed.values()];
	const unique = (selected: typeof rows) => new Set(selected.map(row => row.userId).filter(user => user !== null)).size;
	return [
		{ scope: 'total', key: 'total', users: unique(rows.filter(row => row.inRange)), from: null },
		...[...new Set(rows.filter(row => row.inRange).map(row => row.key))].sort().map(key => ({ scope: 'source' as const, key, users: unique(rows.filter(row => row.inRange && row.key === key)), from: null })),
		...([['day', 1], ['week', 7], ['month', 30]] as const).map(([key, days]) => ({ scope: 'window' as const, key, users: unique(rows.filter(row => row.maxAt >= end - days * 86_400_000)), from: jstDay(new Date(end - days * 86_400_000)) })),
	];
}

/** Persisted counts are hand-calculated, NOT produced by the raw-cohort evaluator below.
 * Ten overlapping users, two sources crossed with two media, and three JST days.
 */
function threeDayFixture() {
	const days = ['2026-09-18', '2026-09-19', '2026-09-20'];
	const span = { from: days[0], to: days[2] };
	const kinds = ['seen', 'reaction', 'reply', 'renote'] as const;
	type Outcome = typeof kinds[number];
	const served: { userId: string; noteId: string; at: number; dimensions: Partial<Record<HanamiMetricsDimension, string>> }[] = [];
	const outcomes: { userId: string; noteId: string; at: number; kind: Outcome }[] = [];
	const persisted: (MetricsAggregateRow & { day: string; dimension: string })[] = [];
	for (const [d, day] of days.entries()) {
		const total = { ...row('total', 10, 20, 16, d < 2 ? 10 : 0), reply: 4, renote: d === 2 ? 12 : 0 };
		persisted.push({ ...total, day, dimension: 'total' });
		for (const source of ['exploration', 'fof']) {
			persisted.push({ ...row(source, 10, 10, 8, d < 2 ? 5 : 0), reply: 2, renote: d === 2 ? 6 : 0, day, dimension: 'source' });
			for (let i = 0; i < 10; i++) {
				const item = { userId: `user-${i}`, noteId: `${day}-${source}-${i}`, at: Date.parse(`${day}T00:00:00+09:00`) + i * 1000,
					dimensions: { source, media: i % 2 === 0 ? 'image' : 'text', contentType: '', freshness: '0-6h', authorLocality: 'local', cluster: 'c1', trendTerm: 'term' } };
				served.push(item);
				const flags = { seen: i < 8, reaction: d === 0 ? i < 5 : d === 1 && i % 2 === 0, reply: i === 0 || i === 9, renote: d === 2 && i < 6 };
				for (const kind of kinds) {
					// Duplicate outcomes still contribute only one per type per served row.
					if (flags[kind]) for (const delay of [60_000, 120_000]) outcomes.push({ ...item, kind, at: item.at + delay });
					// Before serving and beyond the attribution window must contribute nothing.
					outcomes.push({ ...item, kind, at: item.at - 1 }, { ...item, kind, at: item.at + 336 * 3_600_000 + 1 });
				}
			}
		}
		persisted.push(
			{ ...row('image', 5, 10, 8, [6, 10, 0][d]), reply: 2, renote: d === 2 ? 6 : 0, day, dimension: 'media' },
			{ ...row('text', 5, 10, 8, [4, 0, 0][d]), reply: 2, renote: d === 2 ? 6 : 0, day, dimension: 'media' },
		);
		for (const [dimension, key] of Object.entries({ relationshipClass: 'unknown', contentType: 'unjudged', freshness: '0-6h', authorLocality: 'local', cluster: 'c1' })) {
			persisted.push({ ...total, key, day, dimension });
		}
	}
	const raw = (from: string, to: string, dimension?: HanamiMetricsDimension, filter: Record<string, string> = {}, byDay = false): MetricsAggregateRow[] => {
		const grouped = new Map<string, { row: MetricsAggregateRow; users: Set<string> }>();
		for (const item of served) {
			if (item.at < Date.parse(from) || item.at >= Date.parse(to) || Object.entries(filter).some(([key, value]) => item.dimensions[key as HanamiMetricsDimension] !== value)) continue;
			const day = jstDay(new Date(item.at));
			const key = dimension ? item.dimensions[dimension] || (dimension === 'contentType' ? 'unjudged' : 'unknown') : 'total';
			const groupKey = byDay ? day : key;
			const group = grouped.get(groupKey) ?? { row: { ...empty, key, ...(byDay ? { day } : {}) }, users: new Set<string>() };
			group.users.add(item.userId);
			group.row.users = group.users.size;
			group.row.served++;
			for (const kind of kinds) group.row[kind] += Number(outcomes.some(event => event.userId === item.userId && event.noteId === item.noteId && event.kind === kind && event.at >= item.at && event.at <= item.at + 336 * 3_600_000));
			grouped.set(groupKey, group);
		}
		return [...grouped.values()].map(group => group.row).sort((a, b) => a.key.localeCompare(b.key));
	};
	const mock = mockDatabase({}, (sql, params) => {
		if (sql.includes('FROM hanami_metrics_daily') && sql.includes("scope = 'engagement'")) {
			const [from, to, today, dimension] = params as string[];
			const selected = persisted.filter(row => row.day >= from && row.day <= to && row.day < today && row.dimension === dimension);
			if (!sql.includes('SUM(served)')) return selected;
			const groups = new Map<string, MetricsAggregateRow>();
			for (const row of selected) {
				const group = groups.get(row.key) ?? { ...empty, key: row.key };
				for (const kind of ['served', ...kinds] as const) group[kind] += row[kind];
				groups.set(row.key, group);
			}
			return [...groups.values()];
		}
		if (sql.startsWith('WITH cohort')) return raw(params[0] as string, params[1] as string, params[3] as HanamiMetricsDimension | undefined, JSON.parse(params[2] as string), sql.includes('GROUP BY day'));
		if (sql === METRICS_SUMMARY_USERS_SQL) return summaryUsers(served, params[0] as string, params[1] as string);
		if (sql.includes('FROM hanami_metrics_event') && !sql.startsWith('WITH normal') && !sql.includes('FROM (VALUES')) {
			return raw(params[0] as string, params[1] as string, params[2] as HanamiMetricsDimension | undefined).map(({ key, users }) => ({ key, users }));
		}
		return undefined;
	});
	return { ...mock, span, raw, days };
}

describe('deduplicated served-only user queries', () => {
	test.each([false, true])('range users pre-group before DISTINCT (dimension=%s), preserving null and empty-total semantics', dimension => {
		const sql = metricsRangeUsersSql(dimension);
		expect(sql).toContain('COUNT(DISTINCT "userId")::int AS users FROM (');
		expect(sql).toContain('GROUP BY 1, 2');
		expect(sql).toContain('"eventType" = \'served\'');
		expect(sql).toContain('"createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz');
		expect(sql).not.toContain('COUNT(*)');
		expect(sql).not.toContain('LATERAL');
		if (dimension) {
			expect(sql).toContain("COALESCE(NULLIF(dimensions ->> $3::text, ''), CASE WHEN $3 = 'contentType' THEN 'unjudged' ELSE 'unknown' END)");
			expect(sql).toContain(') distinct_users GROUP BY key ORDER BY key');
		} else {
			// An ungrouped outer aggregate still emits total=0 when no served rows exist.
			expect(sql).toMatch(/^SELECT 'total' AS key/);
			expect(sql.trim()).toMatch(/\) distinct_users$/);
		}
	});

	test.each(['2026-09-20', '2026-09-01', '2026-07-01'])('shared range/window scan is exact for range starting %s, including cross-source duplicates and null users', async from => {
		const span = { from, to: '2026-09-20' };
		const bounds = rangeParameters(span);
		const events: ServedUser[] = [];
		for (const [label, at] of [
			['today', '2026-09-20T00:00:00+09:00'],
			['week', '2026-09-14T00:00:00+09:00'],
			['month', '2026-08-22T00:00:00+09:00'],
			['before-month', '2026-08-21T23:59:59.999+09:00'],
			['old', '2026-07-02T00:00:00+09:00'],
			['end-excluded', '2026-09-21T00:00:00+09:00'],
		]) {
			for (let i = 0; i < 5; i++) {
				// Same users across all keys, including 'total' as an actual source value.
				for (const source of ['exploration', 'fof', 'total', '', undefined]) {
					for (let duplicate = 0; duplicate < 2; duplicate++) events.push({ userId: `${label}-${i}`, at: Date.parse(at), dimensions: { source } });
				}
			}
		}
		// A pre-existing source/user can reappear in the requested range.
		events.push({ userId: 'today-0', at: Date.parse('2026-08-22T00:00:00+09:00'), dimensions: { source: 'fof' } });
		events.push({ userId: null, at: Date.parse('2026-09-20T00:00:00+09:00'), dimensions: { source: 'null-only' } });
		const distinct = (start: number, end: number, source?: string) => new Set(events
			.filter(event => event.at >= start && event.at < end && event.userId !== null && (source === undefined || (event.dimensions.source || 'unknown') === source))
			.map(event => event.userId)).size;
		const combined = summaryUsers(events, ...bounds);
		const start = Date.parse(bounds[0]);
		const end = Date.parse(bounds[1]);
		expect(combined.find(row => row.scope === 'total')?.users).toBe(distinct(start, end));
		for (const source of combined.filter(row => row.scope === 'source')) expect(source.users).toBe(distinct(start, end, source.key));
		const expectedWindows = { day: 5, week: 10, month: 15 };
		for (const [key, days] of [['day', 1], ['week', 7], ['month', 30]] as const) {
			expect(distinct(end - days * 86_400_000, end)).toBe(expectedWindows[key]);
			expect(combined.find(row => row.scope === 'window' && row.key === key)).toMatchObject({ users: expectedWindows[key], from: jstDay(new Date(end - days * 86_400_000)) });
		}
		const todaySources = combined.filter(row => row.scope === 'source').map(source => ({ ...empty, key: source.key, users: distinct(Date.parse('2026-09-20T00:00:00+09:00'), end, source.key) }));
		const mock = mockDatabase({ dimensions: todaySources }, (sql, params) => sql === METRICS_SUMMARY_USERS_SQL ? summaryUsers(events, ...(params as [string, string])) : undefined);
		const value = await mock.service.summary(span);
		expect(value.usage.hanamiUsers).toEqual(expectedWindows);
		expect(value.engagement.users).toBe(distinct(start, end));
		expect(value.series.hanamiUsers.at(-1)).toBe(5); // Not 5 sources x 5 users.
		expect(mock.query.mock.calls.filter(([sql]) => sql === METRICS_SUMMARY_USERS_SQL)).toHaveLength(1);
		expect(mock.query.mock.calls.filter(([sql]) => sql.includes('FROM hanami_metrics_event') && !sql.startsWith('WITH normal') && !sql.startsWith('WITH cohort'))).toHaveLength(1);
		expect(mock.query.mock.calls.find(([sql]) => sql === METRICS_SUMMARY_USERS_SQL)?.[1]).toEqual(bounds);
	});

	test('shared SQL scans the union of range and month, groups once, and retains all zero windows for empty facts', () => {
		const sql = METRICS_SUMMARY_USERS_SQL;
		expect(sql.match(/FROM hanami_metrics_event/g)).toHaveLength(1);
		expect(sql).toContain("LEAST($1::timestamptz, $2::timestamptz - interval '720 hours')");
		expect(sql).toContain('AND "createdAt" < $2::timestamptz');
		expect(sql).toContain("COALESCE(NULLIF(dimensions ->> 'source', ''), 'unknown')");
		expect(sql).toContain('MAX("createdAt") AS max_at, BOOL_OR("createdAt" >= $1::timestamptz) AS in_range');
		expect(sql).toContain('GROUP BY 1, 2');
		expect(sql).toContain('COUNT(DISTINCT "userId") FILTER (WHERE in_range)');
		expect(sql).toContain('FROM keyed_users WHERE in_range GROUP BY key');
		expect(sql).toContain("u.max_at >= $2::timestamptz - w.days * interval '24 hours'");
		expect(sql).toContain("($2::timestamptz AT TIME ZONE 'Asia/Tokyo') - w.days * interval '1 day'");
		expect(sql).toContain('LEFT JOIN keyed_users u ON true');
		expect(sql).not.toContain('LATERAL');
		expect(sql).not.toContain('COUNT(*)');
		expect(summaryUsers([], ...rangeParameters(range))).toEqual([
			{ scope: 'total', key: 'total', users: 0, from: null },
			{ scope: 'window', key: 'day', users: 0, from: '2026-09-03' },
			{ scope: 'window', key: 'week', users: 0, from: '2026-08-28' },
			{ scope: 'window', key: 'month', users: 0, from: '2026-08-05' },
		]);
	});
});

describe('daily read path and current-day supplement', () => {
	test('three persisted days equal independent 0/1 raw cohorts, with exact range rather than summed daily users', async () => {
		jest.setSystemTime(new Date('2026-09-21T00:00:00Z'));
		const mock = threeDayFixture();
		const value = await mock.service.summary(mock.span);
		const [expected] = mock.raw(...rangeParameters(mock.span));
		const { key: _key, ...counts } = expected;
		expect(counts).toEqual({ users: 10, served: 60, seen: 48, reaction: 20, reply: 12, renote: 12 });
		expect(value.engagement).toMatchObject(counts);
		expect(value.engagement.engagementRate).toBe(44 / 60);
		expect(value.series.hanamiUsers).toEqual([10, 10, 10]);
		expect(value.series.engagementRate).toEqual([14 / 20, 14 / 20, 16 / 20]);
		for (const dimension of ['source', 'media'] as const) {
			const result = await mock.service.breakdown({ range: mock.span, dimension });
			expect(result).toMatchObject(presentMetricsBreakdown(mock.raw(...rangeParameters(mock.span), dimension)));
		}
		expect(mock.query.mock.calls.some(([sql]) => sql.includes('LATERAL'))).toBe(false);
		const historicalCounts = mock.query.mock.calls.filter(([sql]) => sql.includes("scope = 'engagement'"));
		expect(historicalCounts).toHaveLength(4);
		expect(historicalCounts.filter(([sql]) => sql.includes('SUM(served)'))).toHaveLength(3);
		const sharedUsers = mock.query.mock.calls.filter(([sql]) => sql === METRICS_SUMMARY_USERS_SQL);
		expect(sharedUsers).toHaveLength(1);
		expect(sharedUsers[0][1]).toEqual(rangeParameters(mock.span));
		const uniqueQueries = mock.query.mock.calls.filter(([sql]) => sql.includes(') distinct_users'));
		expect(uniqueQueries).toHaveLength(2);
		for (const [sql, params] of uniqueQueries) {
			expect(sql).toContain('COUNT(DISTINCT "userId")::int');
			expect(sql).toContain('"eventType" = \'served\'');
			expect(params?.slice(0, 2)).toEqual(rangeParameters(mock.span));
		}
	});

	test.each(HANAMI_METRICS_DIMENSIONS.filter(dimension => dimension !== 'trendTerm'))('unfiltered %s (including empty filter) uses daily SUM and matching served-only defaults', async dimension => {
		jest.setSystemTime(new Date('2026-09-21T00:00:00Z'));
		const mock = threeDayFixture();
		const result = await mock.service.breakdown({ range: mock.span, dimension, filter: {} });
		expect(result).toMatchObject(presentMetricsBreakdown(mock.raw(...rangeParameters(mock.span), dimension)));
		expect(mock.query.mock.calls.some(([sql]) => sql.includes('LATERAL'))).toBe(false);
		expect(mock.query.mock.calls.find(([sql]) => sql.includes('SUM(served)'))?.[1]).toEqual([mock.span.from, mock.span.to, '2026-09-21', dimension]);
		const [sql, params] = mock.query.mock.calls.find(([sql]) => sql.includes(') distinct_users'))!;
		expect(sql).toContain("CASE WHEN $3 = 'contentType' THEN 'unjudged' ELSE 'unknown' END");
		expect(sql).toContain('GROUP BY 1, 2');
		expect(sql).toContain('COUNT(DISTINCT "userId")::int');
		expect(params?.[2]).toBe(dimension);
	});

	test('today adds only its JST cohort, ignoring even an existing today rollup, without adding overlapping uniques', async () => {
		// 15:00 UTC is already the NEXT day in JST, and supplement bounds must use JST.
		jest.setSystemTime(new Date('2026-09-19T15:01:00Z'));
		const mock = threeDayFixture();
		const result = await mock.service.summary(mock.span);
		expect(result.engagement).toMatchObject({ users: 10, served: 60, seen: 48, reaction: 20, reply: 12, renote: 12 });
		expect(result.series.hanamiUsers).toEqual([10, 10, 10]);
		expect(result.series.engagementRate).toEqual([0.7, 0.7, 0.8]);
		expect(result.coverage.partialDays).toEqual(['2026-09-20']);
		expect(result.coverage.unavailable).toContain('usage.tlShare.currentDayProvisional');
		const summaryCohorts = mock.query.mock.calls.filter(([sql]) => sql.includes('LATERAL'));
		expect(summaryCohorts).toHaveLength(1);
		expect(summaryCohorts[0][1]?.[3]).toBe('source');
		expect(result.usage.hanamiUsers).toEqual({ day: 10, week: 10, month: 10 });
		const breakdown = await mock.service.breakdown({ range: mock.span, dimension: 'media' });
		expect(breakdown).toMatchObject(presentMetricsBreakdown(mock.raw(...rangeParameters(mock.span), 'media')));
		const cohorts = mock.query.mock.calls.filter(([sql]) => sql.includes('LATERAL'));
		expect(cohorts).toHaveLength(2);
		for (const [, params] of cohorts) expect(params?.slice(0, 2)).toEqual(['2026-09-20T00:00:00+09:00', '2026-09-21T00:00:00+09:00']);
		for (const [sql, params] of mock.query.mock.calls.filter(([sql]) => sql.includes("scope = 'engagement'"))) {
			expect(sql).toContain('day < $3::date');
			expect(params?.[2]).toBe('2026-09-20');
		}
		const todayOnly = await mock.service.summary({ from: '2026-09-20', to: '2026-09-20' });
		expect(todayOnly.engagement).toMatchObject({ users: 10, served: 20, reaction: 0, reply: 4, renote: 12 });
		expect(todayOnly.series.hanamiUsers).toEqual([10]);
	});

	test('filtered breakdown uses independent raw cross-axis cohorts across the whole range', async () => {
		const mock = threeDayFixture();
		const filter = { media: 'image' };
		const value = await mock.service.breakdown({ range: mock.span, dimension: 'source', filter });
		expect(value).toMatchObject(presentMetricsBreakdown(mock.raw(...rangeParameters(mock.span), 'source', filter)));
		expect(value.rows.map(row => row.users)).toEqual([5, 5]);
		expect(mock.query.mock.calls.some(([sql]) => sql.includes('hanami_metrics_daily'))).toBe(false);
		expect(mock.query.mock.calls.find(([sql]) => sql.includes('LATERAL'))?.[1]).toEqual([...rangeParameters(mock.span), '{"media":"image"}', 'source']);
	});

	test('trendTerm is always a whole-range ranked raw exception, even without filters', async () => {
		const mock = mockDatabase({ dimensions: [row('range-top-term', 5)] });
		const value = await mock.service.breakdown({ range, dimension: 'trendTerm' });
		expect(value.rows[0].key).toBe('range-top-term');
		const calls = mock.query.mock.calls.length;
		await mock.service.breakdown({ range, dimension: 'trendTerm', filter: {} });
		expect(mock.query).toHaveBeenCalledTimes(calls);
		expect(mock.query.mock.calls.some(([sql]) => sql.includes('hanami_metrics_daily'))).toBe(false);
		expect(mock.query.mock.calls.find(([sql]) => sql.includes('LATERAL'))?.[0]).toContain('top_terms AS');
	});
});

describe('raw endpoint cache', () => {
	test.each(['filtered', 'trendTerm', 'errors'] as const)('%s normalizes arguments, isolates returned clones and keys, and expires after 61 seconds', async endpoint => {
		const mock = mockDatabase({ dimensions: [row('visible', 5)] });
		const call = (explicit: boolean, different = false) => {
			const input = explicit ? { from: '2026-09-14', to: different ? '2026-09-19' : '2026-09-20' } : { days: 7 as const };
			if (endpoint === 'errors') return mock.service.errors(input);
			return mock.service.breakdown({ range: input, dimension: endpoint === 'filtered' ? 'source' : 'trendTerm',
				filter: endpoint === 'filtered' ? (explicit ? { contentType: '2', media: 'image' } : { media: 'image', contentType: '2' }) : undefined });
		};
		const first = await call(false);
		const expected = structuredClone(first);
		const calls = mock.query.mock.calls.length;
		first.coverage.unavailable.push('mutated');
		first.suppressed.push('mutated');
		const second = await call(true);
		expect(second).toEqual(expected);
		second.range.from = 'corrupt';
		expect(await call(true)).toEqual(expected);
		expect(mock.query).toHaveBeenCalledTimes(calls);
		await call(true, true);
		expect(mock.query.mock.calls.length).toBeGreaterThan(calls);
		const beforeExpiry = mock.query.mock.calls.length;
		jest.advanceTimersByTime(61_000);
		expect(await call(true)).toEqual(expected);
		expect(mock.query.mock.calls.length).toBeGreaterThan(beforeExpiry);
	});

	test('filter values, dimensions and endpoint names do not share cached results', async () => {
		const mock = mockDatabase({ dimensions: [row('visible', 5)] });
		const request = { range, dimension: 'source' as const, filter: { media: 'image' } };
		await mock.service.breakdown(request);
		await mock.service.breakdown({ ...request, filter: { media: 'text' } });
		await mock.service.breakdown({ ...request, dimension: 'contentType' });
		await mock.service.errors(range);
		expect(mock.query.mock.calls.filter(([sql]) => sql.startsWith('WITH cohort'))).toHaveLength(3);
		expect(mock.query.mock.calls.filter(([sql]) => sql.startsWith('WITH runs'))).toHaveLength(2);
	});

	test('failed loads are not cached', async () => {
		const mock = mockDatabase();
		mock.query.mockRejectedValueOnce(new Error('query failed'));
		const request = { range, dimension: 'trendTerm' as const };
		await expect(mock.service.breakdown(request)).rejects.toThrow('query failed');
		await expect(mock.service.breakdown(request)).resolves.toMatchObject({ rows: [] });
		expect(mock.query.mock.calls.filter(([sql]) => sql.startsWith('WITH cohort'))).toHaveLength(2);
	});
});

describe('summary privacy and missing series', () => {
	test('fills only fully covered empty days with zero people; unavailable days/rates remain null', async () => {
		const result = await mockDatabase({ startedAt: '2026-09-02T00:00:00+09:00' }).service.summary(range);
		expect(result.series.hanamiUsers).toEqual([null, 0, 0]);
		expect(result.series.engagementRate).toEqual([null, null, null]);
		expect(result.engagement.served).toBeNull();
		expect(result.series.failedBatches).toEqual([null, 0, 0]);
		expect(result.usage.rateLimited429).toBeNull();
		expect(result.coverage.status).toBe('partial');
	});

	test('small cohorts suppress all counts/rates and daily series, including a small contributing source', async () => {
		const mock = mockDatabase({ totals: [row('total', 7)], daily: [{ ...row('total', 3), day: range.from }], dimensions: [row('a', 5), row('b', 2)] });
		const value = await mock.service.summary(range);
		for (const key of ['users', 'served', 'seen', 'reaction', 'reply', 'renote', 'engagementRate', 'seenRate'] as const) expect(value.engagement[key]).toBeNull();
		expect(value.series.hanamiUsers[0]).toBeNull();
		expect(value.series.engagementRate[0]).toBeNull();
		expect(value.suppressed).toContain('engagement');
	});

	test('exposes exact overlapping users (not sum of daily uniques) and per-type engagement', async () => {
		const total = { ...row('total', 5, 200, 100, 10), reply: 10, renote: 5 };
		const value = await mockDatabase({ totals: [total], daily: [{ ...row('total', 5, 100, 50, 5), reply: 5, renote: 2, day: '2026-09-01' }, { ...row('total', 5, 100, 50, 5), reply: 5, renote: 3, day: '2026-09-02' }], dimensions: [total], windows: [{ key: 'week', users: 5, from: '2026-08-28' }] }).service.summary(range);
		expect(value.engagement.users).toBe(5);
		expect(value.usage.hanamiUsers.week).toBe(5);
		expect(value.engagement.engagementRate).toBe(0.125);
		expect(value.series.hanamiUsers).toEqual([5, 5, 0]);
	});

	test('normal per-type groups, manual refresh users and timeline shares are privacy gated', async () => {
		const value = await mockDatabase({ totals: [row('total', 5)], dimensions: [row('a', 5)], daily: [{ ...row('total', 5), day: range.from }], normal: [{ ...row('normal', 10), reactionUsers: 4, replyUsers: 0, renoteUsers: 0 }], refreshes: [{ day: range.from, users: 2, refreshes: 20 }], timeline: [{ key: 'home', users: 5, requests: 100 }, { key: 'hanami', users: 2, requests: 100 }] }).service.summary(range);
		expect(value.engagement.normalBaseline.reaction).toBeNull();
		expect(value.usage.manualRefreshPerUserDay).toBeNull();
		expect(value.usage.tlShare.home).toBe(1);
		expect(value.usage.tlShare.hanami).toBeNull();
	});

	test('timeline shares exclude anonymous-only groups from the visible denominator', async () => {
		const value = await mockDatabase({
			totals: [row('total', 5)],
			daily: [{ ...row('total', 5), day: range.from }],
			timeline: [
				{ key: 'home', users: 5, requests: 50 },
				{ key: 'local', users: 0, requests: 50 },
			],
		}).service.summary(range);
		expect(value.usage.tlShare.home).toBe(1);
		expect(value.usage.tlShare.local).toBeNull();
	});

	test('timeline shares are unavailable when collection health reports a gap', async () => {
		const value = await mockDatabase({ gap: true, totals: [row('total', 5)], timeline: [{ key: 'home', users: 5, requests: 10 }] }).service.summary(range);
		expect(value.usage.tlShare.home).toBeNull();
		expect(value.coverage.unavailable).toContain('usage.tlShare.collectionGap');
	});

	test('current day and expired archive dates do not acquire fabricated complete coverage', async () => {
		const today = await mockDatabase().service.summary({ from: '2026-09-20', to: '2026-09-20' });
		expect(today.series.hanamiUsers).toEqual([null]);
		const old = await mockDatabase({ startedAt: '2020-01-01T00:00:00Z' }).service.summary({ from: '2024-01-01', to: '2024-01-01' });
		expect(old.series.hanamiUsers).toEqual([null]);
	});
});

describe('current judge metrics and diagnostic capture coverage', () => {
	test('summary and errors share distinct latest-ready fenced backlog at the configured prompt version', async () => {
		const mock = mockDatabase({ settings: { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 7 }, backlog: 13 });
		const summary = await mock.service.summary(range);
		const errors = await mock.service.errors(range);
		expect(summary.generation.judge.backlog).toBe(13);
		expect(errors.judge.backlog).toBe(13);
		expect(summary.coverage.unavailable).not.toContain('generation.judge.backlog');
		expect(errors.coverage.unavailable).not.toContain('judge.backlog');
		const calls = mock.query.mock.calls.filter(([sql]) => sql.startsWith('WITH latest_ready'));
		expect(calls).toHaveLength(2);
		for (const [sql, params] of calls) {
			expect(params).toEqual([7]);
			expect(sql).toContain("WHERE status = 'ready' ORDER BY ordinal DESC LIMIT 1");
			expect(sql).toContain('COUNT(DISTINCT c."noteId") FILTER (WHERE j."noteId" IS NULL)');
			expect(sql).toContain('c."generationId" = g.id AND c."generationFence" = g."generationFence"');
			expect(sql).toContain('j."noteId" = c."noteId" AND j."promptVersion" = $1');
			expect(sql).toContain('GROUP BY g.id');
			expect(sql).not.toContain('c.axis'); // Judge inventory is not exploration-only.
		}
	});

	test.each([null, { promptVersion: 99 }])('invalid/missing settings use the judge default; empty ready inventory is a real zero (%j)', async settings => {
		const mock = mockDatabase({ settings, backlog: 0 });
		expect((await mock.service.summary(range)).generation.judge.backlog).toBe(0);
		expect((await mock.service.errors(range)).judge.backlog).toBe(0);
		expect(mock.query.mock.calls.find(([sql]) => sql.startsWith('WITH latest_ready'))?.[1]).toEqual([1]);
	});

	test('no snapshot or timing/runtime capture stays null and explicitly unavailable', async () => {
		const mock = mockDatabase();
		const summary = await mock.service.summary(range);
		expect(summary.generation.judge).toEqual({ runs: 0, failed: 0, p50Ms: null, p95Ms: null, backlog: null, secPerNote: null, runtime: null });
		expect(summary.coverage.unavailable).toEqual([
			'generation.judge.backlog', 'generation.judge.secPerNote', 'generation.judge.runtime',
			'dropped.exploration', 'tuning.historical', 'usage.rateLimited429',
		]);
		const errors = await mock.service.errors(range);
		expect(errors.judge.backlog).toBeNull();
		expect(errors.coverage.unavailable).toContain('judge.backlog');
		expect(peekRuntime).toHaveBeenCalledTimes(1);
	});

	test.each([
		[{ secondsPerItem: 1.25, wallDurationMs: 9000, processedCount: 3 }, 1.25],
		[{ secondsPerItem: null, wallDurationMs: 9000, processedCount: 3 }, 3],
		[{ wallDurationMs: 1000, processedCount: 3 }, 1 / 3],
		[{ secondsPerItem: 0 }, 0],
		[{ wallDurationMs: 0, processedCount: 2 }, 0],
		[{ wallDurationMs: 9000, processedCount: 0 }, null],
		[{ secondsPerItem: -1, wallDurationMs: -1, processedCount: 2 }, null],
		[{ secondsPerItem: '2', wallDurationMs: null, processedCount: 2 }, null],
		[{ secondsPerItem: Infinity, wallDurationMs: NaN, processedCount: 2 }, null],
		[{}, null],
	] as [{ secondsPerItem?: unknown; wallDurationMs?: unknown; processedCount?: unknown }, number | null][])('uses only captured finite timing without rounding or fabricating zero: %j', async (run, expected) => {
		const mock = mockDatabase({ judgeRuns: [run] });
		const summary = await mock.service.summary(range);
		expect(summary.generation.judge.secPerNote).toBe(expected);
		expect(summary.coverage.unavailable.includes('generation.judge.secPerNote')).toBe(expected === null);
		const sql = mock.query.mock.calls.find(([query]) => query.includes("params->'secondsPerItem'"))?.[0];
		expect(sql).toContain("FROM hanami_foryou_model_run WHERE kind = 'note-judge' AND status = 'ready'");
		expect(sql).toContain('ORDER BY "startedAt" DESC, id DESC LIMIT 1');
		expect(sql).toContain("params->'wallDurationMs'");
		expect(sql).toContain("params->'processedCount'");
		expect(sql).not.toContain('"createdAt"');
	});

	test('recorded runtime is a device allowlist, not raw params or identifiers; warm peek takes priority', async () => {
		const mock = mockDatabase({ judgeRuns: [{ device: 'cuda', secondsPerItem: 2 }] });
		const recorded = await mock.service.summary(range);
		expect(recorded.generation.judge.runtime).toBe('cuda');
		expect(recorded.coverage.unavailable).not.toContain('generation.judge.runtime');
		peekRuntime.mockReturnValue({ available: true, device: 'cpu', deviceName: 'secret-host', reason: 'secret-note', probedAt: '2026-09-20T12:00:00Z' });
		const cached = await mock.service.summary(range);
		expect(cached.generation.judge.runtime).toBe('cpu');
		expect(Object.keys(cached.generation.judge).sort()).toEqual(['backlog', 'failed', 'p50Ms', 'p95Ms', 'runs', 'runtime', 'secPerNote']);
		for (const forbidden of ['secret-host', 'secret-note', 'userId', 'noteId', 'deviceName', 'params', 'probedAt']) {
			expect(JSON.stringify(cached)).not.toContain(forbidden);
		}
		peekRuntime.mockReturnValue({ available: false, device: null, deviceName: null, reason: 'secret failure', probedAt: '2026-09-20T12:00:00Z' });
		expect((await mock.service.summary(range)).generation.judge.runtime).toBeNull();
	});

	test.each(['secret-user https://private/?token=secret', '', null])('never echoes an unrecognized recorded runtime %j', async device => {
		const summary = await mockDatabase({ judgeRuns: [{ device }] }).service.summary(range);
		expect(summary.generation.judge.runtime).toBeNull();
		expect(summary.coverage.unavailable).toContain('generation.judge.runtime');
		expect(JSON.stringify(summary)).not.toContain('token=');
	});

	test('all requested diagnostic snapshots remove only the corresponding unavailability flags', async () => {
		const diagnostics = rangeDays(range).flatMap(day => [{ day, scope: 'dropped' as const }, { day, scope: 'tuning' as const }]);
		const mock = mockDatabase({ diagnostics });
		const summary = await mock.service.summary(range);
		expect(summary.coverage.unavailable).not.toContain('dropped.exploration');
		expect(summary.coverage.unavailable).not.toContain('tuning.historical');
		const call = mock.query.mock.calls.find(([sql]) => sql.includes('FROM hanami_metrics_diagnostic'));
		expect(call?.[1]).toEqual([range.from, range.to]);
		expect(call?.[0]).toContain("SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day, scope");
		expect(call?.[0]).toContain('day >= $1::date AND day <= $2::date');
		expect(call?.[0]).toContain("scope = 'dropped' AND key = 'exploration'");
		for (const forbidden of ['data', 'users', 'userId', 'noteId']) expect(call?.[0]).not.toContain(forbidden);
	});

	test.each(['dropped', 'tuning'] as const)('a missing requested date leaves only %s incomplete; out-of-range snapshots cannot fill it', async missing => {
		const diagnostics = [...rangeDays(range), '2026-08-31', '2026-09-04'].flatMap(day =>
			(['dropped', 'tuning'] as const).filter(scope => scope !== missing || day !== range.from).map(scope => ({ day, scope })));
		const summary = await mockDatabase({ diagnostics }).service.summary(range);
		expect(summary.coverage.unavailable.includes('dropped.exploration')).toBe(missing === 'dropped');
		expect(summary.coverage.unavailable.includes('tuning.historical')).toBe(missing === 'tuning');
	});

	test('a captured current-day diagnostic does not require complete engagement coverage', async () => {
		const day = '2026-09-20';
		const summary = await mockDatabase({ diagnostics: [{ day, scope: 'dropped' }, { day, scope: 'tuning' }] }).service.summary({ from: day, to: day });
		expect(summary.coverage.status).toBe('partial');
		expect(summary.coverage.unavailable).not.toContain('dropped.exploration');
		expect(summary.coverage.unavailable).not.toContain('tuning.historical');
	});
});

describe('errors and HMAC', () => {
	const personal: MetricsGenerationRow = { key: 'personal', users: 10, total: 20, failed: 6, failedUsers: 6, p50Ms: 123, p95Ms: 456, failures: [{ kind: 'exception', count: 6, users: 6 }] };

	test('daily HMAC is deterministic, rotates exactly at JST midnight, and needs a secret', () => {
		const at = new Date('2026-09-20T14:59:59Z');
		const same = new Date('2026-09-19T15:00:00Z');
		const next = new Date('2026-09-20T15:00:00Z');
		expect(metricsUserBucket('private-id', at, 'test-secret')).toMatch(/^u#[0-9a-f]{4}$/);
		expect(metricsUserBucket('private-id', at, 'test-secret')).toBe(metricsUserBucket('private-id', same, 'test-secret'));
		expect(metricsUserBucket('private-id', at, 'test-secret')).not.toBe(metricsUserBucket('private-id', next, 'test-secret'));
		expect(metricsUserBucket('private-id', at, undefined)).toBeNull();
		expect(metricsUserBucket('private-id', at, '')).toBeNull();
	});

	test('missing salt omits recent entirely and advertises unavailability', async () => {
		delete process.env.HANAMI_METRICS_SALT;
		const mock = mockDatabase({ genres: [personal] });
		const value = await mock.service.errors(range);
		expect(value.personal.recent).toEqual([]);
		expect(value.coverage.unavailable).toContain('personal.recent:HANAMI_METRICS_SALT missing');
		expect(mock.query.mock.calls.some(([sql]) => sql.startsWith('SELECT COALESCE') && sql.includes('FROM hanami_user_feed_batch'))).toBe(false);
	});

	test('rare failed users are suppressed even when overall successful batch users exceed five', async () => {
		process.env.HANAMI_METRICS_SALT = 'test-secret';
		const small = { ...personal, failed: 3, failedUsers: 3, failures: [{ kind: 'exception' as const, count: 3, users: 3 }] };
		const mock = mockDatabase({ genres: [small], dailyGenres: [{ ...small, day: range.from }] });
		const value = await mock.service.errors(range);
		expect(value.personal.byKind.exception).toBeNull();
		expect(value.personal.byDay[0].failed).toBeNull();
		expect(value.personal.recent).toEqual([]);
		expect(value.suppressed).toContain('personal.recent');
	});

	test('recent uses an allowlist, never emits raw SQL/messages/identifiers or arbitrary kinds', async () => {
		process.env.HANAMI_METRICS_SALT = 'test-secret';
		const value = await mockDatabase({ genres: [personal], errors: [{ at: '2026-09-01T10:00:00Z', userId: 'secret-user', kind: 'exception', attempts: 3, failureMessage: 'SQL secret-note https://secret/?token=xyz' }] }).service.errors(range);
		expect(value.personal.recent[0]).toMatchObject({ kind: 'exception', message: 'Generation failed', attempts: 3 });
		const json = JSON.stringify(value);
		for (const forbidden of ['secret-user', 'secret-note', 'token=', 'userId', 'noteId', 'failureMessage']) expect(json).not.toContain(forbidden);
		expect(sanitizeMetricsFailure('private-user-id')).toEqual({ kind: 'unknown', message: 'Generation failed (reason unavailable)' });
	});

	test('generation percentiles stay exact raw-range values and no probe is spawned', async () => {
		const value = await mockDatabase({ genres: [personal] }).service.summary(range);
		expect(value.generation.personal).toMatchObject({ p50Ms: 123, p95Ms: 456, failedRate: 0.3 });
		expect(value.generation.judge.runtime).toBeNull();
		expect(value.generation.judge.backlog).toBeNull();
	});

	test('series uses persisted personal-generation extras, preserves small failure groups, and supplements only today', async () => {
		const span = { from: '2026-09-18', to: '2026-09-20' };
		const persisted = [
			{ day: span.from, scope: 'generation', dimension: 'personal', key: 'personal', users: 10, extra: { ...personal, total: 100, failed: 5, failedUsers: 5, p50Ms: 9999, p95Ms: 99999, failures: [{ kind: 'exception', count: 5, users: 5 }] } },
			{ day: '2026-09-19', scope: 'generation', dimension: 'personal', key: 'personal', users: 10, extra: { ...personal, failed: 7, failedUsers: 7, failures: [{ kind: 'exception', count: 5, users: 5 }, { kind: 'lockTimeout', count: 2, users: 2 }] } },
			{ day: span.to, scope: 'generation', dimension: 'personal', key: 'personal', users: 10, extra: { ...personal, failed: 999 } },
		];
		const today = { ...personal, day: span.to, failed: 8, failedUsers: 8, failures: [{ kind: 'exception' as const, count: 8, users: 8 }] };
		const mock = mockDatabase({ genres: [personal], dailyGenres: [today] }, (sql, params) => {
			if (!sql.includes('FROM hanami_metrics_daily') || !sql.includes("scope = 'generation'")) return undefined;
			return persisted.filter(row => row.day >= String(params[0]) && row.day <= String(params[1]) && row.day < String(params[2]))
				.map(row => ({ ...row.extra, key: row.key, day: row.day, users: row.users }));
		});
		const value = await mock.service.summary(span);
		expect(value.series.failedBatches).toEqual([5, null, 8]);
		expect(value.suppressed).toContain('series.failedBatches.2026-09-19');
		expect(value.generation.personal).toMatchObject({ p50Ms: 123, p95Ms: 456, failed: null, failedRate: null });
		expect(Object.values(value.generation.personal.failedByKind)).toEqual([null, null, null, null, null]);
		const [dailySql, params] = mock.query.mock.calls.find(([sql]) => sql.includes("scope = 'generation'"))!;
		expect(params).toEqual([span.from, span.to, span.to]);
		expect(dailySql).toContain("dimension = 'personal' AND key = 'personal'");
		expect(dailySql).toContain("(extra->>'failed')::int AS failed");
		expect(dailySql).toContain("COALESCE((extra->>'failedUsers')::int, 0)");
		expect(dailySql).toContain("COALESCE(extra->'failures', '[]'::jsonb)");
		const runs = mock.query.mock.calls.filter(([sql]) => sql.startsWith('WITH runs'));
		expect(runs).toHaveLength(2);
		expect(runs.find(([sql]) => sql.includes('r.day'))?.[1]).toEqual(rangeParameters({ from: span.to, to: span.to }));
		expect(runs.find(([sql]) => !sql.includes('r.day'))?.[1]).toEqual(rangeParameters(span));
	});

	test('range failure totals cannot reconstruct suppressed daily failures by subtraction', async () => {
		const daily = { ...personal, day: range.from, failedUsers: 2, failed: 2, failures: [{ kind: 'exception' as const, count: 2, users: 2 }] };
		const mock = mockDatabase({ genres: [personal], dailyGenres: [daily] });
		const summary = await mock.service.summary(range);
		expect(summary.generation.personal.failed).toBeNull();
		expect(summary.generation.personal.failedRate).toBeNull();
		expect(Object.values(summary.generation.personal.failedByKind)).toEqual([null, null, null, null, null]);
		const errors = await mock.service.errors(range);
		expect(errors.personal.byDay[0].failed).toBeNull();
		expect(Object.values(errors.personal.byKind)).toEqual([null, null, null, null, null]);
	});
});

test('stats has only weekly exact-user series and source metrics, with defensive 60-second cache', async () => {
	const mock = mockDatabase({ totals: [row('total', 5)], dimensions: [row('exploration', 5)] });
	const value = await mock.service.stats({ from: '2026-09-01', to: '2026-09-14' });
	const calls = mock.query.mock.calls.length;
	expect(value.series).toHaveLength(2);
	expect(value.series.map(week => week.hanamiUsers)).toEqual([5, 5]);
	for (const forbidden of ['userId', 'noteId', 'trendTerm', 'hanamiUsers":[', 'completeDays']) expect(JSON.stringify(value)).not.toContain(forbidden);
	value.sources.length = 0;
	expect((await mock.service.stats({ from: '2026-09-01', to: '2026-09-14' })).sources).toHaveLength(1);
	expect(mock.query.mock.calls).toHaveLength(calls);
});
