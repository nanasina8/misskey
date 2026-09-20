/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import HanamiTimelineChart from '@/core/chart/charts/hanami-timeline.js';
import { entity, schema, timelineKinds } from '@/core/chart/charts/entities/hanami-timeline.js';
import ChartEndpoint, { meta as chartMeta } from '@/server/api/endpoints/charts/hanami-timeline.js';
import HomeEndpoint from '@/server/api/endpoints/notes/timeline.js';
import LocalEndpoint from '@/server/api/endpoints/notes/local-timeline.js';
import SocialEndpoint from '@/server/api/endpoints/notes/hybrid-timeline.js';
import GlobalEndpoint from '@/server/api/endpoints/notes/global-timeline.js';
import HanamiEndpoint from '@/server/api/endpoints/notes/hanami-timeline.js';
import type { HanamiTimelineKind } from '@/core/chart/charts/entities/hanami-timeline.js';
import type { HanamiMetricsTimelineHealthService } from '@/core/hanami/HanamiMetricsTimelineHealthService.js';

// In-memory repositories exercise the REAL Chart.commit/save/uniqueIncrement code.
// Only TypeORM I/O and its two generated update expressions are simulated; no DB.
function repository() {
	const rows = new Map<number, Record<string, number | string[]>>();
	const repo = {
		rows,
		extend: () => repo,
		findOneBy: async ({ date }: { date: number }) => {
			if (!rows.has(date)) {
				const row: Record<string, number | string[]> = { id: date, date };
				for (const kind of timelineKinds) {
					row[`___${kind}_users`] = 0;
					row[`___${kind}_requests`] = 0;
					row[`unique_temp___${kind}_users`] = [];
				}
				rows.set(date, row);
			}
			return rows.get(date);
		},
		createQueryBuilder: () => {
			let id = 0;
			let values: Record<string, number | (() => string)> = {};
			const qb = {
				update: () => qb,
				set: (v: typeof values) => { values = v; return qb; },
				where: (_sql: string, params: { id: number }) => { id = params.id; return qb; },
				execute: async () => {
					const row = rows.get(id);
					if (!row) throw new Error('Missing mock chart row');
					for (const [column, value] of Object.entries(values)) {
						if (typeof value === 'number') {
							row[column] = value;
						} else if (column.startsWith('unique_temp___')) {
							const match = value().match(/'\{(.*)\}'::varchar\[\]/);
							if (!match) throw new Error('Unexpected mock array update');
							row[column] = [...row[column] as string[], ...JSON.parse(`[${match[1]}]`)];
						} else {
							const match = value().match(/\+ (\d+)$/);
							if (!match) throw new Error('Unexpected mock counter update');
							row[column] = (row[column] as number) + Number(match[1]);
						}
					}
				},
			};
			return qb;
		},
	};
	return repo;
}

function makeChart(
	query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockResolvedValue([]),
	health?: Pick<HanamiMetricsTimelineHealthService, 'begin' | 'finish'>,
) {
	const hour = repository();
	const day = repository();
	const logger = { info: jest.fn(), warn: jest.fn() };
	const db = {
		query,
		getRepository: (e: { options: { tableName: string } }) => e.options.tableName.startsWith('__chart_day__') ? day : hour,
	};
	const chart = new HanamiTimelineChart(db as never, {} as never, { logger } as never, health as HanamiMetricsTimelineHealthService | undefined);
	return { chart, query, logger, hour, day };
}

const previousSalt = process.env.HANAMI_METRICS_SALT;
beforeEach(() => { delete process.env.HANAMI_METRICS_SALT; });
afterEach(() => {
	jest.useRealTimers();
	if (previousSalt == null) delete process.env.HANAMI_METRICS_SALT;
	else process.env.HANAMI_METRICS_SALT = previousSalt;
});

describe('HanamiTimelineChart (no external services)', () => {
	test('defines all five unique user and request columns in both migration entities', () => {
		expect(Object.keys(schema)).toHaveLength(10);
		expect(entity.hour.options.tableName).toBe('__chart__hanami_timeline');
		expect(entity.day.options.tableName).toBe('__chart_day__hanami_timeline');
		for (const kind of timelineKinds) {
			expect(schema[`${kind}.users`]).toEqual({ uniqueIncrement: true });
			for (const e of [entity.hour, entity.day]) {
				expect(e.options.columns[`___${kind}_requests`]).toMatchObject({ type: 'integer', default: 0 });
				expect(e.options.columns[`unique_temp___${kind}_users`]).toMatchObject({ type: 'varchar', array: true });
			}
		}
	});

	test('deduplicates a user within a day and across hourly saves for every kind, resetting the next UTC day', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-09-20T01:00:00Z'));
		const { chart, hour, day } = makeChart();
		for (const kind of timelineKinds) {
			await chart.hit(kind, 'user1');
			await chart.hit(kind, 'user1');
			await chart.hit(kind, 'user2');
		}
		await chart.save();
		jest.setSystemTime(new Date('2026-09-20T02:00:00Z'));
		for (const kind of timelineKinds) await chart.hit(kind, 'user1');
		await chart.save();
		for (const kind of timelineKinds) {
			expect([...day.rows.values()][0][`___${kind}_users`]).toBe(2);
			expect([...day.rows.values()][0][`___${kind}_requests`]).toBe(4);
			expect([...hour.rows.values()][1][`___${kind}_users`]).toBe(1);
		}
		jest.setSystemTime(new Date('2026-09-21T00:00:00Z'));
		for (const kind of timelineKinds) await chart.hit(kind, 'user1');
		await chart.save();
		for (const kind of timelineKinds) {
			expect([...day.rows.values()][1][`___${kind}_users`]).toBe(1);
			expect([...day.rows.values()][1][`___${kind}_requests`]).toBe(1);
		}
	});

	test('anonymous requests never create a synthetic user; JST upsert is parameterized and atomic', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-09-20T01:00:00Z'));
		const { chart, day, query } = makeChart();
		for (const kind of timelineKinds) {
			await chart.hit(kind, null);
			await chart.hit(kind, null);
		}
		await chart.save();
		for (const kind of timelineKinds) {
			const row = [...day.rows.values()][0];
			expect(row[`___${kind}_users`]).toBe(0);
			expect(row[`___${kind}_requests`]).toBe(2);
			expect(row[`unique_temp___${kind}_users`]).toEqual([]);
			expect(query.mock.calls.filter(([, params]) => params[1] === kind)).toHaveLength(2);
			expect(query).toHaveBeenCalledWith(expect.any(String), ['2026-09-20', kind, null]);
		}
		const sql = query.mock.calls[0][0];
		expect(sql).toContain('VALUES ($1::date, $2, $3, 1)');
		expect(sql).not.toContain('clock_timestamp');
		expect(sql).toContain('ON CONFLICT ("day", "kind", "userId") DO UPDATE');
		expect(sql).toContain('"hanami_metrics_timeline"."requests" + EXCLUDED."requests"');
	});

	test('HMACs temporary chart identifiers with configured salt, while the JST FK uses the real ID', async () => {
		process.env.HANAMI_METRICS_SALT = 'unit-test-only-secret';
		const { chart, day, query } = makeChart();
		await chart.hit('home', 'user1');
		await chart.hit('home', 'user1');
		await chart.save();
		const row = [...day.rows.values()][0];
		expect(new Set(row.unique_temp___home_users as string[])).toEqual(new Set([
			createHmac('sha256', 'unit-test-only-secret').update('user1').digest('hex'),
		]));
		expect(row.___home_users).toBe(1);
		expect(JSON.stringify(row)).not.toContain('user1');
		expect(query).toHaveBeenCalledTimes(2);
		expect(query).toHaveBeenCalledWith(expect.any(String), [expect.any(String), 'home', 'user1']);
	});

	test('without a salt uses only the established internal ID key, not a fabricated salt', async () => {
		const { chart, day } = makeChart();
		await chart.hit('hanami', 'user1');
		await chart.save();
		expect([...day.rows.values()][0].unique_temp___hanami_users).toEqual(['user1']);
	});

	test('awaits slow persistence without dropping requests above 32 outstanding upserts', async () => {
		let release!: (value: unknown) => void;
		const pending = new Promise(resolve => { release = resolve; });
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockReturnValue(pending);
		const { chart, day, logger } = makeChart(query);
		let completed = 0;
		const hits = Array.from({ length: 40 }, () => chart.hit('home', 'user1').then(() => { completed++; }));
		await Promise.resolve();
		expect(completed).toBe(0);
		expect(query).toHaveBeenCalledTimes(40);
		expect(logger.warn).not.toHaveBeenCalled();
		await chart.save();
		expect([...day.rows.values()][0].___home_requests).toBe(40);
		release([]);
		await Promise.all(hits);
		expect(completed).toBe(40);
		await chart.hit('home', 'user1');
		expect(query).toHaveBeenCalledTimes(41);
	});

	test('keeps the request JST day when a queued write crosses midnight', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-09-20T14:59:59.999Z'));
		let release!: () => void;
		const queued = new Promise<void>(resolve => { release = resolve; });
		const persisted: unknown[][] = [];
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockImplementation(async (_sql, params) => {
			await queued;
			persisted.push(params);
		});
		const { chart } = makeChart(query);
		const beforeMidnight = chart.hit('local', null);
		jest.setSystemTime(new Date('2026-09-20T15:00:00.000Z'));
		const atMidnight = chart.hit('local', 'user1');
		release();
		await Promise.all([beforeMidnight, atMidnight]);
		expect(persisted).toEqual([
			['2026-09-20', 'local', null],
			['2026-09-21', 'local', 'user1'],
		]);
	});

	test.each(['sync', 'async'])('isolates %s DB failures without logging IDs or preventing chart commits', async (mode) => {
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockImplementation(() => {
			if (mode === 'sync') throw new Error('private-user-id');
			return Promise.reject(new Error('private-user-id'));
		});
		const { chart, day, logger } = makeChart(query);
		await expect(chart.hit('home', 'private-user-id')).resolves.toBeUndefined();
		await chart.save();
		expect([...day.rows.values()][0].___home_requests).toBe(1);
		expect(logger.warn).toHaveBeenCalledWith('hanamiTimeline: JST counter write failed; collection gap');
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-user-id');
	});

	test('chart commit and logger failures cannot escape or prevent the separate JST write', async () => {
		const { chart, query, logger } = makeChart();
		jest.spyOn(chart as unknown as { commit: () => void }, 'commit').mockImplementation(() => { throw new Error('commit'); });
		logger.warn.mockImplementation(() => { throw new Error('logger'); });
		await expect(chart.hit('home', 'user1')).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(1);
	});

	test('a failed counter and failed logger still resolve, and subsequent requests attempt persistence', async () => {
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>()
			.mockRejectedValueOnce(new Error('private-user-id')).mockResolvedValue([]);
		const { chart, logger } = makeChart(query);
		logger.warn.mockImplementation(() => { throw new Error('logger'); });
		await expect(chart.hit('home', 'private-user-id')).resolves.toBeUndefined();
		await expect(chart.hit('home', 'user1')).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(2);
	});

	test('registers health synchronously and finishes the captured day only after persistence', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-09-20T14:59:59.999Z'));
		const health = { begin: jest.fn<(day: string) => void>(), finish: jest.fn<(day: string, ok: boolean) => void>() };
		let release!: () => void;
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockImplementation(() => {
			expect(health.begin).toHaveBeenCalledWith('2026-09-20');
			return new Promise<void>(resolve => { release = resolve; });
		});
		const { chart } = makeChart(query, health);
		const hit = chart.hit('local', null);
		expect(health.begin).toHaveBeenCalledTimes(1);
		expect(health.finish).not.toHaveBeenCalled();
		jest.setSystemTime(new Date('2026-09-20T15:00:00Z'));
		release();
		await hit;
		expect(health.finish).toHaveBeenCalledTimes(1);
		expect(health.finish).toHaveBeenCalledWith('2026-09-20', true);
	});

	test.each(['sync', 'async'])('%s counter failure finishes health false exactly once without retrying', async mode => {
		const health = { begin: jest.fn(), finish: jest.fn() };
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockImplementation(() => {
			if (mode === 'sync') throw new Error('private-id');
			return Promise.reject(new Error('private-id'));
		});
		const { chart } = makeChart(query, health);
		await expect(chart.hit('home', 'private-id')).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(1);
		expect(health.finish).toHaveBeenCalledTimes(1);
		expect(health.finish).toHaveBeenCalledWith(health.begin.mock.calls[0][0], false);
	});

	test('health failures never break serving, skip counters, or expose identifiers', async () => {
		const health = {
			begin: jest.fn(() => { throw new Error('private-id'); }),
			finish: jest.fn(() => { throw new Error('private-id'); }),
		};
		const { chart, query, logger } = makeChart(undefined, health);
		await expect(chart.hit('home', null)).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(1);
		expect(health.finish).toHaveBeenCalledWith(expect.any(String), true);
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-id');
	});
});

const user = { id: 'user1' } as never;

function restHarness(kind: HanamiTimelineKind, useFanout = true) {
	const hit = jest.fn<(kind: HanamiTimelineKind, userId: string | null) => Promise<void>>().mockResolvedValue(undefined);
	const metrics = { hit } as never;
	const settings = { enableFanoutTimeline: useFanout } as never;
	const active = { read: jest.fn() } as never;
	const pack = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
	const noteEntity = { packMany: pack } as never;
	const timeline = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
	const fanout = { timeline } as never;
	const getUserPolicies = jest.fn(async () => ({ ltlAvailable: true, gtlAvailable: true }));
	const roles = { getUserPolicies } as never;
	const fetch = async () => ({});
	const cache = {
		userFollowingsCache: { fetch }, userMutingsCache: { fetch: async () => new Set() },
		userBlockedCache: { fetch: async () => new Set() },
		userProfileCache: { fetch: async () => ({ mutedInstances: [] }) },
	} as never;
	const getMany = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
	const qb = {
		andWhere: () => qb, innerJoinAndSelect: () => qb, leftJoinAndSelect: () => qb,
		limit: () => qb, getMany,
	};
	const notes = { createQueryBuilder: () => qb } as never;
	const query = {
		makePaginationQuery: () => qb,
		generateBaseNoteFilteringQuery: jest.fn(), generateMutedUserRenotesQueryForNotes: jest.fn(),
	} as never;
	const unused = {} as never;
	const serve = jest.fn<() => Promise<unknown>>().mockResolvedValue({ kind: 'ok', response: { items: [], mode: 'common' } });
	const endpoint = kind === 'home'
		? new HomeEndpoint(settings, notes, noteEntity, active, unused, cache, fanout, unused, unused, unused, query, metrics)
		: kind === 'local'
			? new LocalEndpoint(settings, notes, noteEntity, roles, active, unused, fanout, query, unused, metrics)
			: kind === 'social'
				? new SocialEndpoint(settings, notes, noteEntity, roles, active, unused, cache, query, unused, unused, unused, fanout, metrics)
				: kind === 'global'
					? new GlobalEndpoint(notes, noteEntity, cache, query, roles, active, metrics)
					: new HanamiEndpoint({ serve } as never, metrics);
	if ('getFromDb' in endpoint) {
		jest.spyOn(endpoint as unknown as { getFromDb: () => Promise<unknown[]> }, 'getFromDb').mockImplementation(getMany);
	}
	return { endpoint, hit, pack, timeline, getUserPolicies, serve, getMany };
}

describe('successful REST response instrumentation', () => {
	const successCases: [HanamiTimelineKind, boolean, boolean, 'common' | 'personalized'][] = [
		['home', false, false, 'common'], ['home', true, false, 'common'],
		['local', false, false, 'common'], ['local', true, false, 'common'],
		['local', false, true, 'common'], ['local', true, true, 'common'],
		['social', false, false, 'common'], ['social', true, false, 'common'],
		['global', false, false, 'common'], ['global', false, true, 'common'],
		['hanami', false, false, 'common'], ['hanami', false, false, 'personalized'],
	];

	test.each(successCases)('%s fanout=%s anonymous=%s mode=%s awaits the real counter before returning', async (kind, fanout, anonymous, mode) => {
		let entered!: () => void;
		let release!: () => void;
		const writing = new Promise<void>(resolve => { entered = resolve; });
		const pending = new Promise<void>(resolve => { release = resolve; });
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockImplementation(() => {
			entered();
			return pending;
		});
		const { chart } = makeChart(query);
		const { endpoint, hit, serve } = restHarness(kind, fanout);
		hit.mockImplementation(chart.hit);
		serve.mockResolvedValue({ kind: 'ok', response: { items: [], mode } });
		let returned = false;
		const response = endpoint.exec(kind === 'hanami' ? {} : { untilId: 'abc123' }, anonymous ? null as never : user, null).then(result => {
			returned = true;
			return result;
		});
		await Promise.race([writing, response.then(() => { throw new Error('Returned without attempting persistence'); })]);
		// Let an incorrectly un-awaited endpoint finish before checking the gate.
		await new Promise<void>(resolve => { setImmediate(resolve); });
		expect(returned).toBe(false);
		expect(query).toHaveBeenCalledTimes(1);
		release();
		await expect(response).resolves.toEqual(kind === 'hanami' ? { items: [], mode } : []);
		expect(returned).toBe(true);
	});

	test.each(successCases)('%s fanout=%s anonymous=%s mode=%s still serves when the real counter fails', async (kind, fanout, anonymous, mode) => {
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('private-user-id'));
		const { chart, logger } = makeChart(query);
		const { endpoint, hit, serve } = restHarness(kind, fanout);
		hit.mockImplementation(chart.hit);
		serve.mockResolvedValue({ kind: 'ok', response: { items: [], mode } });
		await expect(endpoint.exec({}, anonymous ? null as never : user, null))
			.resolves.toEqual(kind === 'hanami' ? { items: [], mode } : []);
		expect(query).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith('hanamiTimeline: JST counter write failed; collection gap');
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-user-id');
	});

	test.each<HanamiTimelineKind>(['home', 'local', 'social'])('%s counts exactly once in DB and fanout branches, including paginated empty responses', async (kind) => {
		for (const fanout of [false, true]) {
			const { endpoint, hit } = restHarness(kind, fanout);
			await expect(endpoint.exec({ untilId: 'abc123' }, user, null)).resolves.toEqual([]);
			expect(hit).toHaveBeenCalledTimes(1);
			expect(hit).toHaveBeenCalledWith(kind, 'user1');
		}
	});

	test.each<HanamiTimelineKind>(['home', 'local', 'social'])('%s excludes rejected fanout, DB query, and packing responses', async (kind) => {
		for (const failure of ['fanout', 'query', 'packing']) {
			const { endpoint, hit, timeline, getMany, pack } = restHarness(kind, failure === 'fanout');
			(failure === 'fanout' ? timeline : failure === 'query' ? getMany : pack).mockRejectedValue(new Error('serving failed'));
			await expect(endpoint.exec({}, user, null)).rejects.toThrow('serving failed');
			expect(hit).not.toHaveBeenCalled();
		}
	});

	test('local/global anonymous requests pass null, never a fake user ID', async () => {
		for (const [kind, fanout] of [['local', false], ['local', true], ['global', false]] as const) {
			const { endpoint, hit } = restHarness(kind, fanout);
			await expect(endpoint.exec({}, null as never, null)).resolves.toEqual([]);
			expect(hit).toHaveBeenCalledTimes(1);
			expect(hit).toHaveBeenCalledWith(kind, null);
		}
	});

	test('global counts authenticated success only after packing; failed packing is not counted', async () => {
		const { endpoint, hit, pack } = restHarness('global');
		await endpoint.exec({}, user, null);
		expect(hit).toHaveBeenCalledWith('global', 'user1');
		hit.mockClear();
		pack.mockRejectedValue(new Error('packing'));
		await expect(endpoint.exec({}, user, null)).rejects.toThrow('packing');
		expect(hit).not.toHaveBeenCalled();
	});

	test.each<HanamiTimelineKind>(['local', 'social', 'global'])('%s policy denial does not count', async (kind) => {
		const { endpoint, hit, getUserPolicies } = restHarness(kind);
		getUserPolicies.mockResolvedValue({ ltlAvailable: false, gtlAvailable: false });
		await expect(endpoint.exec({}, user, null)).rejects.toThrow();
		expect(hit).not.toHaveBeenCalled();
	});

	test.each(['common', 'personalized'])('hanami %s success counts once', async (mode) => {
		const { endpoint, hit, serve } = restHarness('hanami');
		serve.mockResolvedValue({ kind: 'ok', response: { items: [], mode } });
		await expect(endpoint.exec({}, user, null)).resolves.toEqual({ items: [], mode });
		expect(hit).toHaveBeenCalledTimes(1);
		expect(hit).toHaveBeenCalledWith('hanami', 'user1');
	});

	test.each(['roleDisabled', 'invalidCursor', 'cursorExpired', 'commonNotReady', 'invalidRefreshToken', 'refreshTokenExpired', 'refreshRateLimited'])('hanami %s does not count', async (kind) => {
		const { endpoint, hit, serve } = restHarness('hanami');
		serve.mockResolvedValue({ kind });
		await expect(endpoint.exec({}, user, null)).rejects.toThrow();
		expect(hit).not.toHaveBeenCalled();
	});

	test('hanami validation and service failures do not count', async () => {
		const { endpoint, hit, serve } = restHarness('hanami');
		await expect(endpoint.exec({ refresh: true }, user, null)).rejects.toThrow();
		expect(serve).not.toHaveBeenCalled();
		serve.mockRejectedValue(new Error('serve'));
		await expect(endpoint.exec({}, user, null)).rejects.toThrow('serve');
		expect(hit).not.toHaveBeenCalled();
	});
});

describe('admin chart API contract', () => {
	test('requires admin credentials and exposes only ten numeric series', () => {
		expect(chartMeta).toMatchObject({ requireAdmin: true, requireCredential: true, kind: 'read:admin:queue' });
		expect(Object.keys(chartMeta.res.properties)).toEqual([...timelineKinds]);
		for (const kind of timelineKinds) {
		expect(chartMeta.res.properties[kind].properties).toEqual({
				users: { type: 'array', items: { type: 'number', nullable: true, optional: false }, nullable: false, optional: false },
				requests: { type: 'array', items: { type: 'number', nullable: true, optional: false }, nullable: false, optional: false },
		});
		}
		expect(JSON.stringify(chartMeta.res)).not.toMatch(/userId|unique_temp/);
	});

	test('validates chart params and preserves an epoch-zero offset', async () => {
		const getChart = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(
			Object.fromEntries(timelineKinds.map(kind => [kind, { users: [4, null, 5, 0], requests: [10, 0, 20, 0] }])),
		);
		const endpoint = new ChartEndpoint({ getChart } as never);
		const result = await endpoint.exec({ span: 'day', offset: 0 }, user, null);
		expect(result.home).toEqual({ users: [null, null, 5, 0], requests: [null, 0, 20, 0] });
		expect(getChart).toHaveBeenCalledWith('day', 30, new Date(0));
		await endpoint.exec({ span: 'hour' }, user, null);
		expect(getChart).toHaveBeenCalledWith('hour', 30, null);
		await expect(endpoint.exec({ span: 'week' }, user, null)).rejects.toThrow();
		await expect(endpoint.exec({ span: 'day', limit: 501 }, user, null)).rejects.toThrow();
		expect(getChart).toHaveBeenCalledTimes(2);
	});
});
