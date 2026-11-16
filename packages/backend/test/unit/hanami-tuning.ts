/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { Ajv } from 'ajv';
import { HANAMI_FOR_YOU_AXES, computeCaps, hanamiAxisOrder, hanamiInterleave, type ForYouCandidate, type HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
import { normalizeHanamiTuning, resolveHanamiTuning, resolveHanamiSuggestionBase, suggestHanamiAmount, hanamiTuningScore, getAvailableHanamiAxes, applyHanamiDrift, nearestHanamiGroupLevel, hanamiDriftLevel, HANAMI_AXIS_GROUPS, HANAMI_AXIS_GROUP_NAMES, HANAMI_DRIFT_BOUNDS, type HanamiTuningInput } from '@/core/hanami/HanamiTuning.js';
import { hanamiTuningParamDef } from '@/models/json-schema/hanami-tuning.js';
import { suggestHanamiTuning, computeHanamiDriftFactors } from '@/core/hanami/HanamiTuningSuggestion.js';

const centered = { mode: 'auto' as const, direction: 1, drift: 1, groups: { close: 2, buzz: 2, fresh: 2 } };
const profile = (tuning: HanamiTuningInput = {}) => ({ hanamiTuning: { ...centered, ...tuning } });
const groupShares = (amounts: ReadonlyMap<HanamiAxis, number>) => {
	const caps = computeCaps('high', 210, hanamiAxisOrder('high'), amounts);
	const total = [...caps.values()].reduce((a, b) => a + b, 0);
	return HANAMI_AXIS_GROUP_NAMES.map(group => Math.round(100 * HANAMI_AXIS_GROUPS[group].reduce((sum, axis) => sum + (caps.get(axis) ?? 0), 0) / total));
};

describe('Hanami tuning v4', () => {
	test('unset is centered auto; legacy nondefaults migrate only on read; unavailable axes stay zero', () => {
		expect(normalizeHanamiTuning({})).toEqual(centered);
		const legacy = { hanamiRecommendationAxes: { globalPopular: 'high', catchup: 'off', fof: 'low' } };
		expect(normalizeHanamiTuning(legacy).mode).toBe('manual');
		expect(Object.fromEntries(resolveHanamiTuning(legacy).amounts)).toMatchObject({ globalPopular: 1.6, catchup: 0, fof: 0.55, trending: 1 });
		expect(legacy).not.toHaveProperty('hanamiTuning');
		expect(resolveHanamiTuning(profile(), { globalPopular: { available: false } }).amounts.get('globalPopular')).toBe(0);
	});
	test('the old three-slider shape is read as the new one: closeness becomes a direction, the rest is dropped', () => {
		const old = (closeness: number, mode: 'auto' | 'manual' = 'auto') => ({ hanamiTuning: { mode, closeness, freshness: 4, discovery: 0 } });
		expect(normalizeHanamiTuning(old(2))).toEqual(centered);
		expect(normalizeHanamiTuning(old(0))).toEqual({ ...centered, mode: 'direction', direction: 0 });
		expect(normalizeHanamiTuning(old(1))).toEqual({ ...centered, mode: 'direction', direction: 0 });
		expect(normalizeHanamiTuning(old(3))).toEqual({ ...centered, mode: 'direction', direction: 2 });
		expect(normalizeHanamiTuning(old(4))).toEqual({ ...centered, mode: 'direction', direction: 2 });
		// 新しい形で保存し直したあとは、残っている旧項目を見ない。
		expect(normalizeHanamiTuning({ hanamiTuning: { ...centered, closeness: 0 } })).toEqual(centered);
		const manual = normalizeHanamiTuning({ hanamiTuning: { mode: 'manual', closeness: 2, freshness: 2, discovery: 2, manual: { amounts: { fof: 2 }, freshWeights: [3, 3, 3], closeWeights: [3, 3, 3], authorCap: 3 } } });
		expect(manual).toMatchObject({ mode: 'manual', manual: { amounts: { fof: 2, globalPopular: 1 }, authorCap: 3 } });
		expect(manual.manual).not.toHaveProperty('freshWeights');
		const resolved = resolveHanamiTuning({ hanamiTuning: manual });
		expect([resolved.freshWeights, resolved.closeWeights, resolved.authorCap]).toEqual([[1, 1, 1], [1, 1, 1], 3]);
		for (const broken of [{ mode: 'x' }, { direction: 3 }, { drift: -1 }, { groups: { close: 5, buzz: 1.5 } }]) {
			expect(normalizeHanamiTuning({ hanamiTuning: broken as HanamiTuningInput })).toEqual(centered);
		}
	});
	test('auto is all-one; the three directions land near 8:1:1 / 7:2:1 / 5:3:2', () => {
		const order = hanamiAxisOrder('high');
		expect(computeCaps('high', 210, order, resolveHanamiTuning({}).amounts)).toEqual(computeCaps('high', 210, order));
		// 件数は切り上げで決まるので、割合は 1 ポイントまでのずれを許す。
		const near = (actual: number[], expected: number[]) => actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(1));
		near(groupShares(resolveHanamiTuning(profile({ mode: 'direction', direction: 0 })).amounts), [80, 12, 8]);
		expect(groupShares(resolveHanamiTuning(profile({ mode: 'direction', direction: 1 })).amounts)).toEqual(groupShares(resolveHanamiTuning({}).amounts));
		near(groupShares(resolveHanamiTuning(profile({ mode: 'direction', direction: 2 })).amounts), [47, 33, 20]);
		near(groupShares(resolveHanamiTuning({}).amounts), [66, 23, 11]);
		expect(resolveHanamiTuning(profile({ mode: 'direction', direction: 0 })).closeWeights).toEqual([1.8, 1.4, 0.7]);
		expect(resolveHanamiTuning(profile({ mode: 'direction', direction: 2 })).closeWeights).toEqual([0.7, 0.8, 1.3]);
		// 方向は、方向だけ決める を選んでいるときだけ効く。
		expect(resolveHanamiTuning(profile({ mode: 'auto', direction: 0 })).amounts).toEqual(resolveHanamiTuning({}).amounts);
	});
	test('recommend uses the three group levels and nothing else', () => {
		const value = resolveHanamiTuning(profile({ mode: 'recommend', direction: 0, groups: { close: 4, buzz: 0, fresh: 3 } }));
		expect(Object.fromEntries(value.amounts)).toEqual({ neighborTrending: 1.9, catchup: 1.9, fof: 1.9, globalPopular: 0.4, trending: 0.4, exploration: 1.4, reactionSimilar: 1.4 });
		expect(value.closeWeights).toEqual([1, 1, 1]);
		expect(resolveHanamiTuning(profile({ mode: 'recommend' })).amounts).toEqual(resolveHanamiTuning({}).amounts);
		expect([0.3, 0.55, 0.84, 1, 1.19, 1.64, 5, NaN, 0].map(nearestHanamiGroupLevel)).toEqual([0, 1, 2, 2, 3, 4, 4, 2, 2]);
	});
	test('drift moves auto and direction inside the chosen width, never recommend or manual, and never lowers exploration', () => {
		const factors = new Map<HanamiAxis, number>([['neighborTrending', 2], ['trending', 0.5], ['exploration', 0.5], ['fof', 1.1]]);
		expect(hanamiDriftLevel(normalizeHanamiTuning({}))).toBe(1);
		expect(Object.fromEntries(resolveHanamiTuning({}, {}, factors).amounts)).toEqual({ globalPopular: 1, neighborTrending: 1.4, reactionSimilar: 1, catchup: 1, trending: 0.7, fof: 1.1, exploration: 1 });
		for (const [drift, [low, high]] of HANAMI_DRIFT_BOUNDS.entries()) {
			const value = resolveHanamiTuning(profile({ mode: 'direction', direction: 1, drift }), {}, factors).amounts;
			expect([value.get('neighborTrending'), value.get('trending'), value.get('exploration')]).toEqual([high, low, 1]);
		}
		// 方向を選んだ量に掛ける（身近な人中心の 1.3 × 上限 1.4）。
		expect(resolveHanamiTuning(profile({ mode: 'direction', direction: 0 }), {}, factors).amounts.get('neighborTrending')).toBe(1.82);
		for (const mode of ['recommend', 'manual'] as const) {
			expect(hanamiDriftLevel(normalizeHanamiTuning(profile({ mode })))).toBeNull();
			expect(resolveHanamiTuning(profile({ mode }), {}, factors).amounts).toEqual(resolveHanamiTuning(profile({ mode })).amounts);
		}
		expect(resolveHanamiTuning({}, { trending: { default: false } }, factors).amounts.get('trending')).toBe(0);
		expect(resolveHanamiTuning({}, {}, null).amounts).toEqual(resolveHanamiTuning({}).amounts);
		for (const bad of [undefined, NaN, 0, -1]) expect(applyHanamiDrift('fof', 1.3, bad, 1)).toBe(1.3);
	});
	test('non-manual modes honor server defaults, while manual amounts override defaults but never availability', () => {
		for (const axis of HANAMI_FOR_YOU_AXES) {
			const config = { [axis]: { default: false } };
			expect(normalizeHanamiTuning({}, config).mode).toBe('auto');
			for (const mode of ['auto', 'direction', 'recommend'] as const) {
				expect(resolveHanamiTuning(profile({ mode, direction: 2, groups: { close: 4, buzz: 4, fresh: 4 } }), config).amounts.get(axis)).toBe(0);
			}
			expect(getAvailableHanamiAxes(config)).toContain(axis);
			const manual = profile({ mode: 'manual', manual: { amounts: { [axis]: 1.75 }, authorCap: 2 } });
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
	test('four axes multiply and re-sort by relationship in direction mode; excluded axes keep their scores', () => {
		const now = 100 * 86400000;
		const candidates = Array.from({ length: 60 }, (_, i) => ({ noteId: String(i), score: 1 + i / 1000, relationshipClass: i % 2 === 0 ? 'directFollow' as const : 'unknown' as const, createdAt: now - (i % 2 === 0 ? 2 : 48) * 3600000 }));
		for (const axis of HANAMI_FOR_YOU_AXES) {
			const count = (direction: number) => candidates.map(item => ({ ...item, score: hanamiTuningScore(axis, item, item.createdAt, now, resolveHanamiTuning(profile({ mode: 'direction', direction }))) })).sort((a, b) => b.score - a.score).slice(0, 20).filter(item => item.relationshipClass === 'directFollow').length;
			if (['globalPopular', 'trending', 'neighborTrending', 'reactionSimilar'].includes(axis)) {
				expect(count(0)).toBeGreaterThan(count(2));
			} else { expect(count(0)).toBe(count(2)); }
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
		const validate = new Ajv().compile({ ...hanamiTuningParamDef, required: ['mode'] });
		expect(validate(centered)).toBe(true);
		expect(validate({ mode: 'auto' })).toBe(true);
		// 古い画面からの保存（スライダー 3 本）も受け取る。
		expect(validate({ mode: 'auto', closeness: 0, freshness: 2, discovery: 2 })).toBe(true);
		for (const invalid of [{ mode: 'other' }, { direction: 3 }, { drift: 3 }, { groups: { close: 5 } }, { groups: { other: 1 } }, { closeness: 5 }, { unknown: 1 }]) {
			expect(validate({ ...centered, ...invalid })).toBe(false);
		}
		expect(validate({ direction: 1 })).toBe(false);
		const manual = { amounts: { globalPopular: 1.234 }, authorCap: 2 };
		expect(validate({ ...centered, mode: 'manual', manual })).toBe(true);
		expect(validate({ ...centered, mode: 'manual', manual: { ...manual, freshWeights: [1, 1, 1], closeWeights: [1, 1, 1] } })).toBe(true);
		expect(resolveHanamiTuning(profile({ mode: 'manual', manual })).amounts.get('globalPopular')).toBe(1.25);
		for (const invalid of [-.1, 3.1, NaN]) expect(validate({ ...centered, manual: { ...manual, amounts: { fof: invalid } } })).toBe(false);
		expect(validate({ ...centered, manual: { ...manual, authorCap: 5 } })).toBe(false);
	});
	test('suggestion shrinkage, square root, clamps, exploration, eligibility and aggregate-only response', () => {
		const rows = [{ axis: 'globalPopular' as const, seen: 200, reactions: 10, serverSeen: 1000, serverReactions: 100 }, { axis: 'trending' as const, seen: 10, reactions: 30, serverSeen: 100, serverReactions: 100 }, { axis: 'exploration' as const, seen: 20, reactions: 0, serverSeen: 100, serverReactions: 0 }];
		const result = suggestHanamiTuning(rows, resolveHanamiTuning({}), resolveHanamiTuning({}).amounts);
		expect(result.eligible).toBe(true); expect(result.axes[0].rate).toBeCloseTo(13 / 230);
		expect(result.axes.find(a => a.axis === 'trending')?.suggested).toBe(2);
		expect(result.axes.find(a => a.axis === 'exploration')).toMatchObject({ factor: 1, suggested: 1 });
		expect(result.axes.find(a => a.axis === 'fof')).toMatchObject({ factor: .5, suggested: .5 });
		// 平均の重み = 本人が見た件数 ＋ サーバー全体の見られ方 30 件ぶん（1000:100:100）。
		const weights = [200 + 30 * 1000 / 1200, 10 + 30 * 100 / 1200, 20 + 30 * 100 / 1200];
		const rates = [13 / 230, 60 / 40, 0];
		const mean = weights.reduce((sum, weight, i) => sum + weight * rates[i], 0) / weights.reduce((a, b) => a + b, 0);
		expect(result.axes[0].factor).toBeCloseTo(Math.sqrt((13 / 230) / mean));
		expect(result.axes[0].suggested).toBe(Math.round(Math.sqrt((13 / 230) / mean) * 20) / 20);
		expect(computeHanamiDriftFactors(rows)).toEqual(new Map(result.axes.map(a => [a.axis, a.factor])));
		expect(JSON.stringify(result)).not.toMatch(/serverSeen|serverReactions|serverRate|userId|noteId|weight/);
		expect(suggestHanamiTuning([], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts)).toMatchObject({ eligible: false, groups: { close: 2, buzz: 2, fresh: 2 } });
		expect(suggestHanamiTuning([], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts).axes.every(a => a.factor === 1 && a.suggested === 1)).toBe(true);
		expect(suggestHanamiTuning([{ ...rows[0], seen: 199 }], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts).eligible).toBe(false);
		expect(suggestHanamiTuning([{ ...rows[0], reactions: 9 }], resolveHanamiTuning({}), resolveHanamiTuning({}).amounts).eligible).toBe(false);
		expect(suggestHanamiTuning(rows, resolveHanamiTuning({}, { globalPopular: { available: false } }), resolveHanamiTuning({}, { globalPopular: { available: false } }).amounts).axes[0].suggested).toBe(0);
	});
	test('someone with no reactions yet drifts with the whole server, and their own reactions take over as they use it', () => {
		// サーバー全体: 近くで話題と友達の友達はよく反応され、いま話題はほとんど反応されない。
		const server = { neighborTrending: [500, 70], fof: [100, 19], catchup: [300, 32], globalPopular: [1000, 65], exploration: [300, 8], trending: [200, 3], reactionSimilar: [150, 1] } as const;
		const rows = (own: Partial<Record<HanamiAxis, [number, number]>> = {}) => HANAMI_FOR_YOU_AXES.map(axis => ({ axis, seen: own[axis]?.[0] ?? 0, reactions: own[axis]?.[1] ?? 0, serverSeen: server[axis][0], serverReactions: server[axis][1] }));
		const fresh = computeHanamiDriftFactors(rows());
		expect(fresh.get('neighborTrending')!).toBeGreaterThan(1.2);
		expect(fresh.get('fof')!).toBeGreaterThan(fresh.get('neighborTrending')!);
		expect(fresh.get('trending')!).toBe(0.5);
		expect(fresh.get('exploration')!).toBe(1);
		const amounts = resolveHanamiTuning({}, {}, fresh).amounts;
		expect(amounts.get('neighborTrending')).toBeGreaterThan(1); expect(amounts.get('neighborTrending')).toBeLessThanOrEqual(1.4);
		expect(amounts.get('trending')).toBe(0.7);
		const suggestion = suggestHanamiTuning(rows(), resolveHanamiTuning({}), resolveHanamiTuning({}).amounts);
		expect(suggestion).toMatchObject({ eligible: false, totalSeen: 0, groups: { close: 3, buzz: 2, fresh: 2 } });
		// 本人は逆に、人気によく反応して近くで話題には反応しない。件数が増えると本人の傾向が勝つ。
		const own = computeHanamiDriftFactors(rows({ globalPopular: [300, 60], neighborTrending: [300, 3] }));
		expect(own.get('globalPopular')!).toBeGreaterThan(1.2);
		expect(own.get('neighborTrending')!).toBeLessThan(0.8);
	});
	test('suggestion scales the auto amounts so re-applying is idempotent; turned-off axes stay off', () => {
		const rows = [{ axis: 'globalPopular' as const, seen: 200, reactions: 2, serverSeen: 1000, serverReactions: 100 }, { axis: 'trending' as const, seen: 100, reactions: 30, serverSeen: 100, serverReactions: 30 }];
		const auto = normalizeHanamiTuning({});
		const base = resolveHanamiSuggestionBase(auto);
		const first = suggestHanamiTuning(rows, resolveHanamiTuning({ hanamiTuning: auto }), base);
		const amounts = Object.fromEntries(first.axes.map(a => [a.axis, a.suggested]));
		const applied = { ...auto, mode: 'manual' as const, manual: { amounts, authorCap: 2 } };
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
