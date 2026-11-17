/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import {
	buildHanamiRankBacktestPrompt,
	evaluateHanamiRankBacktestModel,
	fitHanamiRankBacktestModel,
	hanamiRankBacktestAuc,
	hanamiRankBacktestBuckets,
	hanamiRankBacktestFeatureVector,
	hanamiRankBacktestItemId,
	hanamiRankBacktestStoredScore,
	hanamiRankBacktestText,
	hanamiRankBacktestWithinUserAuc,
	parseHanamiRankBacktestItemId,
	scoreHanamiRankBacktestModel,
	summarizeHanamiRankBacktest,
	type HanamiRankBacktestSample,
} from '@/core/hanami/HanamiRankBacktest.js';

const sample = (overrides: Partial<HanamiRankBacktestSample> = {}): HanamiRankBacktestSample => ({
	id: '0', userId: 'u', noteId: 'n', seenAt: 0, source: 'globalPopular', relationship: 'unknown', engaged: false, interest: null, ...overrides,
});

describe('文面の組み立て', () => {
	test('改行と連続した空白を 1 つにし、長い文は文字単位で切る', () => {
		expect(hanamiRankBacktestText('  一行目\n\n二行目\t 三行目  ', 100)).toBe('一行目 二行目 三行目');
		expect(hanamiRankBacktestText('あ'.repeat(12), 10)).toBe('あ'.repeat(10) + '…');
		// 絵文字の途中では切らない
		expect(hanamiRankBacktestText('🍣🍣🍣🍣', 3)).toBe('🍣🍣🍣…');
		expect(hanamiRankBacktestText(null, 10)).toBe('');
	});

	test('generic は投稿だけ、personal は最近反応した投稿（新しい順に 8 件まで）と投稿を見せる', () => {
		const generic = buildHanamiRankBacktestPrompt('generic', '新しいキーボードを買った', ['使わない'])!;
		expect(generic).toContain('[投稿]\n新しいキーボードを買った');
		expect(generic).not.toContain('使わない');

		const history = Array.from({ length: 10 }, (_, i) => `反応した投稿 ${i}`);
		const personal = buildHanamiRankBacktestPrompt('personal', '新しいキーボードを買った', history)!;
		expect(personal).toContain('[最近リアクションした投稿]\n- 反応した投稿 0\n- 反応した投稿 1');
		expect(personal).toContain('- 反応した投稿 7\n\n[新しい投稿]\n新しいキーボードを買った');
		expect(personal).not.toContain('反応した投稿 8');
		// どちらも「はい」「いいえ」で答えさせる
		for (const prompt of [generic, personal]) expect(prompt).toContain('「はい」');
	});

	test('personal は、最近反応した投稿が 3 件に満たない人を対象から外す。空の投稿はどちらも対象外', () => {
		expect(buildHanamiRankBacktestPrompt('personal', '投稿', ['1', '2'])).toBeNull();
		expect(buildHanamiRankBacktestPrompt('personal', '投稿', ['1', ' ', '2', '\n'])).toBeNull();
		expect(buildHanamiRankBacktestPrompt('personal', '投稿', ['1', '2', '3'])).not.toBeNull();
		expect(buildHanamiRankBacktestPrompt('generic', '  \n ', [])).toBeNull();
	});
});

describe('記録にある値を点数にする付け方', () => {
	test('interest は判定の点数（未判定は対象外）、follow はフォロー中なら 1', () => {
		expect(hanamiRankBacktestStoredScore('interest', sample({ interest: 3.5 }))).toBe(3.5);
		expect(hanamiRankBacktestStoredScore('interest', sample({ interest: null }))).toBeNull();
		expect(hanamiRankBacktestStoredScore('follow', sample({ relationship: 'directFollow' }))).toBe(1);
		expect(hanamiRankBacktestStoredScore('follow', sample({ relationship: 'unknown' }))).toBe(0);
	});

	test('見た時点までの値（前からの反応・先に反応した人・反応数・新しさ・好み）をそのまま点数にする。値の無い記録は対象外', () => {
		const withFeatures = sample({ clustered: true, features: { prior: 3, social: 2, reactions: 10, ageHours: 5 } });
		expect(hanamiRankBacktestStoredScore('prior', withFeatures)).toBe(3);
		expect(hanamiRankBacktestStoredScore('social', withFeatures)).toBe(2);
		expect(hanamiRankBacktestStoredScore('reactions', withFeatures)).toBe(10);
		// 新しい投稿ほど高い
		expect(hanamiRankBacktestStoredScore('fresh', withFeatures)).toBe(-5);
		expect(hanamiRankBacktestStoredScore('clustered', withFeatures)).toBe(1);
		expect(hanamiRankBacktestStoredScore('clustered', sample({ clustered: false }))).toBe(0);
		for (const variant of ['prior', 'social', 'reactions', 'fresh', 'clustered'] as const) {
			expect(hanamiRankBacktestStoredScore(variant, sample())).toBeNull();
		}
	});
});

describe('組み合わせた点数の検証', () => {
	test('数は対数に、新しさは「6 時間以内」を基準にした 3 つの区分にする', () => {
		const vector = (ageHours: number) => hanamiRankBacktestFeatureVector(sample({ relationship: 'directFollow', clustered: true, features: { prior: 0, social: 1, reactions: 9, ageHours } }))!;
		// follow, prior, social, reactions, 6〜24 時間, 1〜3 日, 3 日以上, clustered
		expect(vector(3)).toEqual([1, 0, Math.log(2), Math.log(10), 0, 0, 0, 1]);
		expect(vector(12).slice(4, 7)).toEqual([1, 0, 0]);
		expect(vector(48).slice(4, 7)).toEqual([0, 1, 0]);
		expect(vector(100).slice(4, 7)).toEqual([0, 0, 1]);
		expect(hanamiRankBacktestFeatureVector(sample())).toBeNull();
	});

	test('反応に効いている値には正の重みが付き、効いていない値の重みは小さい', () => {
		// 1 つめの値が大きいほど反応する。2 つめは 10 件ごとに入れ替わるだけで、反応とは関係が無い。
		const rows = Array.from({ length: 200 }, (_, i) => ({ x: [i % 10, Math.floor(i / 10) % 2], engaged: i % 10 >= 7 }));
		const model = fitHanamiRankBacktestModel(rows);
		expect(model.weights[0]).toBeGreaterThan(1);
		expect(Math.abs(model.weights[1])).toBeLessThan(0.2);
		expect(scoreHanamiRankBacktestModel(model, [9, 0])).toBeGreaterThan(scoreHanamiRankBacktestModel(model, [0, 0]));
		// 同じ入力なら同じ結果（乱数を使わない）
		expect(fitHanamiRankBacktestModel(rows)).toEqual(model);
	});

	test('値がどの記録でも同じ（ばらつき 0）でも、割り算で壊れない', () => {
		const model = fitHanamiRankBacktestModel([{ x: [1, 5], engaged: true }, { x: [1, 2], engaged: false }, { x: [1, 4], engaged: true }, { x: [1, 1], engaged: false }]);
		expect(model.weights.every(Number.isFinite)).toBe(true);
		expect(Number.isFinite(scoreHanamiRankBacktestModel(model, [1, 3]))).toBe(true);
	});

	test('古い半分で式を作り、新しい半分で確かめる。フォロー中かどうかだけの点数と並べて返す', () => {
		// 作者に前から反応している人ほど反応する、という 400 件。フォロー中かどうかは反応と関係なし。
		const samples = Array.from({ length: 400 }, (_, i) => sample({
			id: String(i), userId: `u${i % 4}`, seenAt: i, relationship: i % 2 === 0 ? 'directFollow' : 'unknown',
			engaged: i % 5 >= 3, clustered: false,
			features: { prior: i % 5 >= 3 ? 6 + (i % 3) : i % 3, social: 0, reactions: 1, ageHours: 12 },
		}));
		const evaluation = evaluateHanamiRankBacktestModel(samples)!;
		expect(evaluation.train).toEqual({ seen: 200, engaged: 80 });
		expect(evaluation.test).toEqual({ seen: 200, engaged: 80 });
		expect(evaluation.weights.map(row => row.feature)).toEqual(['follow', 'prior', 'social', 'reactions', 'age6to24h', 'age1to3d', 'ageOver3d', 'clustered']);
		expect(evaluation.weights.find(row => row.feature === 'prior')!.weight).toBeGreaterThan(1);
		const result = (scoring: string, subset: string) => evaluation.results.find(row => row.scoring === scoring && row.subset === subset)!;
		expect(result('model', 'all')).toMatchObject({ seen: 200, engaged: 80, auc: 1, withinUserAuc: 1 });
		expect(result('follow', 'all').auc).toBeCloseTo(0.5, 1);
		expect(result('model', 'unknown').seen).toBe(100);
	});

	test('反応した記録が少ないとき・値の付いた記録が無いときは確かめない', () => {
		const few = Array.from({ length: 100 }, (_, i) => sample({ id: String(i), seenAt: i, engaged: i < 10, features: { prior: 0, social: 0, reactions: 0, ageHours: 1 } }));
		expect(evaluateHanamiRankBacktestModel(few)).toBeNull();
		expect(evaluateHanamiRankBacktestModel(Array.from({ length: 100 }, (_, i) => sample({ id: String(i), engaged: i % 2 === 0 })))).toBeNull();
	});
});

describe('点数と反応の結び付き', () => {
	const row = (score: number, engaged: boolean, userId = 'u') => ({ score, engaged, userId });

	test('反応した投稿の点数がいつも高ければ 1、いつも低ければ 0、同点は半分', () => {
		expect(hanamiRankBacktestAuc([row(0.9, true), row(0.8, true), row(0.2, false), row(0.1, false)])).toBe(1);
		expect(hanamiRankBacktestAuc([row(0.1, true), row(0.9, false)])).toBe(0);
		expect(hanamiRankBacktestAuc([row(0.5, true), row(0.5, false)])).toBe(0.5);
		// 反応 2 件 × 反応なし 2 件 = 4 組のうち、勝ち 2・同点 1・負け 1 → 2.5 / 4
		expect(hanamiRankBacktestAuc([row(0.9, true), row(0.5, true), row(0.5, false), row(0.7, false)])).toBe(0.625);
	});

	test('反応した投稿か、しなかった投稿のどちらかが無ければ null', () => {
		expect(hanamiRankBacktestAuc([row(0.9, true), row(0.1, true)])).toBeNull();
		expect(hanamiRankBacktestAuc([])).toBeNull();
	});

	test('同じ人の中だけで比べると、人による反応のしやすさの差は効かない', () => {
		// a はよく反応する人で点数も全体に高い。b はほとんど反応しない人で点数も低い。
		// まとめて比べると点数が効いているように見えるが、どちらの人の中でも点数は逆に付いている。
		const rows = [
			row(0.8, true, 'a'), row(0.85, true, 'a'), row(0.9, false, 'a'),
			row(0.1, true, 'b'), row(0.2, false, 'b'), row(0.15, false, 'b'), row(0.12, false, 'b'), row(0.3, false, 'b'),
		];
		// 反応 3 件 × 反応なし 5 件 = 15 組のうち、a の 2 件が b の反応なし 4 件に勝つ → 8 / 15
		expect(hanamiRankBacktestAuc(rows)).toBeCloseTo(8 / 15);
		expect(hanamiRankBacktestWithinUserAuc(rows)).toEqual({ auc: 0, users: 2 });
		// 反応した投稿しか無い人・しなかった投稿しか無い人は数えない
		expect(hanamiRankBacktestWithinUserAuc([row(0.8, true, 'a'), row(0.1, false, 'b')])).toEqual({ auc: null, users: 0 });
	});

	test('点数の低い順に 5 つに等分し、上位 2 割の反応も出す', () => {
		const rows = Array.from({ length: 10 }, (_, i) => row((i + 1) / 10, i >= 8));
		expect(hanamiRankBacktestBuckets(rows)).toEqual([
			{ from: 0.1, to: 0.2, seen: 2, engaged: 0 },
			{ from: 0.3, to: 0.4, seen: 2, engaged: 0 },
			{ from: 0.5, to: 0.6, seen: 2, engaged: 0 },
			{ from: 0.7, to: 0.8, seen: 2, engaged: 0 },
			{ from: 0.9, to: 1, seen: 2, engaged: 2 },
		]);
		expect(summarizeHanamiRankBacktest(rows)).toMatchObject({ seen: 10, engaged: 2, auc: 1, withinUserAuc: 1, withinUsers: 1, top20: { seen: 2, engaged: 2 } });
		expect(summarizeHanamiRankBacktest([])).toEqual({ seen: 0, engaged: 0, auc: null, withinUserAuc: null, withinUsers: 0, top20: { seen: 0, engaged: 0 }, buckets: [] });
	});
});

describe('順番待ちの項目の ID', () => {
	test('実行・付け方・記録を結び、元に戻せる', () => {
		const id = hanamiRankBacktestItemId('run1', 'personal', '42');
		expect(id).toBe('run1:personal:42');
		expect(parseHanamiRankBacktestItemId(id)).toEqual({ runId: 'run1', variant: 'personal', sampleId: '42' });
	});

	test('形の違う ID・知らない付け方は読まない', () => {
		expect(parseHanamiRankBacktestItemId('run1:other:42')).toBeNull();
		expect(parseHanamiRankBacktestItemId('run1:personal')).toBeNull();
		expect(parseHanamiRankBacktestItemId('run1:personal:42:extra')).toBeNull();
		expect(parseHanamiRankBacktestItemId('1:n1')).toBeNull();
	});
});
