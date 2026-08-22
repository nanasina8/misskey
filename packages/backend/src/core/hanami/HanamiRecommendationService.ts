/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { QueryRunner, SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { HanamiRecommendationEventsRepository } from '@/models/_.js';
import { MiHanamiRecommendationEvent, type HanamiRecEventType } from '@/models/HanamiRecommendationEvent.js';
import type { HanamiPersonalFeedComputationInput } from '@/core/hanami/HanamiUserFeedContracts.js';
import {
	HANAMI_FOR_YOU_REASON_EVENT_TYPES,
	type HanamiForYouReasonEventHistory,
	type HanamiForYouReasonEventInput,
	type HanamiForYouReasonEventType,
	HanamiForYouProvenanceService,
} from '@/core/hanami/HanamiForYouProvenanceService.js';

export const HANAMI_REASON_EVENT_LOOKBACK_MS = 30 * 60 * 1000;
export const HANAMI_REASON_EVENT_PER_TYPE_LIMIT = 200;
// Seven generation pools total 1,900 candidates (200+500+200+200+250+250+300).
export const HANAMI_GENERATION_CANDIDATE_LIMIT = 1900;
export const HANAMI_DURABLE_SERVED_LOOKBACK_MS = 30 * 60 * 1000;
export const HANAMI_DURABLE_SEEN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type HanamiReasonEventHistoryInput = Pick<HanamiPersonalFeedComputationInput, 'userId' | 'generatedAt' | 'signal'> & {
	readonly perEventTypeLimit?: number;
	readonly queryRunner?: QueryRunner;
};

export type HanamiCandidateServedSeenInput = Pick<HanamiPersonalFeedComputationInput, 'userId' | 'generatedAt' | 'signal'> & {
	readonly noteIds: readonly string[];
	readonly queryRunner?: QueryRunner;
};

export type HanamiDurableServedSeen = {
	readonly served: ReadonlySet<string>;
	readonly seen: ReadonlySet<string>;
};

type EventDatabaseRow = {
	readonly eventId: string;
	readonly noteId: string;
	readonly eventType: string;
	readonly source: string | null;
	readonly occurredAt: Date | string;
};

type CandidateEventDatabaseRow = {
	readonly note_id: string;
	readonly event_type: Extract<HanamiRecEventType, 'served' | 'seen'>;
};

/** Generation-only recommendation event input. It does not record served/seen. */
@Injectable()
export class HanamiRecommendationService {
	constructor(
		@Inject(DI.hanamiRecommendationEventsRepository)
		private hanamiRecommendationEventsRepository: HanamiRecommendationEventsRepository,

		private hanamiForYouProvenanceService: HanamiForYouProvenanceService,
	) {
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (!signal.aborted) return;
		if (signal.reason !== undefined) throw signal.reason;
		const error = new Error('The operation was aborted');
		error.name = 'AbortError';
		throw error;
	}

	private validGeneratedAt(value: string): string {
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) throw new TypeError('generatedAt must be a valid ISO timestamp');
		return new Date(timestamp).toISOString();
	}

	private validPerEventTypeLimit(value: number | undefined): number {
		const limit = value ?? HANAMI_REASON_EVENT_PER_TYPE_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
			throw new RangeError('perEventTypeLimit must be an integer from 1 to 1000');
		}
		return limit;
	}

	private eventQueryBuilder(queryRunner?: QueryRunner): SelectQueryBuilder<MiHanamiRecommendationEvent> {
		return queryRunner == null
			? this.hanamiRecommendationEventsRepository.createQueryBuilder('event')
			: queryRunner.manager.getRepository(MiHanamiRecommendationEvent).createQueryBuilder('event');
	}

	@bindThis
	public async getRecentReasonEventHistory(input: HanamiReasonEventHistoryInput): Promise<HanamiForYouReasonEventHistory> {
		this.throwIfAborted(input.signal);
		const asOf = this.validGeneratedAt(input.generatedAt);
		const cutoff = new Date(Date.parse(asOf) - HANAMI_REASON_EVENT_LOOKBACK_MS).toISOString();
		const perEventTypeLimit = this.validPerEventTypeLimit(input.perEventTypeLimit);
		const events: HanamiForYouReasonEventInput[] = [];

		for (const eventType of HANAMI_FOR_YOU_REASON_EVENT_TYPES) {
			this.throwIfAborted(input.signal);
			events.push(...await this.getEventNoteIdsFromDb(
				input.userId,
				eventType,
				cutoff,
				asOf,
				perEventTypeLimit,
				input.queryRunner,
			));
			this.throwIfAborted(input.signal);
		}

		return this.hanamiForYouProvenanceService.buildReasonEventHistory(events);
	}

	/**
	 * Durable recency for the exact bounded candidate set used by final ranking.
	 * Unrelated newer events cannot consume a global row cap.
	 */
	@bindThis
	public async getDurableServedSeenForCandidates(input: HanamiCandidateServedSeenInput): Promise<HanamiDurableServedSeen> {
		this.throwIfAborted(input.signal);
		const asOf = this.validGeneratedAt(input.generatedAt);
		const servedCutoff = new Date(Date.parse(asOf) - HANAMI_DURABLE_SERVED_LOOKBACK_MS).toISOString();
		const seenCutoff = new Date(Date.parse(asOf) - HANAMI_DURABLE_SEEN_LOOKBACK_MS).toISOString();
		if (!Array.isArray(input.noteIds) || input.noteIds.some(noteId => typeof noteId !== 'string' || noteId.length === 0)) {
			throw new TypeError('noteIds must contain nonempty strings');
		}
		const noteIds = [...new Set(input.noteIds)];
		if (noteIds.length > HANAMI_GENERATION_CANDIDATE_LIMIT) {
			throw new RangeError(`Candidate Note count exceeds ${HANAMI_GENERATION_CANDIDATE_LIMIT}`);
		}
		if (noteIds.length === 0) return Object.freeze({ served: new Set<string>(), seen: new Set<string>() });

		const query = input.queryRunner ?? this.hanamiRecommendationEventsRepository.manager.connection;
		const rows = await query.query(`
			SELECT event."noteId" AS note_id, event."eventType" AS event_type
			FROM "hanami_recommendation_event" event
			WHERE event."userId" = $1
				AND event."noteId" = ANY($2::varchar[])
				AND event."occurredAt" <= $3::timestamptz
				AND ((event."eventType" = 'served' AND event."occurredAt" >= $4::timestamptz)
					OR (event."eventType" = 'seen' AND event."occurredAt" >= $5::timestamptz))
			GROUP BY event."noteId", event."eventType"
		`, [input.userId, noteIds, asOf, servedCutoff, seenCutoff]) as CandidateEventDatabaseRow[];
		this.throwIfAborted(input.signal);

		const served = new Set(rows.filter(row => row.event_type === 'served').map(row => row.note_id));
		const seen = new Set(rows.filter(row => row.event_type === 'seen').map(row => row.note_id));
		return Object.freeze({ served, seen });
	}

	/**
	 * Each event type is queried independently so its 30-minute window, order,
	 * and cap are not consumed by a busier event type before deterministic merge.
	 */
	private async getEventNoteIdsFromDb(
		userId: string,
		eventType: HanamiForYouReasonEventType,
		cutoff: string,
		asOf: string,
		limit: number,
		queryRunner?: QueryRunner,
	): Promise<HanamiForYouReasonEventInput[]> {
		const occurredAt = 'event.occurredAt';
		const rows = await this.eventQueryBuilder(queryRunner)
			.select('event.id', 'eventId')
			.addSelect('event.noteId', 'noteId')
			.addSelect('event.eventType', 'eventType')
			.addSelect('event.source', 'source')
			.addSelect(occurredAt, 'occurredAt')
			.where('event.userId = :userId', { userId })
			.andWhere('event.eventType = :eventType', { eventType })
			.andWhere(`${occurredAt} >= :cutoff`, { cutoff })
			.andWhere(`${occurredAt} <= :asOf`, { asOf })
			.orderBy(occurredAt, 'DESC')
			.addOrderBy('event.id', 'DESC')
			.addOrderBy('event.noteId', 'ASC')
			.limit(limit)
			.getRawMany<EventDatabaseRow>();

		return rows.map(row => ({
			eventId: row.eventId,
			noteId: row.noteId,
			eventType,
			source: row.source ?? null,
			occurredAt: row.occurredAt,
		}));
	}
}
