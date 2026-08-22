/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import * as Bull from 'bullmq';
import type {
	HanamiUserFeedGenerationLifecyclePort,
	HanamiUserFeedGenerationRunResult,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { HanamiUserFeedGenerationProcessorService } from '@/queue/processors/HanamiUserFeedGenerationProcessorService.js';

function createHarness() {
	const lifecycle = {
		runUserFeedGeneration: jest.fn<HanamiUserFeedGenerationLifecyclePort['runUserFeedGeneration']>(),
		reconcileUserFeedGeneration: jest.fn<HanamiUserFeedGenerationLifecyclePort['reconcileUserFeedGeneration']>(),
	};
	const logger = {
		info: jest.fn(),
	};
	const queueLoggerService = {
		logger: {
			createSubLogger: jest.fn(() => logger),
		},
	};
	const service = new HanamiUserFeedGenerationProcessorService(lifecycle, queueLoggerService as never);
	return { service, lifecycle, logger, queueLoggerService };
}

function job(data: unknown) {
	return {
		name: 'hanamiUserFeedGeneration',
		data,
		log: jest.fn(async () => undefined),
		updateProgress: jest.fn(async () => undefined),
	};
}

describe('HanamiUserFeedGenerationProcessorService workstream C', () => {
	const runResults = [
		{ kind: 'pending', batchId: 'batch-01' },
		{ kind: 'leased', batchId: 'batch-01', attempt: 1 },
		{ kind: 'terminal', batchId: 'batch-01', status: 'failed' },
		{ kind: 'stale', batchId: 'batch-01', attempt: 1 },
		{ kind: 'obsolete', batchId: 'batch-01' },
		{ kind: 'alreadyReady', batchId: 'batch-01', itemCount: 30 },
		{ kind: 'published', batchId: 'batch-01', attempt: 1, itemCount: 30, feedEpochId: 'epoch-01', headSequence: '30' },
		{ kind: 'failed', batchId: 'batch-01', attempt: 1, terminal: false },
	] satisfies HanamiUserFeedGenerationRunResult[];

	test.each(runResults)('delegates the $kind delivery entirely to the DB lifecycle', async (result) => {
		const { service, lifecycle, logger, queueLoggerService } = createHarness();
		lifecycle.runUserFeedGeneration.mockResolvedValue(result);
		const generationJob = job({ batchId: 'batch-01' });

		await expect(service.process(generationJob as never)).resolves.toEqual(result);

		expect(queueLoggerService.logger.createSubLogger).toHaveBeenCalledWith('hanami-user-feed-generation');
		expect(lifecycle.runUserFeedGeneration).toHaveBeenCalledWith('batch-01');
		expect(logger.info).toHaveBeenCalledWith('hanami user feed generation delivery completed', {
			batchId: 'batch-01',
			result: result.kind,
		});
		expect(generationJob.log).toHaveBeenCalledWith(`user feed generation result: ${result.kind}`);
		expect(generationJob.updateProgress).toHaveBeenCalledWith(100);
	});

	test('tolerates duplicate deliveries by invoking the idempotent lifecycle with the same batch', async () => {
		const { service, lifecycle } = createHarness();
		lifecycle.runUserFeedGeneration
			.mockResolvedValueOnce({ kind: 'published', batchId: 'batch-01', attempt: 1, itemCount: 1, feedEpochId: 'epoch-01', headSequence: '1' })
			.mockResolvedValueOnce({ kind: 'alreadyReady', batchId: 'batch-01', itemCount: 1 });

		await service.process(job({ batchId: 'batch-01' }) as never);
		await service.process(job({ batchId: 'batch-01' }) as never);

		expect(lifecycle.runUserFeedGeneration).toHaveBeenNthCalledWith(1, 'batch-01');
		expect(lifecycle.runUserFeedGeneration).toHaveBeenNthCalledWith(2, 'batch-01');
	});

	test.each([
		{},
		{ batchId: '' },
		{ batchId: '   ' },
		{ batchId: 1 },
		{ batchId: 'batch-01', attempt: 1 },
		[],
		null,
	])('rejects malformed payload %p without invoking the lifecycle', async (data) => {
		const { service, lifecycle } = createHarness();

		await expect(service.process(job(data) as never)).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		expect(lifecycle.runUserFeedGeneration).not.toHaveBeenCalled();
	});

	test('propagates a hard-timeout rejection to fail the BullMQ delivery', async () => {
		const { service, lifecycle } = createHarness();
		const timeout = new Error('personal generation hard timeout');
		timeout.name = 'AbortError';
		lifecycle.runUserFeedGeneration.mockRejectedValue(timeout);
		const generationJob = job({ batchId: 'batch-01' });

		await expect(service.process(generationJob as never)).rejects.toBe(timeout);
		expect(generationJob.log).not.toHaveBeenCalled();
		expect(generationJob.updateProgress).not.toHaveBeenCalled();
	});
});
