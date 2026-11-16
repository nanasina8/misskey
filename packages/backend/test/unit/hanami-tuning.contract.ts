/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { transformSync } from 'esbuild';
import { AXIS_MAX_SHARE, EXPLORATION_SHARE, computeCaps, hanamiAxisOrder } from '@/core/hanami/HanamiForYouInterleave.js';
import { resolveHanamiTuning, normalizeHanamiTuning, nearestHanamiGroupLevel } from '@/core/hanami/HanamiTuning.js';

// Evaluate the dependency-free client utility so the contract checks behavior, not copied assertions.
const source = readFileSync(resolve(process.cwd(), '../frontend/src/utility/hanami-tuning.ts'), 'utf8');
const module = { exports: {} as Record<string, (...args: any[]) => any> };
new Function('module', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module);
const client = module.exports;

describe('Hanami tuning client/backend contract', () => {
	test('high-confidence base shares and every mode/direction/drift/level mapping and cap agree', () => {
		expect(client.HANAMI_BASE_SHARE).toEqual({ ...AXIS_MAX_SHARE.high, exploration: EXPLORATION_SHARE.high });
		const factors = new Map([['neighborTrending', 2], ['trending', 0.5], ['exploration', 0.5], ['fof', 1.1], ['catchup', 0.9]]);
		const profiles = [];
		for (const mode of ['auto', 'direction', 'recommend', 'manual'] as const) for (let direction = 0; direction < 3; direction++) for (let drift = 0; drift < 3; drift++) {
			profiles.push({ hanamiTuning: { mode, direction, drift, groups: { close: 2, buzz: 2, fresh: 2 } } });
		}
		for (let close = 0; close < 5; close++) for (let buzz = 0; buzz < 5; buzz++) for (let fresh = 0; fresh < 5; fresh++) {
			profiles.push({ hanamiTuning: { mode: 'recommend' as const, direction: 1, drift: 1, groups: { close, buzz, fresh } } });
		}
		for (const profile of profiles) for (const drift of [undefined, null, factors]) {
			const backend = resolveHanamiTuning(profile, {}, drift as never);
			expect(client.resolveHanamiTuning(profile, {}, drift)).toEqual(backend);
			expect(client.computeHanamiCaps(backend.amounts)).toEqual(computeCaps('high', 210, hanamiAxisOrder('high'), backend.amounts));
		}
		for (const factor of [0.1, 0.4, 0.53, 0.7, 0.84, 1, 1.18, 1.19, 1.63, 1.9, 3, NaN, 0]) expect(client.nearestHanamiGroupLevel(factor)).toBe(nearestHanamiGroupLevel(factor));
	});
	test('manual/migration/availability/default normalization stays identical', () => {
		for (const profile of [{}, { hanamiTuning: { mode: 'auto' as const, closeness: 4, discovery: 4 } }, { hanamiTuning: { mode: 'auto' as const, closeness: 0 } }, { hanamiTuning: { mode: 'direction' as const, direction: 2, drift: 0 } }, { hanamiRecommendationAxes: { popular: 'low', fof: false } }, { hanamiRecommendationAxes: { globalPopular: true, trending: 'normal' } }, { hanamiTuning: { mode: 'manual' as const, closeness: 2, freshness: 2, discovery: 2, manual: { amounts: { globalPopular: 1.75, trending: 0 }, freshWeights: [1, 2, 3], closeWeights: [3, 2, 1], authorCap: 4 } } }]) {
			for (const config of [{}, { globalPopular: { available: false } }, { globalPopular: { default: false }, trending: { default: false } }, { popular: { default: false }, globalPopular: { default: true } }, { popular: { available: false, default: false } }]) {
				expect(client.normalizeHanamiTuning(profile, config)).toEqual(normalizeHanamiTuning(profile, config));
				expect(client.resolveHanamiTuning(profile, config)).toEqual(resolveHanamiTuning(profile, config));
			}
		}
	});
});
