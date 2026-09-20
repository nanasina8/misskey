/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// @vitest-environment happy-dom

import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import type { ChartConfiguration } from 'chart.js';
import { engagementTotal, finiteMetric, formatMetric, isMetricSuppressed, metricDifference, metricRatio, safeUserBucket, seriesValues, shareWidth, sourceLabel, sumMetrics, useMetricsResource } from '@/scripts/hanami-metrics.js';
import type { Metric, MetricsNotes, MetricsOpportunities } from '@/scripts/hanami-metrics.js';
import MkHanamiShareBars from '@/components/MkHanamiShareBars.vue';
import MkHanamiSeriesChart from '@/components/MkHanamiSeriesChart.vue';
import HanamiOverview from '@/pages/admin/hanami.overview.vue';
import HanamiStats from '@/pages/admin/hanami.stats.vue';

const chartMock = vi.hoisted(() => ({ configs: [] as ChartConfiguration<'line', Metric[], string>[], destroy: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('chart.js', async importOriginal => ({
	...await importOriginal<typeof import('chart.js')>(),
	Chart: class {
		static register = vi.fn();
		constructor(_canvas: HTMLCanvasElement, config: ChartConfiguration<'line', Metric[], string>) { chartMock.configs.push(config); }
		destroy = chartMock.destroy;
	},
}));
vi.mock('@/events.js', () => ({ globalEvents: { on: chartMock.on, off: chartMock.off } }));

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: apiMock }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><h2><slot name="label"/></h2><slot/></section>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<aside><slot/></aside>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkNumber.vue', () => ({ default: { props: ['value'], template: '<span>{{ value }}</span>' } }));
vi.mock('@/components/MkNumberDiff.vue', () => ({ default: { props: ['value'], template: '<span>{{ value }}</span>' } }));
vi.mock('@/components/MkSelect.vue', () => ({ default: {
	props: ['items', 'modelValue', 'disabled'], emits: ['update:modelValue'],
	template: '<label><slot name="label"/><select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', items.find(item => String(item.value) === $event.target.value).value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>',
} }));
vi.mock('@/i18n.js', () => {
	const keys = 'overview stats usage engagement engagementRate served seen reaction reply renote activeUsersDay activeUsersWeek generationErrors breakdown dimension filter period opportunities topReactedNotes partialData lift users source contentType relationshipClass media freshness authorLocality trendTerm cluster all days7 days14 days30 days90 tlShare manualRefresh rateLimited failed attempts message userBucket date allocation contentOpportunities supplyWalls demand hiddenCost tuningDrift current suggested under over balanced loading error retry perTypeEngagement judge'.split(' ');
	return { i18n: { ts: { _time: { day: 'Day(s)' }, dayOverDayChanges: 'Day over day', _timelines: { home: 'Home', local: 'Local', social: 'Social', global: 'Global' }, _hana: {
		hanamiTimeline: 'Hanami',
		_admin: { ...Object.fromEntries(keys.map(key => [key, key])), share: 'Served share', engagementShare: 'Engagement share', unavailable: 'Unavailable', suppressedFewUsers: '<5 users', noData: 'No data' },
		_recommendation: { _reason: { exploration: 'Explore' }, axisConfidenceHigh: 'High', axisConfidenceLow: 'Low', axisConfidenceNone: 'None' },
	} } } };
});

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in metrics unit tests'); })));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Hanami metrics: nulls and approved per-type engagement', () => {
	test('reaction plus reply counts twice, allowing a rate above 100%', () => {
		const total = engagementTotal({ reaction: 1, reply: 1, renote: 0 });
		expect(total).toBe(2);
		expect(metricRatio(total, 1)).toBe(2);
		expect(formatMetric(metricRatio(total, 1), 'Unavailable', 'percent')).toBe('200%');
	});
	test('a hidden outcome never becomes a visible zero or partial sum', () => {
		expect(engagementTotal({ reaction: 3, reply: null, renote: 1 })).toBeNull();
		expect(sumMetrics([1, null, 3])).toBeNull();
		expect(sumMetrics([0, 0, 0])).toBe(0);
	});
	test.each([[null, 5], [5, null], [5, 0], [0, 0], [1, -1], [Infinity, 1]] as const)('ratio(%s, %s) is unavailable', (numerator, denominator) => {
		expect(metricRatio(numerator, denominator)).toBeNull();
	});
	test('real zeros are distinct from missing values', () => {
		expect(metricRatio(0, 5)).toBe(0);
		expect(formatMetric(0, 'Unavailable', 'percent')).toBe('0%');
		for (const value of [null, undefined, NaN, Infinity]) {
			expect(finiteMetric(value)).toBe(false);
			expect(formatMetric(value, 'Unavailable')).toBe('Unavailable');
		}
	});
	test('paired share ratio uses the supplied visible shares without renormalization', () => {
		expect(metricRatio(.15, .09)).toBeCloseTo(1.6666667);
		expect(shareWidth(.09)).toBe('9%');
		expect(shareWidth(null)).toBeNull();
		expect(shareWidth(NaN)).toBeNull();
		expect(shareWidth(0)).toBe('0%');
		expect(shareWidth(2)).toBe('100%');
		expect(shareWidth(-1)).toBe('0%');
	});
	test('series preserve null gaps and missing days; rates are not capped', () => {
		expect(seriesValues(['a', 'b', 'c', 'd'], [0, null, 2], true)).toEqual([0, null, 200, null]);
	});
	test('no delta is invented for a missing previous day', () => {
		expect(metricDifference(5, null)).toBeNull();
		expect(metricDifference(null, 5)).toBeNull();
		expect(metricDifference(5, 6)).toBe(-1);
	});
	test('suppression applies to a whole subtree, not a similarly named metric', () => {
		expect(isMetricSuppressed('engagement.engagementRate', ['engagement'])).toBe(true);
		expect(isMetricSuppressed('usage.hanamiUsers.day', ['usage.hanamiUsers.day'])).toBe(true);
		expect(isMetricSuppressed('engagementRate', ['engagement'])).toBe(false);
	});
	test('only the daily pseudonymous user bucket may be rendered', () => {
		expect(safeUserBucket('u#a30f')).toBe('u#a30f');
		for (const bucket of ['raw-user-id', 'u#a3', 'u#a30ff', '@user@example.com', '<script>']) expect(safeUserBucket(bucket)).toBeNull();
	});
	test('source localization uses an explicit static map', () => {
		const reasons = { popular: 'Popular', globalPopular: 'Global', exploration: 'Explore', neighborTrending: 'Neighbor', reactionSimilar: 'Similar', catchup: 'Catch up', trending: 'Trend', fof: 'FoF' };
		expect(sourceLabel('exploration', reasons)).toBe('Explore');
		expect(sourceLabel('__proto__', reasons)).toBe('__proto__');
		expect(sourceLabel('unknown-source', reasons)).toBe('unknown-source');
	});
});

describe('MkHanamiShareBars', () => {
	test('renders paired shares, ratio, and a suppressed label without a fabricated bar', () => {
		const view = render(MkHanamiShareBars, { props: { rows: [{ key: 'exploration', label: 'Explore', share: .1, engagementShare: .2 }], suppressed: ['fof'] } });
		expect(view.getByText('Explore')).toBeTruthy();
		expect(view.getByText('2×')).toBeTruthy();
		expect(view.getByText('Served share: 10%')).toBeTruthy();
		expect(view.getByText('Engagement share: 20%')).toBeTruthy();
		expect(view.getByText('fof: <5 users')).toBeTruthy();
		expect(view.container.querySelectorAll('[style*="width"]')).toHaveLength(2);
	});
	test('null shares are unavailable and have no zero-width bar', () => {
		const view = render(MkHanamiShareBars, { props: { rows: [{ key: 'unknown', share: null, engagementShare: null }] } });
		expect(view.getByText('Served share: Unavailable')).toBeTruthy();
		expect(view.getByText('Engagement share: Unavailable')).toBeTruthy();
		expect(view.container.querySelectorAll('[style*="width"]')).toHaveLength(0);
		expect(view.container.textContent).not.toContain('0%');
	});
	test('server-provided text is escaped, not interpreted as HTML', () => {
		const view = render(MkHanamiShareBars, { props: { rows: [{ key: '<img src=x onerror=alert(1)>', share: 0, engagementShare: 0 }] } });
		expect(view.container.querySelector('img')).toBeNull();
		expect(view.getByText('Served share: 0%')).toBeTruthy();
		expect(view.getByText('Unavailable')).toBeTruthy();
	});
	test('an empty response is explicitly identified', () => {
		const view = render(MkHanamiShareBars, { props: { rows: [] } });
		expect(view.getByText('No data')).toBeTruthy();
	});
});

describe('metrics requests', () => {
	test('range changes clear old data, abort, and ignore late responses', async () => {
		const selected = ref(7);
		const requests: { resolve: (value: number) => void; signal: AbortSignal }[] = [];
		const scope = effectScope();
		const state = scope.run(() => useMetricsResource(() => selected.value, (_days, signal) => new Promise<number>(resolve => requests.push({ resolve, signal }))))!;
		expect(state.loading.value).toBe(true);
		selected.value = 30;
		await nextTick();
		expect(requests[0].signal.aborted).toBe(true);
		requests[1].resolve(30);
		await nextTick();
		requests[0].resolve(7);
		await nextTick();
		expect(state.data.value).toBe(30);
		selected.value = 90;
		await nextTick();
		expect(state.data.value).toBeNull();
		scope.stop();
		expect(requests[2].signal.aborted).toBe(true);
		requests[2].resolve(90);
		await nextTick();
		expect(state.data.value).toBeNull();
	});
	test('failures stay local to their panel and can be retried explicitly', async () => {
		const fetcher = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(5);
		const scope = effectScope();
		const state = scope.run(() => useMetricsResource(() => 7, fetcher))!;
		await nextTick();
		expect(state.failed.value).toBe(true);
		expect(state.loading.value).toBe(false);
		expect(state.data.value).toBeNull();
		await state.reload();
		expect(state.failed.value).toBe(false);
		expect(state.data.value).toBe(5);
		scope.stop();
	});
});

describe('MkHanamiSeriesChart', () => {
	test('keeps null gaps, permits >100%, updates and destroys Chart.js instances', async () => {
		chartMock.configs.length = 0;
		chartMock.destroy.mockClear();
		const view = render(MkHanamiSeriesChart, { props: { days: ['2026-09-19', '2026-09-20'], values: [null, 2], label: 'Engagement rate', percent: true } });
		const config = chartMock.configs[0];
		expect(config.data.datasets[0].data).toEqual([null, 200]);
		expect(config.data.datasets[0].spanGaps).toBe(false);
		expect(config.options?.scales?.y?.max).toBeUndefined();
		expect(view.getByRole('img', { name: 'Engagement rate' })).toBeTruthy();
		await view.rerender({ days: ['2026-09-20'], values: [0], label: 'Engagement rate', percent: true });
		expect(chartMock.destroy).toHaveBeenCalledTimes(1);
		expect(chartMock.configs.at(-1)?.data.datasets[0].data).toEqual([0]);
		view.unmount();
		expect(chartMock.destroy).toHaveBeenCalledTimes(2);
		expect(chartMock.off).toHaveBeenCalledWith('themeChanged', expect.any(Function));
	});
	test('an entirely unavailable series is labelled as such', () => {
		const view = render(MkHanamiSeriesChart, { props: { days: ['2026-09-20'], values: [null], label: 'Usage' } });
		expect(view.getByText('Unavailable')).toBeTruthy();
		expect(chartMock.configs.at(-1)?.data.datasets[0].data).toEqual([null]);
	});
});

const coverage = { status: 'partial' as const, startedAt: null, retainedFrom: '2026-09-01', completeDays: [], partialDays: ['2026-09-20'], outcomesThrough: '2026-09-06', unavailable: ['usage.tlShare.global'] };
const range = { from: '2026-09-01', to: '2026-09-20' };
function breakdownResponse(dimension = 'source') {
	return { range, dimension, coverage, denominator: 'visible', suppressed: ['fof'], rows: [
		{ key: dimension === 'media' ? 'text' : 'exploration', users: 5, served: 5, seen: 5, reaction: 5, reply: 5, renote: 0, share: 1, engagementShare: 1, engagementRate: 2, seenRate: 1, engagementPerSeen: 2, lift: 1 },
	] };
}

describe('metrics pages', () => {
	test('overview requests source breakdown, displays request shares and never renders raw user IDs', async () => {
		apiMock.mockReset();
		const failedByKind = { emptyResult: null, candidateLimit: 0, lockTimeout: 0, exception: 0, unknown: 0 };
		apiMock.mockImplementation(async (endpoint: string) => {
			if (endpoint.endsWith('/breakdown')) return breakdownResponse();
			if (endpoint.endsWith('/errors')) return { range, coverage, suppressed: ['generation.personal.failedByKind.emptyResult'], personal: { byKind: failedByKind, byDay: [{ day: range.to, failed: null }], recent: [
				{ at: range.to, kind: 'exception', attempts: 1, message: 'Safe message', userBucket: 'raw-user-id' },
				{ at: range.to, kind: 'exception', attempts: 1, message: 'Second message', userBucket: 'u#a30f' },
			] }, common: { recent: [] }, judge: { recent: [], backlog: null }, rateLimited: { byDay: [] } };
			return { range, coverage, denominator: 'visible', suppressed: ['usage.hanamiUsers.day'],
				usage: { hanamiUsers: { day: null, week: 7, month: 9 }, tlShare: { home: .5, local: 0, social: 0, global: null, hanami: .5 }, manualRefreshPerUserDay: null, rateLimited429: null },
				engagement: { users: 5, served: 5, seen: 5, reaction: 5, reply: 5, renote: 0, engagementRate: 2, seenRate: 1, normalBaseline: { reaction: null, reply: null, renote: null } },
				generation: { personal: { batches: 5, failed: null, failedRate: null, p50Ms: null, p95Ms: null, failedByKind }, common: { generations: 0, failed: 0, p50Ms: null, p95Ms: null }, judge: { runs: 0, failed: 0, p50Ms: null, p95Ms: null, backlog: null, secPerNote: null, runtime: null } },
				series: { day: [range.to], hanamiUsers: [null], engagementRate: [2], failedBatches: [null] },
			};
		});
		const view = render(HanamiOverview, { global: { directives: { tooltip: {} } } });
		await waitFor(() => expect(view.getByText('Home: 50%')).toBeTruthy());
		expect(view.getByText('manualRefresh / users / Day(s): Unavailable')).toBeTruthy();
		expect(view.getByText('Global: Unavailable')).toBeTruthy();
		expect(view.getByText('200%')).toBeTruthy();
		expect(view.getByText('u#a30f')).toBeTruthy();
		expect(view.container.textContent).not.toContain('raw-user-id');
		expect(view.getByText('emptyResult: <5 users')).toBeTruthy();
		expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/breakdown', { range: { days: 30 }, dimension: 'source' }, undefined, expect.any(AbortSignal));
		await fireEvent.update(view.getByRole('combobox'), '7');
		await waitFor(() => expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/summary', { range: { days: 7 } }, undefined, expect.any(AbortSignal)));
	});
	test('stats uses other-dimension filters; a P3 failure does not hide the breakdown', async () => {
		apiMock.mockReset();
		apiMock.mockImplementation(async (endpoint: string, params: { dimension?: string }) => {
			if (endpoint.endsWith('/breakdown')) return breakdownResponse(params.dimension);
			if (endpoint.endsWith('/opportunities')) throw new Error('Pending endpoint');
			return { range, notes: [{ noteId: 'n1', text: '<img src=x>' + 'x'.repeat(200), authorLocality: 'local', source: 'exploration', contentType: 2, served: 20, reaction: 20, reply: 20, renote: 0, engagementRate: 2 }], suppressed: [], unavailable: [] };
		});
		const view = render(HanamiStats);
		await waitFor(() => expect(view.getByText('200%')).toBeTruthy());
		await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
		expect(view.getByRole('button', { name: 'retry' })).toBeTruthy();
		await waitFor(() => expect(view.container.querySelector('article p')?.textContent?.length).toBe(160));
		expect(view.container.querySelector('img')).toBeNull();
		await fireEvent.update(view.getByLabelText('filter (media)'), 'text');
		await waitFor(() => expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/breakdown', { range: { days: 30 }, dimension: 'source', filter: { media: 'text' } }, undefined, expect.any(AbortSignal)));
		await fireEvent.update(view.getByLabelText('dimension'), 'contentType');
		await waitFor(() => expect(view.getByLabelText('filter (source)')).toBeTruthy());
		await waitFor(() => expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/breakdown', { range: { days: 30 }, dimension: 'contentType' }, undefined, expect.any(AbortSignal)));
		expect(view.queryByRole('button', { name: /apply/i })).toBeNull();
	});
	test('SDK-backed panels preserve nulls and scope notes independently to at most 30 days', async () => {
		apiMock.mockReset();
		apiMock.mockImplementation(async (endpoint: string, params: { dimension?: string }) => {
			if (endpoint.endsWith('/breakdown')) return breakdownResponse(params.dimension);
			if (endpoint.endsWith('/notes')) return { range, notes: [{ noteId: 'n1', text: 'Snippet', authorLocality: 'local', source: 'exploration', contentType: null, served: 20, reaction: 20, reply: 20, renote: 0, engagementRate: 2 }], suppressed: [], unavailable: [] } satisfies MetricsNotes;
			return { range, suppressed: ['demand.fof'], unavailable: ['hiddenCost'],
				allocation: [{ axis: 'exploration', share: .1, engagementShare: .2, ratio: 2, capNow: { high: .1, low: .1, none: .1 }, verdict: 'under', suggestedCap: { high: .2, low: .2, none: .2 } }],
				content: [
					{ contentType: null, media: 'text', relationshipClass: 'unknown', served: 300, engagementRate: 2, lift: null, share: .1, opportunity: null, note: 'Content diagnostic' },
					{ contentType: 0, media: 'text', relationshipClass: 'unknown', served: 300, engagementRate: 0, lift: 0, share: 0, opportunity: 0, note: 'Zero diagnostic' },
					{ contentType: 'unjudged', media: 'text', relationshipClass: 'unknown', served: 300, engagementRate: 1.5, lift: 1.5, share: .1, opportunity: .9, note: 'Unjudged diagnostic' },
				],
				supplyWalls: [{ axis: 'exploration', dropped: { unjudged: 10 }, passed: 5, note: 'Supply diagnostic' }],
				demand: [{ axis: 'exploration', usersHigh: 5, avgServedPerPageHigh: 3, avgServedPerPageNormal: 2, note: 'Demand diagnostic' }],
				hiddenCost: [], tuningDrift: { exploration: { high: 5, low: 10 } },
			} satisfies MetricsOpportunities;
		});
		const view = render(HanamiStats);
		await waitFor(() => expect(view.getByText('Content diagnostic')).toBeTruthy());
		expect(Array.from(view.getByText('Content diagnostic').closest('tr')!.querySelectorAll('td'), cell => cell.textContent)).toEqual(['Unavailable', 'text', 'unknown', '300', '200%', 'Unavailable', '10%', 'Unavailable', 'Content diagnostic']);
		expect(view.getByText('Zero diagnostic').closest('tr')?.querySelector('td')?.textContent).toBe('0');
		expect(view.getByText('Unjudged diagnostic').closest('tr')?.querySelector('td')?.textContent).toBe('unjudged');
		expect(view.container.querySelector('article')?.textContent).toContain('contentType: Unavailable');
		expect(view.container.querySelector('article')?.textContent).toContain('engagementRate: 200%');
		for (const label of ['allocation', 'contentOpportunities', 'supplyWalls', 'demand', 'hiddenCost', 'tuningDrift']) expect(view.getByRole('heading', { name: label })).toBeTruthy();
		expect(view.getByText('High: 20% / Low: 20% / None: 20%')).toBeTruthy();
		expect(view.getByText('under')).toBeTruthy();
		expect(view.getByText('unjudged: 10')).toBeTruthy();
		expect(view.queryByRole('button', { name: /apply/i })).toBeNull();
		await fireEvent.click(view.getByRole('button', { name: 'topReactedNotes' }));
		await waitFor(() => expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/notes', { range: { days: 30 }, dimension: 'source', key: 'exploration' }, undefined, expect.any(AbortSignal)));
		await fireEvent.update(view.getByRole('combobox', { name: 'period' }), '90');
		await waitFor(() => expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/opportunities', { range: { days: 90 } }, undefined, expect.any(AbortSignal)));
		expect(apiMock.mock.calls.filter(([endpoint]) => endpoint === 'admin/hanami/metrics/notes').at(-1)).toEqual(['admin/hanami/metrics/notes', { range: { days: 30 } }, undefined, expect.any(AbortSignal)]);
		expect(view.getByText('partialData — topReactedNotes: days30')).toBeTruthy();
		const notesPeriod = view.getByRole('combobox', { name: 'topReactedNotes — period' });
		expect(Array.from(notesPeriod.querySelectorAll('option'), option => option.value)).toEqual(['7', '14', '30']);
		await fireEvent.update(notesPeriod, '7');
		await waitFor(() => expect(apiMock).toHaveBeenLastCalledWith('admin/hanami/metrics/notes', { range: { days: 7 } }, undefined, expect.any(AbortSignal)));
		expect(view.getByText('partialData — topReactedNotes: days7')).toBeTruthy();
		await fireEvent.update(view.getByRole('combobox', { name: 'period' }), '14');
		await waitFor(() => expect(apiMock).toHaveBeenCalledWith('admin/hanami/metrics/notes', { range: { days: 14 } }, undefined, expect.any(AbortSignal)));
		expect(view.queryByText(/partialData — topReactedNotes:/)).toBeNull();
		expect(apiMock.mock.calls.filter(([endpoint]) => endpoint === 'admin/hanami/metrics/notes').every(([, request]) => request.range.days <= 30)).toBe(true);
	});
});
