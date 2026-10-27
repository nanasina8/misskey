/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, vi as jest, test } from 'vitest';
import type { ForYouCandidate, HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
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
			tokenize: jest.fn(async (..._args: unknown[]) => terms),
			tokenizeWithKind: jest.fn(async (..._args: unknown[]) => terms.map(term => ({ term, proper: true }))),
		};
		Object.assign(service, { active: tokenizer });
		expect(await service.tokenize(text)).toEqual(terms);
		expect(await service.tokenizeWithKind(text)).toEqual(expected.map(term => ({ term, proper: true })));
		expect(await service.tokenize(text)).toEqual(terms);
	});
});

export function memoryRedis() {
	const sets = new Map<string, Set<string>>();
	const sorted = new Map<string, Map<string, number>>();
	const strings = new Map<string, string>();
	const expiries = new Map<string, number>();
	const commands: [string, ...unknown[]][] = [];

	function pipeline() {
		const pending: (() => unknown)[] = [];
		const pipe: Record<string, unknown> = {};
		const handlers: Record<string, (...args: any[]) => unknown> = {
			del: (key: string) => { sets.delete(key); strings.delete(key); return 1; },
			sadd: (key: string, ...members: string[]) => {
				let result = 0;
				for (const member of members) {
					const set = sets.get(key) ?? new Set<string>();
					const added = set.has(member) ? 0 : 1;
					set.add(member); sets.set(key, set); result += added;
				}
				return result;
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
			zrange: (key: string, start: number, stop: number) => [...(sorted.get(key) ?? [])].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(start, stop + 1).flatMap(([member, score]) => [member, String(score)]),
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
		smembers: async (key: string) => [...(sets.get(key) ?? [])],
		get: async (key: string) => strings.get(key) ?? null,
		set: async (key: string, value: string) => { strings.set(key, value); return 'OK'; },
		smismember: async (key: string, ...members: string[]) => members.map(member => sets.get(key)?.has(member) ? 1 : 0),
		call: jest.fn(async (..._args: unknown[]) => 'OK'),
	};
}

describe('template suppression (2D)', () => {
	test('counts the first four authors only and bypasses short fingerprints', async () => {
		const redis = memoryRedis();
		const tokenizer = { tokenizeWithKind: jest.fn(async (..._args: unknown[]) => [{ term: '質問', proper: false }]) };
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

describe('V-18: hashtag trend terms', () => {
	test('indexes tags even without tokenizer terms, including every time/author/note key and the proper flag', async () => {
		const redis = memoryRedis();
		const service = new HanamiTrendService(redis as never, {} as never, { tokenizeWithKind: async () => [] } as never, {} as never);
		const at = Date.now();
		await service.indexNote({ id: 'tag-note', userId: 'author', text: '#災害', tags: ['災害'] } as MiNote, at);
		expect(redis.sets.get('hanami:trend:proper')?.has('#災害')).toBe(true);
		for (const prefix of ['hanami:trend:rank:', 'hanami:trend:hrank:']) {
			expect([...redis.sorted].find(([key]) => key.startsWith(prefix))?.[1].get('#災害')).toBe(1);
		}
		for (const key of ['hanami:trend:authorsz:#災害', 'hanami:trend:ra:#災害']) expect(redis.sorted.get(key)?.get('author')).toBe(at);
		expect(redis.sorted.get('hanami:trend:notes:#災害')?.get('tag-note')).toBe(at);
		expect([...redis.sets].some(([key, authors]) => key.startsWith('hanami:trend:as:') && key.endsWith(':#災害') && authors.has('author'))).toBe(true);
	});
	test('deduplicates tags, prioritizes them, and shares the sixteen-term limit with tokenizer terms', async () => {
		const redis = memoryRedis();
		const service = new HanamiTrendService(redis as never, {} as never, { tokenizeWithKind: async () => Array.from({ length: 20 }, (_, i) => ({ term: 'word' + i, proper: false })) } as never, {} as never);
		await service.indexNote({ id: 'many', userId: 'author', text: '短文', tags: ['first', 'first', ...Array.from({ length: 13 }, (_, i) => 'tag' + i)] } as MiNote);
		const ranked = [...redis.sorted].find(([key]) => key.startsWith('hanami:trend:rank:'))![1];
		expect(ranked.size).toBe(16);
		expect(ranked.get('#first')).toBe(1);
		expect(ranked.has('#tag12')).toBe(true);
		expect(ranked.has('word1')).toBe(true);
		expect(ranked.has('word2')).toBe(false);
	});
});

describe('same-time baselines (2B)', () => {
	test.each([false, true])('seven hourly days use the median for proper=%s', async proper => {
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - Date.parse('2023-01-01T00:00:00Z')) / 900000);
		redis.strings.set('hanami:trend:hrank:since', String(Date.now() - 8 * 86400000));
		for (let d = 1; d <= 7; d++) for (let h = Math.floor((cw - d * 96 - 11) / 4); h <= Math.floor((cw - d * 96 + 4) / 4); h++) redis.sorted.set(`hanami:trend:hrank:${h}`, new Map([['学校', 4 * (d === 1 ? 20 : 1)]]));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['学校', 40]]));
		redis.sorted.set('hanami:trend:authorsz:学校', new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
		redis.sets.set(`hanami:trend:as:${cw}:学校`, new Set(['a', 'b', 'c']));
		if (proper) redis.sets.set('hanami:trend:proper', new Set(['学校']));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		expect(await service.getTrendingTerms(30)).toHaveLength(1);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log).toMatchObject({ baseKind: 'median7', baseDays: 7, base: 1 });
		expect(log.spike).toBeGreaterThan(2);
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

function personalSetup(amount = 1) {
	const service = new HanamiForYouService(...Array.from({ length: 13 }, () => ({})) as ConstructorParameters<typeof HanamiForYouService>);
	const affinity = jest.fn(async (_user: string, _run: string | null, candidates: ForYouCandidate[]) => candidates);
	const taste = jest.fn(async (_user: string, candidates: ForYouCandidate[], ..._args: unknown[]) => candidates);
	Object.assign(service, { applyAuthorAffinityRerank: affinity, applyTasteClusterOrdering: taste, hanamiTrendService: { countRecentTermAuthors: async () => new Map() } });
	const input = { userId: 'me', generatedAt: '2026-09-25T12:00:00Z', signal: new AbortController().signal, queryRunner: { query: jest.fn(async (..._args: unknown[]) => []) } } as unknown as HanamiPersonalFeedGenerationContext;
	const axes = new Map<HanamiAxis, number>([['globalPopular', 1], ['trending', amount]]);
	const common: HanamiPersonalFeedCandidate[] = [
		{ noteId: 'shared', authorId: 'author', score: 1, axis: 'globalPopular', origin: 'commonCandidate' },
		{ noteId: 'shared', authorId: 'author', score: 1, axis: 'trending', origin: 'commonCandidate', term: 'topic' },
	];
	const gather = (items = common) => (service as unknown as {
		gatherGenerationCandidates: (input: HanamiPersonalFeedGenerationContext, confidence: string, run: null, axes: Map<HanamiAxis, number>, candidates: HanamiPersonalFeedCandidate[]) => Promise<Map<HanamiAxis, ForYouCandidate[]>>;
	}).gatherGenerationCandidates(input, 'none', null, axes, items);
	return { service, affinity, taste, input, axes, common, gather };
}

describe('popular overlap (1A)', () => {
	test.each([1, 0])('personal trending amount %i controls popular removal', async amount => {
		const setup = personalSetup(amount);
		const result = await setup.gather();
		expect(result.get('globalPopular')).toHaveLength(amount === 0 ? 1 : 0);
		if (amount !== 0) expect(result.get('trending')?.[0].noteId).toBe('shared');
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
		const count = jest.fn(async (..._args: unknown[]) => new Map([['social', 2]]));
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
		redis.sorted.set(`hanami:trend:rank:${cw - 30}`, new Map(terms.map(term => [term, 322])));
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

describe('median coverage and active-term hysteresis (U-1, U-2)', () => {
	test.each([0, 3, 4])('uses %i available days and averages the middle two when even', async days => {
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - Date.parse('2023-01-01T00:00:00Z')) / 900000);
		const epoch = Date.parse('2023-01-01T00:00:00Z');
		if (days > 0) redis.strings.set('hanami:trend:hrank:since', String(epoch + Math.floor((cw - days * 96 - 11) / 4) * 3600000));
		for (let d = 1; d <= days; d++) for (let h = Math.floor((cw - d * 96 - 11) / 4); h <= Math.floor((cw - d * 96 + 4) / 4); h++) redis.sorted.set(`hanami:trend:hrank:${h}`, new Map([['語', 4 * d]]));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['語', 80]]));
		redis.sorted.set(`hanami:trend:rank:${cw - 30}`, new Map([['語', 280]]));
		redis.sorted.set('hanami:trend:authorsz:語', new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
		redis.sets.set(`hanami:trend:as:${cw}:語`, new Set(['a', 'b', 'c']));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		await service.getTrendingTerms(30);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log).toMatchObject({ baseDays: days, baseKind: days ? 'median7' : 'avg72', base: days === 0 ? 1 : days === 3 ? 2 : 2.5 });
	});
	test.each([false, true])('six-hour stay requires adoption in the preceding computation: %s', async adopted => {
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - Date.parse('2023-01-01T00:00:00Z')) / 900000);
		redis.strings.set('hanami:trend:hrank:since', String(Date.now() - 8 * 86400000));
		for (let d = 1; d <= 7; d++) for (let h = Math.floor((cw - d * 96 - 27) / 4); h <= Math.floor((cw - d * 96 + 4) / 4); h++) redis.sorted.set(`hanami:trend:hrank:${h}`, new Map([['語', 4]]));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['語', 8]]));
		redis.sorted.set(`hanami:trend:rank:${cw - 10}`, new Map([['語', 32]]));
		redis.sorted.set('hanami:trend:authorsz:語', new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
		redis.sets.set(`hanami:trend:as:${cw - 10}:語`, new Set(['a', 'b', 'c']));
		if (adopted) redis.sets.set('hanami:trend:active', new Set(['語']));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		expect(await service.getTrendingTerms(30)).toHaveLength(adopted ? 1 : 0);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log.stay).toBe(adopted);
		expect(log.spike6h).toBeGreaterThanOrEqual(1.3);
		const before = redis.commands.length;
		await service.getTrendingTerms(30);
		expect(redis.commands).toHaveLength(before);
		expect([...redis.sets.get('hanami:trend:active') ?? []]).toEqual(adopted ? ['語'] : []);
		if (adopted) expect(redis.expiries.get('hanami:trend:active')).toBe(3600);
	});
});

describe('reviewed term command boundaries (U-14, U-15, U-16)', () => {
	const epoch = Date.parse('2023-01-01T00:00:00Z');
	test('U-14: replenishes active counts outside each top 201, without counting visible windows twice', async () => {
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - epoch) / 900000);
		redis.sets.set('hanami:trend:active', new Set(['active']));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['active', 1]]));
		for (let i = 8; i < 24; i++) redis.sorted.set(`hanami:trend:rank:${cw - i}`, new Map([...Array.from({ length: 201 }, (_, j) => [`filler-${j}`, 100] as [string, number]), ['active', 1]]));
		redis.sorted.set('hanami:trend:authorsz:active', new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
		redis.sets.set(`hanami:trend:as:${cw - 8}:active`, new Set(['a', 'b', 'c']));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		expect((await service.getTrendingTerms(30)).map(term => term.term)).toEqual(['active']);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log).toMatchObject({ term: 'active', stay: true, recentCount: 1 });
		expect(log.spike6h).toBeCloseTo(17 / 24 / 0.1);
		const commands = redis.commands.filter(([name, key]) => name === 'zmscore' && String(key).startsWith('hanami:trend:rank:'));
		expect(commands).toHaveLength(23);
		expect(commands).not.toContainEqual(['zmscore', `hanami:trend:rank:${cw}`, 'active']);
		expect(commands).toContainEqual(['zmscore', `hanami:trend:rank:${cw - 8}`, 'active']);
	});
	test.each(['09:00', '09:10'])('U-15: compares the actual hourly start against since=%s', async start => {
		jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-25T12:00:00Z'));
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - epoch) / 900000);
		redis.strings.set('hanami:trend:hrank:since', String(Date.parse(`2026-09-24T${start}:00Z`)));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['語', 40]]));
		redis.sorted.set('hanami:trend:authorsz:語', new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
		redis.sets.set(`hanami:trend:as:${cw}:語`, new Set(['a', 'b', 'c']));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		await service.getTrendingTerms(30);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string)[0];
		expect(log.baseDays).toBe(start === '09:00' ? 1 : 0);
		const firstHour = Math.floor((cw - 96 - 11) / 4);
		expect(redis.commands.some(([name, key]) => name === 'zmscore' && key === `hanami:trend:hrank:${firstHour}`)).toBe(start === '09:00');
	});
	test('U-16: skips low-count new terms and unions 24 windows only for failed active entrants', async () => {
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - epoch) / 900000);
		redis.strings.set('hanami:trend:hrank:since', String(Date.now() - 8 * 86400000));
		redis.sets.set('hanami:trend:active', new Set(['active', 'entrant']));
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map([['low-one', 1], ['low-two', 2], ['entrant', 40], ['active', 1]]));
		for (const term of ['low-one', 'low-two', 'entrant', 'active']) {
			redis.sorted.set(`hanami:trend:authorsz:${term}`, new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
			redis.sets.set(`hanami:trend:as:${cw}:${term}`, new Set(['a', 'b', 'c']));
		}
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		await service.getTrendingTerms(30);
		const unions = redis.commands.filter(([name]) => name === 'sunion');
		expect(unions).toHaveLength(3);
		expect(unions.filter(command => command.length === 25)).toEqual([['sunion', ...Array.from({ length: 24 }, (_, i) => `hanami:trend:as:${cw - i}:active`)]]);
		expect(unions.some(command => command.slice(1).some(key => String(key).endsWith(':low-one') || String(key).endsWith(':low-two')))).toBe(false);
		const hourly = redis.commands.filter(([name, key]) => name === 'zmscore' && String(key).startsWith('hanami:trend:hrank:'));
		expect(hourly).toHaveLength(98);
		expect(hourly.every(command => command.length === 4 && command.includes('active') && command.includes('entrant'))).toBe(true);
	});
	test('F1: logs the highest fifty scores, then engagement and lexical ties', async () => {
		const redis = memoryRedis();
		const cw = Math.floor((Date.now() - epoch) / 900000);
		const terms = Array.from({ length: 60 }, (_, i) => `term-${String(i).padStart(2, '0')}`);
		redis.sorted.set(`hanami:trend:rank:${cw}`, new Map(terms.map((term, i) => [term, 10 + i])));
		for (const term of terms) {
			redis.sorted.set(`hanami:trend:authorsz:${term}`, new Map(['a', 'b', 'c'].map(id => [id, Date.now()])));
			redis.sets.set(`hanami:trend:as:${cw}:${term}`, new Set(['a', 'b', 'c']));
		}
		// The strongest total spans earlier windows; it is not first in the current-window results.
		redis.sorted.set(`hanami:trend:rank:${cw - 1}`, new Map([['term-00', 1000]]));
		for (const term of ['term-01', 'term-02', 'term-03']) redis.sorted.set(`hanami:trend:rank:${cw - 1}`, new Map([...(redis.sorted.get(`hanami:trend:rank:${cw - 1}`) ?? []), [term, 100 - (10 + Number(term.slice(-2)))]]));
		redis.sorted.set('hanami:trend:notes:term-03', new Map([['popular', Date.now()]]));
		const service = new HanamiTrendService(redis as never, { getGlobalNotesScoresWithCache: async () => new Map([['popular', 1]]) } as never, {} as never, {} as never);
		await service.getTrendingTerms(30);
		const log = JSON.parse(redis.call.mock.calls[0][9] as string) as { term: string; score: number }[];
		expect(log).toHaveLength(50);
		expect(log.slice(0, 4).map(term => term.term)).toEqual(['term-00', 'term-03', 'term-01', 'term-02']);
		expect(log.every((term, i) => i === 0 || log[i - 1].score >= term.score)).toBe(true);
	});
});
