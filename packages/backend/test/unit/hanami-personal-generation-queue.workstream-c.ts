/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';
import { QueueService } from '@/core/QueueService.js';

function createQueueService() {
	const queue = {
		add: jest.fn<(name: string, data: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>>(async () => undefined),
	};
	const service = Object.create(QueueService.prototype) as QueueService;
	service.hanamiGenerationQueue = queue as never;
	return { service, queue };
}

describe('Phase 4 workstream C personal generation queue contract', () => {
	test('enqueues exact batch data with a stable duplicate-safe identity', async () => {
		const { service, queue } = createQueueService();

		await service.enqueueHanamiUserFeedGeneration('batch-01');
		await service.enqueueHanamiUserFeedGeneration('batch-01');

		expect(queue.add).toHaveBeenCalledTimes(2);
		for (const call of queue.add.mock.calls) {
			expect(call).toEqual([
				'hanamiUserFeedGeneration',
				{ batchId: 'batch-01' },
				{
					attempts: 1,
					removeOnComplete: true,
					removeOnFail: true,
					jobId: 'hanamiUserFeedGeneration-batch-01',
				},
			]);
		}
		expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
	});

	test('rejects invalid durable batch IDs before touching BullMQ', () => {
		const { service, queue } = createQueueService();

		expect(() => service.enqueueHanamiUserFeedGeneration('')).toThrow('batchId must be a nonempty string');
		expect(() => service.enqueueHanamiUserFeedGeneration('   ')).toThrow('batchId must be a nonempty string');
		expect(() => service.enqueueHanamiUserFeedGeneration(null as never)).toThrow('batchId must be a nonempty string');
		expect(queue.add).not.toHaveBeenCalled();
	});

	test('routes generation and cache-repair jobs and keeps one reconcile scheduler', () => {
		const queueTypesSource = readFileSync(new URL('../../src/queue/types.ts', import.meta.url), 'utf8');
		const processorSource = readFileSync(new URL('../../src/queue/QueueProcessorService.ts', import.meta.url), 'utf8');
		const queueServiceSource = readFileSync(new URL('../../src/core/QueueService.ts', import.meta.url), 'utf8');
		const workerStart = processorSource.indexOf('//#region hanami common generation');
		const workerEnd = processorSource.indexOf('//#endregion', workerStart);
		const worker = processorSource.slice(workerStart, workerEnd);

		expect(queueTypesSource).toContain('hanamiUserFeedGeneration: HanamiUserFeedGenerationJobData;');
		expect(worker).toContain("case 'hanamiCommonGenerationTick'");
		expect(worker).toContain("case 'hanamiCommonGeneration'");
		expect(worker).toContain("case 'hanamiUserFeedGeneration'");
		expect(worker).toContain('this.hanamiUserFeedGenerationProcessorService.process');
		expect(worker).toContain("case 'hanamiGenerationReconcile'");
		expect(worker).toContain('this.hanamiGenerationReconcileProcessorService.process');
		expect(worker).toContain("case 'hanamiRecommendationEventCacheRepair'");
		expect(worker).toContain("case 'hanamiRecommendationEventCacheReplay'");
		expect(worker).toContain('default: throw new Error(`unrecognized job type ${job.name} for hanamiGeneration`)');
		expect(queueServiceSource.match(/upsertJobScheduler\('hanamiGenerationReconcile'/g)).toHaveLength(1);
	});
});
