/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import Logger from '@/logger.js';
import { TASTE_EMBED_MODEL } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

type TermCandidate = {
	term: string;
	score: number;
	distinctAuthors: number;
	proper: boolean;
};

function redisForTermNotes(rawByTerm: ReadonlyMap<string, string[]>) {
	const zrangeTerms: string[] = [];
	const pipeline = jest.fn(() => {
		const requests: { term: string; options: (string | number)[] }[] = [];
		const pipe = {
			zrange: jest.fn((key: string, ...options: (string | number)[]) => {
				const term = key.slice('hanami:trend:notes:'.length);
				requests.push({ term, options });
				if (!options.includes('BYSCORE')) zrangeTerms.push(term);
				return pipe;
			}),
			exec: jest.fn(async () => requests.map(({ term, options }) => {
				const raw = rawByTerm.get(term) ?? [];
				if (!options.includes('BYSCORE')) return [null, raw] as const;
				const ids: string[] = [];
				for (let i = 0; i < raw.length; i += 2) {
					if (Number(raw[i + 1]) <= Number(options[0]) && Number(raw[i + 1]) >= Number(options[1])) ids.push(raw[i]);
				}
				return [null, ids.slice(0, Number(options[6]))] as const;
			})),
		};
		return pipe;
	});
	return {
		redis: {
			pipeline,
			get: jest.fn(async () => null),
			set: jest.fn(async () => 'OK'),
		},
		pipeline,
		zrangeTerms,
	};
}

function stubTermCandidates(service: HanamiTrendService, candidates: readonly TermCandidate[]) {
	const fn = jest.fn(async (_featuredScores?: ReadonlyMap<string, number>) => candidates);
	Object.defineProperty(service, 'getTrendingTermCandidatesWithCache', {
		value: fn,
		configurable: true,
		writable: true,
	});
	return fn;
}

afterEach(() => {
	jest.restoreAllMocks();
});

describe('HanamiTrendService coherent materialization', () => {
	test('popular head notes remain eligible with 200-note headroom', async () => {
		const now = Date.now();
		const scores = new Map([['popular-top', 1000], ['fresh', 1], ['old', 1], ['unreacted', 0]]);
		const { redis } = redisForTermNotes(new Map([['topic', ['fresh', String(now), 'old', String(now - 86400000), 'unreacted', String(now), 'popular-top', String(now - 3600000)]]]));
		const service = new HanamiTrendService(redis as never, {} as never, {} as never, { query: async () => [] } as never);
		stubTermCandidates(service, [{ term: 'topic', score: 1, distinctAuthors: 3, proper: false }]);
		const bundle = await service.computeTrendBundle(scores);
		expect(bundle.terms[0].representativeNoteIds).toEqual(['popular-top', 'fresh', 'old']);
		expect(bundle.noteCandidates[0]).toEqual({ noteId: 'popular-top', term: 'topic' });
		const pipe = redis.pipeline.mock.results[0].value as ReturnType<typeof redis.pipeline>;
		expect(pipe.zrange).toHaveBeenCalledWith('hanami:trend:notes:topic', 0, 199, 'REV', 'WITHSCORES');
	});

	test('one invocation exposes ranked headroom for top-30 snapshots and the top-30 common pool', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const termCandidates: TermCandidate[] = Array.from({ length: 35 }, (_, index) => ({
			term: `term-${index}`,
			score: 1000 - index,
			distinctAuthors: 40 - index,
			proper: false,
		}));
		const scores = new Map<string, number>();
		for (let index = 0; index < 100; index++) scores.set(`popular-${index}`, 1000 - index);
		const rawByTerm = new Map<string, string[]>();
		for (let termIndex = 0; termIndex < 30; termIndex++) {
			const ids = termIndex < 8
				? ['shared-note', ...Array.from({ length: 29 }, (_, index) => `term-${termIndex}-note-${index}`)]
				: Array.from({ length: 6 }, (_, index) => `term-${termIndex}-note-${index}`);
			const raw: string[] = [];
			for (let rank = 0; rank < ids.length; rank++) {
				raw.push(ids[rank], String(NOW - rank));
				scores.set(ids[rank], 1);
			}
			rawByTerm.set(`term-${termIndex}`, raw);
		}
		const { redis, pipeline, zrangeTerms } = redisForTermNotes(rawByTerm);
		const featuredService = { getGlobalNotesScoresWithCache: jest.fn(async () => new Map<string, number>()) };
		const service = new HanamiTrendService(redis as never, featuredService as never, {} as never, { query: async () => [] } as never);
		const aggregate = stubTermCandidates(service, termCandidates);

		const result = await service.computeTrendBundle(scores);

		expect(aggregate).toHaveBeenCalledTimes(1);
		expect(aggregate).toHaveBeenCalledWith(scores);
		expect(featuredService.getGlobalNotesScoresWithCache).not.toHaveBeenCalled();
		expect(pipeline).toHaveBeenCalledTimes(2);
		expect(zrangeTerms).toHaveLength(30);
		expect(result.computedAt).toBe('2026-08-20T12:00:00.000Z');
		expect(result.terms).toHaveLength(30);
		expect(result.terms.slice(0, 8).every(term => term.representativeNoteIds.length === 30)).toBe(true);
		expect(result.terms.slice(8).every(term => term.representativeNoteIds.length === 6)).toBe(true);
		expect(result.terms[0].representativeNoteIds.slice(0, 6)).toEqual([
			'shared-note',
			'term-0-note-0',
			'term-0-note-1',
			'term-0-note-2',
			'term-0-note-3',
			'term-0-note-4',
		]);
		expect(result.noteCandidates).toHaveLength(365);
		expect(new Set(result.noteCandidates.map(candidate => candidate.noteId)).size).toBe(365);
		expect(result.noteCandidates.filter(candidate => candidate.noteId === 'shared-note')).toHaveLength(1);
		expect(result.noteCandidates.every(candidate => Number(candidate.term.slice('term-'.length)) < 30)).toBe(true);
	});

	test('legacy term and Note methods retain limits and delegate Note generation to the coherent bundle', async () => {
		const { redis } = redisForTermNotes(new Map());
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: jest.fn() } as never, {} as never, { query: async () => [] } as never);
		stubTermCandidates(service, Array.from({ length: 12 }, (_, index) => ({
			term: `legacy-${index}`,
			score: 12 - index,
			distinctAuthors: index + 3,
			proper: index % 2 === 0,
		})));
		const noteCandidates = Array.from({ length: 205 }, (_, index) => ({
			noteId: `legacy-note-${index}`,
			term: `legacy-${index % 8}`,
		}));
		const compute = jest.fn(async () => ({
			computedAt: '2026-08-20T00:00:00.000Z',
			terms: [],
			noteCandidates,
		}));
		Object.defineProperty(service, 'computeTrendBundle', {
			value: compute,
			configurable: true,
			writable: true,
		});

		expect(await service.getTrendingTerms(8)).toHaveLength(8);
		const legacyNotes = await service.getTrendingNoteIds(500);
		expect(legacyNotes).toHaveLength(200);
		expect(legacyNotes[0]).toEqual({ noteId: 'legacy-note-0', term: 'legacy-0' });
		expect(compute).toHaveBeenCalledTimes(1);
		expect(redis.set).toHaveBeenCalledWith(
			'hanami:trend:noteIds',
			JSON.stringify(noteCandidates.slice(0, 200)),
			'EX',
			30,
		);
	});
});

function clusteredFixture(vectors: readonly (readonly number[])[], options: { mean?: number[] | null; singleEmbedding?: number; fail?: 'embedding' | 'mean'; invalid?: boolean } = {}) {
	const mean = options.mean === undefined ? [10, 20] : options.mean;
	const shift = mean ?? [0, 0];
	const raw = new Map<string, string[]>();
	const scores = new Map<string, number>();
	const rows: { noteId: string; embedding: number[] }[] = [];
	const terms: TermCandidate[] = [];
	vectors.forEach((vector, index) => {
		const term = `topic-${index}`;
		terms.push({ term, score: 10 - index, distinctAuthors: 3 + index, proper: false });
		raw.set(term, [`${term}-0`, String(NOW), `${term}-1`, String(NOW - 1000)]);
		for (let note = 0; note < 2; note++) {
			scores.set(`${term}-${note}`, 10 * (index + 1) - note);
			if (options.singleEmbedding === index && note === 1) continue;
			rows.push({ noteId: `${term}-${note}`, embedding: vector.map((value, dim) => shift[dim] + value * (note + 1)) });
		}
	});
	if (options.invalid) rows[0].embedding = [NaN, 0];
	const { redis, pipeline } = redisForTermNotes(raw);
	const query = jest.fn(async (sql: string, _params: unknown[]) => {
		const embedding = sql.includes('hanami_note_embedding');
		if (options.fail === (embedding ? 'embedding' : 'mean')) throw new Error('database unavailable');
		return embedding ? rows : mean == null ? [] : [{ meanVec: mean }];
	});
	const service = new HanamiTrendService(redis as never, {} as never, {} as never, { query } as never);
	stubTermCandidates(service, terms);
	return { service, scores, query, pipeline, raw, rows, terms };
}

describe('trend topic clusters (addendum 2)', () => {
	test.each([0.5, 0.4])('cosine %s controls merging and uses the head term in snapshot and feed', async cosine => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const info = jest.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
		const fixture = clusteredFixture([[1, 0], [cosine, Math.sqrt(1 - cosine * cosine)]]);
		const bundle = await fixture.service.computeTrendBundle(fixture.scores);
		expect(bundle.terms.map(term => term.term)).toEqual(cosine === 0.5 ? ['topic-0'] : ['topic-0', 'topic-1']);
		expect([...new Set(bundle.noteCandidates.map(note => note.term))]).toEqual(bundle.terms.map(term => term.term));
		expect(bundle.terms[0]).toMatchObject({ score: 10, distinctAuthors: 3 });
		expect(fixture.query).toHaveBeenCalledTimes(2);
		expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining('"noteId" = ANY($2)'), [TASTE_EMBED_MODEL, ['topic-0-0', 'topic-0-1', 'topic-1-0', 'topic-1-1']]);
		const pipe = fixture.pipeline.mock.results[0].value as ReturnType<typeof fixture.pipeline>;
		expect(pipe.zrange).toHaveBeenCalledWith('hanami:trend:notes:topic-0', NOW, NOW - 6 * 3600000, 'BYSCORE', 'REV', 'LIMIT', 0, 30);
		if (cosine === 0.5) expect(info).toHaveBeenCalledWith('hanami trend cluster: topic-0 <- topic-1');
		else expect(info).not.toHaveBeenCalled();
		// The legacy term endpoint does not cluster.
		expect(await fixture.service.getTrendingTerms(30)).toHaveLength(2);
	});

	test('merges member note pools by engagement times freshness and round-robins clusters', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const fixture = clusteredFixture([[1, 0], [0.5, Math.sqrt(0.75)], [-1, 0]]);
		fixture.raw.get('topic-1')?.push('topic-0-0', String(NOW));
		fixture.raw.get('topic-1')?.push('old-popular', String(NOW - 24 * 3600000));
		fixture.scores.set('old-popular', 30); // 30 * 1/4 < head note's 10.
		const bundle = await fixture.service.computeTrendBundle(fixture.scores);
		expect(bundle.terms[0].representativeNoteIds).toEqual(['topic-1-0', 'topic-1-1', 'topic-0-0', 'topic-0-1', 'old-popular']);
		expect(bundle.noteCandidates.map(note => [note.noteId, note.term])).toEqual([
			['topic-1-0', 'topic-0'], ['topic-2-0', 'topic-2'],
			['topic-1-1', 'topic-0'], ['topic-2-1', 'topic-2'],
			['topic-0-0', 'topic-0'], ['topic-0-1', 'topic-0'], ['old-popular', 'topic-0'],
		]);
	});

	test('one usable embedding or a zero vector leaves a term isolated', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const fixture = clusteredFixture([[1, 0], [1, 0], [0, 0]], { singleEmbedding: 1 });
		const bundle = await fixture.service.computeTrendBundle(fixture.scores);
		expect(bundle.terms.map(term => term.term)).toEqual(['topic-0', 'topic-1', 'topic-2']);
	});

	test('falls back to the fetched embedding mean when taste state is absent', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const fixture = clusteredFixture([[1, 0], [0.5, Math.sqrt(0.75)], [-1.5, -Math.sqrt(0.75)]], { mean: null });
		const bundle = await fixture.service.computeTrendBundle(fixture.scores);
		expect(bundle.terms.map(term => term.term)).toEqual(['topic-0', 'topic-2']);
	});

	test('compares only cluster heads and picks the closest eligible head', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const chained = clusteredFixture([[1, 0], [0.5, Math.sqrt(0.75)], [-0.5, Math.sqrt(0.75)]]);
		expect((await chained.service.computeTrendBundle(chained.scores)).terms.map(term => term.term)).toEqual(['topic-0', 'topic-2']);
		const closest = clusteredFixture([[1, 0], [0, 1], [0.5, Math.sqrt(0.75)]]);
		const bundle = await closest.service.computeTrendBundle(closest.scores);
		expect(bundle.terms[0].representativeNoteIds).not.toContain('topic-2-0');
		expect(bundle.terms[1].representativeNoteIds).toContain('topic-2-0');
	});

	test.each(['embedding', 'mean', 'invalid'] as const)('continues with singleton clusters on %s failure', async failure => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		const fixture = clusteredFixture([[1, 0], [1, 0]], failure === 'invalid' ? { invalid: true } : { fail: failure });
		const bundle = await fixture.service.computeTrendBundle(fixture.scores);
		expect(bundle.terms.map(term => term.term)).toEqual(['topic-0', 'topic-1']);
		expect(bundle.noteCandidates).toHaveLength(4);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test('limits clustering input to 60 terms before reserving proper noun heads', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const fixture = clusteredFixture(Array.from({ length: 61 }, () => [1, 0]));
		fixture.rows.length = 0;
		fixture.terms.forEach((term, i) => { term.proper = i >= 48; });
		const bundle = await fixture.service.computeTrendBundle(fixture.scores);
		const pipe = fixture.pipeline.mock.results[0].value as ReturnType<typeof fixture.pipeline>;
		expect(pipe.zrange).toHaveBeenCalledTimes(60);
		expect(bundle.terms).toHaveLength(30);
		expect(bundle.terms.filter(term => Number(term.term.slice(6)) >= 48)).toHaveLength(12);
		expect(bundle.terms.some(term => term.term === 'topic-60')).toBe(false);
	});
});
