/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, vi as jest, test } from 'vitest';
import Logger from '@/logger.js';
import { HanamiTrendService, trendDailyKey, trendSameKey, trendSameSetKey, trendTopicTagGame, trendTitleKey } from '@/core/hanami/HanamiTrendService.js';

import { HanamiCommonComputationService, type HanamiTrendSnapshotTerm } from '@/core/hanami/HanamiCommonComputationService.js';
import { HanamiCommonGenerationService } from '@/core/hanami/HanamiCommonGenerationService.js';
import type { HanamiCommonComputationPort, HanamiCommonSourceBundle } from '@/core/hanami/HanamiCommonGenerationContracts.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
type Note = { id: string; userId: string; text: string; replyId: string | null; renoteId: string | null; at: number; terms: string[]; tags?: string[] };

function fixture(notes: Note[], options: { python?: boolean; candidates?: string[] } = {}) {
	const strings = new Map<string, string>();
	const sets = new Map<string, Set<string>>();
	const terms = options.candidates ?? [...new Set(notes.flatMap(note => note.terms))];
	const pipeline = jest.fn(() => {
		const requests: (() => unknown)[] = [];
		const pipe = {
			zrange: jest.fn((key: string, ..._args: unknown[]) => { requests.push(() => notes.filter(note => note.terms.includes(key.slice('hanami:trend:notes:'.length))).sort((a, b) => b.at - a.at).flatMap(note => [note.id, String(note.at)])); return pipe; }),
			smembers: jest.fn((key: string) => { requests.push(() => [...(sets.get(key) ?? [])]); return pipe; }),
			exec: async () => requests.map(run => [null, run()]),
		};
		return pipe;
	});
	const redis = {
		pipeline, get: jest.fn(async (key: string) => strings.get(key) ?? null),
		mget: jest.fn(async (...keys: string[]) => keys.map(key => strings.get(key) ?? null)),
		set: jest.fn(async (key: string, value: string, ..._args: unknown[]) => { strings.set(key, value); return 'OK'; }),
		eval: jest.fn(async (_lua: string, _count: number, key: string, computedAt: number, payload: string, _ttl: number) => {
			const previous = strings.get(key);
			if (previous != null && JSON.parse(previous).computedAt >= computedAt) return 0;
			strings.set(key, payload); return 1;
		}),
	};
	const db = { query: jest.fn(async (sql: string, values: unknown[]) => sql.includes('FROM note') ? notes.filter(note => (values[0] as string[]).includes(note.id)) : []) };
	let serial = 0;
	const ids = { gen: (at?: number) => at === undefined ? `topic-${++serial}` : `bound-${at}`, parse: (id: string) => ({ date: new Date(notes.find(note => note.id === id)!.at) }) };
	const service = new HanamiTrendService(redis as never, {} as never, {} as never, db as never, ids as never);
	Object.defineProperty(service, 'getTrendingTermCandidatesWithCache', { value: jest.fn(async () => terms.map((term, i) => ({ term, score: 10 - i, distinctAuthors: 3, proper: false }))) });
	if (!options.python) Object.defineProperty(service, 'buildTopics', { value: jest.fn(async () => terms.map(term => {
		const members = notes.filter(note => note.terms.includes(term));
		return { terms: [term], noteIds: members.map(note => note.id), authors6h: new Set(members.map(note => note.userId)).size, authors2h: new Set(members.filter(note => note.at >= NOW - 2 * 3600000).map(note => note.userId)).size, center: null };
	})) });
	return { service, redis, strings, sets, db, pipeline };
}

function notesFor(term: string, count = 3): Note[] {
	return Array.from({ length: count }, (_, i) => ({ id: `${term}-${i}`, userId: `${term}-user-${i}`, text: 'https://example.com/' + term, replyId: null, renoteId: null, at: NOW - i * 1000, terms: [term] }));
}

afterEach(() => { jest.restoreAllMocks(); delete process.env.HANAMI_TREND_TOPICS_SCRIPT; });

test.each([false, true, 'hidden'])('V-1 / V-14 / U-24: publishes representatives and optional topic members atomically (members=%s)', async membersEnabled => {
	jest.spyOn(Date, 'now').mockReturnValue(NOW);
	const timestamp = new Date(NOW).toISOString();
	const representativeIds = Array.from({ length: 20 }, (_, i) => `note-${i}`);
	const memberIds = Array.from({ length: 500 }, (_, i) => 'member-' + i);
	const topicTerms: HanamiTrendSnapshotTerm[] = Array.from({ length: membersEnabled ? 30 : 1 }, (_, i) => ({
		term: 'topic-' + i, score: 1, distinctAuthors: 20, representativeNoteIds: membersEnabled === 'hidden' && i === 0 ? [] : representativeIds,
		...(membersEnabled ? { topicId: 'topic-' + i, recentAuthors: 7, topicNoteIds: memberIds } : {}),
	}));
	const source: HanamiCommonSourceBundle = {
		version: 1, capturedAt: timestamp,
		sourceAsOf: { version: 1, capturedAt: timestamp, featuredAt: timestamp, trendAt: timestamp, axisConfigAt: timestamp },
		enabledAxes: ['trending'],
		candidates: { globalPopular: [], exploration: [], trending: [{ noteId: 'note-0', authorId: 'author-0', baseScore: 1, metadata: { term: 'topic' } }] },
		trendSnapshot: { terms: topicTerms },
	};
	const computation: HanamiCommonComputationPort = {
		algorithmVersion: 'unit-v1', buildSourceBundle: async () => source,
		materializeFeed: () => ({ items: [{ noteId: 'note-0', authorId: 'author-0', source: 'trending', sources: ['trending'] }], segmentLengths: [1] }),
	};
	let phaseIndex = 0;
	let leaseOwner: unknown;
	const inserted: unknown[][] = [];
	const memberInserts: unknown[][] = [];
	const entryInserts: unknown[][] = [];
	const createQueryRunner = jest.fn(() => {
		const phase = phaseIndex++;
		const runner = {
			isTransactionActive: false,
			connect: async () => undefined,
			startTransaction: async () => { runner.isTransactionActive = true; },
			commitTransaction: async () => { runner.isTransactionActive = false; },
			rollbackTransaction: async () => { runner.isTransactionActive = false; },
			release: async () => undefined,
			query: async (sql: string, values: unknown[] = []): Promise<unknown[]> => {
				if (sql.includes('pg_catalog.clock_timestamp() +')) return [{ deadline_at: new Date(NOW + 60000).toISOString() }];
				if (sql.includes("set_config('statement_timeout'")) return [{}];
				if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) return [{
					epoch_id: null, latest_sequence: '0', earliest_retained_sequence: '0', latest_ready_generation_id: null,
					generating_generation_id: 'generation', generation_lease_owner: phase === 0 ? null : leaseOwner,
					generation_lease_expires_at: phase === 0 ? null : new Date(NOW + 120000),
					generation_fence: phase === 0 ? '0' : '1', lease_is_live: phase !== 0,
				}];
				if (sql.includes('FROM "hanami_common_generation" g') && sql.includes('FOR UPDATE')) return [{ status: phase === 0 ? 'pending' : 'generating', ordinal: '1', started_at: timestamp, generation_fence: phase === 0 ? '0' : '1' }];
				if (sql.includes('SET "generationFence" = "generationFence" +')) {
					leaseOwner = values[2];
					return [{ generation_fence: '1', epoch_id: null }];
				}
				if (sql.includes('SET "status" = \'generating\'')) return [{ started_at: timestamp, generation_fence: '1' }];
				if (sql.includes('SET "sourceAsOf"')) return [{ generation_fence: '1' }];
				if (sql.includes('SET "generationLeaseExpiresAt"') && sql.includes('clock_timestamp() < $6::timestamptz')) return [{ generation_fence: '1' }];
				if (sql.includes('FROM "hanami_trend_snapshot" t') && sql.includes('FOR UPDATE')) return [{ status: 'pending' }];
				if (sql.includes('AS shape_is_valid')) return [{ shape_is_valid: true, lost_ordinal: false }];
				if (sql.includes('AS counts_match')) return [{ counts_match: true }];
				if (sql.includes('INSERT INTO "hanami_trend_snapshot_representative_note"')) inserted.push(values);
				if (sql.includes('INSERT INTO "hanami_trend_snapshot_entry"')) entryInserts.push(values);
				if (sql.includes('INSERT INTO "hanami_trend_topic_note"')) {
					expect(runner.isTransactionActive).toBe(true);
					expect(sql).toContain('ON CONFLICT ("topicId", "noteId") DO NOTHING');
					expect(sql).not.toContain('note."replyId" IS NULL');
					expect(sql).not.toMatch(/visibility|isSuspended|isBot/);
					memberInserts.push(values);
				}
				if (sql.includes('SET "status" = \'ready\', "itemCount"')) return [{ ordinal: '1' }];
				if (sql.includes('SET "status" = \'ready\', "checksum"')) return [{ generation_fence: '1' }];
				if (sql.includes('SET "status" = \'failed\'')) return [{ generation_fence: '1', ordinal: '1' }];
				if (sql.includes('SET "generatingGenerationId" = NULL')) return [{ generation_fence: '1' }];
				if (sql.includes('SET "epochId" = COALESCE')) return [{ latest_sequence: '1', earliest_retained_sequence: '1' }];
				return [];
			},
		};
		return runner;
	});
	let serial = 0;
	const service = new HanamiCommonGenerationService(
		{ createQueryRunner, query: async () => [] } as never,
		{ hanamiCommonGenerationIntervalMs: 600000, hanamiGenerationWorkerTimeoutMs: 60000, hanamiGenerationLeaseMs: 75000 } as never,
		{ gen: () => `generated-${++serial}`, parse: (id: string) => ({ date: new Date(NOW - Number(id.slice('member-'.length)) * 1000) }) } as never,
		{ ensureMonthAvailable: async () => undefined } as never,
		{ filterCommonEligibleNotes: async (ids: string[]) => new Map(ids.map(id => [id, `author-${id.slice('note-'.length)}`])) } as never,
		computation,
	);
	await expect(service.runCommonGeneration('generation')).resolves.toMatchObject({ kind: 'published', itemCount: 1 });
	const eligible = jest.spyOn(computation, 'buildSourceBundle');

	expect(inserted).toEqual([['2026-10-01', 'generation', topicTerms.flatMap((term, rank) => term.representativeNoteIds.map(() => String(rank))), topicTerms.flatMap(term => term.representativeNoteIds.map((_, position) => position)), topicTerms.flatMap(term => term.representativeNoteIds)]]);
	expect(JSON.parse(entryInserts[0][6] as string).map((term: { recentAuthors: number }) => term.recentAuthors)).toEqual(topicTerms.map(() => membersEnabled ? 7 : 0));
	expect(memberInserts).toEqual(membersEnabled ? [[topicTerms.flatMap(term => Array(500).fill(term.topicId)), topicTerms.flatMap(() => memberIds), topicTerms.flatMap(() => memberIds.map((_, i) => new Date(NOW - i * 1000).toISOString())), timestamp]] : []);
	eligible.mockResolvedValue({ ...source, trendSnapshot: { terms: [{ ...source.trendSnapshot.terms[0], representativeNoteIds: [...representativeIds, 'note-20'] }] } });
	phaseIndex = 0;
	await expect(service.runCommonGeneration('generation')).rejects.toThrow('representative Note limit of 20 exceeded');
	expect(inserted).toHaveLength(1);
});

test('V-19: merged member IDs include replies in popularity/freshness order and cap at 500', async () => {
	jest.spyOn(Date, 'now').mockReturnValue(NOW);
	const notes = [...notesFor('a', 510), ...notesFor('b', 4)];
	notes[0].replyId = 'parent';
	const setup = fixture(notes);
	setup.strings.set(trendSameKey('topic-1', 'topic-2'), '1');
	setup.sets.set(trendSameSetKey('topic-1'), new Set(['topic-2']));
	const result = await setup.service.computeTrendBundle(new Map([['a-0', 999], ['a-509', 100], ['b-3', 200]]));
	expect(result.terms).toHaveLength(1);
	expect(result.terms[0]).toMatchObject({ topicId: 'topic-1', recentAuthors: 514 });
	expect(result.terms[0].topicNoteIds).toHaveLength(500);
	expect(result.terms[0].topicNoteIds?.slice(0, 2)).toEqual(['a-0', 'b-3']);
	expect(result.terms[0].representativeNoteIds).not.toContain('a-0');
	expect(new Set(result.terms[0].topicNoteIds).size).toBe(500);
});

describe('topic materialization (U-4, U-5, U-6, U-7)', () => {
	test('broken Python path falls back to one topic per term and keeps zero engagement', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		process.env.HANAMI_TREND_TOPICS_SCRIPT = '/missing/hanami-topic-script.py';
		const setup = fixture([...notesFor('a'), ...notesFor('b')], { python: true });
		const bundle = await setup.service.computeTrendBundle(new Map());
		expect(bundle.terms.map(t => t.term)).toEqual(['a', 'b']);
		expect(bundle.terms.every(t => t.representativeNoteIds.length === 3)).toBe(true);
		expect(bundle.noteCandidates.map(n => n.noteId)).toEqual(['a-0', 'b-0', 'a-1', 'b-1', 'a-2', 'b-2']);
		expect(Logger.prototype.warn).toHaveBeenCalled();
	});
	test('inherits IDs by greatest Jaccard once, preserves start, then uses the heading fallback', async () => {
		const setup = fixture([]);
		const assign = setup.service['assignTopicIds'].bind(setup.service);
		const raw = (terms: string[], noteIds: string[]) => ({ terms, noteIds, authors6h: 3, authors2h: 3, center: null });
		const previous = [{ ...raw(['old'], ['1', '2', '3', '4']), topicId: 'old-id', startedAt: '2026-10-05T00:00:00Z', daily: false }];
		const result = assign([raw(['low'], ['1', '2', '5', '6']), raw(['high'], ['1', '2', '3'])], previous, NOW);
		expect(result[1]).toMatchObject({ topicId: 'old-id', startedAt: previous[0].startedAt });
		expect(result[0].topicId).not.toBe('old-id');
		expect(new Set(result.map(t => t.topicId)).size).toBe(2);
		expect(assign([raw(['old'], ['different'])], previous, NOW)[0].topicId).toBe('old-id');
		expect(assign([raw(['changed'], ['1'])], previous, NOW)[0].topicId).toBe('old-id');
	});
	test('keeps replies as members while excluding them from twenty representatives and feed candidates', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const notes = [...notesFor('a', 25), ...notesFor('reply')];
		notes[0].replyId = 'parent';
		for (const note of notes.filter(n => n.terms[0] === 'reply')) note.replyId = 'parent';
		const setup = fixture(notes);
		const bundle = await setup.service.computeTrendBundle(new Map([['a-3', 0.98]]));
		expect(bundle.terms).toHaveLength(2);
		expect(bundle.terms[1]).toMatchObject({ representativeNoteIds: [], topicNoteIds: ['reply-0', 'reply-1', 'reply-2'] });
		expect(bundle.terms[0].representativeNoteIds).toEqual(['a-3', 'a-1', 'a-2', ...Array.from({ length: 17 }, (_, i) => `a-${i + 4}`)]);
		expect(bundle.noteCandidates).toHaveLength(20);
		expect(bundle.noteCandidates.map(n => n.noteId)).not.toContain('a-0');
		expect((setup.pipeline.mock.results[0].value as ReturnType<typeof setup.pipeline>).zrange).toHaveBeenCalledWith('hanami:trend:notes:a', NOW, NOW - 6 * 3600000, 'BYSCORE', 'REV', 'LIMIT', 0, 200, 'WITHSCORES');
	});
	test('cached same verdict merges author unions and cached daily verdict reduces ranking by 0.3', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const notes = [...notesFor('a', 6), ...notesFor('b'), ...notesFor('c')];
		notes[6].userId = notes[0].userId;
		const setup = fixture(notes);
		setup.sets.set(trendSameSetKey('topic-1'), new Set(['topic-2']));
		setup.sets.set(trendSameSetKey('topic-2'), new Set(['topic-1']));
		setup.strings.set(trendSameKey('topic-1', 'topic-2'), '1');
		setup.strings.set(trendDailyKey('topic-1'), '1');
		const bundle = await setup.service.computeTrendBundle(new Map());
		expect(bundle.terms.map(t => t.term)).toEqual(['c', 'a']);
		expect(bundle.terms[1]).toMatchObject({ relatedTerms: ['b'], distinctAuthors: 8, topicId: 'topic-1', daily: true });
		const previous = JSON.parse(setup.strings.get('hanami:trend:topics:prev')!);
		expect(previous.topics.map((topic: { terms: string[] }) => topic.terms[0])).toEqual(['b', 'c', 'a']);
		expect(previous.topics).toHaveLength(3);
	});
	test('next computation retains its topic ID and startedAt', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture(notesFor('a'));
		const first = await setup.service.computeTrendBundle(new Map());
		jest.spyOn(Date, 'now').mockReturnValue(NOW + 600000);
		const next = await setup.service.computeTrendBundle(new Map());
		expect(next.terms[0].topicId).toBe(first.terms[0].topicId);
		expect(next.terms[0].startedAt).toBe(first.terms[0].startedAt);
	});
	test('U-12: preserves A/B/C IDs before merging and merges again on the next generation', async () => {
		const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture([...notesFor('a', 6), ...notesFor('b'), ...notesFor('c')]);
		setup.sets.set(trendSameSetKey('topic-1'), new Set(['topic-2']));
		setup.sets.set(trendSameSetKey('topic-2'), new Set(['topic-1', 'topic-3']));
		setup.sets.set(trendSameSetKey('topic-3'), new Set(['topic-2']));
		setup.strings.set(trendSameKey('topic-1', 'topic-2'), '1');
		setup.strings.set(trendSameKey('topic-2', 'topic-3'), '1');
		const first = await setup.service.computeTrendBundle(new Map());
		const before = JSON.parse(setup.strings.get('hanami:trend:topics:prev')!);
		expect(before.computedAt).toBe(NOW);
		expect(before.topics.map((topic: { topicId: string }) => topic.topicId)).toEqual(['topic-1', 'topic-2', 'topic-3']);
		expect(before.topics.every((topic: object) => !('center' in topic))).toBe(true);
		expect(before.topics.map((topic: { noteIds: string[] }) => topic.noteIds.length)).toEqual([6, 3, 3]);
		expect(first.terms).toHaveLength(1);
		expect(first.terms[0]).toMatchObject({ topicId: 'topic-1', distinctAuthors: 12, relatedTerms: ['b', 'c'] });
		clock.mockReturnValue(NOW + 600000);
		const next = await setup.service.computeTrendBundle(new Map());
		expect(next.terms).toHaveLength(1);
		expect(next.terms[0]).toMatchObject({ topicId: 'topic-1', distinctAuthors: 12, relatedTerms: ['b', 'c'] });
		expect(JSON.parse(setup.strings.get('hanami:trend:topics:prev')!).topics.map((topic: { topicId: string }) => topic.topicId)).toEqual(before.topics.map((topic: { topicId: string }) => topic.topicId));
	});
	test('U-13: an older computation finishing later cannot replace a newer prev; equal timestamps are rejected', async () => {
		const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture(notesFor('a'));
		const builder = setup.service['buildTopics'] as import('vitest').Mock<typeof setup.service['buildTopics']>;
		const original = builder.getMockImplementation()!;
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const pending = new Promise<void>(resolve => { release = resolve; });
		builder.mockImplementationOnce(async (...args) => { entered(); await pending; return original(...args); });
		const older = setup.service.computeTrendBundle(new Map());
		await started;
		clock.mockReturnValue(NOW + 600000);
		await setup.service.computeTrendBundle(new Map());
		const newer = setup.strings.get('hanami:trend:topics:prev');
		release(); await older;
		expect(setup.strings.get('hanami:trend:topics:prev')).toBe(newer);
		const writes = setup.redis.eval.mock.calls.filter(([, , key]) => key === 'hanami:trend:topics:prev');
		expect(writes[1][3]).toBe(NOW);
		expect(setup.redis.eval.mock.calls[0][0]).toContain('decoded.computedAt >= tonumber(ARGV[1])');
		await setup.service.computeTrendBundle(new Map());
		expect(setup.strings.get('hanami:trend:topics:prev')).toBe(newer);
	});
	test('U-17: reads only the common generation cache, including a miss, with a thirty-minute TTL', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture(notesFor('a'));
		const compute = jest.spyOn(setup.service, 'computeTrendBundle');
		expect(await setup.service.getTrendingNoteIds(10)).toEqual([]);
		expect(compute).not.toHaveBeenCalled();
		const bundle = await setup.service.computeTrendBundle(new Map());
		expect(setup.redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'hanami:trend:noteIds', NOW, JSON.stringify({ computedAt: NOW, candidates: bundle.noteCandidates }), 1800);
		compute.mockClear();
		expect(await setup.service.getTrendingNoteIds(2)).toEqual(bundle.noteCandidates.slice(0, 2));
		expect(compute).not.toHaveBeenCalled();
	});
	test('U-18: reads one same set per topic in a pipeline and one daily MGET without pair GETs', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture(Array.from({ length: 150 }, (_, i) => notesFor(`term-${i}`)).flat());
		await setup.service.computeTrendBundle(new Map());
		expect(setup.redis.get.mock.calls.map(([key]) => key)).toEqual(['hanami:trend:topics:prev']);
		expect(setup.redis.mget).toHaveBeenCalledTimes(2);
		expect(setup.redis.mget.mock.calls[0]).toHaveLength(150);
		const setsPipe = setup.pipeline.mock.results[1].value as ReturnType<typeof setup.pipeline>;
		expect(setsPipe.smembers).toHaveBeenCalledTimes(150);
		expect(setup.pipeline).toHaveBeenCalledTimes(2);
	});
	test('U-21: A=B then A=C then A!=B separates B despite a stale same-set index', async () => {
		const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture([...notesFor('a', 6), ...notesFor('b'), ...notesFor('c')]);
		setup.sets.set(trendSameSetKey('topic-1'), new Set(['topic-2']));
		setup.sets.set(trendSameSetKey('topic-2'), new Set(['topic-1']));
		setup.strings.set(trendSameKey('topic-1', 'topic-2'), '1');
		const first = await setup.service.computeTrendBundle(new Map());
		expect(first.terms.map(topic => topic.term)).toEqual(['a', 'c']);
		expect(first.terms[0]).toMatchObject({ relatedTerms: ['b'], distinctAuthors: 9 });
		clock.mockReturnValue(NOW + 600000);
		setup.sets.get(trendSameSetKey('topic-1'))!.add('topic-3');
		setup.sets.set(trendSameSetKey('topic-3'), new Set(['topic-1']));
		setup.strings.set(trendSameKey('topic-1', 'topic-3'), '1');
		expect((await setup.service.computeTrendBundle(new Map())).terms).toHaveLength(1);
		clock.mockReturnValue(NOW + 1200000);
		setup.strings.set(trendSameKey('topic-1', 'topic-2'), '0');
		setup.redis.mget.mockClear();
		const last = await setup.service.computeTrendBundle(new Map());
		expect(last.terms.map(topic => topic.term)).toEqual(['a', 'b']);
		expect(last.terms[0]).toMatchObject({ topicId: 'topic-1', relatedTerms: ['c'], distinctAuthors: 9 });
		expect(last.terms[1]).toMatchObject({ topicId: 'topic-2', relatedTerms: [], distinctAuthors: 3 });
		expect(setup.redis.mget).toHaveBeenCalledTimes(3);
		expect(new Set(setup.redis.mget.mock.calls[1])).toEqual(new Set([trendSameKey('topic-1', 'topic-2'), trendSameKey('topic-1', 'topic-3')]));
	});
	test.each([null, '0'])('R7: ignores stale indexes when the pair verdict is %s', async verdict => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture([...notesFor('a'), ...notesFor('b')]);
		setup.sets.set(trendSameSetKey('topic-1'), new Set(['topic-2', 'outside-current-topics', 'topic-1']));
		setup.sets.set(trendSameSetKey('topic-2'), new Set(['topic-1']));
		if (verdict != null) setup.strings.set(trendSameKey('topic-1', 'topic-2'), verdict);
		expect((await setup.service.computeTrendBundle(new Map())).terms.map(topic => topic.term)).toEqual(['a', 'b']);
		expect(setup.redis.mget.mock.calls[1]).toEqual([trendSameKey('topic-1', 'topic-2')]);
	});
	test('U-22: same-set permutations preserve the original maximum-author ID, heading and term order', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture([...notesFor('a'), ...notesFor('b'), ...notesFor('c', 4), ...notesFor('d', 4)]);
		setup.strings.set(trendDailyKey('topic-3'), '1');
		setup.strings.set(trendDailyKey('topic-4'), '1');
		for (const id of ['topic-2', 'topic-3', 'topic-4']) {
			setup.strings.set(trendSameKey('topic-1', id), '1');
			setup.sets.set(trendSameSetKey(id), new Set(['topic-1']));
		}
		const results = [];
		for (const order of [['topic-2', 'topic-3', 'topic-4'], ['topic-4', 'topic-2', 'topic-3'], ['topic-3', 'topic-4', 'topic-2']]) {
			setup.sets.set(trendSameSetKey('topic-1'), new Set(order));
			results.push(await setup.service.computeTrendBundle(new Map()));
		}
		for (const result of results) {
			expect(result.terms).toHaveLength(1);
			expect(result.terms[0]).toMatchObject({ topicId: 'topic-3', term: 'c', relatedTerms: ['a', 'b', 'd'], distinctAuthors: 14, daily: true });
			expect(result).toEqual(results[0]);
		}
		const original = JSON.parse(setup.strings.get('hanami:trend:topics:prev')!);
		expect(original.topics.map((topic: { terms: string[] }) => topic.terms[0])).toEqual(['a', 'b', 'c', 'd']);
		expect(original.topics.map((topic: { authors6h: number }) => topic.authors6h)).toEqual([3, 3, 4, 4]);
	});
	test('U-23: older and equal computations cannot replace newer candidates', async () => {
		const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const setup = fixture(notesFor('a'));
		const builder = setup.service['buildTopics'] as import('vitest').Mock<typeof setup.service['buildTopics']>;
		const original = builder.getMockImplementation()!;
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const pending = new Promise<void>(resolve => { release = resolve; });
		builder.mockImplementationOnce(async (...args) => { entered(); await pending; return original(...args); });
		const older = setup.service.computeTrendBundle(new Map([['a-1', 10]]));
		await started;
		clock.mockReturnValue(NOW + 600000);
		const latest = await setup.service.computeTrendBundle(new Map([['a-2', 10]]));
		const saved = setup.strings.get('hanami:trend:noteIds');
		expect(JSON.parse(saved!)).toEqual({ computedAt: NOW + 600000, candidates: latest.noteCandidates });
		expect(latest.noteCandidates[0].noteId).toBe('a-2');
		release();
		expect((await older).noteCandidates[0].noteId).toBe('a-1');
		expect(setup.strings.get('hanami:trend:noteIds')).toBe(saved);
		const equal = await setup.service.computeTrendBundle(new Map([['a-0', 10]]));
		expect(equal.noteCandidates[0].noteId).toBe('a-0');
		expect(setup.strings.get('hanami:trend:noteIds')).toBe(saved);
		expect(await setup.service.getTrendingNoteIds(3)).toEqual(latest.noteCandidates);
		const writes = setup.redis.eval.mock.calls.filter(([, , key]) => key === 'hanami:trend:noteIds');
		expect(writes.map(([, , , at, , ttl]) => [at, ttl])).toEqual([[NOW + 600000, 1800], [NOW, 1800], [NOW + 600000, 1800]]);
		expect(writes[0][0]).toContain('decoded.computedAt >= tonumber(ARGV[1])');
	});
	test.each([false, true])('R9: reads legacy-array=%s candidates without recomputing and preserves limits', async legacy => {
		const setup = fixture([]);
		const candidates = Array.from({ length: 250 }, (_, i) => ({ noteId: String(i), term: 'a' }));
		setup.strings.set('hanami:trend:noteIds', JSON.stringify(legacy ? candidates : { computedAt: NOW, candidates }));
		const compute = jest.spyOn(setup.service, 'computeTrendBundle');
		expect(await setup.service.getTrendingNoteIds(2)).toEqual(candidates.slice(0, 2));
		expect(await setup.service.getTrendingNoteIds(300)).toEqual(candidates.slice(0, 200));
		expect(await setup.service.getTrendingNoteIds(0)).toEqual([]);
		expect(compute).not.toHaveBeenCalled();
		expect(setup.redis.eval).not.toHaveBeenCalled();
	});
});

describe('V-20: tag-game ranking', () => {
	test.each([
		['あいう漢字', 6, true], ['あいう漢字', 5, false], ['あい漢字', 10, false],
		...['shindanmaker', 'fediqb', 'クイズメーカー', 'mewk', 'marshmallow', 'peing', 'odaibako'].map(tag => [tag, 6, true] as [string, number, boolean]),
	])('tag %s on %s of ten posts => %s', (tag, count, expected) => {
		expect(trendTopicTagGame(Array.from({ length: 10 }, (_, i) => ({ tags: i < Number(count) ? [String(tag), String(tag)] : [] })))).toBe(expected);
	});
	test('recognizes a tag game among equally frequent leading tags and handles empty topics', () => {
		expect(trendTopicTagGame(Array.from({ length: 5 }, () => ({ tags: ['fedibird', 'shindanmaker'] })))).toBe(true);
		expect(trendTopicTagGame([])).toBe(false);
	});
	test('multiplies the two-hour author rank by 0.3 and logs tagGame independently of the daily verdict', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const game = notesFor('game', 10).map((note, i) => ({ ...note, tags: i < 6 ? ['あいう漢字'] : [] }));
		const setup = fixture([...game, ...notesFor('event', 4)]);
		const log = jest.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
		const result = await setup.service.computeTrendBundle(new Map());
		expect(result.terms.map(topic => topic.term)).toEqual(['event', 'game']);
		expect(result.terms[1]).toMatchObject({ daily: true, distinctAuthors: 5, recentAuthors: 5 });
		const data = log.mock.calls.find(([message]) => message === 'hanami trend topics')?.[1] as { topics: { terms: string[]; reasons: string[] }[] };
		expect(data.topics.find(topic => topic.terms[0] === 'game')?.reasons).toEqual(['tagGame']);
	});
});

describe('common topic source fields (U-6, U-8)', () => {
	test('V-14: captures all selected memberships before safety, keeps hidden metadata and selects only eligible representatives', async () => {
		const topics = ['a', 'b', 'hidden'].map(term => ({ term, score: 2, distinctAuthors: 3, recentAuthors: 2, topicNoteIds: ['private', 'private', term], topicId: term, relatedTerms: ['関連'], startedAt: new Date(NOW).toISOString(), daily: term === 'b', representativeNoteIds: term === 'hidden' ? ['hidden'] : ['shared', term] }));
		const computation = new HanamiCommonComputationService({ query: async () => [] } as never, { hanamiRecommendationAxisConfig: { globalPopular: { available: false }, exploration: { available: false } } } as never,
			{ getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never,
			{ computeTrendBundle: async () => ({ computedAt: new Date(NOW).toISOString(), terms: topics, noteCandidates: [] }) } as never,
			{ filterCommonEligibleNotes: async () => new Map([['shared', 'u'], ['a', 'u'], ['b', 'u']]) } as never);
		const source = await computation.buildSourceBundle({ generationId: 'g', generationFence: '1', generatedAt: new Date(NOW).toISOString(), sourceAsOf: new Date(NOW), signal: new AbortController().signal });
		const entries = source.trendSnapshot.terms as HanamiTrendSnapshotTerm[];
		expect(entries).toHaveLength(3);
		expect(entries[1]).toMatchObject({ topicId: 'b', relatedTerms: ['関連'], startedAt: new Date(NOW).toISOString(), daily: true, representativeNoteIds: ['b'] });
		expect(entries[1]).toMatchObject({ recentAuthors: 2, topicNoteIds: ['private', 'b'] });
		expect(Object.isFrozen(entries[1].topicNoteIds)).toBe(true);
		expect(entries[2]).toMatchObject({ topicId: 'hidden', topicNoteIds: ['private', 'hidden'], representativeNoteIds: [] });
		const generation = new HanamiCommonGenerationService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
		expect(() => generation['validateSourceBundle'](source)).not.toThrow();
		for (const invalid of [{ topicId: 'x'.repeat(33) }, { relatedTerms: Array(6).fill('語') }, { startedAt: 'invalid' }, { daily: 'yes' }]) {
			const bad = structuredClone(source);
			Object.assign(bad.trendSnapshot.terms[0], invalid);
			expect(() => generation['validateSourceBundle'](bad)).toThrow();
		}
	});
});


test.each([['a-0', 'a-1'], ['a-0', 'old'], ['old', 'older']] as const)('R2: snapshots only attach titles retaining at least half the named posts (%s, %s)', async (a, b) => {
	jest.spyOn(Date, 'now').mockReturnValue(NOW);
	const setup = fixture(notesFor('a'));
	setup.strings.set(trendTitleKey('topic-1'), JSON.stringify({ title: '寒波', noteIds: [a, b] }));
	const bundle = await setup.service.computeTrendBundle(new Map());
	expect(bundle.terms[0].title).toBe(a === 'old' ? null : '寒波');
});

test('R2: chooses unused representative words in rank order and keeps candidate labels consistent', async () => {
	jest.spyOn(Date, 'now').mockReturnValue(NOW);
	const setup = fixture([...notesFor('a', 5), ...notesFor('b', 4), ...notesFor('c', 3)]);
	jest.mocked(setup.service['buildTopics']).mockResolvedValue([
		{ terms: ['共通', '甲'], noteIds: notesFor('a', 5).map(n => n.id), authors6h: 5, authors2h: 5, center: null },
		{ terms: ['共通', '乙'], noteIds: notesFor('b', 4).map(n => n.id), authors6h: 4, authors2h: 4, center: null },
		{ terms: ['共通', '乙'], noteIds: notesFor('c', 3).map(n => n.id), authors6h: 3, authors2h: 3, center: null },
	]);
	const bundle = await setup.service.computeTrendBundle(new Map());
	expect(bundle.terms.map(t => [t.term, t.relatedTerms])).toEqual([['共通', ['甲']], ['乙', ['共通']]]);
	expect(bundle.noteCandidates.filter(n => n.noteId.startsWith('b-')).every(n => n.term === '乙')).toBe(true);
	expect(bundle.noteCandidates.some(n => n.noteId.startsWith('c-'))).toBe(false);
});
