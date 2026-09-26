/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { ForYouCandidate, HanamiAxis, HanamiAxisLevel } from '@/core/hanami/HanamiForYouInterleave.js';
import type { HanamiPersonalFeedCandidate } from '@/core/hanami/HanamiUserFeedContracts.js';
import type { MiNote } from '@/models/Note.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { HanamiForYouService, type HanamiPersonalFeedGenerationContext } from '@/core/hanami/HanamiForYouService.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { HanamiPersistedFeedReadService } from '@/core/hanami/HanamiPersistedFeedReadService.js';
import { HanamiTimelinePageService } from '@/core/hanami/HanamiTimelinePageService.js';
import { HanamiTokenizerService } from '@/core/hanami/tokenize/HanamiTokenizerService.js';

beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-25T13:00:00Z')); });
afterEach(() => { jest.restoreAllMocks(); });

describe('trend token repair (2A)', () => {
	test.each([
		['シーシャ吸ってきた', ['シー'], ['シーシャ']],
		['キーホルダー作った', ['キー', 'ホルダー'], ['キーホルダー', 'ホルダー']],
		['絵チャしてきた', ['チャ'], []],
		['パンを食べた', ['パン'], []],
		['ロッテリア大好き', ['ロッテリア'], ['ロッテリア']],
		['リアクションありがとう', ['リア'], []],
		['リノートした', ['リノ'], []],
		['コメントした', ['コメ'], []],
		['プロフィールを更新', ['プロ'], []],
		['アカウントを作った', ['アカ'], []],
		['ーリアクションありがとう', ['リア'], []],
		['リアクションとリアリティ', ['リア'], ['リアリティ']],
		['ーシーシャとシーとシール', ['シー', 'シーシャ'], ['シーシャ', 'シール']],
		['シー' + 'シャ'.repeat(16), ['シー'], []],
	])('%s repairs only kind tokens, preserving plain tokenize', async (text, terms, expected) => {
		const service = new HanamiTokenizerService();
		const tokenizer = {
			tokenize: jest.fn(async () => terms),
			tokenizeWithKind: jest.fn(async () => terms.map(term => ({ term, proper: true }))),
		};
		Object.assign(service, { active: tokenizer });
		expect(await service.tokenize(text)).toEqual(terms);
		expect(await service.tokenizeWithKind(text)).toEqual(expected.map(term => ({ term, proper: true })));
		expect(await service.tokenize(text)).toEqual(terms);
	});
});

function memoryRedis() {
	const sets = new Map<string, Set<string>>();
	const sorted = new Map<string, Map<string, number>>();
	const strings = new Map<string, string>();
	const expiries = new Map<string, number>();
	const commands: [string, ...unknown[]][] = [];

	function pipeline() {
		const pending: (() => unknown)[] = [];
		const pipe: Record<string, unknown> = {};
		const handlers: Record<string, (...args: any[]) => unknown> = {
			sadd: (key: string, member: string) => {
				const set = sets.get(key) ?? new Set<string>();
				const added = set.has(member) ? 0 : 1;
				set.add(member); sets.set(key, set); return added;
			},
			scard: (key: string) => sets.get(key)?.size ?? 0,
			zcount: (key: string, min: number) => [...(sorted.get(key)?.values() ?? [])].filter(score => score >= min).length,
			expire: (key: string, ttl: number) => { expiries.set(key, ttl); return 1; },
			zincrby: (key: string, by: number, member: string) => {
				const set = sorted.get(key) ?? new Map<string, number>();
				set.set(member, (set.get(member) ?? 0) + by); sorted.set(key, set); return set.get(member);
			},
			zadd: (key: string, score: number, member: string) => {
				const set = sorted.get(key) ?? new Map<string, number>();
				set.set(member, score); sorted.set(key, set); return 1;
			},
			zremrangebyrank: () => 0,
			zremrangebyscore: (key: string, _min: string, max: string) => {
				for (const [member, score] of sorted.get(key) ?? []) if (score < Number(max.slice(1))) sorted.get(key)?.delete(member);
				return 0;
			},
			set: (key: string, value: string, mode?: string) => { if (mode !== 'NX' || !strings.has(key)) strings.set(key, value); return 'OK'; },
			zmscore: (key: string, ...members: string[]) => members.map(member => sorted.get(key)?.get(member)?.toString() ?? null),
			zrange: (key: string) => [...(sorted.get(key) ?? [])].flatMap(([member, score]) => [member, String(score)]),
			sunion: (...keys: string[]) => [...new Set(keys.flatMap(key => [...(sets.get(key) ?? [])]))],
			zrangebyscore: (key: string, min: number) => [...(sorted.get(key) ?? [])].filter(([, score]) => score >= min).map(([member]) => member),
		};
		for (const [name, handler] of Object.entries(handlers)) {
			pipe[name] = (...args: unknown[]) => { commands.push([name, ...args]); pending.push(() => handler(...args)); return pipe; };
		}
		pipe.exec = async () => pending.map(run => [null, run()]);
		return pipe;
	}

	return {
		sets, sorted, strings, expiries, commands, pipeline, multi: pipeline,
		get: async (key: string) => strings.get(key) ?? null,
		set: async (key: string, value: string) => { strings.set(key, value); return 'OK'; },
		smismember: async (key: string, ...members: string[]) => members.map(member => sets.get(key)?.has(member) ? 1 : 0),
		call: jest.fn(async (..._args: unknown[]) => 'OK'),
	};
}

describe('template suppression (2D)', () => {
	test('counts the first four authors only and bypasses short fingerprints', async () => {
		const redis = memoryRedis();
		const tokenizer = { tokenizeWithKind: jest.fn(async () => [{ term: '質問', proper: false }]) };
		const service = new HanamiTrendService(redis as never, {} as never, tokenizer as never, { query: async () => [] } as never);
		const at = Date.parse('2026-09-25T12:00:00Z');
		for (let i = 1; i <= 6; i++) {
			await service.indexNote({ id: `note-${i}`, userId: `user-${i}`, text: `質問募集中です！ 第${i % 2 ? i : '１２'}回 https://example.com/${i} @user${i}@host.example` } as MiNote, at);
		}
		expect(tokenizer.tokenizeWithKind).toHaveBeenCalledTimes(4);
		const rank = [...redis.sorted].find(([key]) => key.startsWith('hanami:trend:rank:'))?.[1];
		expect(rank?.get('質問')).toBe(4);
		for (let i = 7; i <= 12; i++) await service.indexNote({ id: `note-${i}`, userId: `user-${i}`, text: '短い本文' } as MiNote, at);
		expect(rank?.get('質問')).toBe(10);
		expect(tokenizer.tokenizeWithKind).toHaveBeenCalledTimes(10);
	});
});

describe('same-time baselines (2B)', () => {
	test.each([false, true])('day baseline suppresses ordinary nouns, proper=%s retains avg70', async (proper) => {
		const redis = memoryRedis();
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map([['note', 1]]) } as never, {} as never, { query: async () => [] } as never);
		const cw = Math.floor((Date.now() - Date.parse('2023-01-01T00:00:00Z')) / 900000);
		for (let i = 0; i < 8; i++) redis.sorted.set(`hanami:trend:rank:${cw - i}`, new Map([['学校', 4]]));
		for (const lag of [96, 192]) for (let w = cw - lag - 11; w <= cw - lag + 4; w++) redis.sorted.set(`hanami:trend:rank:${w}`, new Map([['学校', 4]]));
		redis.sorted.set('hanami:trend:authorsz:学校', new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
		redis.sets.set(`hanami:trend:as:${cw}:学校`, new Set(['a', 'b', 'c']));
		redis.sorted.set('hanami:trend:notes:学校', new Map([['note', Date.now()]]));
		if (proper) redis.sets.set('hanami:trend:proper', new Set(['学校']));
		await service.getTrendingTerms(30);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log.baseKind).toBe(proper ? 'avg70' : 'day');
		expect(log.base).toBeCloseTo(proper ? 128 / 280 : 4);
		if (proper) expect(log.spike).toBeGreaterThan(7);
		else expect(log.spike).toBeLessThanOrEqual(1);
	});

	test.each([false, true])('weekly baseline is gated by readiness=%s', async (ready) => {
		const redis = memoryRedis();
		const now = Date.now();
		const cw = Math.floor((now - Date.parse('2023-01-01T00:00:00Z')) / 900000);
		redis.strings.set('hanami:trend:hrank:since', String(now - (ready ? 171 : 169) * 3600000));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['飲み会', 32]]));
		for (let h = Math.floor((cw - 683) / 4); h <= Math.floor((cw - 668) / 4); h++) redis.sorted.set(`hanami:trend:hrank:${h}`, new Map([['飲み会', 16]]));
		redis.sorted.set('hanami:trend:authorsz:飲み会', new Map(['a', 'b', 'c'].map(id => [id, now])));
		redis.sets.set(`hanami:trend:as:${cw}:飲み会`, new Set(['a', 'b', 'c']));
		redis.sorted.set('hanami:trend:notes:飲み会', new Map([['note', now]]));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map([['note', 1]]) } as never, {} as never, { query: async () => [] } as never);
		await service.getTrendingTerms(30);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log.baseKind).toBe(ready ? 'dayWeek' : 'day');
		expect(log.spike).toBeCloseTo(ready ? 0.98 : 40);
	});

	test('hourly writes share quarter-hour author deduplication and expire after eight days', async () => {
		const redis = memoryRedis();
		const service = new HanamiTrendService(redis as never, {} as never, { tokenizeWithKind: async () => [{ term: '学校', proper: false }] } as never, { query: async () => [] } as never);
		const at = Date.parse('2026-09-25T12:00:00Z');
		for (const offset of [0, 1, 900000]) await service.indexNote({ id: String(offset), userId: 'a', text: '学校' } as MiNote, at + offset);
		const hourly = [...redis.sorted].find(([key]) => key.startsWith('hanami:trend:hrank:'))!;
		expect(hourly[1].get('学校')).toBe(2);
		expect(redis.expiries.get(hourly[0])).toBe(8 * 86400);
		expect(redis.commands).toContainEqual(['expire', hourly[0], 8 * 86400, 'NX']);
		expect(Number(redis.strings.get('hanami:trend:hrank:since'))).toBeGreaterThan(at);
	});
});

function personalSetup(level: HanamiAxisLevel = 'normal') {
	const service = new HanamiForYouService(...Array.from({ length: 13 }, () => ({})) as ConstructorParameters<typeof HanamiForYouService>);
	const affinity = jest.fn(async (_user: string, _run: string | null, candidates: ForYouCandidate[]) => candidates);
	const taste = jest.fn(async (_user: string, candidates: ForYouCandidate[]) => candidates);
	Object.assign(service, { applyAuthorAffinityRerank: affinity, applyTasteClusterOrdering: taste, hanamiTrendService: { countRecentTermAuthors: async () => new Map() } });
	const input = { userId: 'me', generatedAt: '2026-09-25T12:00:00Z', signal: new AbortController().signal, queryRunner: { query: jest.fn(async () => []) } } as unknown as HanamiPersonalFeedGenerationContext;
	const axes = new Map<HanamiAxis, HanamiAxisLevel>([['globalPopular', 'normal'], ['trending', level]]);
	const common: HanamiPersonalFeedCandidate[] = [
		{ noteId: 'shared', authorId: 'author', score: 1, axis: 'globalPopular', origin: 'commonCandidate' },
		{ noteId: 'shared', authorId: 'author', score: 1, axis: 'trending', origin: 'commonCandidate', term: 'topic' },
	];
	const gather = (items = common) => (service as unknown as {
		gatherGenerationCandidates: (input: HanamiPersonalFeedGenerationContext, confidence: string, run: null, axes: Map<HanamiAxis, HanamiAxisLevel>, candidates: HanamiPersonalFeedCandidate[]) => Promise<Map<HanamiAxis, ForYouCandidate[]>>;
	}).gatherGenerationCandidates(input, 'none', null, axes, items);
	return { service, affinity, taste, input, axes, common, gather };
}

describe('popular overlap (1A)', () => {
	test.each(['normal', 'off'] as const)('personal trending %s controls popular removal', async level => {
		const setup = personalSetup(level);
		const result = await setup.gather();
		expect(result.get('globalPopular')).toHaveLength(level === 'off' ? 1 : 0);
		if (level !== 'off') expect(result.get('trending')?.[0].noteId).toBe('shared');
	});
});

describe('recent connected authors (3B)', () => {
	test('counts distinct connected authors at the 24h boundary and excludes old or unrelated usage', async () => {
		const redis = memoryRedis();
		const now = Date.parse('2026-09-25T12:00:00Z');
		const service = new HanamiTrendService(redis as never, {} as never, { tokenizeWithKind: async () => [{ term: '話題', proper: false }] } as never, { query: async () => [] } as never);
		for (const [userId, at] of [['old', now - 25 * 3600000], ['edge', now - 24 * 3600000], ['friend', now], ['stranger', now]] as const) {
			await service.indexNote({ id: userId, userId, text: '話題' } as MiNote, at);
		}
		const result = await service.countRecentTermAuthors(['話題', 'なし'], ['friend', 'friend', 'edge', 'old'], now - 24 * 3600000);
		expect(result).toEqual(new Map([['話題', 2], ['なし', 0]]));
		expect(redis.sorted.get('hanami:trend:ra:話題')?.has('old')).toBe(false);
		expect(redis.expiries.get('hanami:trend:ra:話題')).toBe(26 * 3600);
		expect(await service.countRecentTermAuthors(['話題'], [], now)).toEqual(new Map([['話題', 0]]));
		expect(await service.countRecentTermAuthors([], ['friend'], now)).toEqual(new Map());
	});

	test('unions following and positive relations without self and puts social terms first', async () => {
		const setup = personalSetup();
		setup.input.queryRunner.query = jest.fn(async (sql: string) => sql.includes('FROM following') ? [{ id: 'friend' }, { id: 'me' }] : [{ id: 'friend' }, { id: 'relation' }]) as never;
		const count = jest.fn(async () => new Map([['social', 2]]));
		Object.assign(setup.service, { hanamiTrendService: { countRecentTermAuthors: count } });
		const result = await setup.gather([
			{ ...setup.common[1], noteId: 'ordinary', term: 'ordinary', score: 10 },
			{ ...setup.common[1], noteId: 'social', term: 'social', score: 1 },
		]);
		expect(count).toHaveBeenCalledWith(['ordinary', 'social'], ['friend', 'relation'], Date.parse(setup.input.generatedAt) - 86400000);
		expect(result.get('trending')?.map(c => [c.noteId, c.score, c.socialCount])).toEqual([['social', 1, 2], ['ordinary', 0.5, undefined]]);
		expect(setup.input.queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY following.id DESC'), ['me', 2000]);
		expect(setup.input.queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('"relScore" > 0'), ['me', 2000]);
	});

	test('caps the combined circle at 2000 distinct people', async () => {
		const setup = personalSetup();
		setup.input.queryRunner.query = jest.fn(async (sql: string) => sql.includes('FROM following') ? Array.from({ length: 1999 }, (_, i) => ({ id: `f-${i}` })) : [{ id: 'f-0' }, { id: 'r-1' }, { id: 'r-2' }]) as never;
		const count = jest.fn(async (_terms: readonly string[], users: readonly string[]) => { expect(users).toHaveLength(2000); expect(users.at(-1)).toBe('r-1'); return new Map(); });
		Object.assign(setup.service, { hanamiTrendService: { countRecentTermAuthors: count } });
		await setup.gather();
		expect(count).toHaveBeenCalledTimes(1);
	});
});

describe('personal trend ordering (3C)', () => {
	test.each([false, true])('affinity then taste runs independently per tier, no clusters=%s', async noClusters => {
		const setup = personalSetup();
		setup.axes.delete('globalPopular');
		Object.assign(setup.service, { hanamiTrendService: { countRecentTermAuthors: async () => new Map([['social', 1]]) } });
		setup.affinity.mockImplementation(async (_user, _run, candidates) => candidates.map(c => ({ ...c, score: c.score * 2 })));
		if (noClusters) {
			Object.assign(setup.service, { applyTasteClusterOrdering: HanamiForYouService.prototype['applyTasteClusterOrdering'] });
		} else {
			setup.taste.mockImplementation(async (_user, candidates) => [...candidates].reverse());
		}
		const result = await setup.gather([
			{ ...setup.common[1], noteId: 'ordinary', term: 'ordinary', score: 100 },
			{ ...setup.common[1], noteId: 's1', term: 'social', score: 1 },
			{ ...setup.common[1], noteId: 's2', term: 'social', score: 2 },
		]);
		expect(setup.affinity).toHaveBeenCalledTimes(2);
		expect(result.get('trending')?.map(c => c.noteId)).toEqual(['s2', 's1', 'ordinary']);
		expect(result.get('trending')?.map(c => c.score)).toEqual([1, 2 / 3, 1 / 3]);
		if (!noClusters) {
			expect(setup.taste).toHaveBeenCalledTimes(2);
			for (let i = 0; i < 2; i++) expect(setup.affinity.mock.invocationCallOrder[i]).toBeLessThan(setup.taste.mock.invocationCallOrder[i]);
			expect(setup.taste).toHaveBeenCalledWith('me', expect.any(Array), new Set(), new Set(), setup.input);
		}
	});
});

describe('persisted social reason', () => {
	const build = (socialCount: number) => HanamiForYouProvenanceService.prototype.buildReasonMetadata({ term: 'topic', socialCount });
	const read = (value: unknown) => new HanamiPersistedFeedReadService({} as never)['validateReasonMetadata'](value);
	test.each([1, 9999])('preserves count %i through metadata and page reasons', socialCount => {
		const metadata = read(build(socialCount));
		const note = {};
		const packed = [{ note, entry: { kind: 'personal', source: 'trending', reasonMetadata: metadata } }];
		HanamiTimelinePageService.prototype['markRecommendationReasons'](packed as never, true);
		expect(note).toEqual({ _hanamiReason: { reason: 'trending', term: 'topic', socialCount } });
	});
	test.each([0, -1, 10000, 1.5, NaN, Infinity, '2', null])('drops invalid count %s without dropping the note', socialCount => {
		const metadata = Object.freeze({ version: 1, term: 'topic', socialCount });
		expect(read(metadata)).toEqual({ version: 1, term: 'topic' });
		expect(build(socialCount as number)).toEqual({ version: 1, term: 'topic' });
	});
});

describe('spike ranking and rolling authors (addendum 2)', () => {
	test('rejects spike 1.9, uses spike before engagement and breaks ties by engagement then term', async () => {
		const redis = memoryRedis();
		const now = Date.now();
		const cw = Math.floor((now - Date.parse('2023-01-01T00:00:00Z')) / 900000);
		const terms = ['low', 'big', 'b', 'a', 'winner', 'boundary'];
		redis.sets.set('hanami:trend:proper', new Set(terms));
		// Proper-noun baseline: 322 / 280 + 0.1 = 1.25; spike = recent / 10.
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map(terms.map((term, i) => [term, [19, 25, 30, 30, 30, 20][i]])));
		redis.sorted.set(`hanami:trend:rank:${cw - 20}`, new Map(terms.map(term => [term, 322])));
		const scores = new Map<string, number>();
		for (const term of terms) {
			redis.sorted.set(`hanami:trend:authorsz:${term}`, new Map(['u1', 'u2', 'u3'].map(id => [id, now])));
			redis.sets.set(`hanami:trend:as:${cw}:${term}`, new Set(['u1', 'u2', 'u3']));
			redis.sorted.set(`hanami:trend:notes:${term}`, new Map([[term, now]]));
			scores.set(term, term === 'big' ? 10000 : term === 'winner' ? 20 : 1);
		}
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => scores } as never, {} as never, {} as never);
		const result = await service.getTrendingTerms(30);
		expect(result.map(term => [term.term, term.score])).toEqual([['winner', 3], ['a', 3], ['b', 3], ['big', 2.5], ['boundary', 2]]);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string) as { term: string; rejected: string }[];
		expect(log.find(term => term.term === 'low')?.rejected).toBe('lowSpike');
	});

	test('counts unique authors only within 72h, prunes old authors and never writes the old Set', async () => {
		const redis = memoryRedis();
		const now = Date.now();
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map([['fresh', 1]]) } as never, { tokenizeWithKind: async () => [{ term: '地震', proper: false }] } as never, {} as never);
		for (const [userId, at] of [['old', now - 73 * 3600000], ['edge', now - 72 * 3600000], ['a', now], ['a', now], ['b', now], ['c', now]] as const) {
			await service.indexNote({ id: 'fresh', userId, text: '地震' } as MiNote, at);
		}
		expect(redis.sorted.get('hanami:trend:authorsz:地震')?.has('old')).toBe(false);
		// Also verify read-time filtering when no subsequent write has pruned an expired member.
		redis.sorted.get('hanami:trend:authorsz:地震')?.set('unpruned-old', now - 73 * 3600000);
		expect((await service.getTrendingTerms(30))[0]?.distinctAuthors).toBe(4);
		expect(redis.commands.some(([, key]) => String(key).startsWith('hanami:trend:authors:'))).toBe(false);
		expect(redis.expiries.get('hanami:trend:authorsz:地震')).toBe(74 * 3600);
	});
});
