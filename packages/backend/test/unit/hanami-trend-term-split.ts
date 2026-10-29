/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { centerTrendEmbeddings, nameTrendContentTopic, splitTrendTermTopics, trendPeakShare, trendQuantile, trendTermsShareGroup, trendTopicCenter } from '@/core/hanami/HanamiTrendTermSplit.js';
import type { TrendCenteredVectors, TrendTermTopic } from '@/core/hanami/HanamiTrendTermSplit.js';

const MINUTE = 60000;
const NOW = 6 * 60 * MINUTE;
type Note = Parameters<HanamiTrendService['recountTopic']>[1][number];

function note(id: string, createdAt = NOW): Note {
	return { id, userId: id, text: '', createdAt, terms: [], replyId: null, renoteId: null, embeddingIndex: null };
}

function topic(terms: string[], noteIds: string[], origin: 'term' | 'content' = 'term'): TrendTermTopic {
	return { origin, terms, noteIds, authors6h: noteIds.length, authors2h: noteIds.length, center: null };
}

function service() { return new HanamiTrendService({} as never, {} as never, {} as never, {} as never); }

function sample() {
	const notes = Array.from({ length: 6 }, (_, i) => note(String(i)));
	const terms = new Map(notes.map((n, i) => [n.id, [i < 3 ? 'a' : 'b']]));
	const vectors = new Map(notes.map((n, i) => [n.id, i < 3 ? [1, 0, 0] : [0, 1, 0]]));
	return { notes, terms, vectors };
}

function split(data: ReturnType<typeof sample>, raw = [topic(['a', 'b'], data.notes.map(n => n.id))], vectors: TrendCenteredVectors | null = data.vectors) {
	return splitTrendTermTopics(raw, new Map(data.notes.map(n => [n.id, n])), data.terms, vectors, t => service()['recountTopic'](t, data.notes, NOW), 3);
}

afterEach(() => vi.unstubAllEnvs());

describe('term similarity and onset', () => {
	test('peak share uses a closed 30 minute window without changing input order', () => {
		const times = [60 * MINUTE, 30 * MINUTE, 0, 30 * MINUTE + 1];
		expect(trendPeakShare(times)).toBe(0.75);
		expect(trendPeakShare([0, 30 * MINUTE])).toBe(1);
		expect(trendPeakShare([0, 30 * MINUTE + 1])).toBe(0.5);
		expect(trendPeakShare([])).toBe(0);
		expect(times[0]).toBe(60 * MINUTE);
	});
	test('25th percentile uses linear interpolation', () => {
		expect(trendQuantile([40, 10, 30, 20])).toBe(17.5);
		expect(trendQuantile([10, 20])).toBe(12.5);
		expect(trendQuantile([17])).toBe(17);
	});
	test.each([
		[0.6, 0, 0, 0, true], [0.599, 0, 0, 0, false],
		[0.3, 0.5, 0.5, 20 * MINUTE, true], [0.3, 0.5, 0.5, 20 * MINUTE + 1, false],
		[0.3, 0.49, 0.5, 20 * MINUTE, false], [0.3, 0.5, 0.49, 20 * MINUTE, false],
		[0.299, 0.5, 0.5, 20 * MINUTE, false],
	])('cos=%s, peaks=%s/%s, gap=%s => %s', (cos, a, b, gap, expected) => {
		expect(trendTermsShareGroup(cos, { peakShare: a, q25: 0 }, { peakShare: b, q25: gap })).toBe(expected);
	});
	test('centers subtract the mean, normalize, and ignore missing embeddings', () => {
		const binary = Buffer.alloc(4 * 4);
		[4, 6, 1, 2].forEach((value, i) => binary.writeFloatLE(value, i * 4));
		const vectors = centerTrendEmbeddings([{ noteId: 'a' }, { noteId: 'zero' }], binary, 2, [1, 2]);
		expect(Array.from(vectors.get('a')!)).toEqual([0.6, 0.8]);
		expect(Array.from(vectors.get('zero')!)).toEqual([0, 0]);
		expect(trendTopicCenter(['missing', 'a'], vectors)).toEqual([0.6, 0.8]);
		expect(trendTopicCenter(['missing'], vectors)).toBeNull();
	});
	test('R2: only centers requested rows, caches them, and does not read missing IDs', () => {
		const binary = Buffer.alloc(4 * 4);
		[4, 6, 1, 2].forEach((value, i) => binary.writeFloatLE(value, i * 4));
		const read = vi.spyOn(binary, 'readFloatLE');
		const rows = [{ noteId: 'a' }, { noteId: 'zero' }];
		const vectors = centerTrendEmbeddings(rows, binary, 2, [1, 2]);
		expect(read).not.toHaveBeenCalled();
		expect(vectors.get('missing')).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
		const zero = vectors.get('zero');
		expect(Array.from(zero!)).toEqual([0, 0]);
		expect(read).toHaveBeenCalledTimes(2);
		expect(vectors.get('zero')).toBe(zero);
		expect(vectors.get('missing')).toBeUndefined();
		expect(read).toHaveBeenCalledTimes(2);
		const a = vectors.get('a');
		expect(Array.from(a!)).toEqual([0.6, 0.8]);
		expect(read).toHaveBeenCalledTimes(4);
		expect(vectors.get('a')).toBe(a);
		expect(read).toHaveBeenCalledTimes(4);
		const next = centerTrendEmbeddings(rows, binary, 2, [1, 2]);
		expect(next.get('a')).not.toBe(a);
		expect(read).toHaveBeenCalledTimes(6);
	});
});

describe('term topic splitting', () => {
	test('assigns own terms even against similarity and attaches unowned notes only at 0.3 or above', () => {
		const data = sample();
		for (const [id, terms, vector] of [
			['own', ['a'], [-1, 0, 0]], ['edge', [], [0.3, 0, Math.sqrt(1 - 0.3 ** 2)]],
			['below', [], [0.299, 0, Math.sqrt(1 - 0.299 ** 2)]],
		] as const) {
			data.notes.push(note(id)); data.terms.set(id, [...terms]); data.vectors.set(id, [...vector]);
		}
		const result = split(data);
		expect(result.topics.map(t => t.noteIds)).toEqual([['0', '1', '2', 'own', 'edge'], ['3', '4', '5']]);
		expect(result.splits).toEqual([{ terms: ['a', 'b'], groups: [{ terms: ['a'], noteCount: 5 }, { terms: ['b'], noteCount: 3 }] }]);
	});
	test('chooses the closest owned group, resolving equal similarities by group order', () => {
		const data = sample(); data.notes.push(note('both'));
		for (const n of data.notes.slice(0, 3)) n.createdAt = NOW - 60 * MINUTE;
		data.terms.set('both', ['b', 'a']); data.vectors.set('both', [0, 0, 1]);
		expect(split(data).topics[0].noteIds.at(-1)).toBe('both');
		data.vectors.set('both', [0, 1, 0]);
		expect(split(data).topics[1].noteIds.at(-1)).toBe('both');
	});
	test('missing embeddings use the first owned group or the first group', () => {
		const data = sample();
		for (const [id, terms] of [['own', ['b']], ['both', ['b', 'a']], ['none', []]] as const) {
			data.notes.push(note(id)); data.terms.set(id, [...terms]);
		}
		const result = split(data).topics;
		expect(result[0].noteIds).toEqual(['0', '1', '2', 'both', 'none']);
		expect(result[1].noteIds).toEqual(['3', '4', '5', 'own']);
	});
	test.each([
		{ terms: ['a', 'b', 'pending'], groups: [['a', 'pending'], ['b']], firstIds: ['0', '1', '2', 'new'], center: [1, 0, 0] },
		{ terms: ['pending', 'b', 'a'], groups: [['pending', 'b'], ['a']], firstIds: ['3', '4', '5', 'new'], center: [0, 1, 0] },
	])('R2: keeps a null-center term with the first comparable term: $terms', ({ terms, groups, firstIds, center }) => {
		const data = sample(); data.notes.push(note('new')); data.terms.set('new', ['pending']);
		const result = split(data, [topic(terms, data.notes.map(n => n.id))]);
		expect(result.topics.map(t => t.terms)).toEqual(groups);
		expect(result.topics[0].noteIds).toEqual(firstIds);
		expect(result.topics[0].center).toEqual(center);
		expect(result.topics[0].authors6h).toBe(4);
		expect(result.splits).toHaveLength(1);
	});
	test.each([0, 1])('R2: leaves the topic untouched with %s comparable terms', count => {
		const data = sample();
		for (const n of data.notes.slice(count * 3)) data.vectors.delete(n.id);
		const original = topic(['b', 'a'], data.notes.map(n => n.id));
		const result = split(data, [original]);
		expect(result.topics).toHaveLength(1);
		expect(result.topics[0]).toBe(original);
		expect(result.splits).toEqual([]);
	});
	test('preserves topic, group, term and note order; removes absent terms only when split', () => {
		const data = sample(); data.terms.get('0')!.push('c');
		const first = topic(['untouched'], []); const last = topic(['content'], [], 'content');
		const middle = topic(['absent', 'b', 'a', 'c'], ['5', '2', '4', '0', '3', '1']);
		const result = split(data, [first, middle, last]).topics;
		expect(result.map(t => t.terms)).toEqual([['untouched'], ['b'], ['a', 'c'], ['content']]);
		expect(result[1].noteIds).toEqual(['5', '4', '3']);
		expect(result[2].noteIds).toEqual(['2', '0', '1']);
	});
	test('unions terms transitively', () => {
		const data = sample(); data.notes.push(note('bridge'));
		data.terms.set('bridge', ['c']); data.vectors.set('bridge', [Math.SQRT1_2, Math.SQRT1_2, 0]);
		const original = topic(['a', 'b', 'c', 'absent'], data.notes.map(n => n.id));
		expect(split(data, [original]).topics[0]).toBe(original);
	});
	test('recounts effective authors in both windows, dropping groups below three', () => {
		const data = sample();
		data.notes[0].createdAt = NOW - 2 * 60 * MINUTE - 1;
		data.notes[1].createdAt = NOW - 2 * 60 * MINUTE;
		data.notes[4].userId = data.notes[3].userId;
		const result = split(data).topics;
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ terms: ['a'], authors6h: 3, authors2h: 2, center: [1, 0, 0] });
		data.notes[1].userId = data.notes[0].userId;
		expect(split(data).topics).toEqual([]);
	});
	test('filters on effective authors rather than raw authors', () => {
		const data = sample();
		for (const n of data.notes.slice(0, 3)) n.text = '同じ文章を繰り返している投稿';
		expect(split(data).topics.map(t => t.terms)).toEqual([['b']]);
	});
	test('leaves single terms, content topics, and fewer than two present terms untouched', () => {
		const data = sample();
		const raw = [topic(['a'], ['0', '1', '2']), topic(['a', 'b'], ['0', '3'], 'content'), topic(['a', 'absent'], ['0', '1', '2']), topic(['missing', 'absent'], [])];
		const result = split(data, raw);
		result.topics.forEach((t, i) => expect(t).toBe(raw[i]));
		expect(result.splits).toEqual([]);
	});
	test('without meanVec, splitting and its log data are skipped', () => {
		const data = sample(); const raw = [topic(['a', 'b'], data.notes.map(n => n.id))];
		const result = split(data, raw, null);
		expect(result.topics[0]).toBe(raw[0]); expect(result.splits).toEqual([]);
	});
});

describe('content names', () => {
	function naming(cos = 0.5) {
		const notes = Array.from({ length: 20 }, (_, i) => note(String(i)));
		const terms = new Map(notes.map((n, i) => [n.id, [...(i < 5 ? ['name'] : []), ...(i < 4 ? ['related'] : []), ...(i < 3 ? ['small'] : []), '#tag']]));
		const y = Math.sqrt(1 - cos ** 2);
		const vectors = new Map(notes.map((n, i) => [n.id, [cos, i < 10 ? y : -y]]));
		const name = (v: TrendCenteredVectors | null = vectors, scores = new Map<string, number>()) => nameTrendContentTopic(notes.map(n => n.id), new Map(notes.map(n => [n.id, n])), terms, v, scores);
		return { notes, terms, vectors, name };
	}

	test('includes name share 0.25, cosine 0.5 and related share 0.2', () => {
		expect(naming().name()).toEqual(['name', 'related']); expect(naming(0.499).name()).toEqual([]);
	});
	test('returns no terms without a name and counts users rather than posts', () => {
		const data = naming(); data.notes[4].userId = data.notes[0].userId;
		expect(data.name()).toEqual([]);
	});
	test('requires two users even when one user satisfies the fraction', () => {
		const notes = [note('a'), note('b'), note('c')];
		expect(nameTrendContentTopic(['a', 'b', 'c'], new Map(notes.map(n => [n.id, n])), new Map([['a', ['name']]]), null, new Map())).toEqual([]);
	});
	test('orders by users, score and term, limiting related terms to five', () => {
		const data = naming();
		for (let i = 0; i < 5; i++) data.terms.set(String(i), ['d', 'b', 'a', 'c', 'f', 'e', 'g']);
		expect(data.name(undefined, new Map([['g', 100]]))).toEqual(['g', 'a', 'b', 'c', 'd', 'e']);
	});
	test('meanVec absence skips cosine but retains both share thresholds', () => {
		expect(naming(0.1).name(null)).toEqual(['name', 'related']);
		const data = naming(); data.terms.set('4', []); expect(data.name(null)).toEqual([]);
	});
	test('a popular but unrelated term cannot name the topic', () => {
		const data = naming();
		for (let i = 0; i < 5; i++) data.vectors.set(String(i), [-1, 0]);
		for (let i = 5; i < 20; i++) data.vectors.set(String(i), [1, 0]);
		expect(data.name()).toEqual([]);
	});
});

describe('service integration', () => {
	test.each([true, false])('buildTopics retains vectors for this computation only; meanVec present=%s', async present => {
		const dir = mkdtempSync(join(tmpdir(), 'hanami-term-split-test-'));
		const script = join(dir, 'topics.cjs');
		const notes = Array.from({ length: 8 }, (_, i) => ({ ...note(String(i)), text: i < 2 ? 'name' : '' }));
		const raw = topic([], notes.map(n => n.id), 'content');
		writeFileSync(script, `require('node:fs').writeFileSync(process.argv[4], ${JSON.stringify(JSON.stringify({ topics: [raw] }))});`);
		vi.stubEnv('HANAMI_FORYOU_PYTHON', process.execPath);
		vi.stubEnv('HANAMI_TREND_TOPICS_SCRIPT', script);
		const s = new HanamiTrendService({} as never, {} as never,
			{ tokenizeWithKind: async (text: string) => text ? [{ term: text, proper: false }] : [] } as never,
			{ query: async () => present ? [{ meanVec: [1, 0] }] : [] } as never);
		const embeddings = Buffer.alloc(notes.length * 2 * 4);
		for (let i = 0; i < notes.length; i++) embeddings.writeFloatLE(2, i * 2 * 4);
		Object.defineProperty(s, 'loadTopicEmbeddings', { value: async () => ({ rows: notes.map(n => ({ noteId: n.id })), embeddings, dim: 2, baselineDays: [] }) });
		const warn = vi.spyOn(s['logger'], 'warn').mockImplementation(() => {});
		const context: NonNullable<Parameters<HanamiTrendService['buildTopics']>[4]> = { noteTerms: new Map(), vectors: null };
		try {
			const result = await s['buildTopics']([], notes, [], NOW, context);
			expect(result[0].terms).toEqual(['name']);
			expect(context.noteTerms.size).toBe(8);
			if (present) {
				expect(trendTopicCenter(result[0].noteIds, context.vectors!)).toEqual([1, 0]);
				expect(warn).not.toHaveBeenCalled();
			} else {
				expect(context.vectors).toBeNull();
				expect(warn).toHaveBeenCalledExactlyOnceWith('hanami trend term split', { meanVec: null });
			}
			// A Python failure must not leave vectors enabled for the one-term fallback.
			writeFileSync(script, 'process.exit(1);');
			for (const n of notes) n.terms = ['fallback'];
			const fallback = await s['buildTopics']([{ term: 'fallback', score: 1, proper: false, distinctAuthors: 8 }], notes, [], NOW, context);
			expect(context.vectors).toBeNull();
			expect(fallback).toHaveLength(1);
			expect(fallback[0]).toMatchObject({ origin: 'term', terms: ['fallback'], center: null });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test.each([true, false])('compute splits merged terms before assigning IDs only with meanVec: %s', async present => {
		const data = sample();
		for (const n of data.notes) n.text = n.id;
		const s = new HanamiTrendService({ get: async () => null } as never, {} as never,
			{ tokenizeWithKind: async (text: string) => (data.terms.get(text) ?? []).map(term => ({ term, proper: false })) } as never, {} as never);
		Object.defineProperty(s, 'getTrendingTermCandidatesWithCache', { value: async () => [] });
		Object.defineProperty(s, 'collectTopicInput', { value: async () => ({ notes: data.notes, parents: [] }) });
		Object.defineProperty(s, 'buildTopics', { value: async (...args: Parameters<HanamiTrendService['buildTopics']>) => {
			args[4]!.vectors = present ? data.vectors : null;
			return [topic(['a'], ['0', '1', '2']), topic(['b'], ['3', '4', '5']), topic([], ['0', '3'], 'content'), topic([], [], 'content')];
		} });
		const stop = new Error('captured topics before ID assignment');
		const assign = vi.fn(() => { throw stop; });
		Object.defineProperty(s, 'assignTopicIds', { value: assign });
		const log = vi.spyOn(s['logger'], 'info').mockImplementation(() => {});
		await expect(s.computeTrendBundle(new Map())).rejects.toBe(stop);
		const raw = (assign.mock.calls as unknown as [TrendTermTopic[]][])[0][0];
		expect(raw.map(t => t.terms)).toEqual(present ? [['a'], ['b']] : [['a', 'b']]);
		if (present) expect(log).toHaveBeenCalledExactlyOnceWith('hanami trend term split', { topics: [{ terms: ['a', 'b'], groups: [{ terms: ['a'], noteCount: 3 }, { terms: ['b'], noteCount: 3 }] }] });
		else expect(log).not.toHaveBeenCalled();
	});

	test('recomputes merged centers before matching the next content topic', () => {
		const notes = [note('a'), note('b'), note('c'), note('d')];
		const vectors = new Map([['a', [1, 0]], ['b', [0, 1]], ['c', [0, 1]], ['d', [0, 1]]]);
		const raw = [topic(['a'], ['a']), topic([], ['a', 'b', 'c'], 'content'), topic(['later'], ['d'], 'content')];
		for (const t of raw) t.center = trendTopicCenter(t.noteIds, vectors);
		const merged = service()['mergeContentTopics'](raw, notes, NOW, vectors);
		expect(merged).toHaveLength(1); expect(merged[0].noteIds).toEqual(['a', 'b', 'c', 'd']);
		expect(merged[0].center).toEqual(trendTopicCenter(['a', 'b', 'c', 'd'], vectors));
		const withoutMean = service()['mergeContentTopics'](raw, notes, NOW);
		expect(withoutMean).toHaveLength(2); expect(withoutMean[0].center).toEqual([1, 0]);
	});
	test('shares the index extraction rule and caches each note once per computation', async () => {
		const tokens = [{ term: '#tag', proper: true }, { term: 'first', proper: true }, { term: 'first', proper: false },
			...Array.from({ length: 20 }, (_, i) => ({ term: 'word' + i, proper: false }))];
		const tokenizeWithKind = vi.fn(async () => tokens);
		const s = new HanamiTrendService({} as never, {} as never, { tokenizeWithKind } as never, {} as never);
		expect(await s['trendNoteTerms']('text')).toEqual([tokens[1], ...tokens.slice(3, 18)]);
		tokenizeWithKind.mockClear();
		const notes = [note('a'), note('b')]; const cache = new Map<string, string[]>();
		await s['cacheTrendNoteTerms']([topic([], ['a'], 'content')], notes, cache);
		await s['cacheTrendNoteTerms']([topic(['a', 'b'], ['a', 'b'])], notes, cache);
		expect(tokenizeWithKind).toHaveBeenCalledTimes(2);
		expect(cache.get('a')).toEqual(['first', ...Array.from({ length: 15 }, (_, i) => 'word' + i)]);
		await s['cacheTrendNoteTerms']([topic([], ['a'])], notes, new Map());
		expect(tokenizeWithKind).toHaveBeenCalledTimes(3);
	});
});
