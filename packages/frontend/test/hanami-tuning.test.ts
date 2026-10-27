/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { adjustHanamiAmount, createHanamiTuningUndo, getAvailableHanamiAxes, HanamiTuningSaveQueue, normalizeHanamiTuning, resetHanamiTuning, resolveHanamiTuning, switchHanamiMode } from '@/utility/hanami-tuning.js';

afterEach(() => vi.useRealTimers());

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
	test('auto → manual copies current weights/amounts; returning to auto retains positions; re-entering copies again', () => {
		const original = normalizeHanamiTuning({ hanamiTuning: { mode: 'auto', closeness: 0, freshness: 4, discovery: 3 } });
		const resolved = resolveHanamiTuning({ hanamiTuning: original });
		const manual = switchHanamiMode(original, 'manual');
		expect(manual.manual).toEqual({ amounts: Object.fromEntries(resolved.amounts), freshWeights: resolved.freshWeights, closeWeights: resolved.closeWeights, authorCap: 2 });
		const edited = adjustHanamiAmount(manual, 'globalPopular', .25);
		const auto = switchHanamiMode(edited, 'auto');
		expect(auto).toMatchObject(original);
		expect(auto.manual).toEqual(edited.manual);
		expect(switchHanamiMode(auto, 'manual').manual).toEqual(manual.manual);
	});
	test('reset returns centered auto and enables ephemeral reduction', () => {
		expect(resetHanamiTuning()).toEqual({ hanamiTuning: { mode: 'auto', closeness: 2, freshness: 2, discovery: 2 }, hanamiReduceEphemeralPosts: true });
	});
	test('reason +/-25% enters manual, clamps 0..300%, and offers an expiring one-shot undo', () => {
		vi.useFakeTimers();
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
		queue.enqueue({ ...resetHanamiTuning(), hanamiTuning: { mode: 'auto', closeness: 4, freshness: 2, discovery: 2 } });
		await vi.advanceTimersByTimeAsync(600); expect(save).toHaveBeenCalledTimes(1);
		resolve(); await vi.advanceTimersByTimeAsync(0);
		expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0].hanamiTuning.closeness).toBe(4); expect(refresh).toHaveBeenCalledTimes(2);
		save.mockRejectedValueOnce(new Error('offline')); queue.enqueue(resetHanamiTuning()); await vi.advanceTimersByTimeAsync(600);
		expect(error).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(2);
	});
});
