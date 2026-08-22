/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import * as Bull from 'bullmq';
import type { HanamiUserFeedGenerationLifecyclePort } from '@/core/hanami/HanamiUserFeedContracts.js';
import { HanamiGenerationReconcileProcessorService } from '@/queue/processors/HanamiGenerationReconcileProcessorService.js';

function reconcileResult(hasMore: boolean) {
	return {
		batchIdsToEnqueue: ['batch-01', 'batch-02'],
		failedBatchCount: 1,
		obsoleteBatchCount: 2,
		deletedRefreshCount: 3,
		hasMore,
	};
}

function createHarness() {
	const order: string[] = [];
	const commonGenerationProcessorService = {
		processCommonReconcile: jest.fn(async () => {
			order.push('common');
			return { generationId: 'common-01', reason: 'pending' } as const;
		}),
	};
	const userFeedLifecycle = {
		runUserFeedGeneration: jest.fn<HanamiUserFeedGenerationLifecyclePort['runUserFeedGeneration']>(),
		reconcileUserFeedGeneration: jest.fn<HanamiUserFeedGenerationLifecyclePort['reconcileUserFeedGeneration']>(async (limit) => {
			order.push(`personal:${limit}`);
			return reconcileResult(false);
		}),
	};
	const queueService = {
		enqueueHanamiUserFeedGeneration: jest.fn(async (batchId: string) => {
			order.push(`batch:${batchId}`);
		}),
		enqueueHanamiGenerationReconcile: jest.fn(async () => {
			order.push('reconcile');
		}),
	};
	const logger = {
		info: jest.fn(),
		error: jest.fn(),
	};
	const queueLoggerService = {
		logger: {
			createSubLogger: jest.fn(() => logger),
		},
	};
	const service = new HanamiGenerationReconcileProcessorService(
		commonGenerationProcessorService as never,
		userFeedLifecycle,
		queueService as never,
		queueLoggerService as never,
	);
	return { service, commonGenerationProcessorService, userFeedLifecycle, queueService, logger, order };
}

function job(data: unknown = {}) {
	return {
		name: 'hanamiGenerationReconcile',
		data,
		log: jest.fn(async () => undefined),
		updateProgress: jest.fn(async () => undefined),
	};
}

describe('HanamiGenerationReconcileProcessorService workstream C', () => {
	test('runs common first, then a bounded personal pass, then enqueues all returned batches', async () => {
		const { service, commonGenerationProcessorService, userFeedLifecycle, queueService, logger, order } = createHarness();
		const reconcileJob = job();

		await expect(service.process(reconcileJob as never)).resolves.toEqual({
			commonGeneration: { generationId: 'common-01', reason: 'pending' },
			userFeedGeneration: reconcileResult(false),
		});

		expect(order).toEqual(['common', 'personal:100', 'batch:batch-01', 'batch:batch-02']);
		expect(commonGenerationProcessorService.processCommonReconcile).toHaveBeenCalledWith(reconcileJob);
		expect(userFeedLifecycle.reconcileUserFeedGeneration).toHaveBeenCalledWith(100);
		expect(queueService.enqueueHanamiUserFeedGeneration).toHaveBeenNthCalledWith(1, 'batch-01');
		expect(queueService.enqueueHanamiUserFeedGeneration).toHaveBeenNthCalledWith(2, 'batch-02');
		expect(queueService.enqueueHanamiGenerationReconcile).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith('hanami user feed generation reconciled', {
			dispatchedBatchCount: 2,
			failedBatchCount: 1,
			obsoleteBatchCount: 2,
			deletedRefreshCount: 3,
			hasMore: false,
		});
		expect(reconcileJob.updateProgress).toHaveBeenCalledWith(100);
	});

	test('requests exactly one immediate shared pass only when personal reconciliation has more', async () => {
		const { service, userFeedLifecycle, queueService, order } = createHarness();
		userFeedLifecycle.reconcileUserFeedGeneration.mockImplementation(async (limit) => {
			order.push(`personal:${limit}`);
			return reconcileResult(true);
		});

		await service.process(job() as never);

		expect(order).toEqual(['common', 'personal:100', 'batch:batch-01', 'batch:batch-02', 'reconcile']);
		expect(queueService.enqueueHanamiGenerationReconcile).toHaveBeenCalledTimes(1);
	});

	test('tolerates duplicate reconcile deliveries through repeatable lifecycle and enqueue boundaries', async () => {
		const { service, commonGenerationProcessorService, userFeedLifecycle, queueService } = createHarness();

		await service.process(job() as never);
		await service.process(job() as never);

		expect(commonGenerationProcessorService.processCommonReconcile).toHaveBeenCalledTimes(2);
		expect(userFeedLifecycle.reconcileUserFeedGeneration).toHaveBeenCalledTimes(2);
		expect(queueService.enqueueHanamiUserFeedGeneration).toHaveBeenCalledTimes(4);
	});

	test('still reconciles and dispatches personal batches before surfacing a common failure', async () => {
		const { service, commonGenerationProcessorService, userFeedLifecycle, queueService, logger, order } = createHarness();
		const failure = new Error('common reconciliation unavailable');
		commonGenerationProcessorService.processCommonReconcile.mockImplementation(async () => {
			order.push('common');
			throw failure;
		});

		await expect(service.process(job() as never)).rejects.toBe(failure);
		expect(order).toEqual(['common', 'personal:100', 'batch:batch-01', 'batch:batch-02']);
		expect(userFeedLifecycle.reconcileUserFeedGeneration).toHaveBeenCalledWith(100);
		expect(queueService.enqueueHanamiUserFeedGeneration).toHaveBeenNthCalledWith(1, 'batch-01');
		expect(queueService.enqueueHanamiUserFeedGeneration).toHaveBeenNthCalledWith(2, 'batch-02');
		expect(logger.error).toHaveBeenCalledWith('hanami common generation reconciliation failed', { e: failure });
		expect(logger.error.mock.invocationCallOrder[0]).toBeGreaterThan(queueService.enqueueHanamiUserFeedGeneration.mock.invocationCallOrder[1]);
	});

	test('surfaces a personal failure after successful common reconciliation', async () => {
		const { service, commonGenerationProcessorService, userFeedLifecycle, queueService, logger, order } = createHarness();
		const failure = new Error('personal reconciliation unavailable');
		userFeedLifecycle.reconcileUserFeedGeneration.mockImplementation(async (limit) => {
			order.push(`personal:${limit}`);
			throw failure;
		});

		await expect(service.process(job() as never)).rejects.toBe(failure);
		expect(order).toEqual(['common', 'personal:100']);
		expect(commonGenerationProcessorService.processCommonReconcile).toHaveBeenCalledTimes(1);
		expect(queueService.enqueueHanamiUserFeedGeneration).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith('hanami user feed generation reconciliation failed', { e: failure });
	});

	test('preserves both common and personal failures in an AggregateError', async () => {
		const { service, commonGenerationProcessorService, userFeedLifecycle, logger, order } = createHarness();
		const commonFailure = new Error('common reconciliation unavailable');
		const personalFailure = new Error('personal reconciliation unavailable');
		commonGenerationProcessorService.processCommonReconcile.mockImplementation(async () => {
			order.push('common');
			throw commonFailure;
		});
		userFeedLifecycle.reconcileUserFeedGeneration.mockImplementation(async (limit) => {
			order.push(`personal:${limit}`);
			throw personalFailure;
		});

		let rejection: unknown;
		try {
			await service.process(job() as never);
		} catch (error) {
			rejection = error;
		}

		expect(order).toEqual(['common', 'personal:100']);
		expect(rejection).toBeInstanceOf(AggregateError);
		expect((rejection as AggregateError).message).toBe('Hanami common and user feed generation reconciliation both failed');
		expect((rejection as AggregateError).errors).toEqual([commonFailure, personalFailure]);
		expect(logger.error).toHaveBeenNthCalledWith(1, 'hanami common generation reconciliation failed', { e: commonFailure });
		expect(logger.error).toHaveBeenNthCalledWith(2, 'hanami user feed generation reconciliation failed', { e: personalFailure });
	});

	test('rejects nonempty reconcile payloads as unrecoverable', async () => {
		const { service, commonGenerationProcessorService, userFeedLifecycle } = createHarness();

		await expect(service.process(job({ batchId: 'batch-01' }) as never)).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		expect(commonGenerationProcessorService.processCommonReconcile).not.toHaveBeenCalled();
		expect(userFeedLifecycle.reconcileUserFeedGeneration).not.toHaveBeenCalled();
	});
});
