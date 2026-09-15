/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import * as Bull from 'bullmq';
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
import type {
	HanamiCommonGenerationJobData,
	HanamiCommonGenerationTickJobData,
	HanamiGenerationReconcileJobData,
	HanamiNoteJudgeJobData,
} from '../types.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

type HanamiCommonGenerationTickJob = Bull.Job<HanamiCommonGenerationTickJobData, unknown, 'hanamiCommonGenerationTick'>;
type HanamiCommonGenerationJob = Bull.Job<HanamiCommonGenerationJobData, unknown, 'hanamiCommonGeneration'>;
type HanamiGenerationReconcileJob = Bull.Job<HanamiGenerationReconcileJobData, unknown, 'hanamiGenerationReconcile'>;
type HanamiNoteJudgeJob = Bull.Job<HanamiNoteJudgeJobData, unknown, 'hanamiNoteJudge'>;

const NOTE_JUDGE_LOCK_CONTENTION_DELAY_MS = 60_000;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function malformedPayload(jobName: string): never {
	throw new Bull.UnrecoverableError(`Invalid payload for ${jobName}`);
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
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-common-generation');
	}

	@bindThis
	public async processTick(job: HanamiCommonGenerationTickJob): Promise<HanamiCommonGenerationRequestResult> {
		try {
			if (!hasExactKeys(job.data, ['reason']) || (job.data.reason !== 'scheduled' && job.data.reason !== 'seed')) {
				malformedPayload(job.name);
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
			throw normalizeBullRejection(error);
		}
	}

	@bindThis
	public async processGeneration(job: HanamiCommonGenerationJob): Promise<HanamiCommonGenerationRunResult> {
		try {
			if (!hasExactKeys(job.data, ['generationId']) || typeof job.data.generationId !== 'string' || job.data.generationId.trim().length === 0) {
				malformedPayload(job.name);
			}

			const result = await this.lifecycle.runCommonGeneration(job.data.generationId);
			if (result.kind === 'published' && this.hanamiForYouBatchService != null) {
				const judgeJobs = await this.hanamiForYouBatchService.prepareNoteJudgeJobs(result.generationId);
				for (const judgeJob of judgeJobs) await this.queueService.enqueueHanamiNoteJudge(judgeJob.noteIds, judgeJob.promptVersion);
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
			throw normalizeBullRejection(error);
		}
	}

	@bindThis
	public async processNoteJudge(job: HanamiNoteJudgeJob): Promise<{ runId: string; status: 'ready' | 'failed'; processedCount: number }> {
		try {
			if (!hasExactKeys(job.data, ['noteIds', 'promptVersion']) || !Array.isArray(job.data.noteIds) || job.data.noteIds.length === 0 || job.data.noteIds.length > 64 || !job.data.noteIds.every(noteId => typeof noteId === 'string' && noteId.length > 0) || !Number.isSafeInteger(job.data.promptVersion) || job.data.promptVersion < 1) malformedPayload(job.name);
			if (this.hanamiForYouBatchService == null) throw new Error('Hanami note judge service is unavailable');
			const result = await this.hanamiForYouBatchService.runNoteJudgeJob(job.data, this.logger);
			await job.log(`note judge ${result.status}: ${result.processedCount}`);
			await job.updateProgress(100);
			return result;
		} catch (error) {
			if (error instanceof HanamiNoteJudgeLockContentionError) {
				await job.moveToDelayed(Date.now() + NOTE_JUDGE_LOCK_CONTENTION_DELAY_MS, job.token);
				throw new Bull.DelayedError(error.message);
			}
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
			for (const judgeJob of judgeJobs) await this.queueService.enqueueHanamiNoteJudge(judgeJob.noteIds, judgeJob.promptVersion);
			await job.log(`reconciled ${judgeJobs.length} note judge batches`);
		}
		return dispatch;
	}

	@bindThis
	public async processReconcile(job: HanamiGenerationReconcileJob): Promise<HanamiCommonGenerationDispatch | null> {
		try {
			if (!hasExactKeys(job.data, [])) {
				malformedPayload(job.name);
			}

			const dispatch = await this.processCommonReconcile(job);
			await job.updateProgress(100);
			return dispatch;
		} catch (error) {
			throw normalizeBullRejection(error);
		}
	}
}
