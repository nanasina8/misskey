/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { HanamiMetricsRollupCommandService, parseHanamiMetricsRollupArgs } from '@/cli/HanamiMetricsRollupCommandService.js';

describe('hanami:metrics-rollup arguments (no application startup)', () => {
	const now = new Date('2026-09-19T15:00:00.000Z'); // September 20, midnight JST

	test('defaults to yesterday JST and includes exactly 14 days from 14 days ago', () => {
		const range = parseHanamiMetricsRollupArgs(['--from', '2026-09-06'], now);
		expect(range.from).toBe('2026-09-06');
		expect(range.to).toBe('2026-09-19');
		expect(range.days).toHaveLength(14);
		expect(range.days[0]).toBe(range.from);
		expect(range.days[13]).toBe(range.to);
	});

	test('yesterday changes at JST midnight, not UTC midnight', () => {
		expect(parseHanamiMetricsRollupArgs(['--from', '2026-09-01'], new Date('2026-09-19T14:59:59.999Z')).to).toBe('2026-09-18');
		expect(parseHanamiMetricsRollupArgs(['--from', '2026-09-01'], now).to).toBe('2026-09-19');
	});

	test('accepts a leap day and an inclusive single day', () => {
		expect(parseHanamiMetricsRollupArgs(['--to', '2024-02-29', '--from', '2024-02-29']).days).toEqual(['2024-02-29']);
	});

	test('enumerates across a year boundary', () => {
		expect(parseHanamiMetricsRollupArgs(['--from', '2025-12-31', '--to', '2026-01-02']).days)
			.toEqual(['2025-12-31', '2026-01-01', '2026-01-02']);
	});

	test.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-9-01', '2026-09-01T00:00:00Z', ' 2026-09-01', '0000-01-01', 'not-a-date'])(
		'rejects invalid calendar date or format %s on either bound', value => {
			expect(() => parseHanamiMetricsRollupArgs(['--from', value, '--to', '2026-09-19'])).toThrow(/--from/);
			expect(() => parseHanamiMetricsRollupArgs(['--from', '2026-09-01', '--to', value])).toThrow(/--to/);
		},
	);

	test('rejects reversed ranges', () => {
		expect(() => parseHanamiMetricsRollupArgs(['--from', '2026-09-20', '--to', '2026-09-19'])).toThrow(/before/);
	});

	test('accepts exactly 90 inclusive days and rejects 91', () => {
		expect(parseHanamiMetricsRollupArgs(['--from', '2026-01-01', '--to', '2026-03-31']).days).toHaveLength(90);
		expect(() => parseHanamiMetricsRollupArgs(['--from', '2026-01-01', '--to', '2026-04-01'])).toThrow(/90 days/);
	});

	test.each([
		[], ['--to', '2026-09-19'], ['--from'], ['--from', '--to', '2026-09-19'],
		['--from', '2026-09-01', '--to'],
		['--from', '2026-09-01', '--from', '2026-09-02'],
		['--from', '2026-09-01', '--to', '2026-09-19', '--to', '2026-09-19'],
		['--from', '2026-09-01', '--generate'], ['2026-09-01'], ['--from=2026-09-01'],
	].map(args => ({ args })))('rejects missing, duplicate, or unknown arguments: $args', ({ args }) => {
		expect(() => parseHanamiMetricsRollupArgs(args, now)).toThrow();
	});

	test('command recomputes each inclusive day sequentially using only rollupDay', async () => {
		const calls: string[] = [];
		let active = false;
		const rollupDay = jest.fn(async (day: string, options: { recompute: boolean }) => {
			expect(active).toBe(false);
			active = true;
			expect(options).toEqual({ recompute: true });
			await Promise.resolve();
			calls.push(day);
			active = false;
		});
		const command = new HanamiMetricsRollupCommandService({ rollupDay });
		const range = await command.run(['--from', '2026-09-06'], now);
		expect(calls).toEqual(range.days);
		expect(rollupDay).toHaveBeenCalledTimes(14);
	});

	test('validation failure never calls the rollup service', async () => {
		const rollupDay = jest.fn(async () => {});
		const command = new HanamiMetricsRollupCommandService({ rollupDay });
		await expect(command.run(['--from', '2026-02-30'], now)).rejects.toThrow();
		expect(rollupDay).not.toHaveBeenCalled();
	});

	test('rollup failure propagates and stops subsequent dates', async () => {
		const failure = new Error('rollup failed');
		const rollupDay = jest.fn(async () => { throw failure; });
		const command = new HanamiMetricsRollupCommandService({ rollupDay });
		await expect(command.run(['--from', '2026-09-06'], now)).rejects.toBe(failure);
		expect(rollupDay).toHaveBeenCalledTimes(1);
	});
});
