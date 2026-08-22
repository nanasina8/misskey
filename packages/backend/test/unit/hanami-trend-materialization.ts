/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
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
		const terms: string[] = [];
		const pipe = {
			zrange: jest.fn((key: string) => {
				const term = key.slice('hanami:trend:notes:'.length);
				terms.push(term);
				zrangeTerms.push(term);
				return pipe;
			}),
			exec: jest.fn(async () => terms.map(term => [null, rawByTerm.get(term) ?? []] as [null, string[]])),
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
	test('one invocation exposes ranked headroom for top-30 snapshots and the top-eight common pool', async () => {
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
		const service = new HanamiTrendService(redis as never, featuredService as never, {} as never);
		const aggregate = stubTermCandidates(service, termCandidates);

		const result = await service.computeTrendBundle(scores);

		expect(aggregate).toHaveBeenCalledTimes(1);
		expect(aggregate).toHaveBeenCalledWith(scores);
		expect(featuredService.getGlobalNotesScoresWithCache).not.toHaveBeenCalled();
		expect(pipeline).toHaveBeenCalledTimes(1);
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
		expect(result.noteCandidates).toHaveLength(233);
		expect(new Set(result.noteCandidates.map(candidate => candidate.noteId)).size).toBe(233);
		expect(result.noteCandidates.filter(candidate => candidate.noteId === 'shared-note')).toHaveLength(1);
		expect(result.noteCandidates.every(candidate => Number(candidate.term.slice('term-'.length)) < 8)).toBe(true);
	});

	test('legacy term and Note methods retain limits and delegate Note generation to the coherent bundle', async () => {
		const { redis } = redisForTermNotes(new Map());
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: jest.fn() } as never, {} as never);
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
