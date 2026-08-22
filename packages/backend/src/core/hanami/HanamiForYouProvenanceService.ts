/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { QueryRunner } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { QueueService } from '@/core/QueueService.js';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { HanamiRecommendationEventsRepository } from '@/models/_.js';
import type { HanamiRecEventType } from '@/models/HanamiRecommendationEvent.js';
import type {
	HanamiRecommendationEventCacheReplayContinuationJobData,
	HanamiRecommendationEventCacheReplayJobData,
} from '@/queue/types.js';
import type { HanamiPersonalFeedCandidate, HanamiUserFeedReasonMetadata } from '@/core/hanami/HanamiUserFeedContracts.js';
import type { HanamiDurableSeenEntryInput, HanamiDurableServedEntryInput } from '@/core/hanami/HanamiTimelineContracts.js';
import {
	decodeHanamiFeedEntryLocator,
	encodeHanamiFeedEntryLocator,
	encodeHanamiCommonFeedEntryLocator,
	encodeHanamiPersonalFeedEntryLocator,
} from '@/core/hanami/HanamiFeedCodec.js';
import {
	HANAMI_SEEN_CACHE_TTL_MS,
	HANAMI_SEEN_CACHE_TTL_SECONDS,
	HANAMI_SEEN_KEY_PREFIX,
	HANAMI_SERVED_CACHE_TTL_MS,
	HANAMI_SERVED_CACHE_TTL_SECONDS,
	HANAMI_SERVED_KEY_PREFIX,
	HANAMI_SERVED_PROVENANCE_LOOKBACK_MS,
	HANAMI_SOURCE_NORMAL,
} from './HanamiForYouKeys.js';

type ServedEntry = { noteId: MiNote['id']; source?: string | null };
type EventRow = { userId: MiUser['id']; noteId: MiNote['id']; eventType: HanamiRecEventType; source: string | null };
type DurableEventType = Extract<HanamiRecEventType, 'served' | 'seen'>;
type ValidatedFeedEntry = {
	readonly feedEntryId: string;
	readonly feedKind: 'personal' | 'common';
	readonly feedEpochId: string;
	readonly noteId: string;
	readonly source: string;
};
type DurableCacheEvent = ValidatedFeedEntry & {
	readonly eventId: string;
	readonly userId: string;
	readonly eventType: DurableEventType;
	readonly occurredAt: Date | string;
	readonly cacheNow: Date | string;
};
type ValidatedFeedEntryDbRow = {
	readonly feed_entry_id: string;
	readonly feed_kind: 'personal' | 'common';
	readonly feed_epoch_id: string;
	readonly note_id: string;
	readonly source: string;
};
type DurableCacheEventDbRow = ValidatedFeedEntryDbRow & {
	readonly event_id: string;
	readonly user_id: string;
	readonly event_type: DurableEventType;
	readonly occurred_at: Date | string;
	readonly cache_now: Date | string;
};

const MAX_DURABLE_EVENT_BATCH_SIZE = 100;
const CACHE_REPLAY_WATERMARK_KEY = 'hanami:rec:cache-replay:watermark';
const CACHE_REPLAY_WATERMARK_MEMBER = 'completed-through';
const CACHE_REPLAY_LEASE_KEY = 'hanami:rec:cache-replay:lease';
const CACHE_REPLAY_LEASE_TTL_MS = 5 * 60 * 1000;
const CACHE_REPLAY_OVERLAP_MS = 5 * 60 * 1000;
const CACHE_REPLAY_RENEW_SCRIPT = `
	if redis.call('get', KEYS[1]) == ARGV[1] then
		return redis.call('pexpire', KEYS[1], ARGV[2])
	end
	return 0
`;
const CACHE_REPLAY_COMPLETE_SCRIPT = `
	if redis.call('get', KEYS[1]) == ARGV[1] then
		redis.call('zadd', KEYS[2], 'GT', ARGV[2], ARGV[3])
		return redis.call('del', KEYS[1])
	end
	return 0
`;

export class HanamiInvalidFeedEntryError extends Error {
	public readonly code = 'INVALID_FEED_ENTRY';

	constructor(message = 'Invalid Hanami feed entry', options?: ErrorOptions) {
		super(message, options);
		this.name = 'HanamiInvalidFeedEntryError';
	}
}

export const HANAMI_FOR_YOU_REASON_EVENT_TYPES = Object.freeze([
	'reaction',
	'reply',
	'renote',
] as const);

export type HanamiForYouReasonEventType = typeof HANAMI_FOR_YOU_REASON_EVENT_TYPES[number];

export type HanamiForYouReasonEventInput = {
	readonly eventId: string;
	readonly noteId: string;
	readonly eventType: HanamiForYouReasonEventType;
	readonly source: string | null;
	readonly occurredAt: Date | string;
};

export type HanamiForYouReasonEvent = {
	readonly eventId: string;
	readonly noteId: string;
	readonly eventType: HanamiForYouReasonEventType;
	readonly source: string | null;
	readonly occurredAt: string;
};

export type HanamiForYouNoteProvenance = {
	readonly noteId: string;
	readonly latestEvent: HanamiForYouReasonEvent;
	readonly events: readonly HanamiForYouReasonEvent[];
};

export type HanamiForYouReasonEventHistory = {
	/** Exact ordered events. Do not replace this with the lossy latest-by-Note projection. */
	readonly events: readonly HanamiForYouReasonEvent[];
	readonly byNoteId: ReadonlyMap<string, HanamiForYouNoteProvenance>;
};

const REASON_EVENT_ORDER = new Map<HanamiForYouReasonEventType, number>(
	HANAMI_FOR_YOU_REASON_EVENT_TYPES.map((eventType, index) => [eventType, index]),
);

/**
 * はなみ For You の provenance 基盤（canonical spec §7.2/§7.3）。
 *
 * Persisted feed served/seen events are mandatory PostgreSQL writes; Redis is
 * only their recency cache. The old dynamic feed and engagement hooks remain
 * best-effort until that serving path is removed.
 * 反応(reaction/reply/renote)は 14日以内の served を lookup して rec/normal を判定する。
 */
@Injectable()
export class HanamiForYouProvenanceService {
	constructor(
		@Inject(DI.hanamiRecommendationEventsRepository)
		private hanamiRecommendationEventsRepository: HanamiRecommendationEventsRepository,

		private idService: IdService,

		@Inject(DI.redis)
		private redisClient?: Redis.Redis,

		@Inject(QueueService)
		private queueService?: QueueService,
	) {
	}

	/** Builds the persisted Phase 4 reason payload without Note entities or serving side effects. */
	@bindThis
	public buildReasonMetadata(
		candidate: Pick<HanamiPersonalFeedCandidate, 'term' | 'clusterId' | 'bucket'>,
		fallbackOverflow = false,
	): HanamiUserFeedReasonMetadata {
		return Object.freeze({
			version: 1 as const,
			...(candidate.term !== undefined ? { term: candidate.term } : {}),
			...(candidate.clusterId !== undefined ? { clusterId: candidate.clusterId } : {}),
			...(candidate.bucket !== undefined ? { bucket: candidate.bucket } : {}),
			...(fallbackOverflow ? { fallbackOverflow: true as const } : {}),
		});
	}

	/**
	 * Normalizes and deterministically merges independently capped event streams.
	 * Every event remains available even though latestEvent is convenient for ranking.
	 */
	@bindThis
	public buildReasonEventHistory(rows: readonly HanamiForYouReasonEventInput[]): HanamiForYouReasonEventHistory {
		const normalized = rows.map(row => {
			if (row.eventId.length === 0 || row.noteId.length === 0) throw new TypeError('Provenance event IDs must not be empty');
			const occurredAtMs = row.occurredAt instanceof Date ? row.occurredAt.getTime() : Date.parse(row.occurredAt);
			if (!Number.isFinite(occurredAtMs)) throw new TypeError('Provenance occurredAt must be a valid timestamp');
			return {
				event: Object.freeze({
					eventId: row.eventId,
					noteId: row.noteId,
					eventType: row.eventType,
					source: row.source,
					occurredAt: new Date(occurredAtMs).toISOString(),
				}),
				occurredAtMs,
			};
		});

		normalized.sort((a, b) => {
			if (a.occurredAtMs !== b.occurredAtMs) return b.occurredAtMs - a.occurredAtMs;
			if (a.event.eventId !== b.event.eventId) return a.event.eventId < b.event.eventId ? 1 : -1;
			const eventTypeOrder = (REASON_EVENT_ORDER.get(a.event.eventType) ?? 0) - (REASON_EVENT_ORDER.get(b.event.eventType) ?? 0);
			if (eventTypeOrder !== 0) return eventTypeOrder;
			if (a.event.noteId !== b.event.noteId) return a.event.noteId < b.event.noteId ? -1 : 1;
			const aSource = a.event.source ?? '';
			const bSource = b.event.source ?? '';
			return aSource < bSource ? -1 : aSource > bSource ? 1 : 0;
		});

		const events = Object.freeze(normalized.map(row => row.event));
		const grouped = new Map<string, HanamiForYouReasonEvent[]>();
		for (const event of events) {
			const noteEvents = grouped.get(event.noteId);
			if (noteEvents == null) grouped.set(event.noteId, [event]);
			else noteEvents.push(event);
		}
		const byNoteId = new Map<string, HanamiForYouNoteProvenance>();
		for (const [noteId, noteEvents] of grouped) {
			byNoteId.set(noteId, Object.freeze({
				noteId,
				latestEvent: noteEvents[0]!,
				events: Object.freeze(noteEvents),
			}));
		}
		return Object.freeze({ events, byNoteId });
	}

	@bindThis
	public async recordServedFeedEntries(userId: MiUser['id'], entries: readonly HanamiDurableServedEntryInput[]): Promise<void> {
		if (!Array.isArray(entries) || entries.length > MAX_DURABLE_EVENT_BATCH_SIZE) {
			throw new HanamiInvalidFeedEntryError(`Served feed entry batch must contain at most ${MAX_DURABLE_EVENT_BATCH_SIZE} items`);
		}
		if (entries.length === 0) return;

		const events = await this.withTransaction(async (queryRunner) => {
			const user = await this.lockRequester(queryRunner, userId);
			const personal: Array<{
				feedEntryId: string;
				epochId: string;
				sequence: string;
				batchId: string;
				noteId: string;
				source: string;
			}> = [];
			const common: Array<{
				feedEntryId: string;
				epochId: string;
				generatedMonth: string;
				rowId: string;
				batchId: string;
				noteId: string;
				source: string;
			}> = [];

			for (const input of entries) {
				if (!this.isObject(input) || typeof input.feedEntryId !== 'string' || input.feedEntryId.length === 0 || !this.isObject(input.entry)) {
					throw new HanamiInvalidFeedEntryError();
				}
				const entry = input.entry as HanamiDurableServedEntryInput['entry'];
				if (entry.kind === 'personal') {
					if (user.is_hibernated) throw new HanamiInvalidFeedEntryError('Personal feed entry owner is hibernated');
					const canonical = this.encodePersonalLocator(userId, entry.epochId, entry.sequence);
					if (canonical !== input.feedEntryId) throw new HanamiInvalidFeedEntryError('Personal feed-entry locator does not match its persisted entry');
					personal.push({
						feedEntryId: input.feedEntryId,
						epochId: entry.epochId,
						sequence: entry.sequence,
						batchId: entry.batchId,
						noteId: entry.noteId,
						source: entry.source,
					});
				} else if (entry.kind === 'common') {
					const canonical = this.encodeCommonLocator(entry.epochId, entry.generatedMonth, entry.rowId);
					if (canonical !== input.feedEntryId) throw new HanamiInvalidFeedEntryError('Common feed-entry locator does not match its persisted entry');
					common.push({
						feedEntryId: input.feedEntryId,
						epochId: entry.epochId,
						generatedMonth: entry.generatedMonth,
						rowId: entry.rowId,
						batchId: entry.batchId,
						noteId: entry.noteId,
						source: entry.source,
					});
				} else {
					throw new HanamiInvalidFeedEntryError('Unknown feed entry kind');
				}
			}

			const validated = [
				...await this.validateServedPersonalEntries(queryRunner, userId, personal),
				...await this.validateServedCommonEntries(queryRunner, common),
			];
			if (validated.length !== entries.length) throw new HanamiInvalidFeedEntryError('A served feed entry or its ready parent no longer exists');
			return await this.upsertDurableEvents(queryRunner, userId, 'served', validated);
		});

		await this.cacheCommittedEvents(events);
	}

	@bindThis
	public async recordSeenFeedEntries(userId: MiUser['id'], entries: readonly HanamiDurableSeenEntryInput[]): Promise<void> {
		if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_DURABLE_EVENT_BATCH_SIZE) {
			throw new HanamiInvalidFeedEntryError(`Seen feed entry batch must contain 1 to ${MAX_DURABLE_EVENT_BATCH_SIZE} items`);
		}

		const events = await this.withTransaction(async (queryRunner) => {
			const user = await this.lockRequester(queryRunner, userId);
			const personal: Array<{ feedEntryId: string; epochId: string; sequence: string; noteId: string }> = [];
			const common: Array<{ feedEntryId: string; epochId: string; generatedMonth: string; rowId: string; noteId: string }> = [];

			for (const input of entries) {
				if (!this.isObject(input)
					|| typeof input.feedEntryId !== 'string' || input.feedEntryId.length === 0
					|| typeof input.noteId !== 'string' || input.noteId.length === 0) {
					throw new HanamiInvalidFeedEntryError();
				}

				try {
					const locator = decodeHanamiFeedEntryLocator(input.feedEntryId);
					if (encodeHanamiFeedEntryLocator(locator) !== input.feedEntryId) throw new HanamiInvalidFeedEntryError('Non-canonical feed-entry locator');
					if (locator.kind === 'personal') {
						if (locator.userId !== userId || user.is_hibernated) throw new HanamiInvalidFeedEntryError('Invalid personal feed-entry owner');
						personal.push({
							feedEntryId: input.feedEntryId,
							epochId: locator.epochId,
							sequence: locator.sequence,
							noteId: input.noteId,
						});
					} else {
						common.push({
							feedEntryId: input.feedEntryId,
							epochId: locator.epochId,
							generatedMonth: locator.generatedMonth,
							rowId: locator.rowId,
							noteId: input.noteId,
						});
					}
				} catch (error) {
					if (error instanceof HanamiInvalidFeedEntryError) throw error;
					throw new HanamiInvalidFeedEntryError('Malformed feed-entry locator', { cause: error });
				}
			}

			const validated = [
				...await this.validateSeenPersonalEntries(queryRunner, userId, personal),
				...await this.validateSeenCommonEntries(queryRunner, userId, common),
			];
			if (validated.length !== entries.length) {
				throw new HanamiInvalidFeedEntryError('A seen feed entry is invalid or has no matching served event');
			}
			return await this.upsertDurableEvents(queryRunner, userId, 'seen', validated);
		});

		await this.cacheCommittedEvents(events);
	}

	@bindThis
	public async repairRecommendationEventCache(eventIds: readonly string[]): Promise<void> {
		this.validateEventIds(eventIds);
		const uniqueEventIds = [...new Set(eventIds)];
		const rows = await this.hanamiRecommendationEventsRepository.manager.connection.query(`
			WITH repair_clock AS (SELECT clock_timestamp() AS now)
			SELECT e."id" AS event_id, e."userId" AS user_id, e."eventType" AS event_type,
				e."feedEntryId" AS feed_entry_id, e."feedKind" AS feed_kind,
				e."feedEpochId" AS feed_epoch_id, e."noteId" AS note_id,
				e."source" AS source, e."occurredAt" AS occurred_at, c.now AS cache_now
			FROM "hanami_recommendation_event" e
			CROSS JOIN repair_clock c
			WHERE e."id" = ANY($1::varchar[])
				AND e."feedEntryId" IS NOT NULL
				AND e."feedKind" IN ('personal', 'common')
				AND e."feedEpochId" IS NOT NULL
				AND e."occurredAt" IS NOT NULL
				AND ((e."eventType" = 'served' AND e."occurredAt" > c.now - INTERVAL '30 minutes')
					OR (e."eventType" = 'seen' AND e."occurredAt" > c.now - INTERVAL '7 days'))
		`, [uniqueEventIds]) as DurableCacheEventDbRow[];
		if (rows.length === 0) return;
		await this.writeEventsToCache(rows.map(row => this.cacheEventFromDb(row)));
	}

	@bindThis
	public async replayRecommendationEventCache(
		input: HanamiRecommendationEventCacheReplayJobData,
	): Promise<HanamiRecommendationEventCacheReplayContinuationJobData | null> {
		const continuation = this.validateReplayInput(input);
		if (this.redisClient == null) throw new Error('Hanami recommendation event Redis cache is unavailable');

		let asOf: string;
		let fromOccurredAt: string;
		let ownerToken: string;
		let cursor: HanamiRecommendationEventCacheReplayContinuationJobData['cursor'] | undefined;
		if (continuation == null) {
			ownerToken = randomUUID();
			const acquired = await this.redisClient.set(
				CACHE_REPLAY_LEASE_KEY,
				ownerToken,
				'PX',
				CACHE_REPLAY_LEASE_TTL_MS,
				'NX',
			);
			if (acquired !== 'OK') return null;
			const clockRows = await this.hanamiRecommendationEventsRepository.manager.connection.query(`
				SELECT clock_timestamp() AS replay_as_of
			`) as Array<{ replay_as_of: Date | string }>;
			const replayAsOf = clockRows.at(0)?.replay_as_of;
			if (replayAsOf == null) throw new Error('Failed to read the PostgreSQL cache replay clock');
			const asOfMs = this.timestampMs(replayAsOf);
			asOf = new Date(asOfMs).toISOString();

			const watermark = await this.redisClient.zscore(CACHE_REPLAY_WATERMARK_KEY, CACHE_REPLAY_WATERMARK_MEMBER);
			const watermarkMs = watermark == null ? Number.NaN : Number(watermark);
			const liveWindowStart = asOfMs - HANAMI_SEEN_CACHE_TTL_MS;
			const replayStart = Number.isFinite(watermarkMs) && watermarkMs <= asOfMs
				? Math.max(liveWindowStart, watermarkMs - CACHE_REPLAY_OVERLAP_MS)
				: liveWindowStart;
			fromOccurredAt = new Date(replayStart).toISOString();
		} else {
			({ asOf, fromOccurredAt, ownerToken, cursor } = continuation);
			if (!await this.renewCacheReplayLease(ownerToken)) return null;
		}

		const rows = await this.hanamiRecommendationEventsRepository.manager.connection.query(`
			WITH replay_clock AS (SELECT clock_timestamp() AS now)
			SELECT e."id" AS event_id, e."userId" AS user_id, e."eventType" AS event_type,
				e."feedEntryId" AS feed_entry_id, e."feedKind" AS feed_kind,
				e."feedEpochId" AS feed_epoch_id, e."noteId" AS note_id,
				e."source" AS source, e."occurredAt" AS occurred_at, c.now AS cache_now
			FROM "hanami_recommendation_event" e
			CROSS JOIN replay_clock c
			WHERE e."occurredAt" > $1::timestamptz
				AND e."occurredAt" <= $2::timestamptz
				AND e."feedEntryId" IS NOT NULL
				AND e."feedKind" IN ('personal', 'common')
				AND e."feedEpochId" IS NOT NULL
				AND ((e."eventType" = 'served' AND e."occurredAt" > c.now - INTERVAL '30 minutes')
					OR (e."eventType" = 'seen' AND e."occurredAt" > c.now - INTERVAL '7 days'))
				AND ($3::timestamptz IS NULL OR (e."occurredAt", e."id") < ($3::timestamptz, $4::varchar))
			ORDER BY e."occurredAt" DESC, e."id" DESC, e."noteId" ASC
			LIMIT $5
		`, [
			fromOccurredAt,
			asOf,
			cursor?.occurredAt ?? null,
			cursor?.eventId ?? null,
			MAX_DURABLE_EVENT_BATCH_SIZE,
		]) as DurableCacheEventDbRow[];

		await this.writeEventsToCache(rows.map(row => this.cacheEventFromDb(row)));
		if (rows.length === MAX_DURABLE_EVENT_BATCH_SIZE) {
			if (!await this.renewCacheReplayLease(ownerToken)) return null;
			const last = rows.at(-1)!;
			return {
				asOf,
				fromOccurredAt,
				ownerToken,
				cursor: {
					occurredAt: new Date(this.timestampMs(last.occurred_at)).toISOString(),
					eventId: last.event_id,
				},
			};
		}

		await this.completeCacheReplayLease(ownerToken, Date.parse(asOf));
		return null;
	}

	private async renewCacheReplayLease(ownerToken: string): Promise<boolean> {
		if (this.redisClient == null) return false;
		const renewed = await this.redisClient.eval(
			CACHE_REPLAY_RENEW_SCRIPT,
			1,
			CACHE_REPLAY_LEASE_KEY,
			ownerToken,
			String(CACHE_REPLAY_LEASE_TTL_MS),
		);
		return Number(renewed) === 1;
	}

	private async completeCacheReplayLease(ownerToken: string, asOfMs: number): Promise<boolean> {
		if (this.redisClient == null) return false;
		const completed = await this.redisClient.eval(
			CACHE_REPLAY_COMPLETE_SCRIPT,
			2,
			CACHE_REPLAY_LEASE_KEY,
			CACHE_REPLAY_WATERMARK_KEY,
			ownerToken,
			String(asOfMs),
			CACHE_REPLAY_WATERMARK_MEMBER,
		);
		return Number(completed) === 1;
	}

	private async lockRequester(queryRunner: QueryRunner, userId: string): Promise<{ id: string; is_hibernated: boolean }> {
		if (typeof userId !== 'string' || userId.length === 0) throw new HanamiInvalidFeedEntryError('Invalid feed entry requester');
		const rows = await queryRunner.query(`
			SELECT u."id" AS id, u."isHibernated" AS is_hibernated
			FROM "user" u
			WHERE u."id" = $1
			FOR UPDATE OF u
		`, [userId]) as Array<{ id: string; is_hibernated: boolean }>;
		const user = rows.at(0);
		if (user == null) throw new HanamiInvalidFeedEntryError('Feed entry requester does not exist');
		return user;
	}

	private async validateServedPersonalEntries(
		queryRunner: QueryRunner,
		userId: string,
		entries: ReadonlyArray<{
			feedEntryId: string;
			epochId: string;
			sequence: string;
			batchId: string;
			noteId: string;
			source: string;
		}>,
	): Promise<ValidatedFeedEntry[]> {
		if (entries.length === 0) return [];
		const rows = await queryRunner.query(`
			SELECT input.feed_entry_id, 'personal'::text AS feed_kind,
				e."epochId" AS feed_epoch_id, e."noteId" AS note_id, e."source" AS source
			FROM unnest($2::varchar[], $3::varchar[], $4::bigint[], $5::varchar[], $6::varchar[], $7::varchar[])
				WITH ORDINALITY AS input(feed_entry_id, epoch_id, sequence, batch_id, note_id, source, ordinal)
			JOIN "hanami_user_feed_state" s
				ON s."userId" = $1 AND s."epochId" = input.epoch_id AND s."mode" = 'personalized'
			JOIN "hanami_user_feed_epoch" epoch
				ON epoch."userId" = $1 AND epoch."epochId" = input.epoch_id AND epoch."retiredAt" IS NULL
			JOIN "hanami_user_feed_entry" e
				ON e."userId" = $1 AND e."epochId" = input.epoch_id AND e."sequence" = input.sequence
				AND e."batchId" = input.batch_id AND e."noteId" = input.note_id AND e."source" = input.source
			JOIN "hanami_user_feed_batch" b
				ON b."id" = e."batchId" AND b."userId" = e."userId" AND b."epochId" = e."epochId" AND b."status" = 'ready'
			ORDER BY input.ordinal
			FOR SHARE OF s, epoch, e, b
		`, [
			userId,
			entries.map(entry => entry.feedEntryId),
			entries.map(entry => entry.epochId),
			entries.map(entry => entry.sequence),
			entries.map(entry => entry.batchId),
			entries.map(entry => entry.noteId),
			entries.map(entry => entry.source),
		]) as ValidatedFeedEntryDbRow[];
		return rows.map(row => this.validatedEntryFromDb(row));
	}

	private async validateServedCommonEntries(
		queryRunner: QueryRunner,
		entries: ReadonlyArray<{
			feedEntryId: string;
			epochId: string;
			generatedMonth: string;
			rowId: string;
			batchId: string;
			noteId: string;
			source: string;
		}>,
	): Promise<ValidatedFeedEntry[]> {
		if (entries.length === 0) return [];
		const rows = await queryRunner.query(`
			SELECT input.feed_entry_id, 'common'::text AS feed_kind,
				e."epochId" AS feed_epoch_id, e."noteId" AS note_id, e."source" AS source
			FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[], $6::varchar[], $7::varchar[])
				WITH ORDINALITY AS input(feed_entry_id, epoch_id, generated_month, row_id, batch_id, note_id, source, ordinal)
			JOIN "hanami_common_feed_entry" e
				ON e."generatedMonth" = (input.generated_month || '-01')::date AND e."id" = input.row_id
				AND e."epochId" = input.epoch_id AND e."generationId" = input.batch_id
				AND e."noteId" = input.note_id AND e."source" = input.source
			JOIN "hanami_common_generation" g ON g."id" = e."generationId" AND g."status" = 'ready'
			ORDER BY input.ordinal
			FOR SHARE OF e, g
		`, [
			entries.map(entry => entry.feedEntryId),
			entries.map(entry => entry.epochId),
			entries.map(entry => entry.generatedMonth),
			entries.map(entry => entry.rowId),
			entries.map(entry => entry.batchId),
			entries.map(entry => entry.noteId),
			entries.map(entry => entry.source),
		]) as ValidatedFeedEntryDbRow[];
		return rows.map(row => this.validatedEntryFromDb(row));
	}

	private async validateSeenPersonalEntries(
		queryRunner: QueryRunner,
		userId: string,
		entries: ReadonlyArray<{ feedEntryId: string; epochId: string; sequence: string; noteId: string }>,
	): Promise<ValidatedFeedEntry[]> {
		if (entries.length === 0) return [];
		const rows = await queryRunner.query(`
			SELECT input.feed_entry_id, 'personal'::text AS feed_kind,
				e."epochId" AS feed_epoch_id, e."noteId" AS note_id, e."source" AS source
			FROM unnest($2::varchar[], $3::varchar[], $4::bigint[], $5::varchar[])
				WITH ORDINALITY AS input(feed_entry_id, epoch_id, sequence, note_id, ordinal)
			JOIN "hanami_user_feed_state" s
				ON s."userId" = $1 AND s."epochId" = input.epoch_id AND s."mode" = 'personalized'
			JOIN "hanami_user_feed_epoch" epoch
				ON epoch."userId" = $1 AND epoch."epochId" = input.epoch_id AND epoch."retiredAt" IS NULL
			JOIN "hanami_user_feed_entry" e
				ON e."userId" = $1 AND e."epochId" = input.epoch_id AND e."sequence" = input.sequence
				AND e."noteId" = input.note_id
			JOIN "hanami_user_feed_batch" b
				ON b."id" = e."batchId" AND b."userId" = e."userId" AND b."epochId" = e."epochId" AND b."status" = 'ready'
			JOIN "hanami_recommendation_event" served
				ON served."userId" = $1 AND served."eventType" = 'served'
				AND served."feedEntryId" = input.feed_entry_id AND served."feedKind" = 'personal'
				AND served."feedEpochId" = e."epochId" AND served."noteId" = e."noteId"
			ORDER BY input.ordinal
			FOR SHARE OF s, epoch, e, b, served
		`, [
			userId,
			entries.map(entry => entry.feedEntryId),
			entries.map(entry => entry.epochId),
			entries.map(entry => entry.sequence),
			entries.map(entry => entry.noteId),
		]) as ValidatedFeedEntryDbRow[];
		return rows.map(row => this.validatedEntryFromDb(row));
	}

	private async validateSeenCommonEntries(
		queryRunner: QueryRunner,
		userId: string,
		entries: ReadonlyArray<{ feedEntryId: string; epochId: string; generatedMonth: string; rowId: string; noteId: string }>,
	): Promise<ValidatedFeedEntry[]> {
		if (entries.length === 0) return [];
		const rows = await queryRunner.query(`
			SELECT input.feed_entry_id, 'common'::text AS feed_kind,
				e."epochId" AS feed_epoch_id, e."noteId" AS note_id, e."source" AS source
			FROM unnest($2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[], $6::varchar[])
				WITH ORDINALITY AS input(feed_entry_id, epoch_id, generated_month, row_id, note_id, ordinal)
			JOIN "hanami_common_feed_entry" e
				ON e."generatedMonth" = (input.generated_month || '-01')::date AND e."id" = input.row_id
				AND e."epochId" = input.epoch_id AND e."noteId" = input.note_id
			JOIN "hanami_common_generation" g ON g."id" = e."generationId" AND g."status" = 'ready'
			JOIN "hanami_recommendation_event" served
				ON served."userId" = $1 AND served."eventType" = 'served'
				AND served."feedEntryId" = input.feed_entry_id AND served."feedKind" = 'common'
				AND served."feedEpochId" = e."epochId" AND served."noteId" = e."noteId"
			ORDER BY input.ordinal
			FOR SHARE OF e, g, served
		`, [
			userId,
			entries.map(entry => entry.feedEntryId),
			entries.map(entry => entry.epochId),
			entries.map(entry => entry.generatedMonth),
			entries.map(entry => entry.rowId),
			entries.map(entry => entry.noteId),
		]) as ValidatedFeedEntryDbRow[];
		return rows.map(row => this.validatedEntryFromDb(row));
	}

	private async upsertDurableEvents(
		queryRunner: QueryRunner,
		userId: string,
		eventType: DurableEventType,
		entries: readonly ValidatedFeedEntry[],
	): Promise<DurableCacheEvent[]> {
		const uniqueEntries = [...new Map(entries.map(entry => [entry.feedEntryId, entry])).values()];
		const generatedAt = Date.now();
		const rows = uniqueEntries.map(entry => ({
			id: this.idService.gen(generatedAt),
			userId,
			eventType,
			...entry,
		}));
		const result = await queryRunner.query(`
			INSERT INTO "hanami_recommendation_event" (
				"id", "userId", "noteId", "eventType", "source",
				"feedKind", "feedEpochId", "feedEntryId", "occurredAt", "createdAt"
			)
			SELECT input.id, input.user_id, input.note_id, input.event_type, input.source,
				input.feed_kind, input.feed_epoch_id, input.feed_entry_id,
				statement_timestamp(), statement_timestamp()
			FROM jsonb_to_recordset($1::jsonb) AS input(
				id varchar, user_id varchar, note_id varchar, event_type varchar, source varchar,
				feed_kind varchar, feed_epoch_id varchar, feed_entry_id varchar
			)
			ON CONFLICT ("userId", "eventType", "feedEntryId") WHERE "feedEntryId" IS NOT NULL
			DO UPDATE SET
				"noteId" = EXCLUDED."noteId",
				"source" = EXCLUDED."source",
				"feedKind" = EXCLUDED."feedKind",
				"feedEpochId" = EXCLUDED."feedEpochId",
				"occurredAt" = GREATEST("hanami_recommendation_event"."occurredAt", EXCLUDED."occurredAt")
			RETURNING "id" AS event_id, "userId" AS user_id, "eventType" AS event_type,
				"feedEntryId" AS feed_entry_id, "feedKind" AS feed_kind,
				"feedEpochId" AS feed_epoch_id, "noteId" AS note_id,
				"source" AS source, "occurredAt" AS occurred_at,
				statement_timestamp() AS cache_now
		`, [JSON.stringify(rows.map(row => ({
			id: row.id,
			user_id: row.userId,
			event_type: row.eventType,
			feed_entry_id: row.feedEntryId,
			feed_kind: row.feedKind,
			feed_epoch_id: row.feedEpochId,
			note_id: row.noteId,
			source: row.source,
		})))]) as DurableCacheEventDbRow[];
		if (result.length !== uniqueEntries.length) throw new Error('Durable Hanami recommendation event upsert returned an unexpected row count');
		return result.map(row => this.cacheEventFromDb(row));
	}

	private async cacheCommittedEvents(events: readonly DurableCacheEvent[]): Promise<void> {
		try {
			await this.writeEventsToCache(events);
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: recommendation event cache write failed', error);
			try {
				if (this.queueService == null) throw new Error('Hanami recommendation event cache repair queue is unavailable');
				await this.queueService.enqueueHanamiRecommendationEventCacheRepair(events.map(event => event.eventId));
			} catch (queueError) {
				// PostgreSQL is authoritative, so queue failure must not fail the request.
				// eslint-disable-next-line no-console
				console.error('hanami foryou: recommendation event cache repair enqueue failed', queueError);
			}
		}
	}

	private async writeEventsToCache(events: readonly DurableCacheEvent[]): Promise<void> {
		if (events.length === 0) return;
		if (this.redisClient == null) throw new Error('Hanami recommendation event Redis cache is unavailable');
		const now = Math.max(...events.map(event => this.timestampMs(event.cacheNow)));
		const groups = new Map<string, { ttlMs: number; ttlSeconds: number; members: Map<string, number> }>();
		for (const event of events) {
			const occurredAt = this.timestampMs(event.occurredAt);
			const served = event.eventType === 'served';
			const key = `${served ? HANAMI_SERVED_KEY_PREFIX : HANAMI_SEEN_KEY_PREFIX}${event.userId}`;
			const group = groups.get(key) ?? {
				ttlMs: served ? HANAMI_SERVED_CACHE_TTL_MS : HANAMI_SEEN_CACHE_TTL_MS,
				ttlSeconds: served ? HANAMI_SERVED_CACHE_TTL_SECONDS : HANAMI_SEEN_CACHE_TTL_SECONDS,
				members: new Map<string, number>(),
			};
			group.members.set(event.noteId, Math.max(group.members.get(event.noteId) ?? -Infinity, occurredAt));
			groups.set(key, group);
		}

		const transaction = this.redisClient.multi();
		for (const [key, group] of groups) {
			const scoreMembers: Array<number | string> = [];
			for (const [noteId, score] of group.members) scoreMembers.push(score, noteId);
			transaction
				.zadd(key, 'GT', ...(scoreMembers as [number, string]))
				.zremrangebyscore(key, 0, now - group.ttlMs)
				.expire(key, group.ttlSeconds);
		}
		const result = await transaction.exec();
		const commandError = result?.find(item => item[0] != null)?.[0];
		if (result == null || commandError != null) throw new Error('Hanami recommendation event Redis transaction failed', { cause: commandError });
	}

	private validatedEntryFromDb(row: ValidatedFeedEntryDbRow): ValidatedFeedEntry {
		return {
			feedEntryId: row.feed_entry_id,
			feedKind: row.feed_kind,
			feedEpochId: row.feed_epoch_id,
			noteId: row.note_id,
			source: row.source,
		};
	}

	private cacheEventFromDb(row: DurableCacheEventDbRow): DurableCacheEvent {
		return {
			eventId: row.event_id,
			userId: row.user_id,
			eventType: row.event_type,
			occurredAt: row.occurred_at,
			cacheNow: row.cache_now,
			...this.validatedEntryFromDb(row),
		};
	}

	private encodePersonalLocator(userId: string, epochId: string, sequence: string): string {
		try {
			return encodeHanamiPersonalFeedEntryLocator({ userId, epochId, sequence });
		} catch (error) {
			throw new HanamiInvalidFeedEntryError('Invalid personal feed entry', { cause: error });
		}
	}

	private encodeCommonLocator(epochId: string, generatedMonth: string, rowId: string): string {
		try {
			return encodeHanamiCommonFeedEntryLocator({ epochId, generatedMonth, rowId });
		} catch (error) {
			throw new HanamiInvalidFeedEntryError('Invalid common feed entry', { cause: error });
		}
	}

	private validateEventIds(eventIds: readonly string[]): void {
		if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > MAX_DURABLE_EVENT_BATCH_SIZE
			|| eventIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 32)) {
			throw new TypeError(`eventIds must contain 1 to ${MAX_DURABLE_EVENT_BATCH_SIZE} nonempty event IDs`);
		}
	}

	private validateReplayInput(
		input: HanamiRecommendationEventCacheReplayJobData,
	): HanamiRecommendationEventCacheReplayContinuationJobData | null {
		if (!this.isObject(input)) throw new TypeError('Invalid Hanami recommendation event cache replay payload');
		const keys = Object.keys(input);
		if (keys.length === 0) return null;
		if (keys.length !== 4 || !keys.includes('asOf') || !keys.includes('fromOccurredAt') || !keys.includes('ownerToken') || !keys.includes('cursor')
			|| typeof input.asOf !== 'string' || typeof input.fromOccurredAt !== 'string' || typeof input.ownerToken !== 'string' || !this.isObject(input.cursor)
			|| Object.keys(input.cursor).length !== 2 || !Object.hasOwn(input.cursor, 'occurredAt') || !Object.hasOwn(input.cursor, 'eventId')
			|| typeof input.cursor.occurredAt !== 'string' || typeof input.cursor.eventId !== 'string') {
			throw new TypeError('Invalid Hanami recommendation event cache replay payload');
		}
		const asOfMs = Date.parse(input.asOf);
		const fromOccurredAtMs = Date.parse(input.fromOccurredAt);
		const cursorOccurredAtMs = Date.parse(input.cursor.occurredAt);
		if (!Number.isFinite(asOfMs) || !Number.isFinite(fromOccurredAtMs) || !Number.isFinite(cursorOccurredAtMs)
			|| fromOccurredAtMs > cursorOccurredAtMs || cursorOccurredAtMs > asOfMs
			|| input.ownerToken.length === 0 || input.ownerToken.length > 64
			|| input.cursor.eventId.length === 0 || input.cursor.eventId.length > 32) {
			throw new TypeError('Invalid Hanami recommendation event cache replay payload');
		}
		return {
			asOf: new Date(asOfMs).toISOString(),
			fromOccurredAt: new Date(fromOccurredAtMs).toISOString(),
			ownerToken: input.ownerToken,
			cursor: {
				occurredAt: new Date(cursorOccurredAtMs).toISOString(),
				eventId: input.cursor.eventId,
			},
		};
	}

	private timestampMs(value: Date | string): number {
		const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
		if (!Number.isFinite(timestamp)) throw new Error('Durable Hanami recommendation event has an invalid occurredAt');
		return timestamp;
	}

	private isObject(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value != null && !Array.isArray(value);
	}

	private async withTransaction<T>(callback: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
		const queryRunner = this.hanamiRecommendationEventsRepository.manager.connection.createQueryRunner();
		let connected = false;
		try {
			await queryRunner.connect();
			connected = true;
			await queryRunner.startTransaction();
			const result = await callback(queryRunner);
			await queryRunner.commitTransaction();
			return result;
		} catch (error) {
			if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
			throw error;
		} finally {
			if (connected) await queryRunner.release();
		}
	}

	/** Legacy dynamic-feed served hook. Persisted Phase 5 pages must not use it. */
	@bindThis
	public async recordServedEvents(userId: MiUser['id'], entries: ServedEntry[]): Promise<void> {
		if (entries.length === 0) return;
		await this.insertEventsSafe(entries.map(e => ({
			userId,
			noteId: e.noteId,
			eventType: 'served' as const,
			source: e.source ?? null,
		})));
	}

	/**
	 * 反応(reaction/reply/renote)を provenance 付きで記録（§7.2）。
	 * 14日以内に served 済みなら source=その軸（rec 由来）、無ければ 'normal'。
	 * hot path から best-effort（fire-and-forget）で呼ぶ前提。
	 */
	@bindThis
	public async recordEngagement(userId: MiUser['id'], noteId: MiNote['id'], eventType: 'reaction' | 'reply' | 'renote'): Promise<void> {
		try {
			const served = await this.lookupServed(userId, noteId);
			await this.insertEventsSafe([{
				userId,
				noteId,
				eventType,
				// served 行が無ければ 'normal'(rec 由来でない)。served だが axis NULL なら NULL(軸不明だが rec)を保持する
				// （'normal' に潰すと rec/normal provenance が壊れる）。
				source: served == null ? HANAMI_SOURCE_NORMAL : (served.source ?? null),
			}]);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: recordEngagement failed', err);
		}
	}

	/** 14日窓で最新の served event を引く（rec/normal 判定の素）。索引 (userId,noteId,eventType) を使う。 */
	@bindThis
	private async lookupServed(userId: MiUser['id'], noteId: MiNote['id']): Promise<{ source: string | null } | null> {
		const cutoff = new Date(Date.now() - HANAMI_SERVED_PROVENANCE_LOOKBACK_MS);
		const row = await this.hanamiRecommendationEventsRepository.createQueryBuilder('e')
			.select('e.source', 'source')
			.where('e.userId = :userId', { userId })
			.andWhere('e.noteId = :noteId', { noteId })
			.andWhere('e.eventType = :t', { t: 'served' })
			.andWhere('COALESCE(e.occurredAt, e.createdAt) > :cutoff', { cutoff })
			.orderBy('COALESCE(e.occurredAt, e.createdAt)', 'DESC')
			.addOrderBy('e.id', 'DESC')
			.limit(1)
			.getRawOne<{ source: string | null }>();
		if (row == null) return null;
		return { source: row.source ?? null };
	}

	private async insertEvents(rows: EventRow[]): Promise<void> {
		if (rows.length === 0) return;
		const now = new Date();
		const t = now.getTime();
		await this.hanamiRecommendationEventsRepository.insert(rows.map(r => ({
			id: this.idService.gen(t),
			userId: r.userId,
			noteId: r.noteId,
			eventType: r.eventType,
			source: r.source,
			occurredAt: now,
			createdAt: now,
		})));
	}

	/** 二重書きは best-effort。失敗しても短期重複排除(Redis)が効くので致命ではない。 */
	private async insertEventsSafe(rows: EventRow[]): Promise<void> {
		try {
			await this.insertEvents(rows);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: provenance event write failed', err);
		}
	}
}
