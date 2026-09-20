/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import _Ajv from 'ajv';
import type { Schema } from '@/misc/json-schema.js';
import { HanamiMetricsQueryService } from '@/core/hanami/HanamiMetricsQueryService.js';
import {
	breakdownParamDef, breakdownResponseSchema, errorsResponseSchema, metricsDimensions,
	rangeParamDef, statsResponseSchema, summaryResponseSchema,
} from '@/server/api/endpoints/admin/hanami/metrics/schemas.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Only infrastructure dependencies are mocked: Endpoint's AJV validation and
// ApiCallService's actual credential/admin/scope guards run unchanged.
jest.unstable_mockModule('../../src/core/RoleService.js', () => ({ RoleService: class {} }));
jest.unstable_mockModule('../../src/core/UserService.js', () => ({ UserService: class {} }));
jest.unstable_mockModule('../../src/server/api/RateLimiterService.js', () => ({ RateLimiterService: class {} }));
jest.unstable_mockModule('../../src/server/api/ApiLoggerService.js', () => ({ ApiLoggerService: class {} }));
jest.unstable_mockModule('../../src/server/api/AuthenticateService.js', () => ({ AuthenticateService: class {}, AuthenticationError: class extends Error {} }));

const { ApiCallService } = await import('../../src/server/api/ApiCallService.js');

// Exercise real wrappers and the real query service with storage doubles only.
async function loadEndpoints() {
	return {
		summary: await import('../../src/server/api/endpoints/admin/hanami/metrics/summary.js'),
		breakdown: await import('../../src/server/api/endpoints/admin/hanami/metrics/breakdown.js'),
		errors: await import('../../src/server/api/endpoints/admin/hanami/metrics/errors.js'),
		stats: await import('../../src/server/api/endpoints/hanami/stats.js'),
	};
}

const endpoints = [
	{ name: 'admin/hanami/metrics/summary', method: 'summary', schema: summaryResponseSchema, params: {} },
	{ name: 'admin/hanami/metrics/breakdown', method: 'breakdown', schema: breakdownResponseSchema, params: { dimension: 'source' } },
	{ name: 'admin/hanami/metrics/errors', method: 'errors', schema: errorsResponseSchema, params: {} },
	{ name: 'hanami/stats', method: 'stats', schema: statsResponseSchema, params: {} },
] as const;

const ajv = new _Ajv.default({ strict: false }); // optional is backend response-schema metadata.
const admin = { id: 'admin', isSuspended: false } as never;
const range = { from: '2026-09-01', to: '2026-09-07' };
const coverage: Awaited<ReturnType<HanamiMetricsQueryService['summary']>>['coverage'] = {
	status: 'unavailable', startedAt: null, retainedFrom: '2026-06-08',
	completeDays: [], partialDays: ['2026-09-01'], outcomesThrough: '2026-09-05', unavailable: [],
};
const nullCounts = { users: null, served: null, seen: null, reaction: null, reply: null, renote: null };
const nullRates = { share: null, engagementRate: null, seenRate: null, engagementPerSeen: null, lift: null, engagementShare: null };
const failureKinds = { emptyResult: null, candidateLimit: null, lockTimeout: null, exception: null, unknown: null };
const usage = {
	hanamiUsers: { day: null, week: null, month: null },
	tlShare: { home: null, local: null, social: null, global: null, hanami: null },
};
const responses = {
	summary: {
		range, coverage, suppressed: ['engagement'], denominator: 'visible',
		usage: { ...usage, manualRefreshPerUserDay: null, rateLimited429: null },
		engagement: { users: null, served: null, seen: null, reaction: null, reply: null, renote: null, engagementRate: null, seenRate: null, normalBaseline: { reaction: null, reply: null, renote: null } },
		generation: {
			personal: { batches: null, failed: null, failedRate: null, p50Ms: null, p95Ms: null, failedByKind: failureKinds },
			common: { generations: null, failed: null, p50Ms: null, p95Ms: null },
			judge: { runs: null, failed: null, p50Ms: null, p95Ms: null, backlog: null, secPerNote: null, runtime: null },
		},
		series: { day: ['2026-09-01'], hanamiUsers: [null], engagementRate: [null], failedBatches: [null] },
	},
	breakdown: { range, dimension: 'source', denominator: 'visible', coverage, rows: [{ key: 'fof', ...nullCounts, ...nullRates }], suppressed: ['fof'] },
	errors: {
		range, coverage, suppressed: ['personal.byDay.2026-09-01'],
		personal: { byKind: failureKinds, byDay: [{ day: '2026-09-01', failed: null }], recent: [{ at: '2026-09-01T00:00:00.000Z', kind: 'unknown', attempts: 1, message: 'Generation failed (reason unavailable)', userBucket: 'u#abcd' }] },
		common: { recent: [] }, judge: { recent: [], backlog: null }, rateLimited: { byDay: [] },
	},
	stats: {
		range, coverage: { status: 'unavailable', unavailable: [] }, suppressed: ['fof'], denominator: 'visible', usage, engagement: { engagementRate: null },
		sources: [{ key: 'fof', share: null, engagementRate: null, lift: null }],
		series: [{ week: '2026-09-01', hanamiUsers: null, engagementRate: null }],
	},
} satisfies { [K in 'summary' | 'breakdown' | 'errors' | 'stats']: Awaited<ReturnType<HanamiMetricsQueryService[K]>> };

function queryMock() {
	return {
		summary: jest.fn(async (_range?: unknown) => responses.summary),
		breakdown: jest.fn(async (_params: unknown) => responses.breakdown),
		errors: jest.fn(async (_range?: unknown) => responses.errors),
		stats: jest.fn(async (_range?: unknown) => responses.stats),
	};
}

describe('HM-IMPLEMENT metrics request boundary', () => {
	test.each([7, 14, 30, 90])('accepts days=%i and exact date ranges', (days) => {
		const validate = ajv.compile(rangeParamDef);
		expect(validate({ range: { days } })).toBe(true);
		expect(validate({ range })).toBe(true);
		expect(validate({})).toBe(true);
	});

	test.each([
		null, {}, { days: 1 }, { days: 91 }, { days: 7.5 }, { days: '7' },
		{ from: '2026-09-01' }, { to: '2026-09-07' },
		{ from: '2026-9-01', to: '2026-09-07' },
		{ from: '2026-09-01T00:00:00Z', to: '2026-09-07' },
		{ days: 7, ...range }, { days: 7, from: range.from },
		{ ...range, extra: true }, { days: 7, extra: true },
	])('rejects malformed or mixed range %j before calling the service', async (invalidRange) => {
		const modules = await loadEndpoints();
		for (const endpoint of endpoints) {
			const query = queryMock();
			const instance = new modules[endpoint.method].default(query as unknown as HanamiMetricsQueryService);
			await expect(instance.exec({ ...endpoint.params, range: invalidRange }, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
			expect(query[endpoint.method]).not.toHaveBeenCalled();
		}
	});

	test.each(metricsDimensions)('accepts allowlisted dimension and string filter %s', (dimension) => {
		const validate = ajv.compile(breakdownParamDef);
		expect(validate({ dimension, filter: { [dimension]: 'value' } })).toBe(true);
	});

	test.each([
		{}, { dimension: 'userId' }, { dimension: 'noteId' }, { dimension: 'source', filter: { userId: 'private' } },
		{ dimension: 'source', filter: { contentType: 2 } }, { dimension: 'source', filter: null },
		{ dimension: 'source', filter: [] }, { dimension: 'source', filter: { source: ['exploration'] } },
		{ dimension: 'source', filter: { trendTerm: 'x'.repeat(129) } },
		{ dimension: 'source', noteId: 'private' },
	])('rejects unsupported breakdown params %j', async (params) => {
		const { breakdown } = await loadEndpoints();
		const query = queryMock();
		await expect(new breakdown.default(query as unknown as HanamiMetricsQueryService).exec(params, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(query.breakdown).not.toHaveBeenCalled();
	});

	test.each(endpoints)('$name is a thin wrapper and preserves null suppression and coverage', async (endpoint) => {
		const module = (await loadEndpoints())[endpoint.method];
		const query = queryMock();
		const instance = new module.default(query as unknown as HanamiMetricsQueryService);
		await expect(instance.exec({ ...endpoint.params, range }, admin, null)).resolves.toBe(responses[endpoint.method]);
		expect(query[endpoint.method]).toHaveBeenCalledWith(endpoint.method === 'breakdown' ? { range, dimension: 'source', filter: undefined } : range);
		await instance.exec(endpoint.params, admin, null);
		expect(query[endpoint.method]).toHaveBeenLastCalledWith(endpoint.method === 'breakdown' ? { range: undefined, dimension: 'source', filter: undefined } : undefined);
	});

	test('forwards all filters without inventing query behavior or a normal-TL rate', async () => {
		const { breakdown } = await loadEndpoints();
		const query = queryMock();
		const params = { range: { days: 14 }, dimension: 'contentType', filter: { source: 'exploration', media: 'text' } };
		await new breakdown.default(query as unknown as HanamiMetricsQueryService).exec(params, admin, null);
		expect(query.breakdown).toHaveBeenCalledWith(params);
	});

	test('preserves unexpected service failures instead of returning successful fake-zero data', async () => {
		const modules = await loadEndpoints();
		for (const endpoint of endpoints) {
			const error = new Error('Unexpected query failure');
			const query = queryMock();
			query[endpoint.method].mockRejectedValueOnce(error);
			await expect(new modules[endpoint.method].default(query as unknown as HanamiMetricsQueryService).exec({ ...endpoint.params, range }, admin, null)).rejects.toBe(error);
		}
	});

	test.each([
		{ from: '2026-02-30', to: '2026-03-01' },
		{ from: '2026-09-07', to: '2026-09-01' },
		{ from: '2026-01-01', to: '2026-04-01' },
		{ from: '9999-01-01', to: '9999-01-01' },
	])('maps real service range validation to a 400 without querying storage: %j', async (invalidRange) => {
		const modules = await loadEndpoints();
		for (const endpoint of endpoints) {
			const query = jest.fn(async () => []);
			const service = new HanamiMetricsQueryService({ query } as never);
			await expect(new modules[endpoint.method].default(service).exec({ ...endpoint.params, range: invalidRange }, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
			expect(query).not.toHaveBeenCalled();
		}
	});

	test('rejects same-dimension filters via real service validation', async () => {
		const { breakdown } = await loadEndpoints();
		const query = jest.fn(async () => []);
		await expect(new breakdown.default(new HanamiMetricsQueryService({ query } as never)).exec({ dimension: 'source', filter: { source: 'exploration' } }, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
		expect(query).not.toHaveBeenCalled();
	});

	test.each([
		{ from: '2026-01-01', to: '2026-03-31' }, // 90 days inclusive.
		{ from: '2024-02-29', to: '2024-02-29' }, // A real leap day, one-day range.
	])('accepts the real service calendar boundary %j', async (validRange) => {
		const { breakdown } = await loadEndpoints();
		const query = new HanamiMetricsQueryService({ query: async () => [] } as never);
		await expect(new breakdown.default(query).exec({ dimension: 'source', range: validRange }, admin, null)).resolves.toMatchObject({ range: validRange });
	});
});

describe('HM-IMPLEMENT explicit response and privacy contracts', () => {
	test.each(endpoints)('$name declares and accepts nullable suppressed aggregates with coverage', (endpoint) => {
		const validate = ajv.compile(endpoint.schema);
		expect(validate(responses[endpoint.method])).toBe(true);
		expect(validate({ ...responses[endpoint.method], coverage: undefined })).toBe(false);
		for (const field of ['userId', 'noteId', 'text']) {
			expect(validate({ ...responses[endpoint.method], [field]: 'private-canary' })).toBe(false);
		}
	});

	function audit(schema: Schema, forbidden: string[]) {
		expect(schema.type).not.toBe('any');
		if (schema.type === 'object') {
			expect(schema.additionalProperties).toBe(false);
			expect(schema.properties).toBeDefined();
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			expect(forbidden).not.toContain(key);
			audit(child, forbidden);
		}
		if (schema.items) audit(schema.items, forbidden);
	}

	test('all aggregate schemas are closed, explicitly typed, and identifier/content free', () => {
		for (const schema of [summaryResponseSchema, breakdownResponseSchema, errorsResponseSchema, statsResponseSchema]) {
			audit(schema, ['userId', 'noteId', 'text', 'authorId', 'clusterId']);
		}
	});

	test('stats has only weekly series and source metrics, never terms, errors or raw counts', () => {
		audit(statsResponseSchema, ['userId', 'noteId', 'text', 'term', 'trendTerm', 'cluster', 'message', 'userBucket', 'served', 'reaction', 'reply', 'renote']);
		expect(Object.keys(statsResponseSchema.properties.series.items.properties)).toEqual(['week', 'hanamiUsers', 'engagementRate']);
		const validate = ajv.compile(statsResponseSchema);
		expect(validate({ ...responses.stats, series: [{ ...responses.stats.series[0], day: '2026-09-01' }] })).toBe(false);
		expect(validate({ ...responses.stats, sources: [{ ...responses.stats.sources[0], term: 'private-canary' }] })).toBe(false);
	});

	test.each(endpoints)('$name real service output matches the explicit schema without storage access', async (endpoint) => {
		const module = (await loadEndpoints())[endpoint.method];
		const query = new HanamiMetricsQueryService({ query: async () => [] } as never);
		const result: unknown = await new module.default(query).exec({ ...endpoint.params, range }, admin, null);
		const validate = ajv.compile(module.meta.res);
		expect({ valid: validate(result), errors: validate.errors }).toEqual({ valid: true, errors: null });
		expect(JSON.stringify(result)).not.toMatch(/"(?:userId|noteId|text|authorId|clusterId)":/);
	});

	test('populated breakdown strips identifiers, omits small cells, and preserves the three-type numerator', async () => {
		const { breakdown } = await loadEndpoints();
		const rows = [
			{ key: 'exploration', users: 5, served: 10, seen: 5, reaction: 1, reply: 1, renote: 1, userId: 'user-canary', noteId: 'note-canary', text: 'text-canary' },
			{ key: 'fof', users: 4, served: 100, seen: 50, reaction: 10, reply: 10, renote: 10, userId: 'hidden-user-canary' },
		];
		// R1: the unfiltered breakdown reads counts from hanami_metrics_daily and range uniques from a served-only scan.
		// The fixed past range never reaches today's cohort supplement, so no `WITH cohort` query is issued.
		const dailyRows = rows.map(row => ({ ...row, users: 0 }));
		const userRows = rows.map(row => ({ key: row.key, users: row.users, userId: row.userId }));
		const service = new HanamiMetricsQueryService({ query: async (sql: string) => {
			if (sql.includes('FROM hanami_metrics_daily')) return dailyRows;
			if (sql.includes('COUNT(DISTINCT "userId")')) return userRows;
			if (sql.startsWith('WITH cohort')) throw new Error('unfiltered breakdown must not read the cohort CTE for a past range');
			return [];
		} } as never);
		const result: unknown = await new breakdown.default(service).exec({ range, dimension: 'source' }, admin, null);
		expect(result).toMatchObject({
			suppressed: ['fof'], denominator: 'visible',
			rows: [{ key: 'exploration', users: 5, served: 10, reaction: 1, reply: 1, renote: 1, engagementRate: 0.3, share: 1, lift: 1 }],
		});
		expect(ajv.compile(breakdownResponseSchema)(result)).toBe(true);
		expect(JSON.stringify(result)).not.toContain('canary');
	});
});

class TestReply {
	public statusCode = 200;
	public body: unknown;
	public readonly headers = new Map<string, string>();
	private finish!: () => void;
	public readonly sent = new Promise<void>(resolve => { this.finish = resolve; });
	public code(status: number) { this.statusCode = status; return this; }
	public header(name: string, value: string) { this.headers.set(name, value); return this; }
	public send(body?: unknown) { this.body = body; this.finish(); return this; }
}

describe('HM-IMPLEMENT actual API credential/admin/scope guards', () => {
	test.each(endpoints)('$name requires admin credentials and read:admin:queue', async (endpoint) => {
		const module = (await loadEndpoints())[endpoint.method];
		expect(module.meta).toMatchObject({ tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue' });
		expect(module.meta.res).toBe(endpoint.schema);
		expect(module.meta).not.toHaveProperty('cacheSec'); // cache is service-owned, not public HTTP caching.
		for (const scenario of [
			{ user: null, roles: [], token: null, status: 401, code: 'CREDENTIAL_REQUIRED' },
			{ user: admin, roles: [], token: null, status: 403, code: 'ROLE_PERMISSION_DENIED' },
			{ user: admin, roles: [{ isModerator: true }], token: null, status: 403, code: 'ROLE_PERMISSION_DENIED' },
			{ user: admin, roles: [{ isAdministrator: true }], token: { permission: [] }, status: 403, code: 'PERMISSION_DENIED' },
			{ user: admin, roles: [{ isAdministrator: true }], token: null, status: 200, code: null },
			{ user: admin, roles: [{ isAdministrator: true }], token: { permission: ['read:admin:queue'] }, status: 200, code: null },
		]) {
			const query = queryMock();
			const instance = new module.default(query as unknown as HanamiMetricsQueryService);
			const service = new ApiCallService(
				{ enableIpLogging: false, rootUserId: 'root' } as never,
				{ sentryForBackend: false } as never, {} as never,
				{ authenticate: async () => [scenario.user, scenario.token] } as never,
				{} as never, { getUserRoles: async () => scenario.roles } as never,
				{ updateLastActiveDate: async () => undefined } as never,
				{ logger: { error: jest.fn(), warn: jest.fn() } } as never,
			);
			const reply = new TestReply();
			try {
				service.handleRequest(
					{ name: endpoint.name, meta: module.meta, params: module.paramDef, exec: instance.exec },
					{ method: 'POST', body: { ...endpoint.params, i: 'credential' }, query: {}, headers: {}, ip: '127.0.0.1' } as unknown as FastifyRequest<{ Body: Record<string, unknown>; Querystring: Record<string, unknown> }>,
					reply as unknown as FastifyReply,
				);
				await reply.sent;
				expect(reply.statusCode).toBe(scenario.status);
				if (scenario.code) {
					expect(reply.body).toMatchObject({ error: { code: scenario.code } });
					expect(query[endpoint.method]).not.toHaveBeenCalled();
				} else {
					expect(reply.body).toEqual(responses[endpoint.method]);
					expect(query[endpoint.method]).toHaveBeenCalledTimes(1);
				}
			} finally {
				service.dispose();
			}
		}
	});
});
