/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import _Ajv from 'ajv';
import type { Schema } from '@/misc/json-schema.js';
import type { HanamiMetricsInsightsService as InsightsService } from '@/core/hanami/HanamiMetricsInsightsService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { insightsContentTypeSchema, notesResponseSchema, opportunitiesResponseSchema, whatIfResponseSchema } from '@/server/api/endpoints/admin/hanami/metrics/insights-schemas.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Keep real Endpoint/AJV and ApiCallService authorization. Never open storage,
// launch Python, or load the infrastructure dependency graph in this boundary test.
jest.unstable_mockModule('../../src/core/RoleService.js', () => ({ RoleService: class {} }));
jest.unstable_mockModule('../../src/core/UserService.js', () => ({ UserService: class {} }));
jest.unstable_mockModule('../../src/server/api/RateLimiterService.js', () => ({ RateLimiterService: class {} }));
jest.unstable_mockModule('../../src/server/api/ApiLoggerService.js', () => ({ ApiLoggerService: class {} }));
jest.unstable_mockModule('../../src/server/api/AuthenticateService.js', () => ({ AuthenticateService: class {}, AuthenticationError: class extends Error {} }));
jest.unstable_mockModule('../../src/core/hanami/HanamiMetricsDiagnosticsService.js', () => ({
	HanamiMetricsDiagnosticsService: class {},
	HANAMI_DIAGNOSTIC_REASONS: ['unjudged', 'ephemeral', 'lowInterest', 'ff', 'hideMedia', 'servedSeen', 'otherSafety', 'diversity', 'passed'],
}));
const runtime = { available: true, device: 'cpu', deviceName: 'cpu (forced)', reason: null, probedAt: '2026-09-20T00:00:00.000Z' };
const probe = jest.fn(async (_options: { force?: boolean }) => runtime);
jest.unstable_mockModule('../../src/core/hanami/HanamiPythonRuntime.js', () => ({ probeHanamiNoteJudgeRuntime: probe, peekHanamiNoteJudgeRuntime: () => null }));

const opportunities = await import('../../src/server/api/endpoints/admin/hanami/metrics/opportunities.js');
const whatIf = await import('../../src/server/api/endpoints/admin/hanami/metrics/what-if.js');
const notes = await import('../../src/server/api/endpoints/admin/hanami/metrics/notes.js');
const aggregate = await import('../../src/server/api/endpoints/admin/hanami/judge-aggregate.js');
const status = await import('../../src/server/api/endpoints/admin/hanami/judge-status.js');
const { HanamiMetricsInsightsService, INSIGHTS_WHAT_IF_SQL, INSIGHTS_NOTES_SQL } = await import('../../src/core/hanami/HanamiMetricsInsightsService.js');
const { ApiCallService } = await import('../../src/server/api/ApiCallService.js');
const endpoints = [
	{ name: 'admin/hanami/metrics/opportunities', method: 'opportunities', module: opportunities, params: {}, schema: opportunitiesResponseSchema },
	{ name: 'admin/hanami/metrics/what-if', method: 'whatIf', module: whatIf, params: { axis: 'exploration', thresholds: {} }, schema: whatIfResponseSchema },
	{ name: 'admin/hanami/metrics/notes', method: 'notes', module: notes, params: {}, schema: notesResponseSchema },
] as const;
const ajv = new _Ajv.default({ strict: false });
const admin = { id: 'admin', isSuspended: false } as never;
const range = { from: '2026-09-01', to: '2026-09-07' };
const settings = createDefaultHanamiNoteJudgeSettings();
const responses = {
	opportunities: {
		range,
		allocation: [{ axis: 'exploration', share: 0.1, engagementShare: 0.2, ratio: 2, capNow: { high: 0.08, low: 0.08, none: 0.1 }, verdict: 'under', suggestedCap: { high: 0.15, low: 0.15, none: 0.2 } }],
		content: [{ contentType: 'unjudged', media: 'text', relationshipClass: 'unknown', served: 300, engagementRate: 0.1, lift: null, share: 0.1, opportunity: null, note: 'Aggregate explanation only' }],
		supplyWalls: [{ axis: 'exploration', dropped: { unjudged: 10 }, passed: 5, note: 'Snapshot' }],
		demand: [{ axis: 'exploration', usersHigh: 5, avgServedPerPageHigh: 2, avgServedPerPageNormal: 1, note: 'Captured effective settings' }],
		hiddenCost: [{ axis: 'exploration', hidden: 100, normalEngagementOfHidden: 0.1, normalEngagementOfShown: 0.2 }],
		tuningDrift: { exploration: { high: 5 } }, unavailable: ['hiddenCost.normalExposureDenominator'], suppressed: ['content'],
	},
	whatIf: {
		range, interest: [{ theta: 2.95, passed: null, passedEngagementRate: null }], ephemeral: [],
		contentTypeBonus: [{ contentType: 2, engagementRate: null, bonusNow: 2 }], unavailable: [], suppressed: ['interest.2.95'],
	},
	notes: {
		range, notes: [{ noteId: 'public-note', text: 'Public excerpt', authorLocality: 'local', source: 'exploration', contentType: 2, served: 20, reaction: 2, reply: 1, renote: 1, engagementRate: 0.2 }],
		suppressed: ['notes.smallCohort'], unavailable: [],
	},
} satisfies { [K in 'opportunities' | 'whatIf' | 'notes']: Awaited<ReturnType<InsightsService[K]>> };

function insightsMock() {
	return {
		opportunities: jest.fn<InsightsService['opportunities']>().mockResolvedValue(responses.opportunities),
		whatIf: jest.fn<InsightsService['whatIf']>().mockResolvedValue(responses.whatIf),
		notes: jest.fn<InsightsService['notes']>().mockResolvedValue(responses.notes),
	};
}

function realInsights(query: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => []) {
	return new HanamiMetricsInsightsService(
		{ query } as never,
		{ breakdown: async () => ({ rows: [], suppressed: [], coverage: { unavailable: [] } }) } as never,
		{ query: async () => ({ rows: [], suppressed: [] }) } as never,
	);
}

describe('HM-IMPLEMENT P3 strict request and response boundary', () => {
	test.each(endpoints)('$name delegates its exact params and preserves suppressed/unavailable values', async (endpoint) => {
		const service = insightsMock();
		const instance = new endpoint.module.default(service as unknown as InsightsService);
		await expect(instance.exec({ ...endpoint.params, range }, admin, null)).resolves.toBe(responses[endpoint.method]);
		const expected = endpoint.method === 'opportunities' ? range
			: endpoint.method === 'whatIf' ? { range, axis: 'exploration', thresholds: {} }
			: { range, dimension: undefined, key: undefined };
		expect(service[endpoint.method]).toHaveBeenCalledWith(expected);
		const validate = ajv.compile(endpoint.module.meta.res);
		expect(validate(responses[endpoint.method])).toBe(true);
		expect(endpoint.module.meta.res).toBe(endpoint.schema);
	});

	test.each([
		null, {}, { days: 1 }, { days: '7' }, { days: 7, ...range }, { from: range.from },
		{ from: '2026-9-01', to: range.to }, { days: 7, extra: true },
	])('rejects malformed ranges %j before invoking insights', async (invalidRange) => {
		for (const endpoint of endpoints) {
			const service = insightsMock();
			await expect(new endpoint.module.default(service as unknown as InsightsService).exec({ ...endpoint.params, range: invalidRange }, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
			expect(service[endpoint.method]).not.toHaveBeenCalled();
		}
	});

	test.each([
		{}, { axis: 'exploration' }, { thresholds: {} }, { axis: 'catchup', thresholds: {} },
		{ axis: 'exploration', thresholds: null }, { axis: 'exploration', thresholds: [] },
		{ axis: 'exploration', thresholds: { other: [1] } },
		{ axis: 'exploration', thresholds: { interest: [0.99] } },
		{ axis: 'exploration', thresholds: { interest: [5.01] } },
		{ axis: 'exploration', thresholds: { ephemeral: [-0.01] } },
		{ axis: 'exploration', thresholds: { ephemeral: [1.01] } },
		{ axis: 'exploration', thresholds: { interest: ['3'] } },
		{ axis: 'exploration', thresholds: { interest: [NaN] } },
		{ axis: 'exploration', thresholds: { interest: [Infinity] } },
		{ axis: 'exploration', thresholds: { interest: Array(9).fill(3) } },
		{ axis: 'exploration', thresholds: { ephemeral: Array(9).fill(0.5) } },
		{ axis: 'exploration', thresholds: {}, userId: 'private' },
	])('rejects invalid what-if params %j', async (params) => {
		const service = insightsMock();
		await expect(new whatIf.default(service as unknown as InsightsService).exec(params, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(service.whatIf).not.toHaveBeenCalled();
	});

	test.each([{}, { interest: [], ephemeral: [] }, { interest: [1, 2, 2.5, 2.95, 3, 3.5, 4, 5], ephemeral: [0, 1] }])('accepts bounded threshold arrays %j', async (thresholds) => {
		const service = insightsMock();
		await new whatIf.default(service as unknown as InsightsService).exec({ axis: 'exploration', thresholds }, admin, null);
		expect(service.whatIf).toHaveBeenCalledWith({ range: undefined, axis: 'exploration', thresholds });
	});

	test.each([
		{ dimension: 'source' }, { key: 'exploration' }, { dimension: 'userId', key: 'private' },
		{ dimension: 'source', key: 2 }, { dimension: 'source', key: 'x'.repeat(129) }, { noteId: 'private' },
	])('rejects unpaired or unsupported notes params %j', async (params) => {
		const service = insightsMock();
		await expect(new notes.default(service as unknown as InsightsService).exec(params, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(service.notes).not.toHaveBeenCalled();
	});

	test('forwards a paired notes filter and optional/default range unchanged', async () => {
		const service = insightsMock();
		const params = { range: { days: 7 }, dimension: 'contentType', key: '2' };
		await new notes.default(service as unknown as InsightsService).exec(params, admin, null);
		expect(service.notes).toHaveBeenCalledWith(params);
		await new opportunities.default(service as unknown as InsightsService).exec({}, admin, null);
		expect(service.opportunities).toHaveBeenCalledWith(undefined);
	});

	test.each([{ days: 90 }, { from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-30', to: '2026-03-01' }])('real service rejects invalid/over-30-day what-if and notes ranges with 400: %j', async (invalidRange) => {
		for (const endpoint of [endpoints[1], endpoints[2]]) {
			const query = jest.fn(async () => []);
			await expect(new endpoint.module.default(realInsights(query)).exec({ ...endpoint.params, range: invalidRange }, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
			expect(query).not.toHaveBeenCalled();
		}
	});

	test.each(endpoints)('$name real service response at its range boundary matches schema', async (endpoint) => {
		const result: unknown = await new endpoint.module.default(realInsights()).exec({ ...endpoint.params, range: { from: '2026-01-01', to: endpoint.method === 'opportunities' ? '2026-03-31' : '2026-01-30' } }, admin, null);
		const validate = ajv.compile(endpoint.schema);
		expect({ valid: validate(result), errors: validate.errors }).toEqual({ valid: true, errors: null });
	});

	test('contentType explicitly supports numbers, captured strings and null but no arbitrary objects', () => {
		const validate = ajv.compile(insightsContentTypeSchema);
		for (const value of [2, 'unjudged', null]) expect(validate(value)).toBe(true);
		for (const value of [{ noteId: 'private' }, [], false]) expect(validate(value)).toBe(false);
	});

	function audit(schema: Schema, notesAllowed: boolean) {
		expect(schema.type).not.toBe('any');
		expect(schema.additionalProperties).not.toBe(true);
		for (const [name, child] of Object.entries(schema.properties ?? {})) {
			expect(['userId', 'authorId', 'clusterId', ...notesAllowed ? [] : ['noteId', 'text']]).not.toContain(name);
			audit(child, notesAllowed);
		}
		if (schema.items) audit(schema.items, notesAllowed);
		if (typeof schema.additionalProperties === 'object') audit(schema.additionalProperties, notesAllowed);
		for (const child of schema.anyOf ?? []) audit(child, notesAllowed);
	}

	test('only notes can expose note IDs/text; map schemas accept numeric distributions, not arbitrary payloads', () => {
		for (const endpoint of endpoints) {
			audit(endpoint.schema, endpoint.method === 'notes');
			expect(ajv.compile(endpoint.schema)({ ...responses[endpoint.method], userId: 'canary' })).toBe(false);
		}
		expect(ajv.compile(opportunitiesResponseSchema)({ ...responses.opportunities, tuningDrift: { exploration: { high: 'private-canary' } } })).toBe(false);
		expect(ajv.compile(notesResponseSchema)({ ...responses.notes, notes: [{ ...responses.notes.notes[0], text: 'x'.repeat(161) }] })).toBe(false);
		expect(ajv.compile(notesResponseSchema)({ ...responses.notes, notes: Array(21).fill(responses.notes.notes[0]) })).toBe(false);
	});

	test('notes wrapper uses real service visibility rechecks, Unicode excerpt limit and identifier projection', async () => {
		let visible = true;
		const query = jest.fn(async (sql: string) => {
			if (sql === INSIGHTS_NOTES_SQL) return [{ rows: [{ noteId: 'public-note', source: 'exploration', contentType: 'unjudged', users: 5, served: 20, reaction: 2, reply: 1, renote: 1, userId: 'private-canary' }], suppressed: true }];
			if (sql.startsWith('SELECT n.id')) return visible ? [{ noteId: 'public-note', text: '🌸'.repeat(170), authorLocality: 'local', userId: 'private-canary' }] : [];
			return [];
		});
		const endpoint = new notes.default(realInsights(query));
		const first: unknown = await endpoint.exec({ range }, admin, null);
		expect(first).toMatchObject({ notes: [{ text: '🌸'.repeat(160), contentType: 'unjudged', engagementRate: 0.2 }] });
		expect(JSON.stringify(first)).not.toContain('private-canary');
		expect(ajv.compile(notesResponseSchema)(first)).toBe(true);
		visible = false;
		await expect(endpoint.exec({ range }, admin, null)).resolves.toMatchObject({ notes: [] });
		expect(query.mock.calls.filter(([sql]) => sql === INSIGHTS_NOTES_SQL)).toHaveLength(1);
		expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT n.id'))).toHaveLength(2);
	});
});

describe('HM-IMPLEMENT judge-aggregate compatibility and cohort parity', () => {
	test('default request preserves the existing four-query legacy behavior without insights injection', async () => {
		const counts = { judged: 10, ephemeral: 2, interestFiltered: 3 };
		const typeBreakdown = [{ contentType: 2, count: 4 }];
		const topServed = [{ noteId: 'public-note', text: 'Excerpt', reactionScore: 3, interest: 4, ephemeralScore: 0 }];
		const query = jest.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
			.mockResolvedValueOnce([{ settings }]).mockResolvedValueOnce([counts]).mockResolvedValueOnce(typeBreakdown).mockResolvedValueOnce(topServed);
		await expect(new aggregate.default({ query } as never).exec({}, admin, null)).resolves.toEqual({ ...counts, typeBreakdown, topServed });
		expect(query).toHaveBeenCalledTimes(4);
		expect(query.mock.calls[1][0]).toContain('INTERVAL \'24 hours\'');
		expect(query.mock.calls[3][1]).toEqual([settings.promptVersion]);
	});

	test.each([null, 17])('cohort mode preserves passed=%j and skips all unrelated legacy SQL', async (passed) => {
		const insights = insightsMock();
		insights.whatIf.mockResolvedValue({ ...responses.whatIf, interest: [{ theta: 2.95, passed, passedEngagementRate: null }] });
		const query = jest.fn(async () => [{ settings }]);
		const endpoint = new aggregate.default({ query } as never, insights as unknown as InsightsService);
		const result: unknown = await endpoint.exec({ range }, admin, null);
		expect(insights.whatIf).toHaveBeenCalledWith({ range, axis: 'exploration', thresholds: { interest: [2.95] } });
		expect(query).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ judged: null, ephemeral: null, interestFiltered: null, typeBreakdown: [], topServed: [], cohort: { range, passed, suppressed: responses.whatIf.suppressed, unavailable: [] } });
		await endpoint.exec({ axis: 'exploration' }, admin, null);
		expect(insights.whatIf).toHaveBeenLastCalledWith({ range: undefined, axis: 'exploration', thresholds: { interest: [2.95] } });
	});

	test('explicit cohort fails closed if optional insights injection is unavailable', async () => {
		const query = jest.fn(async () => []);
		await expect(new aggregate.default({ query } as never).exec({ axis: 'exploration' }, admin, null)).rejects.toMatchObject({ code: 'METRICS_INSIGHTS_UNAVAILABLE', httpStatusCode: 503 });
		expect(query).not.toHaveBeenCalled();
	});

	test('real what-if and aggregate cohort at theta=2.95 have identical passed counts', async () => {
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('FROM meta')) return [{ settings }];
			if (sql === INSIGHTS_WHAT_IF_SQL) return [
				{ kind: 'interest', theta: 2.95, users: 5, passed: 7, served: 20, engaged: 4 },
				{ kind: 'cohort', theta: 0, users: 5, passed: 7, served: 20, engaged: 4 },
			];
			return [];
		});
		const service = realInsights(query);
		const whatIfResult = await new whatIf.default(service).exec({ range, axis: 'exploration', thresholds: { interest: [2.95] } }, admin, null);
		const aggregateResult = await new aggregate.default({ query } as never, service).exec({ range, axis: 'exploration' }, admin, null);
		expect(aggregateResult.cohort.passed).toBe(7);
		expect(aggregateResult.cohort.passed).toBe(whatIfResult.interest[0].passed);
		expect(query.mock.calls.every(([sql]) => sql.includes('FROM meta') || sql === INSIGHTS_WHAT_IF_SQL || sql.includes('hanami_metrics_state'))).toBe(true);
	});

	test.each([{ axis: 'catchup' }, { range: { days: 7, ...range } }, { threshold: 3 }])('rejects invalid cohort params %j', async (params) => {
		const query = jest.fn(async () => []);
		await expect(new aggregate.default({ query } as never).exec(params, admin, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(query).not.toHaveBeenCalled();
	});
});

describe('HM-IMPLEMENT judge-status latest ready inventory', () => {
	function statusEndpoint(params: Record<string, unknown> = {}, inventory: unknown[] = [{ count: '12', candidateCount: '8' }]) {
		const query = jest.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
			.mockResolvedValueOnce([{ settings }])
			.mockResolvedValueOnce([{ id: 'run', status: 'ready', params, startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:10.000Z' }])
			.mockResolvedValueOnce(inventory);
		return { endpoint: new status.default({ query } as never), query };
	}

	test('backlog and rejudgement count use distinct notes, only latest ready generation, exact fence and prompt version', async () => {
		const { endpoint, query } = statusEndpoint({ secondsPerItem: 2.5 });
		await expect(endpoint.exec({ force: true }, admin, null)).resolves.toMatchObject({ backlog: 12, candidateCount: 8, secPerNote: 2.5, runtime });
		const [sql, params] = query.mock.calls[2];
		expect(sql).toContain('WHERE status = \'ready\' ORDER BY ordinal DESC LIMIT 1');
		expect(sql).toContain('COUNT(DISTINCT c."noteId") FILTER (WHERE j."noteId" IS NULL)');
		expect(sql).toContain('COUNT(DISTINCT c."noteId") FILTER (WHERE j."noteId" IS NOT NULL)');
		expect(sql).toContain('c."generationId" = g.id AND c."generationFence" = g."generationFence"');
		expect(sql).toContain('j."promptVersion" = $1');
		expect(sql).toContain('GROUP BY g.id');
		expect(params).toEqual([settings.promptVersion]);
		expect(probe).toHaveBeenLastCalledWith({ force: true });
	});

	test.each([
		{ params: { secondsPerItem: 1.5, wallDurationMs: 12000, processedCount: 4 }, expected: 1.5 },
		{ params: { wallDurationMs: 12000, processedCount: 4 }, expected: 3 },
		{ params: { wallDurationMs: 12000, processedCount: 0 }, expected: undefined },
		{ params: { secondsPerItem: NaN }, expected: undefined },
		{ params: { secondsPerItem: Infinity }, expected: undefined },
		{ params: { secondsPerItem: -1 }, expected: undefined },
		{ params: {}, expected: undefined },
	])('reports a finite optional seconds-per-note estimate for %j', async ({ params, expected }) => {
		const { endpoint } = statusEndpoint(params);
		const result = await endpoint.exec({}, admin, null);
		if (expected === undefined) expect(result).not.toHaveProperty('secPerNote');
		else expect(result.secPerNote).toBe(expected);
		expect(probe).toHaveBeenLastCalledWith({ force: false });
	});

	test('no ready inventory is unknown, unlike a ready empty inventory', async () => {
		const absent = await statusEndpoint({}, []).endpoint.exec({}, admin, null);
		expect(absent.backlog).toBeNull();
		expect(absent).not.toHaveProperty('candidateCount');
		await expect(statusEndpoint({}, [{ count: 0, candidateCount: 0 }]).endpoint.exec({}, admin, null)).resolves.toMatchObject({ backlog: 0, candidateCount: 0 });
	});
});

class TestReply {
	public statusCode = 200;
	public body: unknown;
	private finish!: () => void;
	public readonly sent = new Promise<void>(resolve => { this.finish = resolve; });
	public code(statusCode: number) { this.statusCode = statusCode; return this; }
	public header(_name: string, _value: string) { return this; }
	public send(body?: unknown) { this.body = body; this.finish(); return this; }
}

describe('HM-IMPLEMENT P3 real API authorization guards', () => {
	test.each(endpoints)('$name requires admin credentials and read:admin:queue', async (endpoint) => {
		expect(endpoint.module.meta).toMatchObject({ tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue' });
		expect(endpoint.module.meta).not.toHaveProperty('cacheSec');
		for (const scenario of [
			{ user: null, roles: [], token: null, status: 401, code: 'CREDENTIAL_REQUIRED' },
			{ user: admin, roles: [], token: null, status: 403, code: 'ROLE_PERMISSION_DENIED' },
			{ user: admin, roles: [{ isModerator: true }], token: null, status: 403, code: 'ROLE_PERMISSION_DENIED' },
			{ user: admin, roles: [{ isAdministrator: true }], token: { permission: [] }, status: 403, code: 'PERMISSION_DENIED' },
			{ user: admin, roles: [{ isAdministrator: true }], token: null, status: 200, code: null },
			{ user: admin, roles: [{ isAdministrator: true }], token: { permission: ['read:admin:queue'] }, status: 200, code: null },
		]) {
			const insights = insightsMock();
			const instance = new endpoint.module.default(insights as unknown as InsightsService);
			const api = new ApiCallService(
				{ enableIpLogging: false, rootUserId: 'root' } as never, { sentryForBackend: false } as never, {} as never,
				{ authenticate: async () => [scenario.user, scenario.token] } as never,
				{} as never, { getUserRoles: async () => scenario.roles } as never,
				{ updateLastActiveDate: async () => undefined } as never,
				{ logger: { error: jest.fn(), warn: jest.fn() } } as never,
			);
			const reply = new TestReply();
			try {
				api.handleRequest(
					{ name: endpoint.name, meta: endpoint.module.meta, params: endpoint.module.paramDef, exec: instance.exec },
					{ method: 'POST', body: { ...endpoint.params, i: 'credential' }, query: {}, headers: {}, ip: '127.0.0.1' } as unknown as FastifyRequest<{ Body: Record<string, unknown>; Querystring: Record<string, unknown> }>,
					reply as unknown as FastifyReply,
				);
				await reply.sent;
				expect(reply.statusCode).toBe(scenario.status);
				if (scenario.code) {
					expect(reply.body).toMatchObject({ error: { code: scenario.code } });
					expect(insights[endpoint.method]).not.toHaveBeenCalled();
				} else {
					expect(reply.body).toEqual(responses[endpoint.method]);
					expect(insights[endpoint.method]).toHaveBeenCalledTimes(1);
				}
			} finally {
				api.dispose();
			}
		}
	});
});
