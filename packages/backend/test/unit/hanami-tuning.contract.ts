/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { transformSync } from 'esbuild';
import { AXIS_MAX_SHARE, EXPLORATION_SHARE, computeCaps, hanamiAxisOrder } from '@/core/hanami/HanamiForYouInterleave.js';
import { resolveHanamiTuning, normalizeHanamiTuning } from '@/core/hanami/HanamiTuning.js';

// Evaluate the dependency-free client utility so the contract checks behavior, not copied assertions.
const source = readFileSync(resolve(process.cwd(), '../frontend/src/utility/hanami-tuning.ts'), 'utf8');
const module = { exports: {} as Record<string, (...args: any[]) => any> };
new Function('module', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module);
const client = module.exports;

describe('Hanami tuning client/backend contract', () => {
	test('high-confidence base shares and every auto mapping/cap agree', () => {
		expect(client.HANAMI_BASE_SHARE).toEqual({ ...AXIS_MAX_SHARE.high, exploration: EXPLORATION_SHARE.high });
		for (let closeness = 0; closeness < 5; closeness++) for (let freshness = 0; freshness < 5; freshness++) for (let discovery = 0; discovery < 5; discovery++) {
			const profile = { hanamiTuning: { mode: 'auto' as const, closeness, freshness, discovery } };
			const backend = resolveHanamiTuning(profile);
			expect(client.resolveHanamiTuning(profile)).toEqual(backend);
			expect(client.computeHanamiCaps(backend.amounts)).toEqual(computeCaps('high', 210, hanamiAxisOrder('high'), backend.amounts));
		}
	});
	test('manual/migration/availability/default normalization stays identical', () => {
		for (const profile of [{}, { hanamiTuning: { mode: 'auto' as const, discovery: 4 } }, { hanamiRecommendationAxes: { popular: 'low', fof: false } }, { hanamiRecommendationAxes: { globalPopular: true, trending: 'normal' } }, { hanamiTuning: { mode: 'manual' as const, closeness: 2, freshness: 2, discovery: 2, manual: { amounts: { globalPopular: 2.71 }, freshWeights: [0, 1.234, 3], closeWeights: [3, 0, 1], authorCap: 4 } } }]) {
			for (const config of [{}, { globalPopular: { available: false } }, { globalPopular: { default: false }, trending: { default: false } }, { popular: { default: false }, globalPopular: { default: true } }, { popular: { available: false, default: false } }]) {
				expect(client.normalizeHanamiTuning(profile, config)).toEqual(normalizeHanamiTuning(profile, config));
				expect(client.resolveHanamiTuning(profile, config)).toEqual(resolveHanamiTuning(profile, config));
			}
		}
	});
});
