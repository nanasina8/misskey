/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import type { HanamiCommonGenerationDispatch } from '@/core/hanami/HanamiCommonGenerationContracts.js';
import {
	HANAMI_USER_FEED_GENERATION_LIFECYCLE,
	type HanamiUserFeedGenerationLifecyclePort,
	type HanamiUserFeedGenerationReconcileResult,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { QueueService } from '@/core/QueueService.js';
import type { HanamiGenerationReconcileJobData } from '../types.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import { HanamiCommonGenerationProcessorService } from './HanamiCommonGenerationProcessorService.js';

const HANAMI_USER_FEED_RECONCILE_LIMIT = 100;

type HanamiGenerationReconcileJob = Bull.Job<HanamiGenerationReconcileJobData, unknown, 'hanamiGenerationReconcile'>;

export type HanamiGenerationReconcileResult = {
	readonly commonGeneration: HanamiCommonGenerationDispatch | null;
	readonly userFeedGeneration: HanamiUserFeedGenerationReconcileResult;
};

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function normalizeBullRejection(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error('Hanami generation reconcile processor rejected with a non-Error value', { cause: error });
}

@Injectable()
export class HanamiGenerationReconcileProcessorService {
	private logger: Logger;

	constructor(
		private commonGenerationProcessorService: HanamiCommonGenerationProcessorService,
		@Inject(HANAMI_USER_FEED_GENERATION_LIFECYCLE)
		private userFeedLifecycle: HanamiUserFeedGenerationLifecyclePort,
		private queueService: QueueService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-generation-reconcile');
	}

	@bindThis
	public async process(job: HanamiGenerationReconcileJob): Promise<HanamiGenerationReconcileResult> {
		try {
			if (!hasExactKeys(job.data, [])) {
				throw new Bull.UnrecoverableError(`Invalid payload for ${job.name}`);
			}

			let commonGeneration: HanamiCommonGenerationDispatch | null = null;
			let commonFailure: Error | null = null;
			try {
				commonGeneration = await this.commonGenerationProcessorService.processCommonReconcile(job);
			} catch (error) {
				commonFailure = normalizeBullRejection(error);
			}

			let userFeedGeneration: HanamiUserFeedGenerationReconcileResult | null = null;
			let userFeedFailure: Error | null = null;
			try {
				userFeedGeneration = await this.userFeedLifecycle.reconcileUserFeedGeneration(HANAMI_USER_FEED_RECONCILE_LIMIT);
				for (const batchId of userFeedGeneration.batchIdsToEnqueue) {
					await this.queueService.enqueueHanamiUserFeedGeneration(batchId);
				}
				if (userFeedGeneration.hasMore) {
					await this.queueService.enqueueHanamiGenerationReconcile();
				}

				this.logger.info('hanami user feed generation reconciled', {
					dispatchedBatchCount: userFeedGeneration.batchIdsToEnqueue.length,
					failedBatchCount: userFeedGeneration.failedBatchCount,
					obsoleteBatchCount: userFeedGeneration.obsoleteBatchCount,
					deletedRefreshCount: userFeedGeneration.deletedRefreshCount,
					hasMore: userFeedGeneration.hasMore,
				});
				await job.log(`user feed reconcile dispatched ${userFeedGeneration.batchIdsToEnqueue.length} batches; hasMore=${userFeedGeneration.hasMore}`);
			} catch (error) {
				userFeedFailure = normalizeBullRejection(error);
			}

			if (commonFailure != null) {
				this.logger.error('hanami common generation reconciliation failed', { e: commonFailure });
			}
			if (userFeedFailure != null) {
				this.logger.error('hanami user feed generation reconciliation failed', { e: userFeedFailure });
			}
			if (commonFailure != null && userFeedFailure != null) {
				throw new AggregateError(
					[commonFailure, userFeedFailure],
					'Hanami common and user feed generation reconciliation both failed',
				);
			}
			if (commonFailure != null) throw commonFailure;
			if (userFeedFailure != null) throw userFeedFailure;
			if (userFeedGeneration == null) {
				throw new Error('Hanami user feed generation reconciliation completed without a result');
			}

			await job.updateProgress(100);
			return { commonGeneration, userFeedGeneration };
		} catch (error) {
			throw normalizeBullRejection(error);
		}
	}
}
