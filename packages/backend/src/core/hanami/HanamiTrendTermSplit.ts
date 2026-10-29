/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const TREND_SPLIT_TERM_COS = 0.6;
const TREND_SPLIT_ONSET_COS = 0.3;
const TREND_SPLIT_PEAK_SPAN_MS = 30 * 60 * 1000;
const TREND_SPLIT_PEAK_SHARE = 0.5;
const TREND_SPLIT_ONSET_QUANTILE = 0.25;
const TREND_SPLIT_ONSET_GAP_MS = 20 * 60 * 1000;
const TREND_SPLIT_ATTACH_COS = 0.3;
const TREND_CONTENT_NAME_COS = 0.5;
const TREND_CONTENT_NAME_SHARE = 0.25;
const TREND_CONTENT_RELATED_SHARE = 0.2;

export type TrendCenteredVectors = Pick<ReadonlyMap<string, ArrayLike<number>>, 'get'>;
export type TrendNoteTerms = ReadonlyMap<string, readonly string[]>;
export type TrendTermTopic = {
	origin?: 'term' | 'content';
	terms: string[];
	noteIds: string[];
	authors6h: number;
	authors2h: number;
	center: number[] | null;
};
type TrendNote = { id: string; userId: string; createdAt: number };
type TrendTermSplit = { terms: string[]; groups: { terms: string[]; noteCount: number }[] };

/** Retain the binary input and center each requested row at most once per computation. */
export function centerTrendEmbeddings(rows: readonly { noteId: string }[], embeddings: Buffer, dim: number, meanVec: readonly number[]): TrendCenteredVectors {
	const indices = new Map<string, number>();
	for (let row = 0; row < rows.length; row++) indices.set(rows[row].noteId, row);
	const vectors = new Map<string, Float64Array>();
	return {
		get(id) {
			const cached = vectors.get(id);
			if (cached != null) return cached;
			const row = indices.get(id);
			if (row == null) return undefined;
			const vector = new Float64Array(dim);
			let norm = 0;
			for (let i = 0; i < dim; i++) {
				vector[i] = embeddings.readFloatLE((row * dim + i) * 4) - meanVec[i];
				norm += vector[i] * vector[i];
			}
			const scale = Math.max(Math.sqrt(norm), 1e-9);
			for (let i = 0; i < dim; i++) vector[i] /= scale;
			vectors.set(id, vector);
			return vector;
		},
	};
}

export function trendTopicCenter(noteIds: readonly string[], vectors: TrendCenteredVectors): number[] | null {
	let center: number[] | null = null;
	let count = 0;
	for (const id of noteIds) {
		const vector = vectors.get(id);
		if (vector == null) continue;
		center ??= Array<number>(vector.length).fill(0);
		for (let i = 0; i < vector.length; i++) center[i] += vector[i];
		count++;
	}
	if (center == null) return null;
	let norm = 0;
	for (let i = 0; i < center.length; i++) { center[i] /= count; norm += center[i] * center[i]; }
	const scale = Math.max(Math.sqrt(norm), 1e-9);
	return center.map(value => value / scale);
}

function dot(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number {
	if (a == null || b == null) return 0;
	let result = 0;
	for (let i = 0; i < a.length; i++) result += a[i] * b[i];
	return result;
}

export function trendPeakShare(times: readonly number[]): number {
	const sorted = [...times].sort((a, b) => a - b);
	let start = 0;
	let best = 0;
	for (let end = 0; end < sorted.length; end++) {
		while (sorted[end] - sorted[start] > TREND_SPLIT_PEAK_SPAN_MS) start++;
		best = Math.max(best, end - start + 1);
	}
	return best / Math.max(1, sorted.length);
}

/** NumPy's default percentile interpolation, for a nonempty series. */
export function trendQuantile(times: readonly number[], quantile = TREND_SPLIT_ONSET_QUANTILE): number {
	const sorted = [...times].sort((a, b) => a - b);
	const position = quantile * (sorted.length - 1);
	const lower = Math.floor(position);
	return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

type TrendOnset = { peakShare: number; q25: number };

export function trendTermsShareGroup(cos: number, a: TrendOnset, b: TrendOnset): boolean {
	return cos >= TREND_SPLIT_TERM_COS || (cos >= TREND_SPLIT_ONSET_COS
		&& a.peakShare >= TREND_SPLIT_PEAK_SHARE && b.peakShare >= TREND_SPLIT_PEAK_SHARE
		&& Math.abs(a.q25 - b.q25) <= TREND_SPLIT_ONSET_GAP_MS);
}

export function nameTrendContentTopic(
	noteIds: readonly string[], notes: ReadonlyMap<string, TrendNote>, noteTerms: TrendNoteTerms,
	vectors: TrendCenteredVectors | null, scores: ReadonlyMap<string, number>,
): string[] {
	const authors = new Set<string>();
	const terms = new Map<string, { users: Set<string>; noteIds: string[] }>();
	for (const id of noteIds) {
		const note = notes.get(id);
		if (note == null) continue;
		authors.add(note.userId);
		for (const term of noteTerms.get(id) ?? []) {
			if (term.startsWith('#')) continue;
			const entry = terms.get(term) ?? { users: new Set<string>(), noteIds: [] };
			entry.users.add(note.userId); entry.noteIds.push(id); terms.set(term, entry);
		}
	}
	const center = vectors == null ? null : trendTopicCenter(noteIds, vectors);
	const ordered = [...terms].filter(([, entry]) => entry.users.size >= 2)
		.sort((a, b) => b[1].users.size - a[1].users.size || (scores.get(b[0]) ?? 0) - (scores.get(a[0]) ?? 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.filter(([, entry]) => vectors == null || dot(trendTopicCenter(entry.noteIds, vectors), center) >= TREND_CONTENT_NAME_COS);
	const lead = ordered.find(([, entry]) => entry.users.size / authors.size >= TREND_CONTENT_NAME_SHARE)?.[0];
	if (lead == null) return [];
	return [lead, ...ordered.filter(([term, entry]) => term !== lead && entry.users.size / authors.size >= TREND_CONTENT_RELATED_SHARE).slice(0, 5).map(([term]) => term)];
}

export function splitTrendTermTopics(
	raw: readonly TrendTermTopic[], notes: ReadonlyMap<string, TrendNote>, noteTerms: TrendNoteTerms,
	vectors: TrendCenteredVectors | null, recountTopic: (topic: TrendTermTopic) => TrendTermTopic, minAuthors: number,
): { topics: TrendTermTopic[]; splits: TrendTermSplit[] } {
	const topics: TrendTermTopic[] = [];
	const splits: TrendTermSplit[] = [];
	if (vectors == null) return { topics: [...raw], splits };
	for (const topic of raw) {
		if (topic.origin !== 'term' || topic.terms.length < 2) { topics.push(topic); continue; }
		const has = new Map(topic.terms.map(term => [term, [] as string[]]));
		for (const id of topic.noteIds) for (const term of noteTerms.get(id) ?? []) has.get(term)?.push(id);
		const terms = topic.terms.filter(term => has.get(term)!.length > 0);
		if (terms.length < 2) { topics.push(topic); continue; }
		const centers = terms.map(term => trendTopicCenter(has.get(term)!, vectors));
		const embedded = terms.map((_, i) => i).filter(i => centers[i] != null);
		if (embedded.length < 2) { topics.push(topic); continue; }
		const onsets = terms.map(term => {
			const times = has.get(term)!.map(id => notes.get(id)!.createdAt);
			return { peakShare: trendPeakShare(times), q25: trendQuantile(times) };
		});
		const parents = terms.map((_, i) => i);
		const root = (i: number): number => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
		for (let i = 0; i < embedded.length; i++) for (let j = i + 1; j < embedded.length; j++) {
			const a = embedded[i]; const b = embedded[j];
			if (trendTermsShareGroup(dot(centers[a], centers[b]), onsets[a], onsets[b])) parents[root(b)] = root(a);
		}
		// No embedding is not evidence of a different topic. Keep these terms with
		// the first term whose center can be compared, preserving original order.
		for (let i = 0; i < terms.length; i++) if (centers[i] == null) parents[i] = root(embedded[0]);
		const groups = new Map<number, string[]>();
		terms.forEach((term, i) => { const group = groups.get(root(i)) ?? []; group.push(term); groups.set(root(i), group); });
		if (groups.size === 1) { topics.push(topic); continue; }
		// Map insertion order preserves the first original term in each component.
		const bundles = [...groups.values()].map(group => ({
			terms: group, noteIds: [] as string[], center: trendTopicCenter([...new Set(group.flatMap(term => has.get(term)!))], vectors),
		}));
		for (const id of topic.noteIds) {
			const own = bundles.filter(bundle => bundle.terms.some(term => noteTerms.get(id)?.includes(term)));
			const choices = own.length > 0 ? own : bundles;
			const vector = vectors.get(id);
			let best = choices[0];
			if (vector != null) {
				let similarity = dot(vector, best.center);
				for (const choice of choices.slice(1)) {
					const cos = dot(vector, choice.center);
					if (cos > similarity) { best = choice; similarity = cos; }
				}
				if (own.length === 0 && similarity < TREND_SPLIT_ATTACH_COS) continue;
			}
			best.noteIds.push(id);
		}
		const divided = bundles.map(bundle => recountTopic({
			origin: 'term', terms: bundle.terms, noteIds: bundle.noteIds, authors6h: 0, authors2h: 0,
			center: trendTopicCenter(bundle.noteIds, vectors),
		})).filter(bundle => bundle.authors6h >= minAuthors);
		topics.push(...divided);
		splits.push({ terms: topic.terms, groups: divided.map(bundle => ({ terms: bundle.terms, noteCount: bundle.noteIds.length })) });
	}
	return { topics, splits };
}
