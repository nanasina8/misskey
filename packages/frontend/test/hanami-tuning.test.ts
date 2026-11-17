/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	HANAMI_FOR_YOU_AXES, adjustHanamiAmount, applyHanamiSuggestedAmounts, createHanamiTuningUndo, getAvailableHanamiAxes,
	HanamiTuningSaveQueue, hanamiDirectionPreviews, hanamiGroupComposition, hanamiGroupTrends, hanamiShareRange, hanamiTenTiles, hanamiTilesSummary,
	normalizeHanamiTuning, resetHanamiTuning, roundHanamiWeight, resolveHanamiTuning, switchHanamiMode, switchHanamiModeWithSuggestion,
} from '@/utility/hanami-tuning.js';
import type { HanamiAxis } from '@/utility/hanami-tuning.js';

afterEach(() => vi.useRealTimers());

/** 身近（close）に寄せる倍率。 */
const closeFactors = new Map<HanamiAxis, number>(HANAMI_FOR_YOU_AXES.map(axis => [axis, ['neighborTrending', 'catchup', 'fof'].includes(axis) ? 1.6 : 0.6]));

describe('Hanami tuning edits', () => {
	test('server defaults mask auto and legacy missing values without disabling manual controls', () => {
		const config = { trending: { default: false }, exploration: { available: false } };
		const auto = normalizeHanamiTuning({}, config);
		expect(auto.mode).toBe('auto');
		expect(resolveHanamiTuning({ hanamiTuning: auto }, config).amounts.get('trending')).toBe(0);
		const manual = switchHanamiMode(auto, 'manual', config);
		expect(manual.manual?.amounts.trending).toBe(0);
		const edited = adjustHanamiAmount(manual, 'trending', .25, config);
		expect(resolveHanamiTuning({ hanamiTuning: edited }, config).amounts.get('trending')).toBe(.25);
		expect(getAvailableHanamiAxes(config)).toContain('trending');
		expect(getAvailableHanamiAxes(config)).not.toContain('exploration');
		expect(normalizeHanamiTuning({ hanamiRecommendationAxes: { catchup: 'high' } }, config).manual?.amounts.trending).toBe(0);
		expect(normalizeHanamiTuning({ hanamiRecommendationAxes: { trending: true } }, config).manual?.amounts.trending).toBe(1);
	});
	test('legacy closeness moves into direction; old manual weights are dropped on read', () => {
		expect(normalizeHanamiTuning({ hanamiTuning: { mode: 'auto', closeness: 0, freshness: 4, discovery: 3 } })).toMatchObject({ mode: 'direction', direction: 0 });
		const legacy = normalizeHanamiTuning({ hanamiTuning: { mode: 'manual', manual: { amounts: { trending: 2 }, authorCap: 3, freshWeights: [1, 2, 3], closeWeights: [1, 1, 1] } } });
		expect(legacy.manual).toEqual({ amounts: expect.objectContaining({ trending: 2 }), authorCap: 3 });
	});
	test('switching between the four modes keeps the other settings, and manual starts from the current amounts', () => {
		const direction = { ...normalizeHanamiTuning({}), mode: 'direction' as const, direction: 2, drift: 0 };
		const manual = switchHanamiMode(direction, 'manual', {}, closeFactors);
		expect(manual.manual?.amounts).toEqual(Object.fromEntries([...resolveHanamiTuning({ hanamiTuning: direction }, {}, closeFactors).amounts].map(([axis, amount]) => [axis, roundHanamiWeight(amount)])));
		const recommend = switchHanamiMode(manual, 'recommend');
		expect(recommend).toMatchObject({ mode: 'recommend', direction: 2, drift: 0, manual: manual.manual });
		expect(switchHanamiMode(recommend, 'auto')).toMatchObject({ mode: 'auto', direction: 2, drift: 0 });
	});
	test('switching to recommend from another mode takes the suggested groups once; it never overwrites while staying in recommend', () => {
		const suggestion = { axes: [], groups: { close: 4, buzz: 0, fresh: 3 } };
		const auto = { ...normalizeHanamiTuning({}), groups: { close: 1, buzz: 1, fresh: 1 } };
		const recommend = switchHanamiModeWithSuggestion(auto, 'recommend', {}, suggestion);
		expect(recommend).toMatchObject({ mode: 'recommend', groups: { close: 4, buzz: 0, fresh: 3 } });
		const edited = { ...recommend, groups: { close: 2, buzz: 2, fresh: 2 } };
		expect(switchHanamiModeWithSuggestion(edited, 'recommend', {}, suggestion)).toBe(edited);
		// おすすめがまだ無いときは、いまの値のまま。
		expect(switchHanamiModeWithSuggestion(auto, 'recommend', {}, null).groups).toEqual({ close: 1, buzz: 1, fresh: 1 });
		// 「すべて自分で」へは、反応に合わせて寄せたあとの量から始める。
		const manual = switchHanamiModeWithSuggestion(auto, 'manual', {}, { axes: [...closeFactors].map(([axis, factor]) => ({ axis, factor })), groups: suggestion.groups });
		expect(manual.manual?.amounts.neighborTrending).toBeCloseTo(1.4);
		expect(manual.manual?.amounts.globalPopular).toBeCloseTo(0.7);
	});
	test('reset returns auto with default levels and enables ephemeral reduction', () => {
		expect(resetHanamiTuning()).toEqual({ hanamiTuning: { mode: 'auto', direction: 1, drift: 1, groups: { close: 2, buzz: 2, fresh: 2 } }, hanamiReduceEphemeralPosts: true });
	});
	test('reason +/-25% enters manual from any mode, clamps 0..300%, and offers an expiring one-shot undo', () => {
		vi.useFakeTimers();
		for (const mode of ['auto', 'direction', 'recommend'] as const) {
			const original = { ...normalizeHanamiTuning({}), mode };
			expect(adjustHanamiAmount(original, 'trending', .25).mode).toBe('manual');
		}
		const original = normalizeHanamiTuning({});
		const added = adjustHanamiAmount(original, 'trending', .25);
		expect(added).toMatchObject({ mode: 'manual', manual: { amounts: { trending: 1.25 } } });
		expect(adjustHanamiAmount(added, 'trending', -.25).manual?.amounts.trending).toBe(1);
		expect(adjustHanamiAmount(added, 'trending', 10).manual?.amounts.trending).toBe(3);
		expect(adjustHanamiAmount(added, 'trending', -10).manual?.amounts.trending).toBe(0);
		const restore = vi.fn();
		const undo = createHanamiTuningUndo(original, restore);
		expect(undo()).toBe(true); expect(undo()).toBe(false);
		expect(restore).toHaveBeenCalledExactlyOnceWith(original);
		const expired = createHanamiTuningUndo(original, restore);
		vi.advanceTimersByTime(8000);
		expect(expired()).toBe(false);
	});
	test('suggested amounts scale the auto amounts, keep turned-off axes off, and are idempotent', () => {
		const axes = HANAMI_FOR_YOU_AXES.map(axis => ({ axis, factor: axis === 'globalPopular' ? 0.95 : axis === 'trending' ? 1.05 : 1 }));
		const manual = { ...switchHanamiMode(normalizeHanamiTuning({}), 'manual'), manual: { amounts: { ...Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, 1])), trending: 3, catchup: 0 }, authorCap: 3 } };
		const applied = applyHanamiSuggestedAmounts(manual, axes);
		expect(applied.manual).toEqual({ amounts: expect.objectContaining({ globalPopular: 0.95, trending: 1.05, catchup: 0, neighborTrending: 1 }), authorCap: 3 });
		expect(applyHanamiSuggestedAmounts(applied, axes).manual).toEqual(applied.manual);
	});
});

describe('Hanami tuning view helpers', () => {
	test('ten tiles always add up to 10 and follow the group composition', () => {
		for (const tuning of [
			normalizeHanamiTuning({}),
			{ ...normalizeHanamiTuning({}), mode: 'direction' as const, direction: 0 },
			{ ...normalizeHanamiTuning({}), mode: 'direction' as const, direction: 2 },
			{ ...normalizeHanamiTuning({}), mode: 'recommend' as const, groups: { close: 0, buzz: 4, fresh: 4 } },
		]) {
			const counts = hanamiTenTiles(hanamiGroupComposition(tuning));
			expect(counts.close + counts.buzz + counts.fresh).toBe(10);
		}
		const close = hanamiTenTiles(hanamiGroupComposition({ ...normalizeHanamiTuning({}), mode: 'direction', direction: 0 }));
		const wide = hanamiTenTiles(hanamiGroupComposition({ ...normalizeHanamiTuning({}), mode: 'direction', direction: 2 }));
		expect(close.close).toBeGreaterThan(wide.close);
		expect(close.fresh).toBeLessThan(wide.fresh);
	});
	test('tiles summary reports which groups grew only for modes that move by themselves', () => {
		const auto = hanamiTilesSummary(normalizeHanamiTuning({}), {}, closeFactors);
		expect(auto.moving).toBe(true);
		expect(auto.increased).toEqual(['close']);
		expect(auto.counts).toEqual(hanamiTenTiles(hanamiGroupComposition(normalizeHanamiTuning({}), {}, closeFactors)));
		const recommend = hanamiTilesSummary({ ...normalizeHanamiTuning({}), mode: 'recommend' }, {}, closeFactors);
		expect(recommend).toMatchObject({ moving: false, increased: [] });
		expect(recommend.counts).toEqual(recommend.base);
		expect(hanamiTilesSummary(normalizeHanamiTuning({}), {}, null).increased).toEqual([]);
	});
	test('group trends follow the bounded factors and are null when nothing moves', () => {
		expect(hanamiGroupTrends(normalizeHanamiTuning({}), {}, closeFactors)).toEqual({ close: 'up', buzz: 'down', fresh: expect.any(String) });
		expect(hanamiGroupTrends({ ...normalizeHanamiTuning({}), mode: 'manual' }, {}, closeFactors)).toBeNull();
		expect(hanamiGroupTrends(normalizeHanamiTuning({}), {}, null)).toBeNull();
	});
	test('share range widens with the drift level, contains the current share, and is null when nothing moves', () => {
		const base = { ...normalizeHanamiTuning({}), mode: 'direction' as const, direction: 1 };
		const ranges = [0, 1, 2].map(drift => hanamiShareRange({ ...base, drift })!);
		const widths = ranges.map(range => range.high - range.low);
		expect(widths[0]).toBeLessThan(widths[1]);
		expect(widths[1]).toBeLessThan(widths[2]);
		for (const range of ranges) {
			expect(range.low).toBeLessThan(range.base);
			expect(range.high).toBeGreaterThan(range.base);
			// 倍率がまだ無いときは、寄せる前のまま。
			expect(range.now).toBe(range.base);
		}
		expect(ranges[0].base).toBe(Math.round(hanamiGroupComposition(base).close));
		const leaning = hanamiShareRange(base, {}, closeFactors)!;
		expect(leaning.now).toBeGreaterThan(leaning.base);
		expect(leaning.now).toBeLessThanOrEqual(leaning.high);
		const wider = new Map([...closeFactors].map(([axis, factor]) => [axis, 1 / factor]));
		const away = hanamiShareRange(base, {}, wider)!;
		expect(away.now).toBeLessThan(away.base);
		expect(away.now).toBeGreaterThanOrEqual(away.low);
		// おまかせは「ふつう」の幅。
		expect(hanamiShareRange(normalizeHanamiTuning({}))).toEqual(hanamiShareRange({ ...normalizeHanamiTuning({}), mode: 'direction', direction: 1, drift: 1 }));
		expect(hanamiShareRange({ ...base, mode: 'recommend' })).toBeNull();
		expect(hanamiShareRange({ ...base, mode: 'manual' })).toBeNull();
	});
	test('direction previews show the share of each direction before any drift', () => {
		const previews = hanamiDirectionPreviews(normalizeHanamiTuning({}));
		expect(previews).toHaveLength(3);
		expect(previews[0].close).toBeGreaterThan(previews[1].close);
		expect(previews[1].close).toBeGreaterThan(previews[2].close);
		expect(previews[2].fresh).toBeGreaterThan(previews[0].fresh);
		expect(previews[1]).toEqual(hanamiGroupComposition({ ...normalizeHanamiTuning({}), mode: 'direction', direction: 1 }));
	});
});

describe('Hanami tuning save queue', () => {
	test('600ms trailing debounce saves once before refreshing, including toggle state', async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const save = vi.fn(async () => { order.push('save'); });
		const refresh = vi.fn(() => order.push('refresh'));
		const queue = new HanamiTuningSaveQueue(save, refresh, vi.fn());
		queue.enqueue(resetHanamiTuning());
		await vi.advanceTimersByTimeAsync(400);
		queue.enqueue({ ...resetHanamiTuning(), hanamiReduceEphemeralPosts: false });
		await vi.advanceTimersByTimeAsync(599); expect(save).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(save).toHaveBeenCalledExactlyOnceWith({ ...resetHanamiTuning(), hanamiReduceEphemeralPosts: false });
		expect(order).toEqual(['save', 'refresh']);
	});
	test('edits during a save serialize exactly one latest followup; failed saves do not refresh', async () => {
		vi.useFakeTimers();
		let resolve!: () => void;
		const save = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { resolve = r; })).mockResolvedValue(undefined);
		const refresh = vi.fn();
		const error = vi.fn();
		const queue = new HanamiTuningSaveQueue(save, refresh, error);
		queue.enqueue(resetHanamiTuning()); await vi.advanceTimersByTimeAsync(600);
		queue.enqueue({ ...resetHanamiTuning(), hanamiReduceEphemeralPosts: false });
		queue.enqueue({ ...resetHanamiTuning(), hanamiTuning: { ...resetHanamiTuning().hanamiTuning, mode: 'direction', direction: 2 } });
		await vi.advanceTimersByTimeAsync(600); expect(save).toHaveBeenCalledTimes(1);
		resolve(); await vi.advanceTimersByTimeAsync(0);
		expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0].hanamiTuning).toMatchObject({ mode: 'direction', direction: 2 }); expect(refresh).toHaveBeenCalledTimes(2);
		save.mockRejectedValueOnce(new Error('offline')); queue.enqueue(resetHanamiTuning()); await vi.advanceTimersByTimeAsync(600);
		expect(error).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(2);
	});
});
