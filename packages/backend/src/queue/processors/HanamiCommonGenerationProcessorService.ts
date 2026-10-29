/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import * as Bull from 'bullmq';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { HANAMI_LLM_EVENT_THROTTLE_MS, recordHanamiLlmEvent, type HanamiLlmEvent } from '@/core/hanami/HanamiLocalLlmLock.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import {
	HANAMI_COMMON_GENERATION_LIFECYCLE,
	type HanamiCommonGenerationDispatch,
	type HanamiCommonGenerationLifecyclePort,
	type HanamiCommonGenerationRequestResult,
	type HanamiCommonGenerationRunResult,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { QueueService } from '@/core/QueueService.js';
import { HanamiForYouBatchService, HanamiNoteJudgeLockContentionError } from '@/core/hanami/HanamiForYouBatchService.js';
import { TREND_CONTENT_JUDGE_EXTRA, TREND_TITLE_SAMPLE_POSTS, TREND_TITLE_TOP } from '@/core/hanami/HanamiTrendService.js';
import type {
	HanamiCommonGenerationJobData,
	HanamiCommonGenerationTickJobData,
	HanamiGenerationReconcileJobData,
	HanamiNoteJudgeJobData,
	HanamiTrendTopicJudgeJobData,
} from '../types.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

type HanamiCommonGenerationTickJob = Bull.Job<HanamiCommonGenerationTickJobData, unknown, 'hanamiCommonGenerationTick'>;
type HanamiCommonGenerationJob = Bull.Job<HanamiCommonGenerationJobData, unknown, 'hanamiCommonGeneration'>;
type HanamiGenerationReconcileJob = Bull.Job<HanamiGenerationReconcileJobData, unknown, 'hanamiGenerationReconcile'>;
type HanamiTrendTopicJudgeJob = Bull.Job<HanamiTrendTopicJudgeJobData, unknown, 'hanamiTrendTopicJudge'>;
type HanamiNoteJudgeJob = Bull.Job<HanamiNoteJudgeJobData, unknown, 'hanamiNoteJudge'>;

const NOTE_JUDGE_LOCK_CONTENTION_DELAY_MS = 60_000;
// prepareTrendTopicJudgeJob sends the ranked top, extra content topics and title targets (the Python side has the same cap).
const TREND_TOPIC_JUDGE_MAX_TOPICS = TREND_TITLE_TOP * 2 + TREND_CONTENT_JUDGE_EXTRA;
const TREND_TOPIC_JUDGE_RETRY_DELAY_MS = 30_000;
const TREND_TOPIC_JUDGE_MAX_WAIT_MS = 20 * 60 * 1000;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function malformedPayload(jobName: string, reason: string): never {
	throw new Bull.UnrecoverableError(`Invalid payload for ${jobName}: ${reason}`);
}

function normalizeBullRejection(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error('Hanami common generation processor rejected with a non-Error value', { cause: error });
}

@Injectable()
export class HanamiCommonGenerationProcessorService {
	private logger: Logger;

	constructor(
		@Inject(HANAMI_COMMON_GENERATION_LIFECYCLE)
		private lifecycle: HanamiCommonGenerationLifecyclePort,
		private queueService: QueueService,
		private queueLoggerService: QueueLoggerService,
		@Optional()
		private hanamiForYouBatchService?: HanamiForYouBatchService,
		@Optional() @Inject(DI.redis) private redisClient?: Redis.Redis,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-common-generation');
	}

	private async recordEvent(event: Omit<HanamiLlmEvent, 'at' | 'error'> & { error?: unknown; throttleMs?: number }): Promise<void> {
		if (this.redisClient != null) await recordHanamiLlmEvent(this.redisClient, event);
		else await this.hanamiForYouBatchService?.recordLlmEvent?.(event);
	}

	@bindThis
	public async processTick(job: HanamiCommonGenerationTickJob): Promise<HanamiCommonGenerationRequestResult> {
		try {
			if (!hasExactKeys(job.data, ['reason']) || (job.data.reason !== 'scheduled' && job.data.reason !== 'seed')) {
				malformedPayload(job.name, 'expected reason=scheduled or seed and no extra fields');
			}

			const result = await this.lifecycle.requestCommonGeneration(job.data.reason);
			if (result.kind === 'dispatch') {
				await this.queueService.enqueueHanamiCommonGeneration(result.generationId);
				this.logger.succ('hanami common generation requested', {
					trigger: job.data.reason,
					generationId: result.generationId,
				});
				await job.log(`dispatched generation ${result.generationId}`);
			} else {
				this.logger.info('hanami common generation request skipped', {
					trigger: job.data.reason,
					reason: result.reason,
				});
				await job.log(`request skipped: ${result.reason}`);
			}
			await job.updateProgress(100);
			return result;
		} catch (error) {
			await this.recordEvent({ job: 'generation', event: error instanceof Bull.UnrecoverableError ? 'rejected' : 'dispatchFailed', jobId: job.id, error });
			throw normalizeBullRejection(error);
		}
	}

	@bindThis
	public async processGeneration(job: HanamiCommonGenerationJob): Promise<HanamiCommonGenerationRunResult> {
		try {
			if (!hasExactKeys(job.data, ['generationId']) || typeof job.data.generationId !== 'string' || job.data.generationId.trim().length === 0) {
				malformedPayload(job.name, 'expected a nonempty generationId and no extra fields');
			}

			const result = await this.lifecycle.runCommonGeneration(job.data.generationId);
			if (result.kind === 'published' && this.hanamiForYouBatchService != null) {
				try {
					const topicJob = await this.hanamiForYouBatchService.prepareTrendTopicJudgeJob?.();
					if (topicJob != null) {
						const queued = await this.queueService.enqueueHanamiTrendTopicJudge(topicJob);
						await this.recordEvent({ job: 'generation', event: 'dispatched', jobId: queued?.id, counts: { jobs: 1, daily: topicJob.dailyIds.length, pairs: topicJob.pairs.length, titles: topicJob.titles?.length ?? 0 } });
					}
				} catch (error) {
					this.logger.warn('hanami trend topic judge dispatch failed', { error: String(error) });
					await this.recordEvent({ job: 'generation', event: 'dispatchFailed', jobId: job.id, error });
				}
				const judgeJobs = await this.hanamiForYouBatchService.prepareNoteJudgeJobs(result.generationId);
				for (const judgeJob of judgeJobs) await this.enqueueNoteJudge(judgeJob);
			}
			switch (result.kind) {
				case 'published':
					this.logger.succ('hanami common generation published', {
						generationId: result.generationId,
						generationFence: result.generationFence,
						itemCount: result.itemCount,
					});
					break;
				case 'alreadyReady':
					this.logger.info('hanami common generation already ready', {
						generationId: result.generationId,
					});
					break;
				case 'notClaimed':
					this.logger.info('hanami common generation not claimed', {
						generationId: result.generationId,
						reason: result.reason,
					});
					break;
				case 'stale':
					this.logger.info('hanami common generation stale', {
						generationId: result.generationId,
					});
					break;
			}
			await job.log(`generation result: ${result.kind}`);
			await job.updateProgress(100);
			return result;
		} catch (error) {
			await this.recordEvent({ job: 'generation', event: error instanceof Bull.UnrecoverableError ? 'rejected' : 'dispatchFailed', jobId: job.id, error });
			throw normalizeBullRejection(error);
		}
	}

	private async enqueueNoteJudge(data: { noteIds: readonly string[]; promptVersion: number }): Promise<void> {
		if (this.hanamiForYouBatchService == null) return;
		const noteIds = await this.hanamiForYouBatchService.reserveNoteJudgeNotes(data.noteIds);
		if (noteIds.length === 0) return;
		try {
			const queued = await this.queueService.enqueueHanamiNoteJudge(noteIds, data.promptVersion);
			await this.recordEvent({ job: 'generation', event: 'dispatched', jobId: queued?.id, counts: { jobs: 1, notes: noteIds.length } });
		} catch (error) {
			await this.hanamiForYouBatchService.clearQueuedNoteJudgeNotes(noteIds);
			await this.recordEvent({ job: 'generation', event: 'dispatchFailed', counts: { notes: noteIds.length }, error });
			throw error;
		}
	}

	@bindThis
	public async processTrendTopicJudge(job: HanamiTrendTopicJudgeJob): Promise<void> {
		try {
			// Jobs queued before titles existed carry only the first three keys.
			if (!(hasExactKeys(job.data, ['topics', 'dailyIds', 'pairs']) || hasExactKeys(job.data, ['topics', 'dailyIds', 'pairs', 'titles'])) || !Array.isArray(job.data.topics) || job.data.topics.length > TREND_TOPIC_JUDGE_MAX_TOPICS || !Array.isArray(job.data.dailyIds) || !Array.isArray(job.data.pairs) || job.data.pairs.length > 45) malformedPayload(job.name, 'expected topics/dailyIds/pairs arrays within limits, optional titles, and no extra fields');
			const ids = new Set<string>();
			for (const topic of job.data.topics) {
				if (!hasExactKeys(topic, ['topicId', 'text']) || typeof topic.topicId !== 'string' || topic.topicId.length === 0 || typeof topic.text !== 'string' || ids.has(topic.topicId)) malformedPayload(job.name, 'topics must have unique nonempty topicId and string text');
				ids.add(topic.topicId);
			}
			if (job.data.dailyIds.some(id => typeof id !== 'string' || !ids.has(id)) || job.data.pairs.some(pair => !hasExactKeys(pair, ['a', 'b']) || typeof pair.a !== 'string' || typeof pair.b !== 'string' || pair.a === pair.b || !ids.has(pair.a) || !ids.has(pair.b))) malformedPayload(job.name, 'dailyIds and distinct pair endpoints must reference supplied topics');
			const titles = job.data.titles;
			if (titles !== undefined && (!Array.isArray(titles) || titles.length > TREND_TITLE_TOP || titles.some(title => !hasExactKeys(title, ['topicId', 'posts', 'noteIds']) || typeof title.topicId !== 'string' || !ids.has(title.topicId)
				|| !Array.isArray(title.posts) || title.posts.length < 3 || title.posts.length > TREND_TITLE_SAMPLE_POSTS || title.posts.some(post => typeof post !== 'string')
				|| !Array.isArray(title.noteIds) || title.noteIds.length > 50 || title.noteIds.some(id => typeof id !== 'string')))) malformedPayload(job.name, 'titles must reference supplied topics and have 3..10 string posts plus at most 50 string noteIds');
		} catch (error) {
			await this.recordEvent({ job: 'topicJudge', event: 'rejected', jobId: job.id, error });
			await this.hanamiForYouBatchService?.recordTrendTopicJudgeResult(job.data, 'rejected', { error: String(error) });
			throw error;
		}
		try {
			await this.hanamiForYouBatchService?.runTrendTopicJudgeJob(job.data, this.logger, job.id);
		} catch (error) {
			if (!(error instanceof HanamiNoteJudgeLockContentionError)) {
				await this.recordEvent({ job: 'topicJudge', event: 'failed', jobId: job.id, error });
				await this.hanamiForYouBatchService?.recordTrendTopicJudgeResult(job.data, 'failed', { error: String(error) });
				throw error;
			}
			// Wait for the shared local-LLM lock instead of skipping the generation, until the topics are stale.
			if (Date.now() - job.timestamp > TREND_TOPIC_JUDGE_MAX_WAIT_MS) {
				await this.recordEvent({ job: 'topicJudge', event: 'gaveUp', jobId: job.id, durationMs: Date.now() - job.timestamp });
				await this.hanamiForYouBatchService?.recordTrendTopicJudgeResult(job.data, 'gaveUp', { waitedMs: Date.now() - job.timestamp });
				this.logger.warn('hanami trend topic judge: gave up waiting for the local LLM', { waitedMs: Date.now() - job.timestamp });
				return;
			}
			await job.moveToDelayed(Date.now() + TREND_TOPIC_JUDGE_RETRY_DELAY_MS, job.token);
			await this.recordEvent({ job: 'topicJudge', event: 'waiting', jobId: job.id, durationMs: Date.now() - job.timestamp, throttleMs: HANAMI_LLM_EVENT_THROTTLE_MS });
			await this.hanamiForYouBatchService?.recordTrendTopicJudgeResult(job.data, 'waiting', { waitedMs: Date.now() - job.timestamp });
			throw new Bull.DelayedError(error.message);
		}
		await job.updateProgress(100);
	}

	@bindThis
	public async processNoteJudge(job: HanamiNoteJudgeJob): Promise<{ runId: string; status: 'ready' | 'failed'; processedCount: number }> {
		try {
			if (!hasExactKeys(job.data, ['noteIds', 'promptVersion']) || !Array.isArray(job.data.noteIds) || job.data.noteIds.length === 0 || job.data.noteIds.length > 64 || !job.data.noteIds.every(noteId => typeof noteId === 'string' && noteId.length > 0) || !Number.isSafeInteger(job.data.promptVersion) || job.data.promptVersion < 1) malformedPayload(job.name, 'expected 1..64 nonempty noteIds and a positive integer promptVersion');
			if (this.hanamiForYouBatchService == null) throw new Error('Hanami note judge service is unavailable');
			const result = await this.hanamiForYouBatchService.runNoteJudgeJob(job.data, this.logger, job.id);
			await job.log(`note judge ${result.status}: ${result.processedCount}`);
			await job.updateProgress(100);
			return result;
		} catch (error) {
			if (error instanceof HanamiNoteJudgeLockContentionError) {
				await job.moveToDelayed(Date.now() + NOTE_JUDGE_LOCK_CONTENTION_DELAY_MS, job.token);
				await this.recordEvent({ job: 'noteJudge', event: 'waiting', jobId: job.id, throttleMs: HANAMI_LLM_EVENT_THROTTLE_MS });
				throw new Bull.DelayedError(error.message);
			}
			if (error instanceof Bull.UnrecoverableError) await this.recordEvent({ job: 'noteJudge', event: 'rejected', jobId: job.id, error });
			throw normalizeBullRejection(error);
		}
	}

	@bindThis
	public async processCommonReconcile(job: HanamiGenerationReconcileJob): Promise<HanamiCommonGenerationDispatch | null> {
		const dispatch = await this.lifecycle.findDispatchableCommonGeneration();
		if (dispatch != null) {
			await this.queueService.enqueueHanamiCommonGeneration(dispatch.generationId);
			this.logger.info('hanami common generation reconciled', {
				generationId: dispatch.generationId,
				reason: dispatch.reason,
			});
			await job.log(`reconciled generation ${dispatch.generationId}: ${dispatch.reason}`);
		} else {
			this.logger.info('hanami common generation reconcile found no work');
			await job.log('reconcile found no work');
		}
		if (this.hanamiForYouBatchService != null) {
			const judgeJobs = await this.hanamiForYouBatchService.reconcileNoteJudgeJobs();
			for (const judgeJob of judgeJobs) await this.enqueueNoteJudge(judgeJob);
			await job.log(`reconciled ${judgeJobs.length} note judge batches`);
		}
		return dispatch;
	}

	@bindThis
	public async processReconcile(job: HanamiGenerationReconcileJob): Promise<HanamiCommonGenerationDispatch | null> {
		try {
			if (!hasExactKeys(job.data, [])) {
				malformedPayload(job.name, 'expected an empty object');
			}

			const dispatch = await this.processCommonReconcile(job);
			await job.updateProgress(100);
			return dispatch;
		} catch (error) {
			await this.recordEvent({ job: 'generation', event: error instanceof Bull.UnrecoverableError ? 'rejected' : 'dispatchFailed', jobId: job.id, error });
			throw normalizeBullRejection(error);
		}
	}
}
