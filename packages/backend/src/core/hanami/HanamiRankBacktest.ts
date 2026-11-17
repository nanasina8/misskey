/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 並べ替えの物差し。過去の「はなみTL で見た → 反応した」の記録に、点数の付け方を当て直して、
// 点数が反応と結び付いているかを測る。新しい付け方を TL に入れる前に、効くかどうかを確かめるためのもの。
// このファイルは DB にも Redis にも触らない部分（文面の組み立てと集計）。

/** GPU で採点する付け方。personal = 本人が最近反応した投稿を見せて判定、generic = 投稿だけを見せて判定 */
export const HANAMI_RANK_BACKTEST_GPU_VARIANTS = ['personal', 'generic'] as const;
export type HanamiRankBacktestGpuVariant = typeof HANAMI_RANK_BACKTEST_GPU_VARIANTS[number];

/**
 * 記録と DB の値をそのまま点数にする付け方（GPU は使わない）。どれも「見た時点までに分かっていたこと」だけを使う。
 * - interest = いまの投稿の判定の「興味」の点数
 * - follow = フォロー中の人の投稿なら 1
 * - prior = 見る前の 90 日に、本人がその作者のほかの投稿に反応した回数
 * - social = 見る前に、本人のフォロー中の人がその投稿に反応した数
 * - reactions = 見る前に、その投稿に付いていた反応の数（本人のものは除く。このサーバーに届いている分）
 * - fresh = 新しい投稿ほど高い（見た時点での、投稿からの時間の逆）
 * - clustered = 出したときに、本人の好みのまとまりに当たっていたら 1
 */
export const HANAMI_RANK_BACKTEST_STORED_VARIANTS = ['interest', 'follow', 'prior', 'social', 'reactions', 'fresh', 'clustered'] as const;
export type HanamiRankBacktestStoredVariant = typeof HANAMI_RANK_BACKTEST_STORED_VARIANTS[number];

export type HanamiRankBacktestVariant = HanamiRankBacktestGpuVariant | HanamiRankBacktestStoredVariant;
export const HANAMI_RANK_BACKTEST_VARIANTS: readonly HanamiRankBacktestVariant[] = [...HANAMI_RANK_BACKTEST_GPU_VARIANTS, ...HANAMI_RANK_BACKTEST_STORED_VARIANTS];

/**
 * 付け方や集計を変えたら上げる。実行に記録しておき、古い版の実行しか無ければ、空いたときに自動で取り直す。
 * 2: 記録と DB の値を使う付け方（prior・social・reactions・fresh・clustered）と、組み合わせた点数の検証を追加
 */
export const HANAMI_RANK_BACKTEST_VERSION = 2;
/** prior で数える期間（見た時刻より前の日数） */
export const HANAMI_RANK_BACKTEST_PRIOR_DAYS = 90;

/** 判定係に選ばせる答え。点数は 1 つめ（はい）の確率 */
export const HANAMI_RANK_BACKTEST_CHOICES = ['はい', 'いいえ'] as const;

/** personal で見せる「最近反応した投稿」の件数 */
export const HANAMI_RANK_BACKTEST_HISTORY_MAX = 8;
/** これより少ない人は personal の対象から外す（材料が足りない） */
export const HANAMI_RANK_BACKTEST_HISTORY_MIN = 3;
export const HANAMI_RANK_BACKTEST_HISTORY_CHARS = 100;
export const HANAMI_RANK_BACKTEST_NOTE_CHARS = 300;

export const HANAMI_RANK_BACKTEST_SUBSETS = ['all', 'unknown', 'directFollow'] as const;
export type HanamiRankBacktestSubset = typeof HANAMI_RANK_BACKTEST_SUBSETS[number];

/** 採点の対象 1 件 = はなみTL で 1 人が 1 つの投稿を見た記録 */
export type HanamiRankBacktestSample = {
	id: string;
	userId: string;
	noteId: string;
	/** 見た時刻（ミリ秒） */
	seenAt: number;
	source: string;
	relationship: string;
	/** その人がその投稿に反応・返信・リノートしたか */
	engaged: boolean;
	/** いまの投稿の判定の「興味」の点数（未判定は null） */
	interest: number | null;
	authorId?: string;
	/** 出したときに、本人の好みのまとまりに当たっていたか */
	clustered?: boolean;
	/** 見た時点までの値。調べられなかった記録には付かない */
	features?: HanamiRankBacktestFeatures;
};

export type HanamiRankBacktestFeatures = {
	prior: number;
	social: number;
	reactions: number;
	/** 見た時点での、投稿からの時間 */
	ageHours: number;
};

export type HanamiRankBacktestScored = { score: number; engaged: boolean; userId: string };

export type HanamiRankBacktestBucket = { from: number; to: number; seen: number; engaged: number };

export type HanamiRankBacktestSummary = {
	seen: number;
	engaged: number;
	/** 反応した投稿の点数が、反応しなかった投稿の点数より高い割合（0.5 = でたらめと同じ、1 = 完全に当たる）。全員まとめて比べた値 */
	auc: number | null;
	/** 同じ人の中だけで比べた値。人による反応のしやすさの差を除くので、並べ替えに効くかはこちらで見る */
	withinUserAuc: number | null;
	/** withinUserAuc に入った人数（反応した投稿としなかった投稿の両方がある人） */
	withinUsers: number;
	/** 点数の高い順に 2 割を取ったときの件数と反応 */
	top20: { seen: number; engaged: number };
	/** 点数の低い順に 5 つに等分したもの */
	buckets: HanamiRankBacktestBucket[];
};

/** 改行や連続した空白を 1 つの空白にし、長すぎる分は切る（文字単位） */
export function hanamiRankBacktestText(text: string | null | undefined, maxChars: number): string {
	const collapsed = (text ?? '').replace(/\s+/gu, ' ').trim();
	const chars = Array.from(collapsed);
	return chars.length <= maxChars ? collapsed : chars.slice(0, maxChars).join('') + '…';
}

/**
 * 判定係に渡す文面を作る。personal で、最近反応した投稿が足りないときは null（その人は対象外）。
 * 文面を変えたら、前の結果とは比べられない（実行ごとに全部採点し直すので、混ざることはない）。
 */
export function buildHanamiRankBacktestPrompt(variant: HanamiRankBacktestGpuVariant, note: string, history: readonly string[]): string | null {
	const target = hanamiRankBacktestText(note, HANAMI_RANK_BACKTEST_NOTE_CHARS);
	if (target === '') return null;
	if (variant === 'generic') {
		return 'SNS の投稿 1 件です。読んだ人がこの投稿にリアクション（いいねなど）をしそうなら「はい」、しなさそうなら「いいえ」とだけ答えてください。\n\n'
			+ `[投稿]\n${target}`;
	}
	const liked = history.map(text => hanamiRankBacktestText(text, HANAMI_RANK_BACKTEST_HISTORY_CHARS)).filter(text => text !== '').slice(0, HANAMI_RANK_BACKTEST_HISTORY_MAX);
	if (liked.length < HANAMI_RANK_BACKTEST_HISTORY_MIN) return null;
	return 'SNS の利用者が最近リアクションした投稿と、新しい投稿 1 件です。この利用者が新しい投稿にリアクションしそうなら「はい」、しなさそうなら「いいえ」とだけ答えてください。\n\n'
		+ `[最近リアクションした投稿]\n${liked.map(text => `- ${text}`).join('\n')}\n\n`
		+ `[新しい投稿]\n${target}`;
}

/** 記録と DB の値を点数にする付け方の点数。点数を付けられない記録は null */
export function hanamiRankBacktestStoredScore(variant: HanamiRankBacktestStoredVariant, sample: HanamiRankBacktestSample): number | null {
	switch (variant) {
		case 'interest': return sample.interest != null && Number.isFinite(sample.interest) ? sample.interest : null;
		case 'follow': return sample.relationship === 'directFollow' ? 1 : 0;
		case 'prior': return sample.features?.prior ?? null;
		case 'social': return sample.features?.social ?? null;
		case 'reactions': return sample.features?.reactions ?? null;
		case 'fresh': return sample.features == null ? null : -sample.features.ageHours;
		case 'clustered': return sample.clustered == null ? null : (sample.clustered ? 1 : 0);
	}
}

/** 反応した 1 件と反応しなかった 1 件の組のうち、反応したほうの点数が高い組の数（同点は 0.5）と、組の総数 */
function pairWins(rows: readonly { score: number; engaged: boolean }[]): { wins: number; pairs: number } {
	const sorted = [...rows].sort((a, b) => a.score - b.score);
	let negativesBelow = 0;
	let wins = 0;
	let positives = 0;
	let negatives = 0;
	for (let start = 0; start < sorted.length;) {
		let end = start;
		let tiePositives = 0;
		let tieNegatives = 0;
		while (end < sorted.length && sorted[end].score === sorted[start].score) {
			if (sorted[end].engaged) tiePositives++; else tieNegatives++;
			end++;
		}
		wins += tiePositives * (negativesBelow + tieNegatives / 2);
		negativesBelow += tieNegatives;
		positives += tiePositives;
		negatives += tieNegatives;
		start = end;
	}
	return { wins, pairs: positives * negatives };
}

/** 全員まとめて比べた AUC。反応した投稿か、しなかった投稿のどちらかが無ければ null */
export function hanamiRankBacktestAuc(rows: readonly { score: number; engaged: boolean }[]): number | null {
	const { wins, pairs } = pairWins(rows);
	return pairs === 0 ? null : wins / pairs;
}

/** 同じ人の中だけで比べた AUC（組の数で重みを付けた平均）。比べられる人がいなければ null */
export function hanamiRankBacktestWithinUserAuc(rows: readonly HanamiRankBacktestScored[]): { auc: number | null; users: number } {
	const byUser = new Map<string, HanamiRankBacktestScored[]>();
	for (const row of rows) {
		const list = byUser.get(row.userId) ?? [];
		list.push(row);
		byUser.set(row.userId, list);
	}
	let wins = 0;
	let pairs = 0;
	let users = 0;
	for (const list of byUser.values()) {
		const own = pairWins(list);
		if (own.pairs === 0) continue;
		wins += own.wins;
		pairs += own.pairs;
		users++;
	}
	return { auc: pairs === 0 ? null : wins / pairs, users };
}

/** 点数の低い順に count 個に等分する（同じ点数でも件数で分ける） */
export function hanamiRankBacktestBuckets(rows: readonly { score: number; engaged: boolean }[], count = 5): HanamiRankBacktestBucket[] {
	const sorted = [...rows].sort((a, b) => a.score - b.score);
	const buckets: HanamiRankBacktestBucket[] = [];
	for (let i = 0; i < count; i++) {
		const part = sorted.slice(Math.floor(i * sorted.length / count), Math.floor((i + 1) * sorted.length / count));
		if (part.length === 0) continue;
		buckets.push({ from: part[0].score, to: part[part.length - 1].score, seen: part.length, engaged: part.filter(row => row.engaged).length });
	}
	return buckets;
}

export function summarizeHanamiRankBacktest(rows: readonly HanamiRankBacktestScored[]): HanamiRankBacktestSummary {
	const within = hanamiRankBacktestWithinUserAuc(rows);
	const top = [...rows].sort((a, b) => b.score - a.score).slice(0, Math.ceil(rows.length * 0.2));
	return {
		seen: rows.length,
		engaged: rows.filter(row => row.engaged).length,
		auc: hanamiRankBacktestAuc(rows),
		withinUserAuc: within.auc,
		withinUsers: within.users,
		top20: { seen: top.length, engaged: top.filter(row => row.engaged).length },
		buckets: hanamiRankBacktestBuckets(rows),
	};
}

export function hanamiRankBacktestInSubset(subset: HanamiRankBacktestSubset, sample: HanamiRankBacktestSample): boolean {
	return subset === 'all' || sample.relationship === subset;
}

/** 順番待ちの項目の ID。実行・付け方・記録の 3 つを結ぶ（どれも英数字だけ） */
export function hanamiRankBacktestItemId(runId: string, variant: HanamiRankBacktestGpuVariant, sampleId: string): string {
	return `${runId}:${variant}:${sampleId}`;
}

export function parseHanamiRankBacktestItemId(itemId: string): { runId: string; variant: HanamiRankBacktestGpuVariant; sampleId: string } | null {
	const [runId, variant, sampleId, ...rest] = itemId.split(':');
	if (rest.length > 0 || !runId || !sampleId || !(HANAMI_RANK_BACKTEST_GPU_VARIANTS as readonly string[]).includes(variant)) return null;
	return { runId, variant: variant as HanamiRankBacktestGpuVariant, sampleId };
}

// ───────── 組み合わせた点数（学習する並べ替えの最小形）を、入れる前に確かめる ─────────

/**
 * 組み合わせに使う値。数は対数にし、新しさは「6 時間以内」を基準にした 3 つの区分にする
 * （反応は 6〜24 時間でいちばん多く、単純に新しいほど良いわけではないため）。
 */
export const HANAMI_RANK_BACKTEST_MODEL_FEATURES = ['follow', 'prior', 'social', 'reactions', 'age6to24h', 'age1to3d', 'ageOver3d', 'clustered'] as const;

export function hanamiRankBacktestFeatureVector(sample: HanamiRankBacktestSample): number[] | null {
	if (sample.features == null) return null;
	const age = sample.features.ageHours;
	return [
		sample.relationship === 'directFollow' ? 1 : 0,
		Math.log1p(Math.max(0, sample.features.prior)),
		Math.log1p(Math.max(0, sample.features.social)),
		Math.log1p(Math.max(0, sample.features.reactions)),
		age >= 6 && age < 24 ? 1 : 0,
		age >= 24 && age < 72 ? 1 : 0,
		age >= 72 ? 1 : 0,
		sample.clustered === true ? 1 : 0,
	];
}

export type HanamiRankBacktestModel = {
	mean: number[];
	scale: number[];
	/** 平均 0・ばらつき 1 にそろえた値に掛ける重み。大きいほど「反応した」に効く */
	weights: number[];
	bias: number;
};

/**
 * 反応したかどうかを当てる、いちばん単純な式（ロジスティック回帰）を作る。
 * 値は平均 0・ばらつき 1 にそろえ、重みが大きくなりすぎないよう抑える（l2）。乱数は使わないので、同じ入力なら同じ結果になる。
 */
export function fitHanamiRankBacktestModel(rows: readonly { x: readonly number[]; engaged: boolean }[], options: { iterations?: number; learningRate?: number; l2?: number } = {}): HanamiRankBacktestModel {
	const iterations = options.iterations ?? 400;
	const learningRate = options.learningRate ?? 0.5;
	const l2 = options.l2 ?? 1;
	const dimension = rows[0]?.x.length ?? 0;
	const count = Math.max(1, rows.length);
	const mean = Array.from({ length: dimension }, (_, j) => rows.reduce((sum, row) => sum + row.x[j], 0) / count);
	const scale = Array.from({ length: dimension }, (_, j) => {
		const deviation = Math.sqrt(rows.reduce((sum, row) => sum + (row.x[j] - mean[j]) ** 2, 0) / count);
		return deviation > 1e-9 ? deviation : 1;
	});
	const z = rows.map(row => row.x.map((value, j) => (value - mean[j]) / scale[j]));
	const weights = new Array<number>(dimension).fill(0);
	const positives = rows.filter(row => row.engaged).length;
	// 切片は、全体の反応の割合から始める（反応は 1 割に満たないので、0 から始めると遠回りになる）
	const rate = Math.min(1 - 1e-6, Math.max(1e-6, positives / count));
	let bias = Math.log(rate / (1 - rate));
	for (let step = 0; step < iterations; step++) {
		const gradient = new Array<number>(dimension).fill(0);
		let biasGradient = 0;
		for (let i = 0; i < rows.length; i++) {
			let logit = bias;
			for (let j = 0; j < dimension; j++) logit += weights[j] * z[i][j];
			const error = 1 / (1 + Math.exp(-logit)) - (rows[i].engaged ? 1 : 0);
			biasGradient += error;
			for (let j = 0; j < dimension; j++) gradient[j] += error * z[i][j];
		}
		bias -= learningRate * biasGradient / count;
		for (let j = 0; j < dimension; j++) weights[j] -= learningRate * (gradient[j] + l2 * weights[j]) / count;
	}
	return { mean, scale, weights, bias };
}

export function scoreHanamiRankBacktestModel(model: HanamiRankBacktestModel, x: readonly number[]): number {
	let logit = model.bias;
	for (let j = 0; j < model.weights.length; j++) logit += model.weights[j] * ((x[j] ?? 0) - model.mean[j]) / model.scale[j];
	return logit;
}

/** 式を作る側・確かめる側のそれぞれに、反応した記録がこれだけ無ければ確かめない */
export const HANAMI_RANK_BACKTEST_MODEL_MIN_ENGAGED = 20;

export type HanamiRankBacktestModelEvaluation = {
	train: { seen: number; engaged: number };
	test: { seen: number; engaged: number };
	weights: Array<{ feature: typeof HANAMI_RANK_BACKTEST_MODEL_FEATURES[number]; weight: number }>;
	/** 確かめる側（新しい半分）での結果。model = 組み合わせた点数、follow = フォロー中かどうかだけ（比べる相手） */
	results: Array<{ scoring: 'model' | 'follow'; subset: HanamiRankBacktestSubset } & HanamiRankBacktestSummary>;
};

/**
 * 記録を見た時刻の順に並べ、古い半分で式を作り、新しい半分で確かめる（作るのに使った記録では確かめない）。
 * 記録が足りないときは null。
 */
export function evaluateHanamiRankBacktestModel(samples: readonly HanamiRankBacktestSample[]): HanamiRankBacktestModelEvaluation | null {
	const usable = samples.flatMap(sample => {
		const x = hanamiRankBacktestFeatureVector(sample);
		return x == null ? [] : [{ sample, x, engaged: sample.engaged }];
	}).sort((a, b) => a.sample.seenAt - b.sample.seenAt || (a.sample.id < b.sample.id ? -1 : 1));
	const half = Math.floor(usable.length / 2);
	const train = usable.slice(0, half);
	const test = usable.slice(half);
	const engagedIn = (rows: readonly { engaged: boolean }[]): number => rows.filter(row => row.engaged).length;
	for (const part of [train, test]) {
		const engaged = engagedIn(part);
		if (engaged < HANAMI_RANK_BACKTEST_MODEL_MIN_ENGAGED || part.length - engaged < HANAMI_RANK_BACKTEST_MODEL_MIN_ENGAGED) return null;
	}
	const model = fitHanamiRankBacktestModel(train);
	const results: HanamiRankBacktestModelEvaluation['results'] = [];
	for (const scoring of ['model', 'follow'] as const) {
		for (const subset of HANAMI_RANK_BACKTEST_SUBSETS) {
			const rows = test.filter(row => hanamiRankBacktestInSubset(subset, row.sample)).map(row => ({
				score: scoring === 'model' ? scoreHanamiRankBacktestModel(model, row.x) : (row.sample.relationship === 'directFollow' ? 1 : 0),
				engaged: row.engaged,
				userId: row.sample.userId,
			}));
			results.push({ scoring, subset, ...summarizeHanamiRankBacktest(rows) });
		}
	}
	return {
		train: { seen: train.length, engaged: engagedIn(train) },
		test: { seen: test.length, engaged: engagedIn(test) },
		weights: HANAMI_RANK_BACKTEST_MODEL_FEATURES.map((feature, j) => ({ feature, weight: model.weights[j] })),
		results,
	};
}

