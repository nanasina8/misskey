/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { HanamiForYouSafetyService } from './HanamiForYouSafetyService.js';

const CURSOR_PREFIX = 'hts1';
const PG_BIGINT_MAX = '9223372036854775807';
const TOPIC_NOTES_MAX = 20;
const TREND_DATE_TIME_MIN = Date.parse('2000-01-01T00:00:00Z');
const TREND_DATE_TIME_MAX = Date.parse('2100-01-01T00:00:00Z');

/** UTC milliseconds within the supported trend API date range. */
export function normalizeHanamiTrendDateTime(value: string): string | null {
	const date = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
	if (date == null) return null;
	const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
	if (offset != null && Number(offset[1]) > 15) return null;
	const [year, month, day] = date.slice(1, 4).map(Number);
	const calendar = new Date(0);
	calendar.setUTCFullYear(year, month - 1, day);
	if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp) || timestamp < TREND_DATE_TIME_MIN || timestamp >= TREND_DATE_TIME_MAX) return null;
	return new Date(timestamp).toISOString();
}

type TrendCursor = {
	ordinal: string;
	rank: string;
};

type TrendRow = {
	trend_entry_id: string;
	snapshot_id: string;
	snapshot_generated_at: Date | string;
	snapshot_ordinal: string;
	rank: string;
	term: string;
	topic_id: string | null;
	related_terms: string[];
	started_at: Date | string | null;
	daily: boolean;
	score: number;
	distinct_authors: number;
	recent_authors: number;
	representative_note_ids: string[];
};

export type HanamiTopicSeries = { at: string; authors: number }[];
export type HanamiTopicKind = 'new' | 'rising' | 'steady';

export function hanamiTopicKind(startedAt: string | null, at: string, recentAuthors: number, series: HanamiTopicSeries): HanamiTopicKind {
	const now = Date.parse(at);
	const age = startedAt == null ? Infinity : now - Date.parse(startedAt);
	if (age >= 0 && age <= 3600000) return 'new';
	const hourAgo = now - 3600000;
	const nearest = series.reduce<HanamiTopicSeries[number] | null>((best, point) => best == null
		|| Math.abs(Date.parse(point.at) - hourAgo) < Math.abs(Date.parse(best.at) - hourAgo) ? point : best, null);
	return nearest != null && recentAuthors >= nearest.authors * 2 && recentAuthors - nearest.authors >= 5 ? 'rising' : 'steady';
}

export type HanamiTopicResponse = {
	topicId: string; term: string; relatedTerms: string[]; startedAt: string | null; lastSeenAt: string;
	peakAuthors: number; series: HanamiTopicSeries; kind: HanamiTopicKind; active: boolean;
};

export type HanamiTrendSnapshotResult = {
	kind: 'ok';
	response: {
		items: Array<{
			trendEntryId: string;
			snapshotId: string;
			snapshotGeneratedAt: string;
			term: string;
			topicId: string | null;
			relatedTerms: string[];
			startedAt: string | null;
			score: number;
			distinctAuthors: number;
			representativeNote: Packed<'Note'> | null;
			series: HanamiTopicSeries;
			participants: Packed<'UserLite'>[];
			kind: HanamiTopicKind;
		}>;
		nextCursor: string | null;
		hasMore: boolean;
	};
} | {
	kind: 'invalidCursor' | 'cursorExpired';
};

export type HanamiTrendHistoryResponse = {
	blocks: { from: string; to: string; items: {
		topicId: string | null; term: string; relatedTerms: string[]; startedAt: string | null; daily: boolean;
		firstSeenAt: string; lastSeenAt: string; peakAuthors: number; representativeNote: Packed<'Note'> | null;
	}[] }[];
	nextUntil: string | null;
};

@Injectable()
export class HanamiTrendSnapshotService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,
		@Inject(DI.config)
		private config: Config,
		private safetyService: HanamiForYouSafetyService,
	) {}

	@bindThis
	public async getPage(input: {
		history: boolean;
		limit: number;
		cursor: string | null;
		me: MiLocalUser | null;
	}): Promise<HanamiTrendSnapshotResult> {
		let cursor: TrendCursor | null = null;
		if (input.cursor != null) {
			try {
				cursor = this.decodeCursor(input.cursor);
			} catch (error) {
				return { kind: error instanceof TrendCursorKeyExpiredError ? 'cursorExpired' : 'invalidCursor' };
			}
		}

		const limit = Math.min(30, Math.max(1, input.limit));
		const values: unknown[] = [limit + 1];
		let boundarySql = '';
		let snapshotSql = '';
		if (input.history) {
			if (cursor != null) {
				values.push(cursor.ordinal, cursor.rank);
				boundarySql = `AND (snapshot."ordinal" < $2::bigint OR (snapshot."ordinal" = $2::bigint AND entry."rank" > $3::bigint))`;
			}
		} else {
			snapshotSql = `AND snapshot."id" = (SELECT latest."id" FROM "hanami_trend_snapshot" latest JOIN "hanami_common_generation" latest_generation ON latest_generation."id" = latest."commonGenerationId" AND latest_generation."status" = 'ready' WHERE latest."status" = 'ready' ORDER BY latest."ordinal" DESC LIMIT 1)`;
		}

		const rows = await this.db.query(`
			SELECT entry."id" AS trend_entry_id, snapshot."id" AS snapshot_id,
				snapshot."generatedAt" AS snapshot_generated_at, snapshot."ordinal"::text AS snapshot_ordinal,
				entry."rank"::text AS rank, entry."term" AS term, entry."score" AS score,
				entry."distinctAuthors" AS distinct_authors,
				entry."recentAuthors" AS recent_authors,
				entry."topicId" AS topic_id, entry."relatedTerms" AS related_terms,
				entry."startedAt" AS started_at, entry."daily" AS daily,
				ARRAY(
					SELECT representative."noteId"
					FROM "hanami_trend_snapshot_representative_note" representative
					WHERE representative."snapshotId" = snapshot."id" AND representative."rank" = entry."rank"
					ORDER BY representative."position" ASC
				) AS representative_note_ids
			FROM "hanami_trend_snapshot_entry" entry
			JOIN "hanami_trend_snapshot" snapshot ON snapshot."id" = entry."snapshotId" AND snapshot."status" = 'ready'
			JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
			WHERE (entry."topicId" IS NULL OR EXISTS (
				SELECT 1 FROM "hanami_trend_snapshot_representative_note" representative
				WHERE representative."snapshotId" = entry."snapshotId" AND representative."rank" = entry."rank"
					AND representative."generatedMonth" = entry."generatedMonth"
			)) ${snapshotSql} ${boundarySql}
			ORDER BY snapshot."ordinal" DESC, entry."rank" ASC
			LIMIT $1
		`, values) as TrendRow[];
		const hasMore = input.history && rows.length > limit;
		const pageRows = rows.slice(0, limit);
		const representativeIds = [...new Set(pageRows.flatMap(row => row.representative_note_ids))];
		const packed = await this.safetyService.filterAndPackPublic(representativeIds, input.me);
		const packedById = new Map(packed.map(note => [note.id, note]));
		const series = await this.getSeries(pageRows.map(row => ({ topicId: row.topic_id, at: this.toIsoString(row.snapshot_generated_at) })));
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last != null ? this.encodeCursor({ ordinal: last.snapshot_ordinal, rank: last.rank }) : null;

		return {
			kind: 'ok',
			response: {
				items: pageRows.map((row, index) => ({
					trendEntryId: row.trend_entry_id,
					snapshotId: row.snapshot_id,
					snapshotGeneratedAt: this.toIsoString(row.snapshot_generated_at),
					term: row.term,
					topicId: row.topic_id ?? null,
					relatedTerms: row.related_terms ?? [],
					startedAt: row.started_at == null ? null : this.toIsoString(row.started_at),
					score: Number(row.score),
					distinctAuthors: Number(row.distinct_authors),
					representativeNote: row.representative_note_ids.map(id => packedById.get(id)).find(note => note != null) ?? null,
					series: series[index],
					participants: [...new Map(row.representative_note_ids.flatMap(id => {
						const note = packedById.get(id);
						return note == null ? [] : [[note.user.id, note.user] as const];
					})).values()].slice(0, 3),
					kind: hanamiTopicKind(row.started_at == null ? null : this.toIsoString(row.started_at), this.toIsoString(row.snapshot_generated_at), Number(row.recent_authors), series[index]),
				})),
				nextCursor,
				hasMore: nextCursor != null,
			},
		};
	}

	/** Chronological series anchored to each entry, including only published snapshots. */
	private async getSeries(topics: { topicId: string | null; at: string }[]): Promise<HanamiTopicSeries[]> {
		const result = topics.map(() => [] as HanamiTopicSeries);
		if (!topics.some(topic => topic.topicId != null)) return result;
		const times = topics.filter(topic => topic.topicId != null).map(topic => Date.parse(topic.at));
		const from = new Date(Math.min(...times) - 6 * 60 * 60 * 1000);
		const to = new Date(Math.max(...times));
		const months = [new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)).toISOString().slice(0, 10),
			new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)];
		const rows = await this.db.query<Array<{ selected_index: number; at: Date | string; authors: number }>>(`
			WITH points AS (
				SELECT selected.selected_index, snapshot."generatedAt" AS at, entry."recentAuthors" AS authors,
					ROW_NUMBER() OVER (PARTITION BY selected.selected_index ORDER BY snapshot."generatedAt" DESC, snapshot."ordinal" DESC) AS position
				FROM jsonb_to_recordset($1::jsonb) AS selected(selected_index integer, topic_id varchar(32), at timestamptz)
				JOIN "hanami_trend_snapshot_entry" entry ON entry."topicId" = selected.topic_id
				JOIN "hanami_trend_snapshot" snapshot ON snapshot."id" = entry."snapshotId" AND snapshot."status" = 'ready'
				JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
				WHERE snapshot."generatedAt" >= selected.at - INTERVAL '6 hours' AND snapshot."generatedAt" <= selected.at
					AND entry."generatedMonth" >= $2::date AND entry."generatedMonth" < $3::date
			)
			SELECT selected_index, at, authors FROM points WHERE position <= 36 ORDER BY selected_index, at, position DESC
		`, [JSON.stringify(topics.map((topic, index) => ({ selected_index: index, topic_id: topic.topicId, at: topic.at }))), ...months]);
		for (const row of rows) result[row.selected_index].push({ at: this.toIsoString(row.at), authors: Number(row.authors) });
		return result;
	}

	@bindThis
	public async getTopic(topicId: string): Promise<HanamiTopicResponse | null> {
		const rows = await this.db.query<Array<{
			term: string; related_terms: string[]; started_at: Date | string | null; at: Date | string; recent_authors: number; peak_authors: number; active: boolean;
		}>>(`
			WITH retained_months AS (
				SELECT date_trunc('month', MIN(snapshot."generatedAt") AT TIME ZONE 'UTC')::date AS from_month,
					(date_trunc('month', MAX(snapshot."generatedAt") AT TIME ZONE 'UTC') + INTERVAL '1 month')::date AS to_month
				FROM "hanami_trend_snapshot" snapshot
				JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
				WHERE snapshot."status" = 'ready'
			), latest_ready AS (
				SELECT snapshot."id" AS id,
					date_trunc('month', snapshot."generatedAt" AT TIME ZONE 'UTC')::date AS generated_month
				FROM "hanami_trend_snapshot" snapshot
				JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
				WHERE snapshot."status" = 'ready' ORDER BY snapshot."ordinal" DESC LIMIT 1
			), observations AS (
				SELECT entry.*, snapshot."generatedAt" AS at, snapshot."ordinal" AS ordinal,
					MAX(entry."distinctAuthors") OVER () AS peak_authors
				FROM "hanami_trend_snapshot_entry" entry
				JOIN "hanami_trend_snapshot" snapshot ON snapshot."id" = entry."snapshotId" AND snapshot."status" = 'ready'
				JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
				WHERE entry."topicId" = $1
					AND entry."generatedMonth" >= (SELECT from_month FROM retained_months)
					AND entry."generatedMonth" < (SELECT to_month FROM retained_months)
			)
			SELECT "term" AS term, "relatedTerms" AS related_terms, "startedAt" AS started_at, at,
				"recentAuthors" AS recent_authors, peak_authors,
				EXISTS (SELECT 1 FROM "hanami_trend_snapshot_entry" current_entry
					WHERE current_entry."topicId" = $1 AND current_entry."snapshotId" = (SELECT id FROM latest_ready)
						AND current_entry."generatedMonth" = (SELECT generated_month FROM latest_ready)) AS active
			FROM observations ORDER BY at DESC, ordinal DESC, "rank" ASC LIMIT 1
		`, [topicId]);
		const row = rows[0];
		if (row == null) return null;
		const at = this.toIsoString(row.at);
		const startedAt = row.started_at == null ? null : this.toIsoString(row.started_at);
		const [series] = await this.getSeries([{ topicId, at }]);
		return { topicId, term: row.term, relatedTerms: row.related_terms, startedAt, lastSeenAt: at,
			peakAuthors: Number(row.peak_authors), series, kind: hanamiTopicKind(startedAt, at, Number(row.recent_authors), series), active: row.active };
	}

	@bindThis
	public async getMemberNotes(input: { topicId: string; sort: 'popular' | 'recent'; limit: number; offset: number; me: MiLocalUser | null }): Promise<Packed<'Note'>[]> {
		const noteJoin = input.sort === 'popular' ? `CROSS JOIN LATERAL (
			SELECT n."reactions", n."renoteCount", n."repliesCount"
			FROM "note" n WHERE n."id" = member."noteId"
		) note` : '';
		const order = input.sort === 'popular' ? `(
			COALESCE((SELECT SUM(reaction.value::double precision) FROM jsonb_each_text(note."reactions"::jsonb) reaction), 0)
			+ note."renoteCount" + note."repliesCount"
		) * POWER(0.5::double precision, EXTRACT(EPOCH FROM (statement_timestamp() - member."noteCreatedAt")) / 43200.0) DESC,` : '';
		const rows = await this.db.query<Array<{ note_id: string }>>(`
			SELECT member."noteId" AS note_id FROM "hanami_trend_topic_note" member
			${noteJoin}
			WHERE member."topicId" = $1
			ORDER BY ${order} member."noteCreatedAt" DESC, member."noteId" DESC LIMIT $2 OFFSET $3
		`, [input.topicId, input.limit, input.offset]);
		const ids = rows.map(row => row.note_id);
		if (ids.length === 0) return [];
		const packed = await this.safetyService.filterAndPackPublic(ids, input.me);
		const byId = new Map(packed.map(note => [note.id, note]));
		return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
	}

	/** Six-hour JST blocks, with one row per continuing topic in each block. */
	@bindThis
	public async getHistory(input: { until?: string; blocks: number; me: MiLocalUser | null }): Promise<HanamiTrendHistoryResponse> {
		const blockMs = 6 * 60 * 60 * 1000;
		const jstMs = 9 * 60 * 60 * 1000;
		const boundary = input.until == null ? Date.now() : Date.parse(input.until) - 1;
		const newestFrom = Math.floor((boundary + jstMs) / blockMs) * blockMs - jstMs;
		const oldestFrom = newestFrom - (input.blocks - 1) * blockMs;
		const fromMonth = new Date(oldestFrom);
		const toMonth = new Date(newestFrom + blockMs - 1);
		const months = [new Date(Date.UTC(fromMonth.getUTCFullYear(), fromMonth.getUTCMonth(), 1)).toISOString().slice(0, 10),
			new Date(Date.UTC(toMonth.getUTCFullYear(), toMonth.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)];
		type HistoryRow = {
			block_from: Date | string; snapshot_id: string; rank: string;
			topic_id: string | null; term: string; related_terms: string[]; started_at: Date | string | null; daily: boolean;
			first_seen_at: Date | string; last_seen_at: Date | string; peak_authors: number;
		};
		const rows = await this.db.query<HistoryRow[]>(`
			WITH observations AS (
				SELECT snapshot."id" AS snapshot_id, snapshot."generatedAt" AS generated_at,
					snapshot."ordinal" AS ordinal, entry."rank"::text AS rank,
					entry."term" AS term, entry."topicId" AS topic_id, entry."relatedTerms" AS related_terms,
					entry."startedAt" AS started_at, entry."daily" AS daily, entry."distinctAuthors" AS authors,
					date_bin(INTERVAL '6 hours', snapshot."generatedAt", TIMESTAMPTZ '1970-01-01 00:00:00+09') AS block_from,
					CASE WHEN entry."topicId" IS NULL THEN 'term:' || entry."term" ELSE 'topic:' || entry."topicId" END AS topic_key
				FROM "hanami_trend_snapshot_entry" entry
				JOIN "hanami_trend_snapshot" snapshot ON snapshot."id" = entry."snapshotId" AND snapshot."status" = 'ready'
				JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
				WHERE snapshot."generatedAt" >= $1 AND snapshot."generatedAt" < $2
					AND entry."generatedMonth" >= $3::date AND entry."generatedMonth" < $4::date
					AND (entry."topicId" IS NULL OR EXISTS (
						SELECT 1 FROM "hanami_trend_snapshot_representative_note" representative
						WHERE representative."snapshotId" = entry."snapshotId" AND representative."rank" = entry."rank"
							AND representative."generatedMonth" = entry."generatedMonth"
					))
			), topics AS (
				SELECT *, MIN(generated_at) OVER topic AS first_seen_at, MAX(generated_at) OVER topic AS last_seen_at,
					MAX(authors) OVER topic AS peak_authors,
					ROW_NUMBER() OVER (PARTITION BY block_from, topic_key ORDER BY generated_at DESC, ordinal DESC, rank::bigint DESC) AS latest
				FROM observations WINDOW topic AS (PARTITION BY block_from, topic_key)
			), ranked AS (
				SELECT *, ROW_NUMBER() OVER (PARTITION BY block_from ORDER BY daily ASC, peak_authors DESC, last_seen_at DESC) AS block_rank
				FROM topics WHERE latest = 1
			)
			SELECT block_from, snapshot_id, rank, topic_id, term, related_terms, started_at, daily,
				first_seen_at, last_seen_at, peak_authors
			FROM ranked WHERE block_rank <= 15 ORDER BY block_from DESC, block_rank
		`, [new Date(oldestFrom).toISOString(), new Date(newestFrom + blockMs).toISOString(), ...months]);
		const representatives = rows.length === 0 ? [] : await this.db.query<Array<{ snapshot_id: string; rank: string; note_id: string }>>(`
			SELECT representative."snapshotId" AS snapshot_id, representative."rank"::text AS rank, representative."noteId" AS note_id
			FROM "hanami_trend_snapshot_representative_note" representative
			JOIN jsonb_to_recordset($1::jsonb) AS selected(snapshot_id varchar(32), rank bigint)
				ON selected.snapshot_id = representative."snapshotId" AND selected.rank = representative."rank"
			WHERE representative."generatedMonth" >= $2::date AND representative."generatedMonth" < $3::date
			ORDER BY representative."snapshotId", representative."rank", representative."position"
		`, [JSON.stringify(rows.map(row => ({ snapshot_id: row.snapshot_id, rank: row.rank }))), ...months]);
		const noteIds = new Map<string, string[]>();
		for (const row of representatives) {
			const key = `${row.snapshot_id}:${row.rank}`;
			const ids = noteIds.get(key) ?? [];
			ids.push(row.note_id); noteIds.set(key, ids);
		}
		const grouped = Array.from({ length: input.blocks }, (_, index) => {
			const from = newestFrom - index * blockMs;
			return { from: new Date(from).toISOString(), to: new Date(from + blockMs).toISOString(),
				items: rows.filter(row => Date.parse(this.toIsoString(row.block_from)) === from) };
		});
		const ids = [...new Set(representatives.map(row => row.note_id))];
		const packed = await this.safetyService.filterAndPackPublic(ids, input.me);
		const byId = new Map(packed.map(note => [note.id, note]));
		const older = await this.db.query(`SELECT EXISTS (
			SELECT 1 FROM "hanami_trend_snapshot" snapshot
			JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
			WHERE snapshot."status" = 'ready' AND snapshot."generatedAt" < $1
		) AS exists`, [new Date(oldestFrom).toISOString()]) as { exists: boolean }[];
		return {
			blocks: grouped.map(block => ({ from: block.from, to: block.to, items: block.items.map(item => ({
				topicId: item.topic_id, term: item.term, relatedTerms: item.related_terms,
				startedAt: item.started_at == null ? null : this.toIsoString(item.started_at), daily: item.daily,
				firstSeenAt: this.toIsoString(item.first_seen_at), lastSeenAt: this.toIsoString(item.last_seen_at), peakAuthors: Number(item.peak_authors),
				representativeNote: (noteIds.get(`${item.snapshot_id}:${item.rank}`) ?? []).map(id => byId.get(id)).find(note => note != null) ?? null,
			})) })),
			nextUntil: older[0]?.exists ? new Date(oldestFrom).toISOString() : null,
		};
	}

	/** Saved posts across all ready observations of a topic in one history block. */
	@bindThis
	public async getTopicNotes(input: { from: string; to: string; topicId?: string; term?: string; me: MiLocalUser | null }): Promise<{ notes: Packed<'Note'>[] }> {
		const from = new Date(input.from);
		const to = new Date(input.to);
		const months = [new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)).toISOString().slice(0, 10),
			new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)];
		const topicSql = input.topicId != null ? 'entry."topicId" = $5' : 'entry."topicId" IS NULL AND entry."term" = $5';
		const rows = await this.db.query<Array<{ note_id: string }>>(`
			WITH ranked_notes AS (
				SELECT representative."noteId" AS note_id, snapshot."generatedAt" AS generated_at,
					snapshot."ordinal" AS ordinal, representative."position" AS position,
					ROW_NUMBER() OVER (PARTITION BY representative."noteId"
						ORDER BY snapshot."generatedAt" DESC, snapshot."ordinal" DESC, representative."position" ASC) AS occurrence
				FROM "hanami_trend_snapshot_entry" entry
				JOIN "hanami_trend_snapshot" snapshot ON snapshot."id" = entry."snapshotId" AND snapshot."status" = 'ready'
				JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
				JOIN "hanami_trend_snapshot_representative_note" representative
					ON representative."snapshotId" = entry."snapshotId" AND representative."rank" = entry."rank"
					AND representative."generatedMonth" = entry."generatedMonth"
				WHERE snapshot."generatedAt" >= $1::timestamptz AND snapshot."generatedAt" < $2::timestamptz
					AND entry."generatedMonth" >= $3::date AND entry."generatedMonth" < $4::date
					AND representative."generatedMonth" >= $3::date AND representative."generatedMonth" < $4::date
					AND ${topicSql}
			)
			SELECT note_id FROM ranked_notes WHERE occurrence = 1
			ORDER BY generated_at DESC, ordinal DESC, position ASC LIMIT $6
		`, [from.toISOString(), to.toISOString(), ...months, input.topicId ?? input.term, TOPIC_NOTES_MAX]);
		const ids = [...new Set(rows.map(row => row.note_id))].slice(0, TOPIC_NOTES_MAX);
		if (ids.length === 0) return { notes: [] };
		const packed = await this.safetyService.filterAndPackPublic(ids, input.me);
		const byId = new Map(packed.map(note => [note.id, note]));
		return { notes: ids.flatMap(id => {
			const note = byId.get(id);
			return note == null ? [] : [note];
		}) };
	}

	private toIsoString(value: Date | string): string {
		return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
	}

	private encodeCursor(cursor: TrendCursor): string {
		this.validateDecimal(cursor.ordinal);
		this.validateDecimal(cursor.rank);
		const key = this.config.hanamiCursorSigningKeys[0]!;
		const payload = Buffer.from(JSON.stringify(['HTS', 1, key.id, 'history', cursor.ordinal, cursor.rank]), 'utf8').toString('base64url');
		const input = `${CURSOR_PREFIX}.${payload}`;
		const signature = createHmac('sha256', key.secret).update(input, 'ascii').digest('base64url');
		return `${input}.${signature}`;
	}

	private decodeCursor(cursor: string): TrendCursor {
		const parts = cursor.split('.');
		if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX || parts[1]!.includes('=') || parts[2]!.includes('=')) throw new Error('Invalid trend cursor');
		const payloadBuffer = Buffer.from(parts[1]!, 'base64url');
		if (payloadBuffer.toString('base64url') !== parts[1]) throw new Error('Non-canonical trend cursor');
		const value = JSON.parse(payloadBuffer.toString('utf8')) as unknown;
		if (!Array.isArray(value) || value.length !== 6 || value[0] !== 'HTS' || value[1] !== 1
			|| typeof value[2] !== 'string' || value[3] !== 'history' || typeof value[4] !== 'string' || typeof value[5] !== 'string') {
			throw new Error('Invalid trend cursor payload');
		}
		const key = this.config.hanamiCursorSigningKeys.find(candidate => candidate.id === value[2]);
		if (key == null) throw new TrendCursorKeyExpiredError();
		const expected = createHmac('sha256', key.secret).update(`${CURSOR_PREFIX}.${parts[1]}`, 'ascii').digest();
		const signature = Buffer.from(parts[2]!, 'base64url');
		if (signature.toString('base64url') !== parts[2] || signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('Invalid trend cursor signature');
		this.validateDecimal(value[4]);
		this.validateDecimal(value[5]);
		return { ordinal: value[4], rank: value[5] };
	}

	private validateDecimal(value: string): void {
		if (!/^(?:0|[1-9]\d*)$/.test(value) || value.length > PG_BIGINT_MAX.length || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
			throw new Error('Invalid trend cursor decimal');
		}
	}
}

class TrendCursorKeyExpiredError extends Error {}
