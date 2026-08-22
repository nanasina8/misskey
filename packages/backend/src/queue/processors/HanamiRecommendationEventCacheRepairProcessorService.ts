/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { bindThis } from '@/decorators.js';
import { QueueService } from '@/core/QueueService.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import type {
	HanamiRecommendationEventCacheRepairJobData,
	HanamiRecommendationEventCacheReplayJobData,
} from '../types.js';

type CacheRepairJob = Bull.Job<HanamiRecommendationEventCacheRepairJobData, unknown, 'hanamiRecommendationEventCacheRepair'>;
type CacheReplayJob = Bull.Job<HanamiRecommendationEventCacheReplayJobData, unknown, 'hanamiRecommendationEventCacheReplay'>;

function isExactPayload(value: unknown): value is HanamiRecommendationEventCacheRepairJobData {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'eventIds') || !Array.isArray(record.eventIds)) return false;
	return record.eventIds.length >= 1
		&& record.eventIds.length <= 100
		&& record.eventIds.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 32);
}

function isExactReplayPayload(value: unknown): value is HanamiRecommendationEventCacheReplayJobData {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0) return true;
	if (keys.length !== 4 || !Object.hasOwn(record, 'asOf') || !Object.hasOwn(record, 'fromOccurredAt') || !Object.hasOwn(record, 'ownerToken') || !Object.hasOwn(record, 'cursor')
		|| typeof record.asOf !== 'string' || typeof record.fromOccurredAt !== 'string' || typeof record.ownerToken !== 'string'
		|| typeof record.cursor !== 'object' || record.cursor == null || Array.isArray(record.cursor)) return false;
	const cursor = record.cursor as Record<string, unknown>;
	if (Object.keys(cursor).length !== 2 || !Object.hasOwn(cursor, 'occurredAt') || !Object.hasOwn(cursor, 'eventId')
		|| typeof cursor.occurredAt !== 'string' || typeof cursor.eventId !== 'string') return false;
	const asOf = Date.parse(record.asOf);
	const fromOccurredAt = Date.parse(record.fromOccurredAt);
	const cursorOccurredAt = Date.parse(cursor.occurredAt);
	return Number.isFinite(asOf) && Number.isFinite(fromOccurredAt) && Number.isFinite(cursorOccurredAt)
		&& fromOccurredAt <= cursorOccurredAt && cursorOccurredAt <= asOf
		&& record.ownerToken.length >= 1 && record.ownerToken.length <= 64
		&& cursor.eventId.length >= 1 && cursor.eventId.length <= 32;
}

@Injectable()
export class HanamiRecommendationEventCacheRepairProcessorService {
	constructor(
		private hanamiForYouProvenanceService: HanamiForYouProvenanceService,
		private queueService: QueueService,
	) {}

	@bindThis
	public async process(job: CacheRepairJob): Promise<void> {
		if (!isExactPayload(job.data)) throw new Bull.UnrecoverableError(`Invalid payload for ${job.name}`);
		await this.hanamiForYouProvenanceService.repairRecommendationEventCache(job.data.eventIds);
	}

	@bindThis
	public async processReplay(job: CacheReplayJob): Promise<void> {
		if (!isExactReplayPayload(job.data)) throw new Bull.UnrecoverableError(`Invalid payload for ${job.name}`);
		const continuation = await this.hanamiForYouProvenanceService.replayRecommendationEventCache(job.data);
		if (continuation != null) await this.queueService.enqueueHanamiRecommendationEventCacheReplay(continuation);
	}
}
