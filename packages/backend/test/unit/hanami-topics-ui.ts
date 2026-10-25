/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, vi as jest, test } from 'vitest';
import { HanamiTrendSnapshotService, hanamiTopicKind } from '@/core/hanami/HanamiTrendSnapshotService.js';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import TopicEndpoint, { meta as topicMeta } from '@/server/api/endpoints/notes/hanami-topic.js';
import NotesEndpoint, { meta as notesMeta } from '@/server/api/endpoints/notes/hanami-topic-notes.js';
import TrendsEndpoint from '@/server/api/endpoints/notes/hanami-trends.js';

const at = '2026-10-07T12:00:00.000Z';
const before = (ms: number) => new Date(Date.parse(at) - ms).toISOString();
afterEach(() => { jest.restoreAllMocks(); });

describe('V-1: topic membership schema and retention', () => {
	test('migration up/down creates the compound key, cascade, TTL index and recent author default', async () => {
		const filename = new URL('../../migration/1791331201000-hanamiTopicMembers.js', import.meta.url);
		const source = readFileSync(filename, 'utf8').replace('export class', 'class');
		const migration = new Function(`${source}; return new HanamiTopicMembers1791331201000();`)() as { up(runner: unknown): Promise<void>; down(runner: unknown): Promise<void> };
		const query = jest.fn(async (_sql: string) => undefined);
		await migration.up({ query });
		expect(query.mock.calls).toHaveLength(5);
		expect(query.mock.calls[0][0]).toContain('PRIMARY KEY ("topicId", "noteId")');
		expect(query.mock.calls[0][0]).toContain('REFERENCES "note"("id") ON DELETE CASCADE');
		expect(query.mock.calls[1][0]).toContain('("addedAt")');
		expect(query.mock.calls[0][0]).toContain('"noteCreatedAt" timestamptz NOT NULL');
		expect(query.mock.calls[2][0]).toContain('("noteId")');
		expect(query.mock.calls[3][0]).toContain('("topicId", "noteCreatedAt" DESC, "noteId" DESC)');
		expect(query.mock.calls[4][0]).toContain('"recentAuthors" integer NOT NULL DEFAULT 0');
		await migration.down({ query });
		expect(query.mock.calls.slice(5).map(call => call[0])).toEqual([
			'ALTER TABLE "hanami_trend_snapshot_entry" DROP COLUMN "recentAuthors"', 'DROP TABLE "hanami_trend_topic_note"',
		]);
	});
	test('hourly topic sweep preserves the exact 30-day boundary', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(Date.parse(at));
		const query = jest.fn(async (_sql: string, _values: unknown[]) => []);
		const service = Object.create(HanamiForYouBatchService.prototype) as HanamiForYouBatchService;
		Object.assign(service, { db: { query } });
		await service.cleanupTopicNotes();
		expect(query).toHaveBeenCalledWith('DELETE FROM "hanami_trend_topic_note" WHERE "addedAt" < $1::timestamptz', [before(30 * 86400000)]);
		expect(query.mock.calls[0][0]).not.toContain('clock_timestamp');
	});
});

describe('V-2: topic momentum and visible participants', () => {
	test.each([
		[0, 10, 20, 'new'], [3600000, 10, 20, 'new'], [3600001, 10, 20, 'rising'],
		[7200000, 10, 19, 'steady'], [7200000, 4, 8, 'steady'], [7200000, 4, 9, 'rising'],
		[7200000, 0, 4, 'steady'], [7200000, 0, 5, 'rising'],
	])('age %s, prior %s, current %s gives %s', (age, prior, current, kind) => {
		expect(hanamiTopicKind(before(age as number), at, current as number, [{ at: before(3600000), authors: prior as number }, { at, authors: current as number }])).toBe(kind);
	});
	test('uses the nearest chronological point, breaking equal distance toward the older point; missing history is steady', () => {
		expect(hanamiTopicKind(before(7200000), at, 10, [{ at: before(4200000), authors: 5 }, { at: before(3000000), authors: 8 }, { at, authors: 10 }])).toBe('rising');
		expect(hanamiTopicKind(null, at, 10, [])).toBe('steady');
		expect(hanamiTopicKind(before(-1), at, 1, [])).toBe('steady');
	});
	test('returns series, first safe representative and at most three distinct safe authors in representative order; current honors limit 30', async () => {
		const base = { trend_entry_id: 'entry', snapshot_id: 'snapshot', snapshot_generated_at: at, snapshot_ordinal: '1', rank: '0',
			term: 'topic', topic_id: 'topic', related_terms: [], started_at: before(7200000), daily: false, score: 1, distinct_authors: 20, recent_authors: 10,
			representative_note_ids: ['unsafe', 'a', 'a2', 'b', 'c', 'd'] };
		const query = jest.fn(async (sql: string, _values: unknown[]) => sql.includes('WITH points') ? [
			{ selected_index: 0, at: before(3600000), authors: 5 }, { selected_index: 0, at, authors: 10 },
		] : [base, { ...base, topic_id: null, rank: '1', representative_note_ids: [] }]);
		const pack = jest.fn(async () => ['d', 'c', 'b', 'a2', 'a'].map(id => ({ id, user: { id: id === 'a2' ? 'a' : id } })));
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
		const response = await new TrendsEndpoint(service).exec({ limit: 30 }, null, null);
		expect(query.mock.calls[0][1]).toEqual([31]);
		expect(query.mock.calls[0][0]).toContain('entry."recentAuthors"');
		expect(query.mock.calls[0][0]).toContain('WHERE (entry."topicId" IS NULL OR EXISTS (');
		expect(query.mock.calls[1][0]).toContain("selected.at - INTERVAL '6 hours'");
		expect(query.mock.calls[1][0]).toContain('position <= 36');
		expect(query.mock.calls[1][0]).toContain('entry."generatedMonth" >= $2::date AND entry."generatedMonth" < $3::date');
		expect(query.mock.calls[1][1].slice(1)).toEqual(['2026-10-01', '2026-11-01']);
		expect(query.mock.calls[1][0]).toContain("generation.\"status\" = 'ready'");
		expect(response.items[0]).toMatchObject({ representativeNote: { id: 'a' }, participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], kind: 'rising', series: [{ at: before(3600000), authors: 5 }, { at, authors: 10 }] });
		expect(response.items[1].series).toEqual([]);
	});
});

describe('V-3: public topic metadata', () => {
	test.each([true, false])('returns newest metadata, all-time peak and active=%s', async active => {
		const query = jest.fn(async (sql: string) => sql.includes('WITH points') ? [] : [{ term: 'title', related_terms: ['related'], started_at: before(3600000), at, recent_authors: 7, peak_authors: 45, active }]);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, {} as never);
		expect(await new TopicEndpoint(service).exec({ topicId: 'topic' }, null, null)).toEqual({ topicId: 'topic', term: 'title', relatedTerms: ['related'], startedAt: before(3600000), lastSeenAt: at, peakAuthors: 45, series: [], kind: 'new', active });
		expect(query.mock.calls[0][0]).toContain('MAX(entry."distinctAuthors") OVER ()');
		expect(query.mock.calls[0][0]).toContain('ORDER BY at DESC, ordinal DESC');
		expect(query.mock.calls[0][0]).toContain('WHERE entry."topicId" = $1');
		expect(query.mock.calls[0][0]).toContain('entry."generatedMonth" >= (SELECT from_month FROM retained_months)');
		expect(query.mock.calls[0][0]).toContain('entry."generatedMonth" < (SELECT to_month FROM retained_months)');
		expect(query.mock.calls[0][0]).not.toContain('hanami_trend_snapshot_representative_note');
		expect(topicMeta).toMatchObject({ requireCredential: false, allowGet: true });
	});
		test('unknown IDs return NO_SUCH_TOPIC without querying graph points', async () => {
		const query = jest.fn(async () => []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, {} as never);
		await expect(new TopicEndpoint(service).exec({ topicId: 'missing' }, null, null)).rejects.toMatchObject({ code: 'NO_SUCH_TOPIC', httpStatusCode: 404 });
		expect(query).toHaveBeenCalledTimes(1);
	});
	test('V-13: a six-hour window crossing a UTC month includes both months', async () => {
		const query = jest.fn(async (sql: string, _values: unknown[]) => sql.includes('WITH points') ? [] : [{ term: 'title', related_terms: [], started_at: null, at: '2026-11-01T02:00:00Z', recent_authors: 7, peak_authors: 45, active: true }]);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, {} as never);
		await service.getTopic('topic');
		expect(query.mock.calls[1][1].slice(1)).toEqual(['2026-10-01', '2026-12-01']);
		expect(query.mock.calls[0][0]).toContain('current_entry."generatedMonth" = (SELECT generated_month FROM latest_ready)');
		const migration = readFileSync(new URL('../../migration/1791244800000-hanamiTrendTopics.js', import.meta.url), 'utf8');
		expect(migration).toContain('IDX_hanami_trend_snapshot_entry_topic');
		expect(migration).toContain('("topicId")');
	});
});

describe('V-4: public member posts', () => {
	test.each(['popular', 'recent'] as const)('V-11: %s reads one SQL page from 10,000 members without transferring all IDs to TS', async sort => {
		const members = Array.from({ length: 10000 }, (_, i) => ({ note_id: 'member-' + i }));
		const query = jest.fn(async (sql: string, values: unknown[]) => {
			expect(sql).toContain('LIMIT $2 OFFSET $3');
			expect(sql).toContain('WHERE member."topicId" = $1');
			expect(values).toEqual(['topic', 30, 480]);
			return members.slice(values[2] as number, (values[2] as number) + (values[1] as number));
		});
		const pack = jest.fn(async (ids: string[], _me: unknown) => ids.slice(1).reverse().map(id => ({ id })));
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
		const me = { id: 'me' } as never;
		const response = await new NotesEndpoint(service).exec({ topicId: 'topic', sort, limit: 30, offset: 480 }, me, null);
		expect(query).toHaveBeenCalledTimes(1);
		expect(response.map((note: { id: string }) => note.id)).toEqual(members.slice(481, 510).map(member => member.note_id));
		expect(pack).toHaveBeenCalledWith(members.slice(480, 510).map(member => member.note_id), me);
		const sql = query.mock.calls[0][0];
		expect(sql).toContain('member."noteCreatedAt" DESC, member."noteId" DESC LIMIT $2 OFFSET $3');
		expect(sql).not.toContain('unnest');
		if (sort === 'popular') {
			expect(sql.replace(/\s+/g, ' ')).toContain('CROSS JOIN LATERAL ( SELECT n."reactions", n."renoteCount", n."repliesCount" FROM "note" n WHERE n."id" = member."noteId" ) note');
			expect(sql).not.toContain('JOIN "note" note ON');
			expect(sql).toContain('jsonb_each_text(note."reactions"::jsonb)');
			expect(sql).toContain('note."renoteCount" + note."repliesCount"');
			expect(sql).toContain('statement_timestamp() - member."noteCreatedAt"');
			expect(sql).toContain('/ 43200.0');
		} else {
			expect(sql).not.toContain('LATERAL');
			expect(sql).not.toContain('JOIN "note"');
			expect(sql).not.toContain('POWER(');
		}
		expect(notesMeta).toMatchObject({ requireCredential: false, allowGet: true });
	});
	test('default sort/limit/offset use popular/20/0', async () => {
		const query = jest.fn(async (_sql: string, _values: unknown[]) => []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, {} as never);
		await new NotesEndpoint(service).exec({ topicId: 'topic' }, null, null);
		expect(query.mock.calls[0][1]).toEqual(['topic', 20, 0]);
		expect(query.mock.calls[0][0]).toContain('POWER(');
	});
	test.each([
		{}, { topicId: '' }, { topicId: 'x'.repeat(33) }, { topicId: 't', sort: 'score' },
		{ topicId: 't', limit: 0 }, { topicId: 't', limit: 31 }, { topicId: 't', limit: 1.5 },
		{ topicId: 't', offset: -1 }, { topicId: 't', offset: 481 }, { topicId: 't', offset: 0.5 }, { topicId: 't', offset: '0' },
	])('rejects invalid params %j before reading membership', async input => {
		const getMemberNotes = jest.fn(async () => []);
		await expect(new NotesEndpoint({ getMemberNotes } as never).exec(input, null, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(getMemberNotes).not.toHaveBeenCalled();
	});
	test('empty membership returns no posts after one SQL query without packing', async () => {
		const query = jest.fn(async () => []);
		const pack = jest.fn(async () => []);
		const service = new HanamiTrendSnapshotService({ query } as never, {} as never, { filterAndPackPublic: pack } as never);
		expect(await new NotesEndpoint(service).exec({ topicId: 'missing' }, null, null)).toEqual([]);
		expect(query).toHaveBeenCalledTimes(1);
		expect(pack).not.toHaveBeenCalled();
	});
});
