/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import {
	HANAMI_USER_FEED_GENERATION_LIFECYCLE,
	type HanamiUserFeedGenerationLifecyclePort,
	type HanamiUserFeedGenerationRunResult,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { QueueService } from '@/core/QueueService.js';
import type { HanamiUserFeedGenerationJobData } from '../types.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

type HanamiUserFeedGenerationJob = Bull.Job<HanamiUserFeedGenerationJobData, unknown, 'hanamiUserFeedGeneration'>;

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function normalizeBullRejection(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error('Hanami user feed generation processor rejected with a non-Error value', { cause: error });
}

@Injectable()
export class HanamiUserFeedGenerationProcessorService {
	private logger: Logger;

	constructor(
		@Inject(HANAMI_USER_FEED_GENERATION_LIFECYCLE)
		private lifecycle: HanamiUserFeedGenerationLifecyclePort,
		private queueService: QueueService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-user-feed-generation');
	}

	@bindThis
	public async process(job: HanamiUserFeedGenerationJob): Promise<HanamiUserFeedGenerationRunResult> {
		try {
			if (!hasExactKeys(job.data, ['batchId']) || typeof job.data.batchId !== 'string' || job.data.batchId.trim().length === 0) {
				throw new Bull.UnrecoverableError(`Invalid payload for ${job.name}`);
			}

			const result = await this.lifecycle.runUserFeedGeneration(job.data.batchId);
			if (result.kind === 'replaced') {
				try {
					await this.queueService.enqueueHanamiUserFeedGeneration(result.replacementBatchId);
				} catch (error) {
					this.logger.error('failed to enqueue replacement user feed batch', {
						e: normalizeBullRejection(error),
						replacementBatchId: result.replacementBatchId,
					});
				}
			}
			this.logger.info('hanami user feed generation delivery completed', {
				batchId: job.data.batchId,
				result: result.kind,
			});
			await job.log(`user feed generation result: ${result.kind}`);
			await job.updateProgress(100);
			return result;
		} catch (error) {
			throw normalizeBullRejection(error);
		}
	}
}
