/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { Ajv } from 'ajv';
import { HANAMI_FOR_YOU_AXES, computeCaps, hanamiAxisOrder, hanamiInterleave, type ForYouCandidate, type HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
import { normalizeHanamiTuning, resolveHanamiTuning, resolveHanamiSuggestionBase, suggestHanamiAmount, hanamiTuningScore, getAvailableHanamiAxes } from '@/core/hanami/HanamiTuning.js';
import { hanamiTuningParamDef } from '@/models/json-schema/hanami-tuning.js';
import { suggestHanamiTuning } from '@/core/hanami/HanamiTuningSuggestion.js';

const profile = (closeness = 2, freshness = 2, discovery = 2) => ({ hanamiTuning: { mode: 'auto' as const, closeness, freshness, discovery } });

describe('Hanami tuning v3', () => {
	test('unset is centered auto; legacy nondefaults migrate only on read; unavailable axes stay zero', () => {
		expect(normalizeHanamiTuning({})).toEqual(profile().hanamiTuning);
		const legacy = { hanamiRecommendationAxes: { globalPopular: 'high', catchup: 'off', fof: 'low' } };
		expect(normalizeHanamiTuning(legacy).mode).toBe('manual');
		expect(Object.fromEntries(resolveHanamiTuning(legacy).amounts)).toMatchObject({ globalPopular: 1.6, catchup: 0, fof: 0.55, trending: 1 });
		expect(legacy).not.toHaveProperty('hanamiTuning');
		expect(resolveHanamiTuning(profile(), { globalPopular: { available: false } }).amounts.get('globalPopular')).toBe(0);
	});
	test('all 125 auto combinations match the published tables', () => {
		const discovery = [[1.6, 1.6, .55, .55, 0], [1.6, 1, 1, .55, .55], [1, 1, 1, 1, 1], [1, .55, 1.6, 1, 1.6], [.55, .55, 1.6, 1.6, 1.6]];
		const close = [[1.6, 1.6], [1.6, 1], [1, 1], [.55, 1], [.55, .55]];
		const cw = [[3, 2, .4], [1.8, 1.4, .7], [1, 1, 1], [.7, .8, 1.3], [.4, .6, 2]];
		const fw = [[2.5, 1.5, .5], [1.6, 1.2, .75], [1, 1, 1], [.8, 1, 1.25], [.6, 1, 1.5]];
		for (let c = 0; c < 5; c++) for (let f = 0; f < 5; f++) for (let d = 0; d < 5; d++) {
			const value = resolveHanamiTuning(profile(c, f, d));
			expect((['globalPopular', 'trending', 'reactionSimilar', 'fof', 'exploration'] as const).map(a => value.amounts.get(a))).toEqual(discovery[d]);
			expect([value.amounts.get('catchup'), value.amounts.get('neighborTrending')]).toEqual(close[c]);
			expect(value.closeWeights).toEqual(cw[c]); expect(value.freshWeights).toEqual(fw[f]); expect(value.authorCap).toBe(2);
		}
	});
	test('auto honors server defaults, while manual amounts override defaults but never availability', () => {
		for (const axis of HANAMI_FOR_YOU_AXES) {
			const config = { [axis]: { default: false } };
			expect(normalizeHanamiTuning({}, config).mode).toBe('auto');
			expect(resolveHanamiTuning({}, config).amounts.get(axis)).toBe(0);
			expect(resolveHanamiTuning(profile(0, 0, 4), config).amounts.get(axis)).toBe(0);
			expect(getAvailableHanamiAxes(config)).toContain(axis);
			const manual = { hanamiTuning: { ...profile().hanamiTuning, mode: 'manual' as const, manual: { amounts: { [axis]: 1.75 }, freshWeights: [1, 1, 1], closeWeights: [1, 1, 1], authorCap: 2 } } };
			expect(resolveHanamiTuning(manual, config).amounts.get(axis)).toBe(1.75);
			expect(resolveHanamiTuning(manual, { [axis]: { default: false, available: false } }).amounts.get(axis)).toBe(0);
		}
	});
	test('legacy migration uses server defaults only for unspecified axes, including aliases', () => {
		const config = { popular: { default: false }, trending: { default: false }, reactionSimilar: { default: false } };
		const profile = { hanamiRecommendationAxes: { catchup: 'high', globalPopular: true, neighborTrending: 'normal' } };
		const migrated = normalizeHanamiTuning(profile, config);
		expect(migrated).toMatchObject({ mode: 'manual', manual: { amounts: { catchup: 1.6, globalPopular: 1, exploration: 0, trending: 0, neighborTrending: 1, reactionSimilar: 0 } } });
		expect(Object.fromEntries(resolveHanamiTuning(profile, config).amounts)).toEqual(migrated.manual!.amounts);
		expect(profile).not.toHaveProperty('hanamiTuning');
		for (const value of [true, 'normal'] as const) {
			const explicit = { hanamiRecommendationAxes: { trending: value } };
			expect(normalizeHanamiTuning(explicit, config).mode).toBe('manual');
			expect(resolveHanamiTuning(explicit, config).amounts.get('trending')).toBe(1);
		}
		expect(resolveHanamiTuning({}, { popular: { default: false }, globalPopular: { default: true } }).amounts.get('globalPopular')).toBe(1);
	});
	test('all-one caps preserve the base defaults and discovery shares are 44/39/29/24/16 within one point', () => {
		const order = hanamiAxisOrder('high');
		expect(computeCaps('high', 210, order, resolveHanamiTuning({}).amounts)).toEqual(computeCaps('high', 210, order));
		for (let d = 0; d < 5; d++) {
			const caps = computeCaps('high', 210, order, resolveHanamiTuning(profile(2, 2, d)).amounts);
			const share = 100 * ((caps.get('globalPopular') ?? 0) + (caps.get('trending') ?? 0)) / [...caps.values()].reduce((a, b) => a + b, 0);
			expect(Math.abs(share - [44, 39, 29, 24, 16][d])).toBeLessThanOrEqual(1);
		}
	});
	test('four axes multiply and re-sort by relationship and note age; excluded axes keep their scores', () => {
		const now = 100 * 86400000;
		const candidates = Array.from({ length: 60 }, (_, i) => ({ noteId: String(i), score: 1 + i / 1000, relationshipClass: i % 2 === 0 ? 'directFollow' as const : 'unknown' as const, createdAt: now - (i % 2 === 0 ? 2 : 48) * 3600000 }));
		for (const axis of HANAMI_FOR_YOU_AXES) {
			const count = (c:number, f:number) => candidates.map(item => ({ ...item, score: hanamiTuningScore(axis, item, item.createdAt, now, resolveHanamiTuning(profile(c, f))) })).sort((a, b) => b.score - a.score).slice(0, 20).filter(item => item.relationshipClass === 'directFollow').length;
			if (['globalPopular', 'trending', 'neighborTrending', 'reactionSimilar'].includes(axis)) {
				expect(count(0, 2)).toBeGreaterThan(count(4, 2)); expect(count(2, 0)).toBeGreaterThan(count(2, 4));
			} else { expect(count(0, 0)).toBe(count(4, 4)); }
		}
	});
	test.each([1, 2, 3, 4] as const)('authorCap %i scales 10/30/210 windows and allows all-direct feeds', n => {
		const candidates: ForYouCandidate[] = Array.from({ length: 1500 }, (_, i) => ({ noteId: String(i), userId: `author-${i % 80}`, score: 1500 - i, relationshipClass: 'directFollow' }));
		const out = hanamiInterleave({ confidence: 'high', limit: 210, personalConstraints: true, authorCap: n, amounts: new Map<HanamiAxis, number>([['globalPopular', 1]]), axisCandidates: new Map([['globalPopular', candidates]]) }).slice(0, 210);
		expect(out).toHaveLength(210);
		for (const size of [10, 30, 210]) for (let start = 0; start + size <= out.length; start++) {
			const counts = new Map<string, number>(); for (const item of out.slice(start, start + size)) counts.set(item.userId!, (counts.get(item.userId!) ?? 0) + 1);
			expect(Math.max(...counts.values())).toBeLessThanOrEqual(size === 10 ? Math.max(1, Math.round(n / 2)) : size === 30 ? n : 3 * n);
		}
	});
	test('a stricter cap keeps old history and still admits unrelated new authors', () => {
		const seed = Array.from({ length: 29 }, (_, i) => ({ noteId: `old-${i}`, userId: 'old-author', score: 1, relationshipClass: 'directFollow' as const }));
		const out = hanamiInterleave({ confidence: 'none', limit: 30, personalConstraints: true, authorCap: 1, followingSeedVisible: seed, axisCandidates: new Map([['globalPopular', Array.from({ length: 30 }, (_, i) => ({ noteId: `new-${i}`, userId: `new-${i}`, score: 1 }))]]) });
		expect(out.length).toBeGreaterThan(0); expect(seed).toHaveLength(29);
	});
	test('API range validation and 0.05 normalization', () => {
		const validate = new Ajv().compile({ ...hanamiTuningParamDef, required: ['mode', 'closeness', 'freshness', 'discovery'] });
		expect(validate({ ...profile().hanamiTuning, closeness: 5 })).toBe(false);
		const manual = { amounts: { globalPopular: 1.234 }, freshWeights: [1, 1, 1], closeWeights: [1, 1, 1], authorCap: 2 };
		expect(validate({ ...profile().hanamiTuning, mode: 'manual', manual })).toBe(true);
		expect(resolveHanamiTuning({ hanamiTuning: { ...profile().hanamiTuning, mode: 'manual', manual } }).amounts.get('globalPopular')).toBe(1.25);
		for (const invalid of [-.1, 3.1, NaN]) expect(validate({ ...profile().hanamiTuning, manual: { ...manual, amounts: { fof: invalid } } })).toBe(false);
		expect(validate({ ...profile().hanamiTuning, manual: { ...manual, authorCap: 5 } })).toBe(false);
	});
	test('suggestion shrinkage, square root, clamps, exploration, eligibility and aggregate-only response', () => {
		const rows = [{ axis: 'globalPopular' as const, seen: 200, reactions: 10, serverSeen: 1000, serverReactions: 100 }, { axis: 'trending' as const, seen: 10, reactions: 30, serverSeen: 100, serverReactions: 100 }, { axis: 'exploration' as const, seen: 20, reactions: 0, serverSeen: 100, serverReactions: 0 }];
		const result = suggestHanamiTuning(rows, resolveHanamiTuning({}), resolveHanamiTuning({}).amounts);
		expect(result.eligible).toBe(true); expect(result.axes[0].rate).toBeCloseTo(13 / 230);
		expect(result.axes.find(a => a.axis === 'trending')?.suggested).toBe(2);
		expect(result.axes.find(a => a.axis === 'exploration')?.suggested).toBe(1);
		expect(result.axes.find(a => a.axis === 'fof')?.suggested).toBe(.5);
		const mean = result.axes.reduce((sum, a) => sum + a.seen / result.totalSeen * a.rate, 0);
		expect(result.axes[0].suggested).toBe(Math.round(Math.sqrt((13 / 230) / mean) * 20) / 20);
		expect(JSON.stringify(result)).not.toMatch(/serverSeen|serverReactions|serverRate|userId|noteId/);
		expect(suggestHanamiTuning([], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts).eligible).toBe(false);
		expect(suggestHanamiTuning([{ ...rows[0], seen: 199 }], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts).eligible).toBe(false);
		expect(suggestHanamiTuning([{ ...rows[0], reactions: 9 }], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts).eligible).toBe(false);
		expect(suggestHanamiTuning(rows, resolveHanamiTuning({}, { globalPopular: { available: false } }), resolveHanamiTuning({}, { globalPopular: { available: false } }).amounts).axes[0].suggested).toBe(0);
	});
	test('suggestion scales the auto amounts so re-applying is idempotent; turned-off axes stay off', () => {
		const rows = [{ axis: 'globalPopular' as const, seen: 200, reactions: 2, serverSeen: 1000, serverReactions: 100 }, { axis: 'trending' as const, seen: 100, reactions: 30, serverSeen: 100, serverReactions: 30 }];
		const auto = normalizeHanamiTuning({});
		const base = resolveHanamiSuggestionBase(auto);
		const first = suggestHanamiTuning(rows, resolveHanamiTuning({ hanamiTuning: auto }), base);
		const amounts = Object.fromEntries(first.axes.map(a => [a.axis, a.suggested]));
		const applied = { ...auto, mode: 'manual' as const, manual: { amounts, freshWeights: [1, 1, 1], closeWeights: [1, 1, 1], authorCap: 2 } };
		const second = suggestHanamiTuning(rows, resolveHanamiTuning({ hanamiTuning: applied }), resolveHanamiSuggestionBase(applied));
		expect(second.axes.map(a => a.suggested)).toEqual(first.axes.map(a => a.suggested));
		expect(second.axes.every(a => a.suggested === a.current)).toBe(true);
		const off = { ...applied, manual: { ...applied.manual, amounts: { ...amounts, trending: 0 } } };
		expect(suggestHanamiTuning(rows, resolveHanamiTuning({ hanamiTuning: off }), resolveHanamiSuggestionBase(off)).axes.find(a => a.axis === 'trending')?.suggested).toBe(0);
		// A manually enabled default-off axis scales from the normal amount instead of collapsing to zero.
		expect(suggestHanamiAmount(1.4, 0, 1.2)).toBe(1.2);
	});
});

describe('Hanami tuning save rate limit', () => {
	test('tuning-only updates use 10/minute separately; profile/mixed/empty writes retain the original budget', async () => {
		const { resolveHanamiTuningUpdateLimit } = await import('@/server/api/hanami-tuning-limit.js');
		const original = { duration: 3600000, max: 20 };
		expect(resolveHanamiTuningUpdateLimit('i/update', { hanamiTuning: profile().hanamiTuning }, original)).toEqual({ key: 'i/update:hanami-tuning', duration: 60000, max: 10 });
		expect(resolveHanamiTuningUpdateLimit('i/update', { hanamiReduceEphemeralPosts: false }, original)?.key).toBe('i/update:hanami-tuning');
		for (const data of [{}, { name: 'Name' }, { name: 'Name', hanamiTuning: profile().hanamiTuning }]) expect(resolveHanamiTuningUpdateLimit('i/update', data, original)).toBe(original);
		expect(resolveHanamiTuningUpdateLimit('other', { hanamiTuning: {} }, original)).toBe(original);
	});
});
