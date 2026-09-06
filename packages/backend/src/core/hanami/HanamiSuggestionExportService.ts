/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { createHanamiSuggestionExportId, decodeHanamiSuggestionExportCursor, encodeHanamiSuggestionExportCursor, HanamiSuggestionExportCodecError, pseudonymizeHanamiSuggestionExportId } from './HanamiSuggestionExportCodec.js';

const MAX_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
const EXPORT_MS = 60 * 60 * 1000;
type Row = { event_id: string; event_user_id: string; note_id: string; author_id: string; event_type: string; feed_kind: string | null; source: string | null; occurred_at: Date | null; created_at: Date };
const EVENT_TYPES = ['served', 'seen', 'reaction', 'reply', 'renote'] as const;
const FEED_KINDS = ['personal', 'common', 'userRecommendation'] as const;
const SOURCES = ['globalPopular', 'neighborTrending', 'reactionSimilar', 'catchup', 'trending', 'fof', 'exploration', 'normal'] as const;
type EventType = (typeof EVENT_TYPES)[number];
type FeedKind = (typeof FEED_KINDS)[number];
type Source = (typeof SOURCES)[number];
type Origin = 'commonCandidate' | 'personalCandidate' | 'userRecommendation' | null;
/** Only export-scoped pseudonyms, a coarse bucket, outcome flags, and allowlisted categorical provenance leave this service. */
export type HanamiSuggestionExportEvent = Readonly<{ user: string; note: string; author: string; timeBucket: string; eventType: EventType; feedKind: FeedKind | null; source: Source | null; sources: Source[]; origin: Origin; reactionOutcome: boolean; replyOutcome: boolean; renoteOutcome: boolean }>;
export type HanamiSuggestionExportPage = Readonly<{ exportId: string; expiresAt: string; events: HanamiSuggestionExportEvent[]; cursor: string | null; hasMore: boolean }>;

export class HanamiSuggestionExportError extends Error {
	public constructor(public readonly code: 'FORBIDDEN' | 'INVALID_REQUEST' | 'INVALID_CURSOR' | 'EXPIRED_CURSOR') { super(code); }
}

@Injectable()
export class HanamiSuggestionExportService {
	public constructor(
		@Inject(DI.db) private dataSource: DataSource,
		@Inject(DI.config) private config: Config,
		private moderationLogService: ModerationLogService,
	) { }

	public async export(actor: { id: string; isAdmin: boolean }, input: { startAt?: string; endAt?: string; limit?: number; cursor?: string }, now = new Date()): Promise<HanamiSuggestionExportPage> {
		if (!actor.isAdmin) throw new HanamiSuggestionExportError('FORBIDDEN');
		let state: import('./HanamiSuggestionExportCodec.js').HanamiSuggestionExportCursor;
		let firstPage = false;
		if (input.cursor != null) {
			if (input.startAt !== undefined || input.endAt !== undefined || input.limit !== undefined) throw new HanamiSuggestionExportError('INVALID_REQUEST');
			try { state = decodeHanamiSuggestionExportCursor(input.cursor, this.config.hanamiCursorSigningKeys, now); } catch (error) {
				throw new HanamiSuggestionExportError(error instanceof HanamiSuggestionExportCodecError && error.code === 'EXPIRED_CURSOR' ? 'EXPIRED_CURSOR' : 'INVALID_CURSOR');
			}
			if (state.actorId !== actor.id) throw new HanamiSuggestionExportError('INVALID_CURSOR');
		} else {
			if (input.startAt == null || input.endAt == null || input.limit == null) throw new HanamiSuggestionExportError('INVALID_REQUEST');
			const start = Date.parse(input.startAt); const end = Date.parse(input.endAt);
			if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > MAX_PERIOD_MS || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new HanamiSuggestionExportError('INVALID_REQUEST');
			state = { exportId: createHanamiSuggestionExportId(), actorId: actor.id, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), limit: input.limit, lastCreatedAt: null, lastEventId: null, expiresAt: new Date(now.getTime() + EXPORT_MS).toISOString() };
			firstPage = true;
		}

		// All eligibility filtering belongs in SQL, so one bounded look-ahead query
		// yields an exact hasMore without a cursor that can produce an empty page.
		const rows = await this.fetchBatch(state, state.lastCreatedAt, state.lastEventId);
		const pageRows = rows.slice(0, state.limit);
		const events = pageRows.map(row => this.pack(row, state.exportId));
		const last = pageRows.at(-1);
		const lastCreatedAt = last?.created_at.toISOString() ?? state.lastCreatedAt;
		const lastEventId = last?.event_id ?? state.lastEventId;
		const hasMore = rows.length > state.limit;
		if (firstPage) await this.audit(actor.id, state);
		const next = hasMore ? encodeHanamiSuggestionExportCursor({ ...state, lastCreatedAt, lastEventId }, this.config.hanamiCursorSigningKeys) : null;
		return { exportId: state.exportId, expiresAt: state.expiresAt, events, cursor: next, hasMore };
	}

	private async fetchBatch(state: import('./HanamiSuggestionExportCodec.js').HanamiSuggestionExportCursor, lastCreatedAt: string | null, lastEventId: string | null): Promise<Row[]> {
		return await this.dataSource.query(`SELECT e.id AS event_id, e."userId" AS event_user_id, e."noteId" AS note_id, n."userId" AS author_id, e."eventType" AS event_type, e."feedKind" AS feed_kind, e.source, e."occurredAt" AS occurred_at, e."createdAt" AS created_at FROM hanami_recommendation_event e INNER JOIN note n ON n.id = e."noteId" INNER JOIN "user" author ON author.id = n."userId" INNER JOIN "user" event_user ON event_user.id = e."userId" WHERE e."createdAt" >= $1 AND e."createdAt" <= $2 AND e."eventType" = ANY($5::varchar[]) AND n.visibility = 'public' AND n."channelId" IS NULL AND author."isDeleted" = false AND author."isSuspended" = false AND event_user."isDeleted" = false AND event_user."isSuspended" = false AND ($3::timestamptz IS NULL OR (e."createdAt", e.id) > ($3::timestamptz, $4)) ORDER BY e."createdAt" ASC, e.id ASC LIMIT $6`, [state.startAt, state.endAt, lastCreatedAt, lastEventId, EVENT_TYPES, state.limit + 1]) as Row[];
	}

	private pack(row: Row, exportId: string): HanamiSuggestionExportEvent {
		const bucketAt = row.occurred_at ?? row.created_at;
		const bucket = new Date(Math.floor(bucketAt.getTime() / (6 * 60 * 60 * 1000)) * 6 * 60 * 60 * 1000).toISOString();
		const eventType = row.event_type as EventType;
		const feedKind = FEED_KINDS.includes(row.feed_kind as FeedKind) ? row.feed_kind as FeedKind : null;
		const source = SOURCES.includes(row.source as Source) ? row.source as Source : null;
		const origin: Origin = feedKind === 'common' ? 'commonCandidate' : feedKind === 'personal' ? 'personalCandidate' : feedKind === 'userRecommendation' ? 'userRecommendation' : null;
		return { user: pseudonymizeHanamiSuggestionExportId(exportId, 'user', row.event_user_id, this.config.hanamiCursorSigningKeys), note: pseudonymizeHanamiSuggestionExportId(exportId, 'note', row.note_id, this.config.hanamiCursorSigningKeys), author: pseudonymizeHanamiSuggestionExportId(exportId, 'author', row.author_id, this.config.hanamiCursorSigningKeys), timeBucket: bucket, eventType, feedKind, source, sources: source == null ? [] : [source], origin, reactionOutcome: eventType === 'reaction', replyOutcome: eventType === 'reply', renoteOutcome: eventType === 'renote' };
	}

	private async audit(actorId: string, state: import('./HanamiSuggestionExportCodec.js').HanamiSuggestionExportCursor): Promise<void> {
		const [{ count }] = await this.dataSource.query(`SELECT count(*)::int AS count FROM hanami_recommendation_event e INNER JOIN note n ON n.id = e."noteId" INNER JOIN "user" author ON author.id = n."userId" INNER JOIN "user" event_user ON event_user.id = e."userId" WHERE e."createdAt" >= $1 AND e."createdAt" <= $2 AND e."eventType" = ANY($3::varchar[]) AND n.visibility = 'public' AND n."channelId" IS NULL AND author."isDeleted" = false AND author."isSuspended" = false AND event_user."isDeleted" = false AND event_user."isSuspended" = false`, [state.startAt, state.endAt, EVENT_TYPES]) as { count: number }[];
		await this.moderationLogService.log({ id: actorId }, 'exportHanamiSuggestionEvents', { period: { startAt: state.startAt, endAt: state.endAt }, count, exportId: state.exportId });
	}
}
