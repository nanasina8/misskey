/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 同じ出来事が別の話題に割れていそうな組を、手がかりの強い順に挙げる。
// ここでは「同じかもしれない」と挙げるだけで、まとめるかどうかは LLM の判定（same）が決める。
/** 組を探す話題の数（順位の上から） */
export const TREND_RELATED_TOPIC_MAX = 40;
/** 1 回に残す組の上限 */
export const TREND_RELATED_PAIR_MAX = 60;
/** 共通の人がこの人数以上、かつ小さい側の人数に対してこの割合以上なら候補にする */
export const TREND_RELATED_MIN_SHARED_AUTHORS = 2;
export const TREND_RELATED_MIN_AUTHOR_RATIO = 0.3;
/** 内容（話題の中心）がこれ以上近ければ候補にする */
export const TREND_RELATED_MIN_COS = 0.6;
/** 2 つの話題の投稿のうち、どちらもこの割合以上が前回の同じ話題に入っていたら「その話題から分かれた」とみなす */
export const TREND_RELATED_SIBLING_SHARE = 0.5;
/** 話題の投稿のうち、この割合以上が相手の話題の前回の投稿だったら「投稿が移ってきた」とみなす */
export const TREND_RELATED_MOVED_SHARE = 0.3;

export type TrendRelatedTopic = {
	topicId: string;
	terms: readonly string[];
	noteIds: readonly string[];
	center?: readonly number[] | null;
};

function cosine(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): number {
	if (a == null || b == null || a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const cos = normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
	return Number.isFinite(cos) ? cos : 0;
}

/**
 * 手がかり: 共通の投稿／前回は 1 つの話題だった・相手の話題から投稿が移ってきた／共通の語／共通の人／内容の近さ。
 * 話題は 10 分ごとに作り直すので、同じ出来事の投稿が回によって別のまとまりに入り、新しい ID の話題として現れることがある。
 * 前回の話題（previous）と比べるのは、それを拾うため。
 * 返すのは [topicId, topicId] の組で、手がかりの強い順。
 */
export function trendRelatedTopicPairs(
	topics: readonly TrendRelatedTopic[],
	authorOfNote: ReadonlyMap<string, string>,
	previous: readonly { topicId: string; noteIds: readonly string[] }[] = [],
	limit = TREND_RELATED_PAIR_MAX,
): Array<[string, string]> {
	const head = topics.slice(0, TREND_RELATED_TOPIC_MAX);
	const previousOfNote = new Map<string, string>();
	for (const topic of previous) for (const id of topic.noteIds) if (!previousOfNote.has(id)) previousOfNote.set(id, topic.topicId);
	const info = head.map(topic => {
		const notes = new Set(topic.noteIds);
		const authors = new Set<string>();
		const fromPrevious = new Map<string, number>();
		for (const id of notes) {
			const author = authorOfNote.get(id);
			if (author != null) authors.add(author);
			const origin = previousOfNote.get(id);
			if (origin != null) fromPrevious.set(origin, (fromPrevious.get(origin) ?? 0) + 1);
		}
		const [origin, count] = [...fromPrevious].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
		return {
			topic, notes, authors, terms: new Set(topic.terms), fromPrevious,
			origin: origin != null && notes.size > 0 && count / notes.size >= TREND_RELATED_SIBLING_SHARE ? origin : null,
		};
	});
	const scored: Array<{ pair: [string, string]; score: number }> = [];
	for (let i = 0; i < info.length; i++) {
		for (let j = i + 1; j < info.length; j++) {
			const a = info[i];
			const b = info[j];
			let sharedNotes = false;
			for (const id of a.notes) if (b.notes.has(id)) { sharedNotes = true; break; }
			let sharedAuthors = 0;
			for (const author of a.authors) if (b.authors.has(author)) sharedAuthors++;
			const ratio = sharedAuthors / Math.max(1, Math.min(a.authors.size, b.authors.size));
			const sharedTerm = [...a.terms].some(term => b.terms.has(term));
			// 話題の ID は回をまたいで引き継ぐので、「前回の相手の ID の話題に入っていた投稿」は相手から移ってきた投稿。
			const moved = (a.fromPrevious.get(b.topic.topicId) ?? 0) / Math.max(1, a.notes.size) >= TREND_RELATED_MOVED_SHARE
				|| (b.fromPrevious.get(a.topic.topicId) ?? 0) / Math.max(1, b.notes.size) >= TREND_RELATED_MOVED_SHARE;
			const sibling = moved || (a.origin != null && a.origin === b.origin);
			const cos = cosine(a.topic.center, b.topic.center);
			const people = sharedAuthors >= TREND_RELATED_MIN_SHARED_AUTHORS && ratio >= TREND_RELATED_MIN_AUTHOR_RATIO;
			if (!sharedNotes && !sibling && !sharedTerm && !people && cos < TREND_RELATED_MIN_COS) continue;
			scored.push({
				pair: [a.topic.topicId, b.topic.topicId],
				score: (sibling ? 2 : 0) + (sharedNotes ? 1 : 0) + (sharedTerm ? 1 : 0) + (people ? ratio : 0) + Math.max(0, cos),
			});
		}
	}
	// 同点は元の順位（上の話題どうし）を優先する。sort は安定なので、そのまま並べ替えればよい。
	return scored.sort((x, y) => y.score - x.score).slice(0, limit).map(item => item.pair);
}
