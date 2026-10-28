/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const TREND_DUP_JACCARD = 0.3;
export const TREND_DUP_EXTRA_WEIGHT = 0.1;
const TAG_GAMES = new Set(['shindanmaker', 'fediqb', 'クイズメーカー', 'mewk', 'marshmallow', 'peing', 'odaibako']);
const MARKUP = /https?:\/\/\S+|@[\w.-]+(@[\w.-]+)?|:[a-zA-Z0-9_+-]+:|\$\[[^\s\]]*|\]|<\/?[a-z]+>|[#＃][^\s#＃]+/g;

export type TrendAuthorNote = { userId: string; text: string | null; tags?: readonly string[] };

export function trendCleanText(text: string): string {
	return text.replace(MARKUP, '');
}

export function trendPlayTag(tag: string): boolean {
	return TAG_GAMES.has(tag.toLowerCase()) || (tag.match(/[\u3041-\u309f]/gu)?.length ?? 0) >= 3;
}

export function trendShingles(text: string | null): Set<string> {
	const chars = Array.from(trendCleanText(text ?? '').replace(/[0-9０-９.,%％]+/g, '0').replace(/[\s、。！!？?「」『』()（）*＊~〜ー…・,，:：]/g, ''));
	return new Set(chars.slice(2).map((_, i) => chars.slice(i, i + 3).join('')));
}

export function trendSimilarText(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	let common = 0;
	for (const value of a) if (b.has(value)) common++;
	const union = a.size + b.size - common;
	return union > 0 && common / union >= TREND_DUP_JACCARD;
}

/** Authors are connected transitively, using any of their posts or shared play tags. */
export function hanamiTrendAuthorGroups(notes: readonly TrendAuthorNote[], playTags = true): string[][] {
	const byAuthor = new Map<string, { shingles: Set<string>[]; tags: Set<string> }>();
	for (const note of notes) {
		const author = byAuthor.get(note.userId) ?? { shingles: [], tags: new Set<string>() };
		author.shingles.push(trendShingles(note.text));
		if (playTags) for (const tag of [...(note.tags ?? []), ...Array.from((note.text ?? '').matchAll(/[#＃]([^\s#＃]+)/g), match => match[1])]) {
			if (trendPlayTag(tag)) author.tags.add(tag.toLowerCase());
		}
		byAuthor.set(note.userId, author);
	}
	const authors = [...byAuthor];
	const parents = authors.map((_, i) => i);
	const root = (i: number): number => {
		while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
		return i;
	};
	for (let a = 0; a < authors.length; a++) for (let b = a + 1; b < authors.length; b++) {
		if (root(a) === root(b)) continue;
		const x = authors[a][1]; const y = authors[b][1];
		if ([...x.tags].some(tag => y.tags.has(tag)) || x.shingles.some(s => y.shingles.some(t => trendSimilarText(s, t)))) parents[root(b)] = root(a);
	}
	const groups = new Map<number, string[]>();
	authors.forEach(([id], i) => { const key = root(i); const group = groups.get(key) ?? []; group.push(id); groups.set(key, group); });
	return [...groups.values()];
}

export function hanamiTrendEffectiveAuthors(notes: readonly TrendAuthorNote[], playTags = true): number {
	const groups = hanamiTrendAuthorGroups(notes, playTags);
	// Round once to tenths, avoiding 2.999999… at the three-author boundary.
	return Math.round(groups.reduce((sum, group) => sum + 1 + TREND_DUP_EXTRA_WEIGHT * (group.length - 1), 0) * 10) / 10;
}
