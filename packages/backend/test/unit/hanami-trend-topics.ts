/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, jest } from '@jest/globals';
import { encodeFp16 } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { prepareHanamiPythonCommand, resolveHanamiTrendTopicsScript } from '@/core/hanami/HanamiPythonRuntime.js';

import { HanamiTrendSnapshotService, normalizeHanamiTrendDateTime } from '@/core/hanami/HanamiTrendSnapshotService.js';
import { meta as trendMeta, paramDef as trendParams } from '@/server/api/endpoints/notes/hanami-trends.js';
import { meta as historyMeta, paramDef as historyParams } from '@/server/api/endpoints/notes/hanami-trend-history.js';

import TopicNotesEndpoint, { meta as topicNotesMeta } from '@/server/api/endpoints/notes/hanami-trend-topic-notes.js';
import TrendsEndpoint from '@/server/api/endpoints/notes/hanami-trends.js';
import HistoryEndpoint from '@/server/api/endpoints/notes/hanami-trend-history.js';

import { HanamiForYouBatchService, type HanamiTrendTopicJudgeJobData } from '@/core/hanami/HanamiForYouBatchService.js';
import { probeHanamiNoteJudgeRuntime } from '@/core/hanami/HanamiPythonRuntime.js';
import { HanamiTrendService, trendDailyKey, trendSameKey, trendSameSetKey } from '@/core/hanami/HanamiTrendService.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';
import { QueueService } from '@/core/QueueService.js';

const python = prepareHanamiPythonCommand(['-c', 'import numpy, networkx']);
let available = true;
try { execFileSync(python.file, python.args, { env: python.env }); } catch { available = false; }
const pythonTest = available ? test : test.skip;
const now = Date.parse('2026-10-06T12:00:00Z');

function run(input: unknown, vectors: number[][] = []) {
	const dir = mkdtempSync(join(tmpdir(), 'hanami-topics-test-'));
	try {
		writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
		writeFileSync(join(dir, 'vectors.bin'), Buffer.concat(vectors.map(encodeFp16)));
		const command = prepareHanamiPythonCommand([resolveHanamiTrendTopicsScript(), join(dir, 'input.json'), join(dir, 'vectors.bin'), join(dir, 'output.json')]);
		execFileSync(command.file, command.args, { env: command.env, timeout: 15000 });
		return JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')).topics as { terms: string[]; noteIds: string[]; authors6h: number; authors2h: number; center: number[] | null }[];
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

function note(id: string, terms = ['地震']) {
	return { id, userId: id, createdAt: now, text: '', replyId: null as string | null, renoteId: null as string | null, terms, embeddingIndex: null as number | null };
}

describe('pure Python trend topics (U-3)', () => {
	pythonTest('shared parents and grandparent links connect notes without embeddings', () => {
		const notes = [note('a'), note('b'), note('c')];
		notes[0].replyId = 'parent-a'; notes[1].replyId = 'parent-b'; notes[2].replyId = 'parent-a';
		const topics = run({ notes, now, dim: 0, terms: [{ term: '地震', score: 3 }], parents: [{ id: 'parent-a', replyId: 'root' }, { id: 'parent-b', replyId: 'root' }] });
		expect(topics).toHaveLength(1);
		expect(topics[0]).toMatchObject({ terms: ['地震'], noteIds: ['a', 'b', 'c'], authors6h: 3, authors2h: 3, center: null });
	});
	pythonTest('normalizes tracking queries and punctuation, ignoring image links', () => {
		const notes = [note('a'), note('b'), note('c'), note('d'), note('e'), note('f')];
		notes[0].text = 'https://example.com/story/?utm_source=x&s=1&q=keep';
		notes[1].text = 'https://example.com/story/?q=keep&ref=x。';
		notes[2].text = 'https://example.com/story/?q=keep';
		for (const n of notes.slice(3)) n.text = 'https://example.com/image.JPG?utm_source=x';
		const topics = run({ notes, now, dim: 0, terms: [{ term: '地震', score: 3 }] });
		expect(topics).toHaveLength(1);
		expect(topics[0].noteIds).toEqual(['a', 'b', 'c']);
	});
	pythonTest('uses centered embeddings and rejects a term with less than 35% author share', () => {
		const notes = Array.from({ length: 9 }, (_, i) => ({ ...note(String(i), [i < 3 ? '地震' : `別${Math.floor(i / 3)}`, '一般']), embeddingIndex: i }));
		const vectors = notes.map((_, i) => i < 3 ? [11, 20, 30] : i < 6 ? [10, 21, 30] : [10, 20, 31]);
		const topics = run({ notes, now, dim: 3, meanVec: [10, 20, 30], terms: [{ term: '地震', score: 4 }, { term: '別1', score: 3 }, { term: '別2', score: 2 }, { term: '一般', score: 1 }] }, vectors);
		expect(topics).toHaveLength(3);
		expect(topics.flatMap(t => t.terms)).not.toContain('一般');
		expect(topics[0].center).toEqual([1, 0, 0]);
	});
	pythonTest('TypeScript runs the real Python builder and materializes related terms and author unions', async () => {
		const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
		try {
			const notes = Array.from({ length: 6 }, (_, i) => ({ ...note(String(i), [i < 3 ? '地震' : '震度']), text: 'https://example.com/earthquake' }));
			const strings = new Map<string, string>();
			const redis = {
				get: async (key: string) => strings.get(key) ?? null,
				mget: async (...keys: string[]) => keys.map(key => strings.get(key) ?? null),
				eval: async (_lua: string, _count: number, key: string, _at: number, value: string) => { strings.set(key, value); return 1; },
				set: async (key: string, value: string) => { strings.set(key, value); return 'OK'; },
				pipeline: () => {
					const terms: string[] = [];
					const pipe = { smembers: (_key: string) => { terms.push(''); return pipe; }, zrange: (key: string) => { terms.push(key.slice('hanami:trend:notes:'.length)); return pipe; }, exec: async () => terms.map(term => [null, notes.filter(n => n.terms.includes(term)).flatMap(n => [n.id, String(n.createdAt)])]) };
					return pipe;
				},
			};
			const db = { query: async (sql: string) => sql.includes('FROM note') ? notes : [] };
			const service = new HanamiTrendService(redis as never, {} as never, {} as never, db as never, { gen: () => 'topic', parse: () => ({ date: new Date(now) }) } as never);
			Object.defineProperty(service, 'getTrendingTermCandidatesWithCache', { value: async () => [{ term: '地震', score: 3, proper: false, distinctAuthors: 3 }, { term: '震度', score: 2, proper: false, distinctAuthors: 3 }] });
			const result = await service.computeTrendBundle(new Map());
			expect(result.terms).toHaveLength(1);
			expect(result.terms[0]).toMatchObject({ term: '地震', relatedTerms: ['震度'], distinctAuthors: 6, topicId: 'topic', daily: false });
			expect(result.noteCandidates).toHaveLength(6);
		} finally { clock.mockRestore(); }
	});

	pythonTest('handles edgeless input and authors older than two hours', () => {
		expect(run({ notes: [note('a'), note('b'), note('c')], now, dim: 0, terms: [{ term: '地震', score: 3 }] })).toEqual([]);
		const notes = [note('a'), note('b'), note('c')].map(n => ({ ...n, createdAt: now - 3 * 3600000, text: 'https://example.com/event' }));
		expect(run({ notes, now, dim: 0, terms: [{ term: '地震', score: 3 }] })[0].authors2h).toBe(0);
	});
});

// History and schema tests use a read-only DB double, never the local database.

describe('topic persistence and public history (U-8, U-9)', () => {
	test('migration up/down alters the partition parent and creates/drops its topic index', async () => {
		const { HanamiTrendTopics1791244800000 } = await import('../../migration/1791244800000-hanamiTrendTopics.js');
		const statements: string[] = [];
		const runner = { query: async (sql: string) => { statements.push(sql); } };
		const migration = new HanamiTrendTopics1791244800000();
		await migration.up(runner);
		await migration.down(runner);
		expect(statements).toHaveLength(6);
		expect(statements[0]).toContain('ALTER TABLE "hanami_trend_snapshot_entry"');
		expect(statements[0]).toContain('cardinality("relatedTerms") <= 5');
		for (const field of ['topicId', 'relatedTerms', 'startedAt', 'daily']) expect(statements[0]).toContain(`ADD COLUMN "${field}"`);
		expect(statements[1]).toContain('CREATE INDEX');
		expect(statements[2]).toContain('ON "hanami_trend_snapshot" ("generatedAt")');
		expect(statements[3]).toBe('DROP INDEX "IDX_hanami_trend_snapshot_generated_at"');
		expect(statements[4]).toContain('DROP INDEX');
		for (const field of ['topicId', 'relatedTerms', 'startedAt', 'daily']) expect(statements[5]).toContain(`DROP COLUMN "${field}"`);
	});
	test('keeps existing trend parameters and fields, exposing only three additional fields', () => {
		expect(Object.keys(trendParams.properties)).toEqual(['limit', 'history', 'cursor']);
		expect(Object.keys(trendMeta.res.properties.items.items.properties).sort()).toEqual(['trendEntryId', 'snapshotId', 'snapshotGeneratedAt', 'term', 'score', 'distinctAuthors', 'representativeNote', 'topicId', 'relatedTerms', 'startedAt'].sort());
		expect(historyMeta).toMatchObject({ requireCredential: false, allowGet: true });
		expect(historyParams.properties.blocks).toMatchObject({ minimum: 1, maximum: 4, default: 2 });
	});
	test('returns SQL-aggregated topics, latest representatives, legacy terms, and JST bounds', async () => {
		const base = { snapshot_id: 's', rank: '0', related_terms: [], started_at: '2026-10-05T03:00:00Z', daily: false };
		const rows = [
			{ ...base, block_from: '2026-10-05T09:00:00Z', term: 'evening', topic_id: 'evening', peak_authors: 3, first_seen_at: '2026-10-05T10:00:00Z', last_seen_at: '2026-10-05T10:00:00Z' },
			{ ...base, rank: '1', block_from: '2026-10-05T03:00:00Z', term: 'after', related_terms: ['関連'], topic_id: 'topic', peak_authors: 20, first_seen_at: '2026-10-05T03:10:00Z', last_seen_at: '2026-10-05T08:00:00Z' },
			{ ...base, rank: '2', block_from: '2026-10-05T03:00:00Z', term: 'legacy', topic_id: null, peak_authors: 5, first_seen_at: '2026-10-05T04:00:00Z', last_seen_at: '2026-10-05T05:00:00Z' },
		];
		const query = jest.fn(async (sql: string, values: unknown[]) => {
			if (sql.includes('SELECT EXISTS')) return [{ exists: true }];
			if (sql.includes('jsonb_to_recordset')) return JSON.parse(values[0] as string).flatMap((row: object) => [{ ...row, note_id: 'hidden' }, { ...row, note_id: 'safe' }]);
			return rows;
		});
		const safety = { filterAndPackPublic: jest.fn(async () => [{ id: 'safe' }]) };
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, safety as never);
		const result = await service.getHistory({ until: '2026-10-05T15:00:00Z', blocks: 2, me: null });
		expect(result.blocks.map(block => [block.from, block.to])).toEqual([
			['2026-10-05T09:00:00.000Z', '2026-10-05T15:00:00.000Z'],
			['2026-10-05T03:00:00.000Z', '2026-10-05T09:00:00.000Z'],
		]);
		expect(result.blocks[1].items).toHaveLength(2);
		expect(result.blocks[1].items[0]).toMatchObject({ term: 'after', relatedTerms: ['関連'], peakAuthors: 20, firstSeenAt: '2026-10-05T03:10:00.000Z', lastSeenAt: '2026-10-05T08:00:00.000Z', representativeNote: { id: 'safe' } });
		expect(result.blocks[1].items[1]).toMatchObject({ topicId: null, term: 'legacy', peakAuthors: 5 });
		expect(result.nextUntil).toBe('2026-10-05T03:00:00.000Z');
		expect(query.mock.calls[0][0]).toContain('generation."status" = \'ready\'');
		expect(query.mock.calls[2][0]).toContain('generation."status" = \'ready\'');
		expect(query.mock.calls[0][1]).toEqual(['2026-10-05T03:00:00.000Z', '2026-10-05T15:00:00.000Z', '2026-10-01', '2026-11-01']);
		expect(query.mock.calls[0][0]).toContain('MIN(generated_at) OVER topic');
		expect(query.mock.calls[0][0]).toContain('MAX(authors) OVER topic');
		expect(query.mock.calls[0][0]).toContain("THEN 'term:' || entry.\"term\"");
	});
	test('U-19: selects fifteen in SQL before fetching or packing representatives, pruning entry partitions', async () => {
		const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
		try {
			const rows = Array.from({ length: 15 }, (_, i) => ({ snapshot_id: 's', rank: String(i + 1), topic_id: String(i + 1), term: String(i + 1), related_terms: [], started_at: null, daily: false, peak_authors: 29 - i, block_from: new Date('2026-10-06T09:00:00Z'), first_seen_at: new Date(now), last_seen_at: new Date(now) }));
			const query = jest.fn(async (sql: string, values: unknown[]) => {
				if (sql.includes('SELECT EXISTS')) return [{ exists: false }];
				if (sql.includes('jsonb_to_recordset')) {
					const selected = JSON.parse(values[0] as string) as { snapshot_id: string; rank: string }[];
					expect(selected).toHaveLength(15);
					return selected.map(row => ({ ...row, note_id: `hidden-${row.rank}` }));
				}
				expect(sql).toContain('FROM ranked WHERE block_rank <= 15');
				expect(sql).toContain('ORDER BY daily ASC, peak_authors DESC, last_seen_at DESC');
				expect(sql).toContain('entry."generatedMonth" >= $3::date AND entry."generatedMonth" < $4::date');
				expect(sql).not.toContain('hanami_trend_snapshot_representative_note');
				return rows;
			});
			const pack = jest.fn(async (_ids: string[]) => []);
			const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
			const result = await service.getHistory({ blocks: 1, me: null });
			expect(result.blocks[0].from).toBe('2026-10-06T09:00:00.000Z');
			expect(result.blocks[0].items).toHaveLength(15);
			expect(result.blocks[0].items[0].term).toBe('1');
			expect(result.blocks[0].items.every(item => item.representativeNote == null)).toBe(true);
			expect(pack.mock.calls[0][0]).toHaveLength(15);
			expect(query).toHaveBeenCalledTimes(3);
			expect(result.nextUntil).toBeNull();
		} finally { clock.mockRestore(); }
	});
	test('does not fetch representatives for empty blocks and prunes across a UTC month boundary', async () => {
		const query = jest.fn(async (sql: string, _values: unknown[]) => sql.includes('SELECT EXISTS') ? [{ exists: true }] : []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: async () => [] } as never);
		const result = await service.getHistory({ until: '2026-11-01T03:00:00Z', blocks: 2, me: null });
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls[0][1]).toEqual(['2026-10-31T15:00:00.000Z', '2026-11-01T03:00:00.000Z', '2026-10-01', '2026-12-01']);
		expect(result.blocks.every(block => block.items.length === 0)).toBe(true);
		expect(result.nextUntil).toBe('2026-10-31T15:00:00.000Z');
	});
});

async function withRuntime(cuda: boolean, operation: (dir: string) => Promise<void>) {
	const previousDevice = process.env.HANAMI_NOTE_JUDGE_DEVICE;
	const previousScript = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
	const previousTopicScript = process.env.HANAMI_TREND_TOPIC_JUDGE_SCRIPT;
	const dir = mkdtempSync(join(tmpdir(), 'hanami-topic-judge-test-'));
	const script = join(dir, 'probe.py');
	try {
		delete process.env.HANAMI_NOTE_JUDGE_DEVICE;
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = script;
		writeFileSync(script, `print('${JSON.stringify({ cudaAvailable: cuda })}')`);
		await probeHanamiNoteJudgeRuntime({ force: true });
		await operation(dir);
	} finally {
		writeFileSync(script, 'print(\'{"cudaAvailable":false}\')');
		await probeHanamiNoteJudgeRuntime({ force: true });
		for (const [key, value] of [['HANAMI_NOTE_JUDGE_DEVICE', previousDevice], ['HANAMI_NOTE_JUDGE_SCRIPT', previousScript], ['HANAMI_TREND_TOPIC_JUDGE_SCRIPT', previousTopicScript]]) {
			if (value == null) delete process.env[key!]; else process.env[key!] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

function topicBatch(redis: unknown, query = jest.fn(async () => [] as { id: string; text: string; replyId: string | null }[]), scores = new Map<string, number>()) {
	return new HanamiForYouBatchService({ query } as never, {} as never, redis as never, { gen: () => 'id' } as never, { getGlobalNotesScoresWithCache: async () => scores } as never);
}

const jobData: HanamiTrendTopicJudgeJobData = { topics: [{ topicId: 'a', text: 'A' }, { topicId: 'b', text: 'B' }], dailyIds: ['a', 'b'], pairs: [{ a: 'a', b: 'b' }] };

describe('GPU topic judge jobs (U-7)', () => {
	test('without GPU creates no job and does not query or acquire a lock', async () => {
		await withRuntime(false, async () => {
			const get = jest.fn(async () => null);
			const set = jest.fn(async () => 'OK');
			const query = jest.fn(async () => []);
			const service = topicBatch({ get, set }, query);
			expect(await service.prepareTrendTopicJudgeJob()).toBeNull();
			await service.runTrendTopicJudgeJob(jobData, {} as never);
			expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
		});
	});
	test('uses the existing note judge exclusive lock and skips when unavailable', async () => {
		await withRuntime(true, async () => {
			const set = jest.fn(async () => null);
			const get = jest.fn(async () => null);
			await topicBatch({ get, set }).runTrendTopicJudgeJob(jobData, {} as never);
			expect(set).toHaveBeenCalledWith('hanami:llm:exclusive:v1', expect.any(String), 'EX', 35 * 60, 'NX');
			expect(get).not.toHaveBeenCalled();
		});
	});
	test('selects only top ten, uncached daily/pairs, non-replies, ten texts and eight terms', async () => {
		await withRuntime(true, async () => {
			const topics = Array.from({ length: 11 }, (_, i) => ({ topicId: String(i), terms: Array.from({ length: 9 }, (_, j) => `語${j}`), noteIds: Array.from({ length: 12 }, (_, j) => `${i}-${String(j).padStart(2, '0')}`) }));
			const rows = topics.flatMap(topic => topic.noteIds.map(id => ({ id, text: 'あ'.repeat(150), replyId: id.endsWith('11') ? 'parent' : null })));
			const get = async (key: string) => key === 'hanami:trend:topics:prev' ? JSON.stringify({ computedAt: now, topics }) : key === trendDailyKey('0') || key === trendSameKey('0', '1') ? '0' : null;
			const mget = jest.fn(async (...keys: string[]) => Promise.all(keys.map(get)));
			const service = topicBatch({ get, mget }, jest.fn(async () => rows), new Map([['0-00', 100]]));
			const result = (await service.prepareTrendTopicJudgeJob())!;
			expect(result.topics).toHaveLength(10);
			expect(result.dailyIds).toHaveLength(9);
			expect(result.dailyIds).not.toContain('0');
			expect(result.pairs).toHaveLength(44);
			expect(mget).toHaveBeenCalledTimes(2);
			expect(mget.mock.calls.map(keys => keys.length)).toEqual([10, 45]);
			expect(result.topics[0].text.split('\n')[0]).toBe('関連語: 語0・語1・語2・語3・語4・語5・語6・語7');
			expect(result.topics[0].text.split('\n').slice(2)).toHaveLength(10);
			expect(result.topics[0].text.split('\n')[2]).toBe('- ' + 'あ'.repeat(120));
		});
	});
	test('reads probabilities at the specified thresholds, stores six-hour verdicts, logs P and releases the lock', async () => {
		await withRuntime(true, async dir => {
			const script = join(dir, 'judge.py');
			writeFileSync(script, 'import json,sys\njson.dump({\'status\':\'ok\',\'judgements\':[{\'kind\':\'daily\',\'topicId\':\'a\',\'probability\':0.6},{\'kind\':\'daily\',\'topicId\':\'b\',\'probability\':0.59},{\'kind\':\'same\',\'a\':\'a\',\'b\':\'b\',\'probability\':0.7},{\'kind\':\'same\',\'a\':\'a\',\'b\':\'c\',\'probability\':0.69}]},open(sys.argv[2],\'w\'))');
			process.env.HANAMI_TREND_TOPIC_JUDGE_SCRIPT = script;
			const set = jest.fn(async (..._args: unknown[]) => 'OK');
			const sets = new Map([[trendSameSetKey('a'), new Set(['c'])], [trendSameSetKey('c'), new Set(['a'])]]);
			const sadd = jest.fn();
			const srem = jest.fn((key: string, member: string) => sets.get(key)?.delete(member));
			const expire = jest.fn();
			const multi = () => {
				const pending: (() => unknown)[] = [];
				const pipe = {
					set: (...args: unknown[]) => { pending.push(() => set(...args)); return pipe; },
					sadd: (...args: unknown[]) => { pending.push(() => sadd(...args)); return pipe; },
					srem: (key: string, member: string) => { pending.push(() => srem(key, member)); return pipe; },
					expire: (...args: unknown[]) => { pending.push(() => expire(...args)); return pipe; },
					exec: async () => Promise.all(pending.map(run => run())),
				};
				return pipe;
			};
			const release = jest.fn(async () => 1);
			const logger = { info: jest.fn(), warn: jest.fn() };
			const data = { ...jobData, topics: [...jobData.topics, { topicId: 'c', text: 'C' }], pairs: [...jobData.pairs, { a: 'a', b: 'c' }] };
			await topicBatch({ mget: async (...keys: string[]) => keys.map(() => null), set, multi, eval: release }).runTrendTopicJudgeJob(data, logger as never);
			expect(set).toHaveBeenCalledWith(trendDailyKey('a'), '1', 'EX', 21600);
			expect(set).toHaveBeenCalledWith(trendDailyKey('b'), '0', 'EX', 21600);
			expect(set).toHaveBeenCalledWith(trendSameKey('a', 'b'), '1', 'EX', 21600);
			expect(set).toHaveBeenCalledWith(trendSameKey('a', 'c'), '0', 'EX', 21600);
			expect(srem.mock.calls).toEqual([[trendSameSetKey('a'), 'c'], [trendSameSetKey('c'), 'a']]);
			expect(sets.get(trendSameSetKey('a'))?.has('c')).toBe(false);
			expect(sets.get(trendSameSetKey('c'))?.has('a')).toBe(false);
			expect(logger.warn).not.toHaveBeenCalled();
			expect(sadd.mock.calls).toEqual([[trendSameSetKey('a'), 'b'], [trendSameSetKey('b'), 'a']]);
			expect(expire.mock.calls).toEqual([[trendSameSetKey('a'), 21600], [trendSameSetKey('b'), 21600]]);
			expect(logger.info).toHaveBeenCalledWith('hanami trend topic judgement', expect.objectContaining({ probability: 0.7, verdict: true }));
			expect(release).toHaveBeenCalledWith(expect.any(String), 1, 'hanami:llm:exclusive:v1', expect.any(String));
		});
	});
	test('dispatches the new job after publication and runs it through the common generation processor', async () => {
		const queue = { enqueueHanamiTrendTopicJudge: jest.fn(async () => undefined), enqueueHanamiNoteJudge: jest.fn() };
		const batch = { prepareTrendTopicJudgeJob: async () => jobData, prepareNoteJudgeJobs: async () => [], runTrendTopicJudgeJob: jest.fn(async () => undefined) };
		const logger = { info: jest.fn(), succ: jest.fn() };
		const processor = new HanamiCommonGenerationProcessorService({ runCommonGeneration: async () => ({ kind: 'published', generationId: 'g' }) } as never, queue as never, { logger: { createSubLogger: () => logger } } as never, batch as never);
		const job = { name: 'hanamiCommonGeneration', data: { generationId: 'g' }, log: async () => undefined, updateProgress: async () => undefined };
		await processor.processGeneration(job as never);
		expect(queue.enqueueHanamiTrendTopicJudge).toHaveBeenCalledWith(jobData);
		await processor.processTrendTopicJudge({ ...job, name: 'hanamiTrendTopicJudge', data: jobData } as never);
		expect(batch.runTrendTopicJudgeJob).toHaveBeenCalledWith(jobData, logger);
	});
	test('uses the same durable queue and note judge options', async () => {
		const queue = { add: jest.fn(async () => undefined) };
		const service = Object.create(QueueService.prototype) as QueueService;
		Object.defineProperty(service, 'getHanamiGenerationQueue', { value: () => queue });
		await service.enqueueHanamiTrendTopicJudge(jobData);
		expect(queue.add).toHaveBeenCalledWith('hanamiTrendTopicJudge', jobData, expect.objectContaining({ jobId: expect.stringMatching(/^hanamiTrendTopicJudge-/) }));
	});
});

describe('saved topic posts (U-24, U-25, U-27)', () => {
	const from = '2026-10-31T21:00:00Z';
	const to = '2026-11-01T03:00:00Z';
	test('U-24: migration expands the parent CHECK and deletes extra positions before restoring it', async () => {
		const { HanamiTrendTopicNotes1791331200000 } = await import('../../migration/1791331200000-hanamiTrendTopicNotes.js');
		const queries: string[] = [];
		const runner = { query: async (sql: string) => { queries.push(sql); } };
		const migration = new HanamiTrendTopicNotes1791331200000();
		await migration.up(runner);
		await migration.down(runner);
		expect(queries).toHaveLength(5);
		expect(queries[0]).toContain('DROP CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_position"');
		expect(queries[1]).toContain('CHECK ("position" >= 0 AND "position" < 20)');
		expect(queries[2]).toBe('DELETE FROM "hanami_trend_snapshot_representative_note" WHERE "position" >= 5');
		expect(queries[3]).toContain('DROP CONSTRAINT');
		expect(queries[4]).toContain('CHECK ("position" >= 0 AND "position" < 5)');
		expect(queries.every(sql => sql.includes('"hanami_trend_snapshot_representative_note"'))).toBe(true);
	});
	test('U-25: retrieves bounded distinct saved IDs and preserves their order after safety filtering', async () => {
		const rawIds = ['new-first', 'shared', 'shared', ...Array.from({ length: 22 }, (_, i) => `older-${i}`)];
		const expected = [...new Set(rawIds)].slice(0, 20);
		const query = jest.fn(async (_sql: string, _values: unknown[]) => rawIds.map(note_id => ({ note_id })));
		const me = { id: 'viewer' };
		const pack = jest.fn(async (ids: string[]) => ids.filter(id => id !== 'new-first' && id !== 'older-5').reverse().map(id => ({ id })));
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
		const endpoint = new TopicNotesEndpoint(service);
		expect(topicNotesMeta).toMatchObject({ requireCredential: false, allowGet: true });
		expect((await endpoint.exec({ from, to, topicId: 'topic' }, me as never, null)).notes.map((note: { id: string }) => note.id)).toEqual(expected.filter(id => id !== 'new-first' && id !== 'older-5'));
		expect(pack).toHaveBeenCalledWith(expected, me);
		const [sql, params] = query.mock.calls[0];
		expect(params).toEqual(['2026-10-31T21:00:00.000Z', '2026-11-01T03:00:00.000Z', '2026-10-01', '2026-12-01', 'topic', 20]);
		expect(sql).toContain('snapshot."status" = \'ready\'');
		expect(sql).toContain('generation."status" = \'ready\'');
		expect(sql).toContain('PARTITION BY representative."noteId"');
		expect(sql).toContain('ORDER BY generated_at DESC, ordinal DESC, position ASC LIMIT $6');
		expect(sql).toContain('WHERE occurrence = 1');
		expect(sql).toContain('AND entry."topicId" = $5');
		expect(sql).toContain('entry."generatedMonth" >= $3::date');
		expect(sql).toContain('representative."generatedMonth" >= $3::date');
	});
	test('U-25: legacy term lookup only matches null topic IDs and includes the exclusive end month partition', async () => {
		const query = jest.fn(async (_sql: string, _values: unknown[]) => []);
		const pack = jest.fn(async () => []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
		const endpoint = new TopicNotesEndpoint(service);
		const params = { from: '2026-10-31T18:00:00Z', to: '2026-11-01T00:00:00Z', term: 'legacy' };
		expect(await endpoint.exec(params, null, null)).toEqual({ notes: [] });
		expect(query.mock.calls[0][0]).toContain('entry."topicId" IS NULL AND entry."term" = $5');
		expect(query.mock.calls[0][1]).toEqual(['2026-10-31T18:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-10-01', '2026-12-01', 'legacy', 20]);
		expect(pack).not.toHaveBeenCalled();
	});
	test.each([
		{}, { topicId: 't', term: 'legacy' }, { topicId: '' }, { term: '' }, { topicId: null }, { term: null },
		{ topicId: 'x'.repeat(33) }, { term: 'x'.repeat(257) },
		{ topicId: 't', from: 'not-a-date' }, { topicId: 't', to: 'not-a-date' },
		{ topicId: 't', from: '2026-10-31' }, { topicId: 't', from: '2026-10-31T25:00:00Z' },
		{ topicId: 't', from: '2026-02-29T21:00:00Z', to: '2026-03-01T03:00:00Z' },
		{ topicId: 't', from: '2026-10-31T24:00:00Z' },
		{ topicId: 't', from: to }, { topicId: 't', from: '2026-11-01T04:00:00Z' },
		{ topicId: 't', to: '2026-11-01T03:00:00.001Z' },
		{ topicId: 't', from: undefined }, { topicId: 't', to: undefined },
	])('U-25: invalid request %j returns INVALID_PARAM before querying', async invalid => {
		const getTopicNotes = jest.fn(async () => ({ notes: [] }));
		const endpoint = new TopicNotesEndpoint({ getTopicNotes } as never);
		await expect(endpoint.exec({ from, to, ...invalid }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(getTopicNotes).not.toHaveBeenCalled();
	});
	test('U-27: the existing trend response still exposes the first visible representative only', async () => {
		const ids = Array.from({ length: 20 }, (_, i) => `saved-${i}`);
		const row = { trend_entry_id: 'e', snapshot_id: 's', snapshot_generated_at: new Date(now), snapshot_ordinal: '1', rank: '0', term: 'topic', topic_id: 'topic', related_terms: [], started_at: null, score: 2, distinct_authors: 20, representative_note_ids: ids };
		const pack = jest.fn(async () => [{ id: 'saved-19' }, { id: 'saved-1' }]);
		const service = new HanamiTrendSnapshotService({ query: async () => [row] } as never, {} as never, { filterAndPackPublic: pack } as never);
		const response = await new TrendsEndpoint(service).exec({}, null, null);
		expect(response.items).toHaveLength(1);
		expect(response.items[0].representativeNote).toEqual({ id: 'saved-1' });
		expect(response.items[0]).not.toHaveProperty('notes');
	});
	test('U-27: the history endpoint initializes and returns only the first visible saved representative', async () => {
		const row = { snapshot_id: 's', rank: '0', block_from: '2026-10-06T09:00:00Z', topic_id: 'topic', term: 'topic', related_terms: [], started_at: null, daily: false, peak_authors: 20, first_seen_at: new Date(now), last_seen_at: new Date(now) };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT EXISTS')) return [{ exists: false }];
			if (sql.includes('jsonb_to_recordset')) return Array.from({ length: 20 }, (_, i) => ({ snapshot_id: 's', rank: '0', note_id: `saved-${i}` }));
			return [row];
		});
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: async () => [{ id: 'saved-19' }, { id: 'saved-1' }] } as never);
		const endpoint = new HistoryEndpoint(service);
		const response = await endpoint.exec({ until: '2026-10-06T15:00:00Z', blocks: 1 }, null, null);
		expect(response.blocks[0].items[0].representativeNote).toEqual({ id: 'saved-1' });
		expect(response.blocks[0].items[0]).not.toHaveProperty('notes');
		const callCount = query.mock.calls.length;
		await expect(endpoint.exec({ until: 'not-a-date' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		await expect(endpoint.exec({ until: '2026-10-06T25:00:00Z' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		await expect(endpoint.exec({ until: '2026-02-29T12:00:00Z' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(query).toHaveBeenCalledTimes(callCount);
	});
});

describe('canonical trend date-time boundaries (U-30, U-31)', () => {
	test('U-30: normalizes fractional UTC bounds before querying and includes the ending month partition', async () => {
		const query = jest.fn(async (_sql: string, _params: unknown[]) => []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: async () => [] } as never);
		const endpoint = new TopicNotesEndpoint(service);
		await expect(endpoint.exec({ from: '2026-10-31T18:00:01Z', to: '2026-11-01T00:00:00.000500Z', topicId: 'topic' }, null, null)).resolves.toEqual({ notes: [] });
		const [sql, params] = query.mock.calls[0];
		expect(params).toEqual(['2026-10-31T18:00:01.000Z', '2026-11-01T00:00:00.000Z', '2026-10-01', '2026-12-01', 'topic', 20]);
		expect(sql).toContain('snapshot."generatedAt" < $2::timestamptz');
		expect(sql).toContain('representative."generatedMonth" < $4::date');
	});
	test.each([
		['2026-10-31T21:00:00Z', '2026-11-01T03:00:00.000001Z', '2026-10-31T21:00:00.000Z', '2026-11-01T03:00:00.000Z'],
		['2026-11-01T06:00:00+09:00', '2026-11-01T12:00:00.000999+09:00', '2026-10-31T21:00:00.000Z', '2026-11-01T03:00:00.000Z'],
	])('U-30: accepts six hours plus sub-millisecond precision after normalization (%s, %s)', async (from, to, normalizedFrom, normalizedTo) => {
		const getTopicNotes = jest.fn(async (_params: unknown) => ({ notes: [] }));
		const endpoint = new TopicNotesEndpoint({ getTopicNotes } as never);
		await endpoint.exec({ from, to, term: 'legacy' }, null, null);
		expect(getTopicNotes).toHaveBeenCalledWith({ from: normalizedFrom, to: normalizedTo, term: 'legacy', topicId: undefined, me: null });
		await expect(endpoint.exec({ from, to: '2026-11-01T03:00:00.001Z', topicId: 'topic' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(getTopicNotes).toHaveBeenCalledTimes(1);
	});
	test.each(['+15:59', '-15:59'])('U-31: accepts the supported offset boundary %s and passes only UTC milliseconds', async offset => {
		const from = `2026-10-31T18:00:00${offset}`;
		const to = `2026-10-31T19:00:00.123999${offset}`;
		const getTopicNotes = jest.fn(async (_params: unknown) => ({ notes: [] }));
		const getHistory = jest.fn(async (_params: unknown) => ({ blocks: [], nextUntil: null }));
		await new TopicNotesEndpoint({ getTopicNotes } as never).exec({ from, to, topicId: 'topic' }, null, null);
		expect(getTopicNotes).toHaveBeenCalledWith({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), topicId: 'topic', term: undefined, me: null });
		await new HistoryEndpoint({ getHistory } as never).exec({ until: to, blocks: 1 }, null, null);
		expect(getHistory).toHaveBeenCalledWith({ until: new Date(to).toISOString(), blocks: 1, me: null });
	});
	test.each([
		'2026-10-31T18:00:00+16:00', '2026-10-31T18:00:00-16:00',
		'2026-10-31T18:00:00+23:59', '2026-10-31T18:00:00-23:59',
		'2026-10-31T18:00:00+15:60', 'not-a-date', '2026-02-29T18:00:00Z',
		'0000-01-01T00:00:00Z', '0001-01-01T00:00:00+15:59', '9999-12-31T23:59:59-15:59',
	])('U-31: rejects unnormalizable or PostgreSQL-incompatible date %s before either API reaches SQL', async invalid => {
		const getTopicNotes = jest.fn(async () => ({ notes: [] }));
		const getHistory = jest.fn(async () => ({ blocks: [], nextUntil: null }));
		const topicEndpoint = new TopicNotesEndpoint({ getTopicNotes } as never);
		await expect(topicEndpoint.exec({ from: invalid, to: '2026-10-31T19:00:00Z', topicId: 'topic' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', kind: 'client' });
		await expect(topicEndpoint.exec({ from: '2026-10-31T18:00:00Z', to: invalid, topicId: 'topic' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', kind: 'client' });
		await expect(new HistoryEndpoint({ getHistory } as never).exec({ until: invalid }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', kind: 'client' });
		expect(getTopicNotes).not.toHaveBeenCalled();
		expect(getHistory).not.toHaveBeenCalled();
	});
	test.each(['+16:00', '-16:00'])('U-31: both APIs return an explicit HTTP 400 for offset %s', async offset => {
		const invalid = `2026-10-31T18:00:00${offset}`;
		const getTopicNotes = jest.fn(async () => ({ notes: [] }));
		const getHistory = jest.fn(async () => ({ blocks: [], nextUntil: null }));
		await expect(new TopicNotesEndpoint({ getTopicNotes } as never).exec({ from: invalid, to: '2026-10-31T19:00:00Z', topicId: 'topic' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
		await expect(new HistoryEndpoint({ getHistory } as never).exec({ until: invalid }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
		expect(getTopicNotes).not.toHaveBeenCalled();
		expect(getHistory).not.toHaveBeenCalled();
	});
	test('U-31: normalization keeps leap days and UTC milliseconds for supported dates', () => {
		expect(normalizeHanamiTrendDateTime('2024-02-29T12:34:56.123456Z')).toBe('2024-02-29T12:34:56.123Z');
	});
});

describe('supported trend API date range (U-32)', () => {
	test.each([
		['0001-01-01T00:00:00Z', '0001-01-01T01:00:00Z', '0001-01-01T00:00:00Z'],
		['9999-12-30T00:00:00Z', '9999-12-30T01:00:00Z', '9999-12-30T00:00:00Z'],
		['1999-12-31T23:59:59.999Z', '2000-01-01T00:00:00Z', '1999-12-31T23:59:59.999Z'],
		['2099-12-31T23:59:59.999Z', '2100-01-01T00:00:00Z', '2100-01-01T00:00:00Z'],
		['2000-01-01T00:00:00+00:01', '2000-01-01T00:01:00+00:01', '2000-01-01T00:00:00+00:01'],
		['2099-12-31T23:59:00-00:01', '2100-01-01T00:00:00-00:01', '2099-12-31T23:59:00-00:01'],
		['2099-12-31T23:59:59.999Z', '2100-01-01T00:00:00.000500Z', '2100-01-01T00:00:00.000500Z'],
	])('U-32: rejects bounds outside 2000–2100 after normalization before querying (%s, %s)', async (from, to, until) => {
		const query = jest.fn(async () => []);
		const pack = jest.fn(async () => []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
		await expect(new TopicNotesEndpoint(service).exec({ from, to, topicId: 'topic' }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
		await expect(new HistoryEndpoint(service).exec({ until }, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
		expect(query).not.toHaveBeenCalled();
		expect(pack).not.toHaveBeenCalled();
	});
	test.each([
		['2000-01-01T00:00:00Z', '2000-01-01T00:00:00.001Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.001Z'],
		['1999-12-31T23:00:00-01:00', '1999-12-31T23:00:00.001999-01:00', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.001Z'],
		['2099-12-31T23:59:59.998Z', '2099-12-31T23:59:59.999999Z', '2099-12-31T23:59:59.998Z', '2099-12-31T23:59:59.999Z'],
		['2100-01-01T00:59:59.998+01:00', '2100-01-01T00:59:59.999999+01:00', '2099-12-31T23:59:59.998Z', '2099-12-31T23:59:59.999Z'],
	])('U-32: accepts normalized bounds at the inclusive lower and exclusive upper edges (%s, %s)', async (from, to, normalizedFrom, normalizedTo) => {
		const getTopicNotes = jest.fn(async (_params: unknown) => ({ notes: [] }));
		const getHistory = jest.fn(async (_params: unknown) => ({ blocks: [], nextUntil: null }));
		await new TopicNotesEndpoint({ getTopicNotes } as never).exec({ from, to, topicId: 'topic' }, null, null);
		expect(getTopicNotes).toHaveBeenCalledWith({ from: normalizedFrom, to: normalizedTo, topicId: 'topic', term: undefined, me: null });
		const endpoint = new HistoryEndpoint({ getHistory } as never);
		await endpoint.exec({ until: from }, null, null);
		await endpoint.exec({ until: to }, null, null);
		expect(getHistory.mock.calls).toEqual([[{ until: normalizedFrom, blocks: 2, me: null }], [{ until: normalizedTo, blocks: 2, me: null }]]);
	});
});
