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
 * 記録にある値をそのまま点数にする付け方（GPU は使わない。比べる相手）。
 * interest = いまの投稿の判定の「興味」の点数、follow = フォロー中の人の投稿なら 1
 */
export const HANAMI_RANK_BACKTEST_STORED_VARIANTS = ['interest', 'follow'] as const;
export type HanamiRankBacktestStoredVariant = typeof HANAMI_RANK_BACKTEST_STORED_VARIANTS[number];

export type HanamiRankBacktestVariant = HanamiRankBacktestGpuVariant | HanamiRankBacktestStoredVariant;
export const HANAMI_RANK_BACKTEST_VARIANTS: readonly HanamiRankBacktestVariant[] = [...HANAMI_RANK_BACKTEST_GPU_VARIANTS, ...HANAMI_RANK_BACKTEST_STORED_VARIANTS];

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

/** 記録にある値を点数にする付け方の点数。点数を付けられない記録は null */
export function hanamiRankBacktestStoredScore(variant: HanamiRankBacktestStoredVariant, sample: HanamiRankBacktestSample): number | null {
	if (variant === 'interest') return sample.interest != null && Number.isFinite(sample.interest) ? sample.interest : null;
	return sample.relationship === 'directFollow' ? 1 : 0;
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
