/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { funnelWidth, secondsFromMs, shortDay, sparklineSegments, topicJudgeTone } from '@/scripts/hanami-admin-overview.js';

describe('Hanami admin overview helpers', () => {
	test('short day labels drop the year and leading zeros', () => {
		expect(shortDay('2026-10-06')).toBe('10/6');
		expect(shortDay('2026-01-29')).toBe('1/29');
		expect(shortDay('week 42')).toBe('week 42');
	});
	test('sparklines split at missing values instead of drawing zero', () => {
		expect(sparklineSegments([], 120, 28)).toEqual([]);
		expect(sparklineSegments([null, null], 120, 28)).toEqual([]);
		const [first, second] = sparklineSegments([0, 4, null, 2, 4], 120, 28);
		expect(first).toBe('0.0,26.0 30.0,2.0');
		expect(second).toBe('90.0,14.0 120.0,2.0');
	});
	test('a lone value stays visible as a short flat segment', () => {
		expect(sparklineSegments([null, 3, null], 120, 28)).toEqual(['60.0,2.0 62.0,2.0']);
		// At the right edge it extends leftwards so the viewBox does not clip it.
		expect(sparklineSegments([null, 3], 120, 28)).toEqual(['118.0,2.0 120.0,2.0']);
	});
	test('a flat series does not divide by zero', () => {
		expect(sparklineSegments([0, 0], 120, 28)).toEqual(['0.0,26.0 120.0,26.0']);
	});
	test('topic judge tone separates success, waiting and trouble', () => {
		for (const outcome of ['ok', 'partial', 'nothingToDo'] as const) expect(topicJudgeTone(outcome)).toBe('ok');
		for (const outcome of ['noGpu', 'gaveUp', 'rejected', 'failed'] as const) expect(topicJudgeTone(outcome)).toBe('warn');
		expect(topicJudgeTone('waiting')).toBe('neutral');
		expect(topicJudgeTone(null)).toBe('neutral');
	});
	test('seconds and funnel widths tolerate missing values', () => {
		expect(secondsFromMs(3300)).toBe('3.3');
		expect(secondsFromMs(null)).toBeNull();
		expect(funnelWidth(1001, 2098)).toBe(`${1001 / 2098 * 100}%`);
		expect(funnelWidth(5, 0)).toBe('0%');
		expect(funnelWidth(null, 10)).toBe('0%');
		expect(funnelWidth(20, 10)).toBe('100%');
	});
});
