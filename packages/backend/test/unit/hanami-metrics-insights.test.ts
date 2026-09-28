/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HANAMI_FOR_YOU_AXES, hanamiInterleave } from '@/core/hanami/HanamiForYouInterleave.js';
import { METRICS_COHORT_CTE, METRICS_COLLECTION_GAP_SQL } from '@/core/hanami/HanamiMetricsContracts.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { presentMetricsBreakdown } from '@/core/hanami/HanamiMetricsQueryService.js';
import type { HanamiMetricsWhatIfRequest } from '@/core/hanami/HanamiMetricsInsightsContracts.js';

// Read-only storage doubles; no DB, Redis, safety graph, Python, or background services.
jest.unstable_mockModule('../../src/core/hanami/HanamiForYouSafetyService.js', () => ({ HanamiForYouSafetyService: class {} }));
const {
	HanamiMetricsInsightsService, HANAMI_INSIGHTS_CAPS, allocationVerdict, suggestedCaps,
	INSIGHTS_CONTENT_SQL, INSIGHTS_DEMAND_SQL, INSIGHTS_HIDDEN_SQL, INSIGHTS_WHAT_IF_SQL, INSIGHTS_NOTES_SQL,
} = await import('@/core/hanami/HanamiMetricsInsightsService.js');

const range = { from: '2026-09-01', to: '2026-09-07' };
const aggregate = (overrides: Record<string, unknown> = {}) => ({ key: 'exploration', users: 5, served: 300, seen: 100, reaction: 20, reply: 10, renote: 0, ...overrides });
const joint = (overrides: Record<string, unknown> = {}) => ({ ...aggregate(), contentType: '2', media: 'text', relationshipClass: 'unknown', ...overrides });
const note = (overrides: Record<string, unknown> = {}) => ({ noteId: 'public-note', source: 'exploration', contentType: '2', users: 5, served: 20, reaction: 1, reply: 1, renote: 0, ...overrides });

function fixture() {
	const state = { startedAt: '2026-08-01T00:00:00Z' as string | null, insightsStartedAt: '2026-08-01T00:00:00Z' as string | null };
	const settings = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 7, ephemeralThreshold: 0.5 };
	const data = {
		collectionGap: false,
		content: [joint()],
		demand: [{ axis: 'exploration', level: 'high', users: 5, pages: 12, average: 3.5 }, { axis: 'exploration', level: 'normal', users: 5, pages: 9, average: 2 }],
		hidden: [{ axis: 'globalPopular', decision: 'hiddenEphemeral', users: 5, candidates: 10, engaged: 2 }, { axis: 'globalPopular', decision: 'shown', users: 5, candidates: 20, engaged: 6 }],
		days: [{ day: '2026-09-06' }],
		notes: [note()],
		notesSuppressed: false,
		details: [{ noteId: 'public-note', text: '😀'.repeat(170), authorLocality: 'local' }],
		whatIf: [
			{ kind: 'interest', theta: 2, users: 5, passed: 3, served: 20, engaged: 2 },
			{ kind: 'interest', theta: 3, users: 5, passed: 2, served: 10, engaged: 2 },
			{ kind: 'interest', theta: 4, users: 5, passed: 1, served: 5, engaged: 2 },
			{ kind: 'ephemeral', theta: 0, users: 5, passed: 1, served: 5, engaged: 2 },
			{ kind: 'ephemeral', theta: 0.5, users: 5, passed: 2, served: 10, engaged: 2 },
			{ kind: 'ephemeral', theta: 1, users: 5, passed: 3, served: 20, engaged: 2 },
			{ kind: 'contentType', theta: 2, users: 5, passed: 3, served: 20, engaged: 2 },
			{ kind: 'cohort', theta: 0, users: 5, passed: 3, served: 20, engaged: 2 },
			{ kind: 'servedCohort', theta: 0, users: 5, passed: 3, served: 20, engaged: 2 },
		],
	};
	const sourceRows = [aggregate()];
	const breakdown = jest.fn(async (_request: unknown) => ({ range, dimension: 'source', ...presentMetricsBreakdown(sourceRows as never), coverage: { unavailable: [] } }));
	const diagnostic = { available: true, suppressed: ['tuning/fof:low'], rows: [
		{ scope: 'dropped', key: 'exploration', users: 5, capturedAt: '2026-09-06T00:00:00Z', data: { available: true, dropped: { ephemeral: 9, hideMedia: 3, userId: 'secret' }, passed: 10, noteId: 'secret' } },
		{ scope: 'tuning', key: 'exploration:high', users: 8, capturedAt: '2026-09-06T00:00:00Z', data: { axis: 'exploration', level: 'high' } },
	] };
	const diagnostics = { query: jest.fn(async (_day: string) => diagnostic) };
	const query = jest.fn(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
		if (sql === METRICS_COLLECTION_GAP_SQL) return [{ gap: data.collectionGap }];
		if (sql === INSIGHTS_CONTENT_SQL) return data.content;
		if (sql === INSIGHTS_DEMAND_SQL) return data.demand;
		if (sql === INSIGHTS_HIDDEN_SQL) return data.hidden;
		if (sql === INSIGHTS_WHAT_IF_SQL) return data.whatIf;
		if (sql === INSIGHTS_NOTES_SQL) return [{ rows: data.notes, suppressed: data.notesSuppressed }];
		if (sql.includes('FROM hanami_metrics_diagnostic')) return data.days;
		if (sql.includes('FROM hanami_metrics_state')) return [state];
		if (sql.includes('FROM meta')) return [{ settings }];
		if (sql.includes('FROM note n')) return data.details;
		throw new Error('Unexpected SQL');
	});
	return { service: new HanamiMetricsInsightsService({ query } as never, { breakdown } as never, diagnostics as never), query, breakdown, diagnostics, diagnostic, data, state, settings, sourceRows };
}

beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-09-20T12:00:00Z')); });
afterEach(() => { jest.useRealTimers(); });

describe('allocation and current cap parity', () => {
	test.each<[number, string]>([[1.3, 'under'], [1.2999, 'balanced'], [0.7001, 'balanced'], [0.7, 'over'], [0, 'over']])('ratio %s is %s', (ratio, verdict) => {
		expect(allocationVerdict(ratio)).toBe(verdict);
	});

	test.each(['high', 'low', 'none'] as const)('%s base caps match actual interleave, including exploration', confidence => {
		const axisCandidates = new Map(HANAMI_FOR_YOU_AXES.map(axis => [axis,
																																																																		Array.from({ length: 1100 }, (_, index) => ({ noteId: `${axis}-${index}`, userId: `${axis}-author-${index}`, score: 1100 - index })),
		]));
		const actual = hanamiInterleave({ confidence, limit: 1000, axisCandidates });
		for (const axis of HANAMI_FOR_YOU_AXES) {
			// Float arithmetic in computeCaps may ceil one extra item. Base share is exact to 0.01.
			const count = actual.filter(row => row.source === axis && !row.fallbackOverflow).length;
			expect(Math.abs(count - HANAMI_INSIGHTS_CAPS[axis][confidence] * 1000)).toBeLessThanOrEqual(1);
		}
	});

	test('round05, deterministic largest remainder, zero caps, and all confidence budgets', () => {
		const caps = { high: 0.08, low: 0.12, none: 0 };
		expect(suggestedCaps([{ capNow: caps, ratio: 1 }])).toEqual([{ high: 0.1, low: 0.1, none: 0 }]);
		for (let ratio = 0; ratio <= 10; ratio += 0.13) {
			const result = suggestedCaps(HANAMI_FOR_YOU_AXES.map(axis => ({ capNow: { ...HANAMI_INSIGHTS_CAPS[axis] }, ratio })));
			for (const confidence of ['high', 'low', 'none'] as const) {
				expect(result.reduce((sum, cap) => sum + cap[confidence], 0)).toBeLessThanOrEqual(1 + 1e-12);
				for (const cap of result) expect(cap[confidence] * 20).toBeCloseTo(Math.round(cap[confidence] * 20), 12);
			}
		}
		const tied = Array.from({ length: 3 }, () => ({ capNow: { high: 1, low: 1, none: 1 }, ratio: 1 }));
		expect(suggestedCaps(tied).map(row => row.high)).toEqual([0.35, 0.35, 0.3]);
	});

	test('heterogeneous ratios conserve at most twenty integer units in every confidence budget', () => {
		expect(suggestedCaps([])).toEqual([]);
		for (let sample = 0; sample < 100; sample++) {
			const result = suggestedCaps(HANAMI_FOR_YOU_AXES.map((axis, index) => ({
				capNow: { ...HANAMI_INSIGHTS_CAPS[axis] }, ratio: ((sample + 1) * (index + 3) % 37) / 3,
			})));
			for (const confidence of ['high', 'low', 'none'] as const) {
				const units = result.map(cap => Math.round(cap[confidence] * 20));
				expect(units.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(20);
				result.forEach((cap, index) => expect(cap[confidence]).toBe(units[index] / 20));
			}
		}
	});
});

describe('opportunities use observed cohorts, not reconstructions', () => {
	test('full response cache skips all storage and collaborators, isolates clones, and expires after 61 seconds', async () => {
		const f = fixture();
		const first = await f.service.opportunities(range);
		const expected = structuredClone(first);
		const calls = f.query.mock.calls.length;
		expect(calls).toBeGreaterThan(0);
		first.allocation[0].capNow.high = 999;
		first.supplyWalls[0].dropped.ephemeral = 999;
		first.unavailable.push('mutated');
		const second = await f.service.opportunities(range);
		expect(second).toEqual(expected);
		second.content[0].served = 999;
		expect(await f.service.opportunities({ to: range.to, from: range.from })).toEqual(expected);
		expect(f.query).toHaveBeenCalledTimes(calls);
		expect(f.breakdown).toHaveBeenCalledTimes(1);
		expect(f.diagnostics.query).toHaveBeenCalledTimes(1);
		jest.advanceTimersByTime(61_000);
		await f.service.opportunities(range);
		expect(f.query).toHaveBeenCalledTimes(calls * 2);
		expect(f.breakdown).toHaveBeenCalledTimes(2);
		expect(f.diagnostics.query).toHaveBeenCalledTimes(2);
	});

	test('equivalent resolved ranges share a key; different ranges do not, and validation still runs', async () => {
		const f = fixture();
		const first = await f.service.opportunities({ days: 7 });
		const calls = f.query.mock.calls.length;
		expect(await f.service.opportunities({ to: '2026-09-20', from: '2026-09-14' })).toEqual(first);
		expect(f.query).toHaveBeenCalledTimes(calls);
		await expect(f.service.opportunities({ days: 7, from: '2026-09-14', to: '2026-09-20' } as never)).rejects.toThrow(RangeError);
		expect(f.query).toHaveBeenCalledTimes(calls);
		await f.service.opportunities(range);
		expect(f.query).toHaveBeenCalledTimes(calls * 2);
	});

	test('shares reuse breakdown exactly; every section returns available facts without identifiers', async () => {
		const f = fixture();
		const result = await f.service.opportunities(range);
		expect(f.breakdown).toHaveBeenCalledWith({ range, dimension: 'source' });
		expect(result.allocation[0]).toMatchObject({ axis: 'exploration', share: 1, engagementShare: 1, ratio: 1, verdict: 'balanced' });
		expect(result.content[0]).toMatchObject({ contentType: 2, served: 300, engagementRate: 0.1, lift: 1 });
		expect(result.demand).toEqual([{ axis: 'exploration', usersHigh: 5, avgServedPerPageHigh: 3.5, avgServedPerPageNormal: 2, note: expect.stringContaining('REST pages') }]);
		expect(result.hiddenCost).toEqual([{ axis: 'globalPopular', hidden: 10, normalEngagementOfHidden: 0.2, normalEngagementOfShown: 0.3 }]);
		expect(result.unavailable).toContain('hiddenCost.normalExposureDenominator');
		expect(f.diagnostics.query).toHaveBeenCalledWith('2026-09-06');
		expect(result.supplyWalls).toEqual([{ axis: 'exploration', dropped: { ephemeral: 9, hideMedia: 3 }, passed: 10, note: expect.stringContaining('Snapshot 2026-09-06') }]);
		expect(result.tuningDrift).toEqual({ exploration: { high: 8 } });
		expect(result.unavailable).toContain('tuningDrift.defaultRelativeDelta:snapshot:2026-09-06:effectiveLevelsOnly');
		expect(result.suppressed).toEqual([]);
		expect(JSON.stringify(result)).not.toMatch(/secret|"(?:userId|noteId|text|authorId|clusterId)":/);
	});

	test('allocation keeps breakdown denominators even with non-axis sources and suppressed axes', async () => {
		const f = fixture();
		f.sourceRows.push(aggregate({ key: 'globalPopular', served: 700, reaction: 100 }),
			aggregate({ key: 'unknown', served: 100, reaction: 40 }), aggregate({ key: 'fof', users: 4, served: 10000 }));
		const expected = presentMetricsBreakdown(f.sourceRows as never);
		const result = await f.service.opportunities(range);
		expect(result.allocation.map(row => row.axis)).toEqual(['exploration', 'globalPopular', 'fof']);
		for (const row of result.allocation) {
			const source = expected.rows.find(item => item.key === row.axis)!;
			expect(row.share).toBe(source.share);
			expect(row.engagementShare).toBe(source.engagementShare);
			expect(row.ratio).toBe(source.engagementShare! / source.share!);
		}
		expect(result.suppressed).toEqual([]);
	});

	test('content has joint cells, >=300 served; all cohorts enter denominators', async () => {
		const f = fixture();
		f.data.content = [joint(), joint({ contentType: '3', served: 299 }), joint({ contentType: '4', users: 4, served: 10000 })];
		const result = await f.service.opportunities(range);
		expect(result.content).toHaveLength(2);
		expect(result.content[0].share).toBe(300 / 10599);
		expect(result.content[0].opportunity).toBe(1);
		expect(result.suppressed).toEqual([]);
	});

	test('no seen denominator means null lift/opportunity, never an invented zero', async () => {
		const f = fixture();
		f.data.content = [joint({ seen: 0 })];
		expect((await f.service.opportunities(range)).content[0]).toMatchObject({ lift: null, opportunity: null });
	});

	test('zero observed engagement is not an unknown lift when another visible cell has outcomes', async () => {
		const f = fixture();
		f.data.content = [joint(), joint({ contentType: '3', reaction: 0, reply: 0, renote: 0 })];
		const result = await f.service.opportunities(range);
		expect(result.content[0]).toMatchObject({ contentType: 2, lift: 2, share: 0.5, opportunity: 1 });
		expect(result.content[1]).toMatchObject({ contentType: 3, engagementRate: 0, lift: 0, opportunity: 0 });
	});

	test('all-zero outcomes leave content lift and allocation ratios unknown', async () => {
		const f = fixture();
		f.data.content = [joint({ reaction: 0, reply: 0, renote: 0 })];
		f.sourceRows[0].reaction = 0;
		f.sourceRows[0].reply = 0;
		const result = await f.service.opportunities(range);
		expect(result.content[0]).toMatchObject({ engagementRate: 0, lift: null, opportunity: null });
		expect(result.allocation).toEqual([]);
	});

	test.each(['high', 'normal'])('demand includes small groups: %s', async level => {
		const f = fixture();
		f.data.demand.find(row => row.level === level)!.users = 4;
		const result = await f.service.opportunities(range);
		expect(result.demand).toHaveLength(1);
		expect(result.suppressed).toEqual([]);
	});

	test.each(['hiddenEphemeral', 'shown'])('hiddenCost includes small groups: %s', async decision => {
		const f = fixture();
		f.data.hidden.find(row => row.decision === decision)!.users = 4;
		const result = await f.service.opportunities(range);
		expect(result.hiddenCost).toHaveLength(1);
		expect(result.suppressed).toEqual([]);
	});

	test('historical capture gaps and absent snapshots are explicit, not fabricated zero rows', async () => {
		const f = fixture();
		f.state.insightsStartedAt = '2026-09-20T00:00:00Z';
		f.data.days = [];
		f.data.demand = [];
		f.data.hidden = [];
		const result = await f.service.opportunities(range);
		expect(result.unavailable).toEqual(expect.arrayContaining(['demand.hiddenCost.captureHistory.partial', 'supplyWalls.snapshot', 'tuningDrift.snapshot']));
		expect(result.demand).toEqual([]);
		expect(result.hiddenCost).toEqual([]);
		expect(f.diagnostics.query).not.toHaveBeenCalled();
	});

	test('known collection gaps hide page/candidate comparisons, not independent served cohorts', async () => {
		const f = fixture();
		f.data.collectionGap = true;
		const result = await f.service.opportunities(range);
		expect(result.demand).toEqual([]);
		expect(result.hiddenCost).toEqual([]);
		expect(result.allocation).toHaveLength(1);
		expect(result.content).toHaveLength(1);
		expect(result.unavailable).toEqual(expect.arrayContaining(['demand.collectionGap', 'hiddenCost.collectionGap']));
		expect(f.query).toHaveBeenCalledWith(METRICS_COLLECTION_GAP_SQL, [range.from, range.to]);
	});

	test('captured zero demand/outcomes remain genuine zeros, including per-type rates above one', async () => {
		const f = fixture();
		f.data.demand.forEach(row => { row.average = 0; });
		f.data.hidden[0].engaged = 0;
		f.data.hidden[1].engaged = 60;
		const result = await f.service.opportunities(range);
		expect(result.demand[0]).toMatchObject({ avgServedPerPageHigh: 0, avgServedPerPageNormal: 0 });
		expect(result.hiddenCost[0]).toMatchObject({ normalEngagementOfHidden: 0, normalEngagementOfShown: 3 });
	});

	test('absent snapshots do not fabricate zero supply', async () => {
		const f = fixture();
		f.diagnostic.rows = [];
		f.diagnostic.suppressed = ['dropped/exploration', 'tuning/exploration:high'];
		const result = await f.service.opportunities(range);
		expect(result.supplyWalls).toEqual([]);
		expect(result.tuningDrift).toEqual({});
		expect(result.suppressed).toEqual([]);
		expect(result.unavailable).toEqual(expect.arrayContaining(['supplyWalls.snapshot', 'tuningDrift.snapshot']));
	});

	test('small cohorts participate in source ratios', async () => {
		const f = fixture();
		f.sourceRows.push(aggregate({ key: 'fof', users: 4 }));
		f.sourceRows[0].reaction = 0;
		f.sourceRows[0].reply = 0;
		const result = await f.service.opportunities(range);
		expect(result.allocation.map(row => row.axis)).toEqual(['exploration', 'fof']);
		expect(result.allocation[0].ratio).toBe(0);
		expect(result.suppressed).toEqual([]);
	});
});

describe('what-if contract, privacy and bounds', () => {
	const request: HanamiMetricsWhatIfRequest = { range, axis: 'exploration', thresholds: { interest: [2, 3, 4], ephemeral: [0, 0.5, 1] } };
	test('returns monotonic unique-note counts, per-served three-type rates and configured bonuses', async () => {
		const f = fixture();
		const result = await f.service.whatIf(request);
		expect(result.interest.map(row => row.passed)).toEqual([3, 2, 1]);
		expect(result.ephemeral.map(row => row.passed)).toEqual([1, 2, 3]);
		expect(result.interest[1].passedEngagementRate).toBe(0.2); // reaction + reply, not OR.
		expect(result.contentTypeBonus[2]).toEqual({ contentType: 2, engagementRate: 0.1, bonusNow: 2 });
		expect(f.query).toHaveBeenCalledWith(INSIGHTS_WHAT_IF_SQL, ['2026-09-01T00:00:00+09:00', '2026-09-08T00:00:00+09:00', '{"source":"exploration"}', 7, [2, 3, 4], [0, 0.5, 1], 2.95, 0.5]);
		expect(JSON.stringify(result)).not.toMatch(/"(?:userId|noteId|text|authorId)":/);
	});

	test('threshold order and duplicates never change which SQL point is presented', async () => {
		const f = fixture();
		f.data.whatIf.reverse(); // UNION/GROUP BY do not promise SQL result order.
		const result = await f.service.whatIf({ ...request, thresholds: { interest: [4, 2, 3, 2], ephemeral: [1, 0, 0.5, 0] } });
		expect(result.interest.map(row => [row.theta, row.passed])).toEqual([[4, 1], [2, 3], [3, 2]]);
		expect(result.ephemeral.map(row => [row.theta, row.passed])).toEqual([[1, 3], [0, 1], [0.5, 2]]);
	});

	test('empty qualifying sets have zero passes, while observed zero outcomes are not null', async () => {
		const f = fixture();
		Object.assign(f.data.whatIf[0], { engaged: 0 });
		Object.assign(f.data.whatIf[2], { users: 0, passed: 0, served: 0, engaged: 0 });
		const result = await f.service.whatIf(request);
		expect(result.interest[0]).toMatchObject({ passed: 3, passedEngagementRate: 0 });
		expect(result.interest[2]).toMatchObject({ passed: 0, passedEngagementRate: null });
		expect(result.suppressed).toEqual([]);
	});

	test('includes small qualifying cohorts', async () => {
		const f = fixture();
		f.data.whatIf[1].users = 4;
		f.data.whatIf[6].users = 4;
		const result = await f.service.whatIf(request);
		expect(result.interest[1]).toEqual({ theta: 3, passed: 2, passedEngagementRate: 0.2 });
		expect(result.contentTypeBonus[2].engagementRate).toBe(0.1);
		expect(result.suppressed).toEqual([]);
	});

	test('empty history and missing current-PV judgements report unavailable instead of fake zero', async () => {
		const f = fixture();
		f.state.startedAt = null;
		f.data.whatIf = [];
		const result = await f.service.whatIf(request);
		expect(result.interest.every(row => row.passed === null)).toBe(true);
		expect(result.unavailable).toEqual(expect.arrayContaining(['served.captureHistory', 'whatIf.currentPromptJudgedExplorationCohort']));
	});

	test('partial judged inventory is labeled explicitly', async () => {
		const f = fixture();
		f.data.whatIf.find(row => row.kind === 'servedCohort')!.passed = 4;
		expect((await f.service.whatIf(request)).unavailable).toContain('whatIf.currentPromptJudgedExplorationCohort.partial:unjudgedOrRuleExcluded');
	});

	test.each([NaN, Infinity, -Infinity, 0, 5.1, '3'])('rejects invalid interest %s before storage', async theta => {
		const f = fixture();
		await expect(f.service.whatIf({ ...request, thresholds: { interest: [theta as number] } })).rejects.toThrow(RangeError);
		expect(f.query).not.toHaveBeenCalled();
	});

	test.each([-0.01, 1.01, Infinity])('rejects invalid ephemeral %s', async theta => {
		await expect(fixture().service.whatIf({ ...request, thresholds: { ephemeral: [theta] } })).rejects.toThrow(RangeError);
	});

	test('at most eight values per array; explicit empty arrays preserved, defaults use current theta', async () => {
		const f = fixture();
		await expect(f.service.whatIf({ ...request, thresholds: { interest: Array(9).fill(3) } })).rejects.toThrow(RangeError);
		expect((await f.service.whatIf({ ...request, thresholds: { interest: [], ephemeral: [] } })).interest).toEqual([]);
		await f.service.whatIf({ ...request, thresholds: {} });
		expect(f.query.mock.calls.find(([sql, params]) => sql === INSIGHTS_WHAT_IF_SQL && (params?.[4] as number[])[0] === 2.95)?.[1]?.[5]).toEqual([0.5]);
	});

	test('full response defensive cache skips even meta SQL; settings refresh after 61 seconds', async () => {
		const f = fixture();
		const first = await f.service.whatIf(request);
		const expected = structuredClone(first);
		const calls = f.query.mock.calls.length;
		expect(calls).toBe(3);
		first.interest[0].passed = 999;
		first.unavailable.push('mutated');
		const second = await f.service.whatIf(request);
		expect(second).toEqual(expected);
		second.contentTypeBonus[2].bonusNow = 999;
		f.settings.promptVersion++;
		f.settings.contentTypeBonus = f.settings.contentTypeBonus.map((bonus, index) => index === 2 ? 3 : bonus);
		// R1 B explicitly permits settings to remain stale for the response-cache TTL.
		expect(await f.service.whatIf(request)).toEqual(expected);
		expect(f.query).toHaveBeenCalledTimes(calls);
		jest.advanceTimersByTime(61_000);
		expect((await f.service.whatIf(request)).contentTypeBonus[2].bonusNow).toBe(3);
		expect(f.query).toHaveBeenCalledTimes(calls * 2);
		expect(f.query).toHaveBeenCalledWith(INSIGHTS_WHAT_IF_SQL, expect.arrayContaining([8]));
	});

	test('normalizes object order and duplicates, but preserves meaningful threshold order and different arguments', async () => {
		const f = fixture();
		const first = await f.service.whatIf(request);
		const calls = f.query.mock.calls.length;
		expect(await f.service.whatIf({
			thresholds: { ephemeral: [0, 0.5, 1, 0], interest: [2, 3, 2, 4] },
			axis: 'exploration', range: { to: range.to, from: range.from },
		})).toEqual(first);
		expect(f.query).toHaveBeenCalledTimes(calls);
		const reordered = await f.service.whatIf({ ...request, thresholds: { interest: [4, 3, 2], ephemeral: [1, 0.5, 0] } });
		expect(reordered.interest.map(row => row.theta)).toEqual([4, 3, 2]);
		expect(reordered.ephemeral.map(row => row.theta)).toEqual([1, 0.5, 0]);
		expect(f.query).toHaveBeenCalledTimes(calls * 2);
		await f.service.whatIf({ ...request, thresholds: { interest: [2] } });
		expect(f.query).toHaveBeenCalledTimes(calls * 3);
		await f.service.whatIf({ ...request, range: { from: range.from, to: '2026-09-08' } });
		expect(f.query).toHaveBeenCalledTimes(calls * 4);
	});

	test('normalized relative ranges and omitted defaults hit cache, while empty arrays remain distinct', async () => {
		const f = fixture();
		const first = await f.service.whatIf({ ...request, range: { days: 7 }, thresholds: {} });
		const calls = f.query.mock.calls.length;
		expect(await f.service.whatIf({ ...request, range: { to: '2026-09-20', from: '2026-09-14' }, thresholds: { ephemeral: undefined, interest: undefined } })).toEqual(first);
		expect(f.query).toHaveBeenCalledTimes(calls);
		f.settings.interestThreshold = 3;
		f.settings.ephemeralThreshold = 1;
		expect(await f.service.whatIf({ ...request, range: { days: 7 }, thresholds: {} })).toEqual(first);
		expect(f.query).toHaveBeenCalledTimes(calls);
		const empty = await f.service.whatIf({ ...request, range: { days: 7 }, thresholds: { interest: [], ephemeral: [] } });
		expect(empty.interest).toEqual([]);
		expect(empty.ephemeral).toEqual([]);
		expect(f.query).toHaveBeenCalledTimes(calls * 2);
		jest.advanceTimersByTime(61_000);
		const refreshed = await f.service.whatIf({ ...request, range: { days: 7 }, thresholds: {} });
		expect(refreshed.interest.map(row => row.theta)).toEqual([3]);
		expect(refreshed.ephemeral.map(row => row.theta)).toEqual([1]);
		expect(f.query).toHaveBeenCalledTimes(calls * 3);
	});

	test('valid cached thresholds cannot bypass validation of excess duplicates or unknown fields', async () => {
		const f = fixture();
		await f.service.whatIf({ ...request, thresholds: { interest: [3] } });
		const calls = f.query.mock.calls.length;
		await expect(f.service.whatIf({ ...request, thresholds: { interest: Array(9).fill(3) } })).rejects.toThrow(RangeError);
		await expect(f.service.whatIf({ ...request, thresholds: { interest: [3], unknown: [] } } as never)).rejects.toThrow(RangeError);
		await expect(f.service.whatIf({ ...request, axis: 'fof', thresholds: { interest: [3] } } as never)).rejects.toThrow(RangeError);
		expect(f.query).toHaveBeenCalledTimes(calls);
	});

	test('cache is bounded to 32 entries under varying threshold requests', async () => {
		const f = fixture();
		for (let index = 0; index < 33; index++) await f.service.whatIf({ ...request, thresholds: { interest: [1 + index / 100] } });
		await f.service.whatIf({ ...request, thresholds: { interest: [1] } });
		expect(f.query.mock.calls.filter(([sql]) => sql === INSIGHTS_WHAT_IF_SQL)).toHaveLength(34);
	});
});

describe('notes and bounded raw ranges', () => {
	test('recent cohorts explicitly distinguish in-flight outcomes from current-day capture', async () => {
		const f = fixture();
		const mature = await f.service.notes({ range: { from: '2026-09-05', to: '2026-09-05' } });
		expect(mature.unavailable).toEqual([]);
		const immature = await f.service.notes({ range: { from: '2026-09-06', to: '2026-09-06' } });
		expect(immature.unavailable).toEqual(['served.outcomesProvisional']);
		const current = await f.service.opportunities({ days: 7 });
		expect(current.unavailable).toEqual(expect.arrayContaining([
			'served.currentDayProvisional', 'served.outcomesProvisional',
			'demand.hiddenCost.currentDayProvisional', 'hiddenCost.outcomesProvisional',
		]));
		const whatIf = await f.service.whatIf({ range: { days: 7 }, axis: 'exploration', thresholds: {} });
		expect(whatIf.unavailable).toEqual(expect.arrayContaining(['served.currentDayProvisional', 'served.outcomesProvisional']));
	});

	test('>=20 served, all users, snippet160 codepoints, and explicit fields only', async () => {
		const f = fixture();
		f.data.notes.push(note({ served: 19 }), note({ users: 4 }));
		const result = await f.service.notes({ range, dimension: 'source', key: 'exploration' });
		expect(result.notes).toHaveLength(2);
		expect(result.notes[0]).toEqual({ noteId: 'public-note', text: '😀'.repeat(160), authorLocality: 'local', source: 'exploration', contentType: 2, served: 20, reaction: 1, reply: 1, renote: 0, engagementRate: 0.1 });
		expect(f.query).toHaveBeenCalledWith(INSIGHTS_NOTES_SQL, ['2026-09-01T00:00:00+09:00', '2026-09-08T00:00:00+09:00', '{"source":"exploration"}']);
	});

	test('cached aggregates still recheck public/deleted/suspended/target safety each time', async () => {
		const f = fixture();
		const first = await f.service.notes({ range });
		first.notes[0].served = 999;
		expect((await f.service.notes({ range })).notes[0].served).toBe(20);
		f.data.details = []; // The live safety query no longer returns the note.
		expect((await f.service.notes({ range })).notes).toEqual([]);
		expect(f.query.mock.calls.filter(([sql]) => sql === INSIGHTS_NOTES_SQL)).toHaveLength(1);
		expect(f.query.mock.calls.filter(([sql]) => sql.includes('FROM note n'))).toHaveLength(3);
		jest.advanceTimersByTime(61_000);
		await f.service.notes({ range });
		expect(f.query.mock.calls.filter(([sql]) => sql === INSIGHTS_NOTES_SQL)).toHaveLength(2);
	});

	test.each(['reply', 'renote'])('cache hits refresh text and remove wrappers with newly private/deleted %s targets', async target => {
		const f = fixture();
		f.data.notes = [note({ noteId: 'private-target-wrapper' }), note({ noteId: 'deleted-target-wrapper' })];
		f.data.details = f.data.notes.map(row => ({ noteId: row.noteId, text: 'original', authorLocality: 'local' }));
		expect((await f.service.notes({ range })).notes).toHaveLength(2);
		f.data.details[0].text = 'edited public text';
		expect((await f.service.notes({ range })).notes[0].text).toBe('edited public text');
		// The live SQL excludes one wrapper for a private target and the other for a missing target.
		f.data.details = [];
		expect((await f.service.notes({ range })).notes).toEqual([]);
		expect(f.query.mock.calls.filter(([sql]) => sql === INSIGHTS_NOTES_SQL)).toHaveLength(1);
		const safetyCalls = f.query.mock.calls.filter(([sql]) => sql.includes('FROM note n'));
		expect(safetyCalls).toHaveLength(3);
		for (const [sql, params] of safetyCalls) {
			expect(params).toEqual([['private-target-wrapper', 'deleted-target-wrapper']]);
			expect(sql).toContain(`LEFT JOIN note ${target}_target ON ${target}_target.id=n."${target}Id"`);
			expect(sql).toContain(`n."${target}Id" IS NULL OR (${target}_target.visibility='public'`);
			for (const alias of ['author', 'reply_author', 'renote_author']) {
				expect(sql).toContain(`${alias}."isSuspended"=false`);
				expect(sql).toContain(`${alias}."isDeleted"=false`);
			}
			expect(sql).toContain('n.visibility=\'public\'');
		}
	});

	test('notes normalize filter object order but isolate different filters', async () => {
		const f = fixture();
		const first = await f.service.notes({ range, dimension: 'source', key: 'exploration' });
		const calls = f.query.mock.calls.length;
		expect(await f.service.notes({ key: 'exploration', dimension: 'source', range: { to: range.to, from: range.from } })).toEqual(first);
		expect(f.query).toHaveBeenCalledTimes(calls + 1); // Only the mandatory live safety query.
		await f.service.notes({ range, dimension: 'source', key: 'fof' });
		await f.service.notes({ range, dimension: 'media', key: 'fof' });
		expect(f.query.mock.calls.filter(([sql]) => sql === INSIGHTS_NOTES_SQL)).toHaveLength(3);
	});

	test('notes suppression never enumerates unsafe note ids', async () => {
		const f = fixture();
		f.data.notes = [];
		f.data.notesSuppressed = true;
		const result = await f.service.notes({ range });
		expect(result.suppressed).toEqual([]);
		expect(result.notes).toEqual([]);
	});

	test.each([{ dimension: 'source' }, { key: 'value' }, { dimension: 'userId', key: 'secret' }, { dimension: 'source', key: 'x'.repeat(129) }])('rejects malformed filter %j', async params => {
		const f = fixture();
		await expect(f.service.notes({ range, ...params } as never)).rejects.toThrow(RangeError);
		expect(f.query).not.toHaveBeenCalled();
	});

	test('30-day maximum is enforced for notes/what-if; opportunities still supports 90', async () => {
		const f = fixture();
		await expect(f.service.notes({ range: { days: 90 } })).rejects.toThrow('at most 30 days');
		await expect(f.service.whatIf({ range: { days: 90 }, axis: 'exploration', thresholds: {} })).rejects.toThrow('at most 30 days');
		await expect(f.service.notes({ range: { from: '2026-08-01', to: '2026-08-31' } })).rejects.toThrow('at most 30 days');
		expect(f.query).not.toHaveBeenCalled();
		await expect(f.service.notes({ range: { from: '2026-08-01', to: '2026-08-30' } })).resolves.toHaveProperty('notes');
		await expect(f.service.opportunities({ days: 90 })).resolves.toHaveProperty('allocation');
	});

	test('unexpected storage failures are not swallowed as successful empty results', async () => {
		const f = fixture();
		f.query.mockRejectedValueOnce(new Error('storage failure'));
		await expect(f.service.notes({ range })).rejects.toThrow('storage failure');
	});
});

describe('SQL invariants (storage execution belongs to main integration gate)', () => {
	test('joint cohort is exactly P1 SQL, including separate 0/1 outcome types and inclusive14day boundary', () => {
		expect(INSIGHTS_CONTENT_SQL.startsWith(METRICS_COHORT_CTE)).toBe(true);
		for (const sql of [INSIGHTS_WHAT_IF_SQL, INSIGHTS_NOTES_SQL]) {
			expect(sql.startsWith(METRICS_COHORT_CTE.replace('SELECT s."userId",', 'SELECT s."noteId", s."userId",'))).toBe(true);
		}
		expect(METRICS_COHORT_CTE).toContain('<= s."createdAt" + interval \'336 hours\'');
		expect(METRICS_COHORT_CTE).toContain('MAX(CASE WHEN e."eventType" = \'reply\' THEN 1 ELSE 0 END)');
	});

	test('what-if is unique served exploration inventory at current PV, never arbitrary historic judgement inventory', () => {
		expect(INSIGHTS_WHAT_IF_SQL).toContain('COUNT(DISTINCT j."noteId")');
		expect(INSIGHTS_WHAT_IF_SQL).toContain('COUNT(DISTINCT j."userId")');
		expect(INSIGHTS_WHAT_IF_SQL).toContain('j."promptVersion"=$4');
		expect(INSIGHTS_WHAT_IF_SQL).toContain('j.model NOT LIKE \'rule:%\'');
		expect(INSIGHTS_WHAT_IF_SQL).not.toContain('"judgedAt"');
		expect(INSIGHTS_WHAT_IF_SQL).toContain('j.interest >= CASE');
		expect(INSIGHTS_WHAT_IF_SQL).toContain('j."ephemeralScore" <= CASE');
	});

	test('demand counts actual pages and captured levels, not event/profile estimates', () => {
		expect(INSIGHTS_DEMAND_SQL).toContain('FROM hanami_metrics_page');
		expect(INSIGHTS_DEMAND_SQL).toContain('jsonb_each_text(p.axes)');
		expect(INSIGHTS_DEMAND_SQL).toContain('AVG(COALESCE((p.counts->>a.key)::numeric,0))');
		expect(INSIGHTS_DEMAND_SQL).not.toMatch(/user_profile|hanami_metrics_event/);
	});

	test('hidden cost deduplicates types per candidate/user/note in14days, normal outcomes only', () => {
		expect(INSIGHTS_HIDDEN_SQL).toContain('COUNT(DISTINCT e."eventType")');
		expect(INSIGHTS_HIDDEN_SQL).toContain('e."userId"=c."userId" AND e."noteId"=c."noteId" AND e.source=\'normal\'');
		expect(INSIGHTS_HIDDEN_SQL).toContain('<=c."capturedAt"+interval \'336 hours\'');
		expect(INSIGHTS_HIDDEN_SQL).toContain('COUNT(*)::int AS candidates');
	});

	test('notes enforce safe public targets before top20 selection and sort per-type outcome rate', () => {
		expect(INSIGHTS_NOTES_SQL).toContain('FROM cohort GROUP BY "noteId"');
		expect(INSIGHTS_NOTES_SQL).toContain('served>=20');
		expect(INSIGHTS_NOTES_SQL).toContain('(reaction+reply+renote)::float8/served DESC');
		expect(INSIGHTS_NOTES_SQL).toContain('LIMIT 20');
		expect(INSIGHTS_NOTES_SQL).toContain('jsonb_agg(r ORDER BY');
		expect(INSIGHTS_NOTES_SQL).toContain('false AS suppressed');
		for (const alias of ['author', 'reply_author', 'renote_author']) {
			expect(INSIGHTS_NOTES_SQL).toContain(`${alias}."isSuspended"=false`);
			expect(INSIGHTS_NOTES_SQL).toContain(`${alias}."isDeleted"=false`);
		}
		for (const alias of ['n', 'reply_target', 'renote_target']) expect(INSIGHTS_NOTES_SQL).toContain(`${alias}.visibility='public'`);
	});
});
