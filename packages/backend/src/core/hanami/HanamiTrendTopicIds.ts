/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// いま話題の「話題の ID」を、10 分ごとの計算のあいだで引き継ぐ決まり。
// 見出し・「同じ話題」の判定・始まった時刻は ID にひも付く。同じ出来事の話題が割れたりまとまったりを繰り返すたびに
// ID が変わると、そのたびに全部やり直しになり、一覧に同じ出来事が何件も並ぶ。そこで次の 4 つで ID を保つ。
//   決まり 1: 前の話題は、自分の投稿をいちばん多く受け継いだ話題を「続き」に指名する（割れたら、大きく受け継いだ側が ID を持つ）。
//   決まり 2: 複数から指名された話題（まとまり直した話題）は、指名した話題のうち古いほうの ID を使う。
//   決まり 3: 指名されなかった話題も、まだ使われていない重なる相手がいれば、その ID を引き継ぐ。
//   決まり 4: 消えた話題の ID をしばらく覚えておき、同じ投稿のまとまりが戻ってきたら同じ ID を使う。

/** 前の話題と投稿がこの割合（Jaccard）以上重なっていれば、引き継ぎの相手にできる */
export const TREND_TOPIC_INHERIT_JACCARD = 0.2;
/** 指名した話題のうち、共通の投稿がいちばん多いもののこの割合以上あるなかで、いちばん古い話題の ID を使う */
export const TREND_TOPIC_INHERIT_NEAR_BEST = 0.5;
/** 消えた話題の ID を覚えておく時間 */
export const TREND_TOPIC_RETIRED_MS = 3 * 60 * 60 * 1000;
/** 覚えておく消えた話題の数の上限（あとで消えたものを優先） */
export const TREND_TOPIC_RETIRED_MAX = 40;
/** 消えた話題 1 つにつき覚えておく投稿の数の上限 */
export const TREND_TOPIC_RETIRED_NOTE_MAX = 300;
/** まとめた話題の代表（一覧に出す ID）は、いちばん人数の多い話題のこの割合以上の人数がいる話題のなかで、いちばん古いものにする */
export const TREND_TOPIC_LEADER_SHARE = 0.5;

export type TrendTopicIdSource = { topicId: string; startedAt: string; terms: string[]; noteIds: string[] };
export type TrendRetiredTopic = TrendTopicIdSource & { retiredAt: number };
/** live = 前回の話題の続き / retired = 消えていた話題が戻った / heading = 投稿は重ならないが先頭の語が同じ / new = 新しい話題 */
export type TrendTopicIdOrigin = 'live' | 'retired' | 'heading' | 'new';
export type TrendTopicIdAssignment = { source: TrendTopicIdSource | null; origin: TrendTopicIdOrigin };

type Pair = { index: number; k: number; common: number; jaccard: number };

function startedTime(topic: { startedAt: string }): number {
	const at = Date.parse(topic.startedAt);
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/**
 * 今回の話題それぞれに、引き継ぐ相手（前回の話題か、消えて間もない話題）を決める。相手がいなければ source は null（新しい ID を作る）。
 * 1 つの ID を引き継げるのは 1 つの話題だけ。
 */
export function assignTrendTopicIds(
	raw: readonly { terms: readonly string[]; noteIds: readonly string[] }[],
	previous: readonly TrendTopicIdSource[], retired: readonly TrendRetiredTopic[], now: number,
): TrendTopicIdAssignment[] {
	const liveIds = new Set(previous.map(topic => topic.topicId));
	const pool: (TrendTopicIdSource & { live: boolean })[] = [
		...previous.map(topic => ({ ...topic, live: true })),
		...retired.filter(topic => topic.retiredAt > now - TREND_TOPIC_RETIRED_MS && !liveIds.has(topic.topicId)).map(topic => ({ ...topic, live: false })),
	];
	const sizes: number[] = [];
	const byNote = new Map<string, number[]>();
	pool.forEach((topic, k) => {
		const ids = new Set(topic.noteIds);
		sizes.push(ids.size);
		for (const id of ids) {
			const list = byNote.get(id);
			if (list == null) byNote.set(id, [k]); else list.push(k);
		}
	});
	// 引き継ぎの相手にできる組（投稿が十分に重なる組）だけを集める。
	const byRaw: Pair[][] = raw.map((topic, index) => {
		const ids = new Set(topic.noteIds);
		const common = new Map<number, number>();
		for (const id of ids) for (const k of byNote.get(id) ?? []) common.set(k, (common.get(k) ?? 0) + 1);
		return [...common].map(([k, count]) => ({ index, k, common: count, jaccard: count / Math.max(1, ids.size + sizes[k] - count) }))
			.filter(pair => pair.jaccard >= TREND_TOPIC_INHERIT_JACCARD);
	});
	const older = (a: Pair, b: Pair): number => startedTime(pool[a.k]) - startedTime(pool[b.k]) || b.common - a.common || Number(pool[b.k].live) - Number(pool[a.k].live) || a.k - b.k;
	const used = new Set<string>();
	const result: TrendTopicIdAssignment[] = raw.map(() => ({ source: null, origin: 'new' }));
	const take = (pair: Pair): void => {
		const source = pool[pair.k];
		const { live: _live, ...rest } = source;
		used.add(source.topicId);
		result[pair.index] = { source: rest, origin: source.live ? 'live' : 'retired' };
	};

	// 決まり 1: 前の話題は、自分の投稿をいちばん多く受け継いだ話題を「続き」に指名する。
	const heir = new Map<number, Pair>();
	for (const pair of byRaw.flat()) {
		const current = heir.get(pair.k);
		if (current == null || pair.common > current.common || (pair.common === current.common && pair.jaccard > current.jaccard)) heir.set(pair.k, pair);
	}
	const nominated: Pair[][] = raw.map(() => []);
	for (const pair of heir.values()) nominated[pair.index].push(pair);

	// 決まり 2: 複数から指名された話題は、共通の投稿がいちばん多い相手の半分以上あるなかで、いちばん古い話題の ID を使う。
	// （まとまり直した話題が、新しくできた片割れではなく、もとの話題の ID を使い続けるように。小さな古い話題を吸収しただけでは ID は変わらない。）
	for (const list of nominated) {
		if (list.length === 0) continue;
		const top = list.reduce((max, pair) => Math.max(max, pair.common), 0);
		take(list.filter(pair => pair.common >= top * TREND_TOPIC_INHERIT_NEAR_BEST).sort(older)[0]);
	}

	// 決まり 3: 指名されなかった話題は、まだ使われていない相手のうち、共通の投稿がいちばん多いものを引き継ぐ（重なりの大きい話題から選ぶ）。
	const strongest = (list: readonly Pair[]): number => list.reduce((max, pair) => Math.max(max, pair.common), 0);
	const leftovers = raw.map((_, index) => index).filter(index => result[index].source == null && byRaw[index].length > 0)
		.sort((a, b) => strongest(byRaw[b]) - strongest(byRaw[a]) || a - b);
	for (const index of leftovers) {
		const available = byRaw[index].filter(pair => !used.has(pool[pair.k].topicId));
		if (available.length === 0) continue;
		take(available.sort((a, b) => b.common - a.common || older(a, b))[0]);
	}

	// 投稿がどの話題とも重ならないときだけ、先頭の語が同じ前回の話題を引き継ぐ（投稿が総入れ替えになった長い話題）。
	raw.forEach((topic, index) => {
		if (byRaw[index].length > 0) return;
		const source = previous.find(prev => prev.terms[0] === topic.terms[0] && !used.has(prev.topicId));
		if (source == null) return;
		used.add(source.topicId);
		result[index] = { source, origin: 'heading' };
	});
	return result;
}

/**
 * 決まり 4 のための、次の回に渡す「消えた話題」の一覧。今回だれにも引き継がれなかった前回の話題を足し、使われた ID と期限切れを除く。
 * @param previousAt 前回の計算の時刻（前回の話題が最後に出ていた時刻）
 */
export function nextTrendRetiredTopics(
	previous: readonly TrendTopicIdSource[], retired: readonly TrendRetiredTopic[], usedIds: ReadonlySet<string>, previousAt: number, now: number,
): TrendRetiredTopic[] {
	const seen = new Set<string>();
	const next: TrendRetiredTopic[] = [];
	const add = (topic: TrendTopicIdSource, retiredAt: number): void => {
		if (usedIds.has(topic.topicId) || seen.has(topic.topicId) || retiredAt <= now - TREND_TOPIC_RETIRED_MS) return;
		seen.add(topic.topicId);
		next.push({ topicId: topic.topicId, startedAt: topic.startedAt, terms: topic.terms.slice(0, 6), noteIds: topic.noteIds.slice(0, TREND_TOPIC_RETIRED_NOTE_MAX), retiredAt });
	};
	for (const topic of previous) add(topic, Math.min(previousAt, now));
	for (const topic of retired) add(topic, topic.retiredAt);
	return next.sort((a, b) => b.retiredAt - a.retiredAt).slice(0, TREND_TOPIC_RETIRED_MAX);
}

/**
 * 「同じ話題」としてまとめた話題のうち、一覧に出す代表を選ぶ。
 * いちばん人数の多い話題の TREND_TOPIC_LEADER_SHARE 以上の人数がいるもののなかで、いちばん古い話題にする
 * （人数が近い話題どうしで代表が入れ替わるたびに、見出しと始まった時刻が変わらないように）。
 */
export function pickTrendTopicLeader<T extends { startedAt: string; authors6h: number }>(members: readonly T[]): T {
	const largest = members.reduce((max, topic) => Math.max(max, topic.authors6h), 0);
	return members.filter(topic => topic.authors6h >= largest * TREND_TOPIC_LEADER_SHARE)
		.reduce((leader, topic) => startedTime(topic) < startedTime(leader) || (startedTime(topic) === startedTime(leader) && topic.authors6h > leader.authors6h) ? topic : leader);
}
