/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { HanamiTimelinePartitionMaintenanceProcessorService } from '@/queue/processors/HanamiTimelinePartitionMaintenanceProcessorService.js';

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error) {
		return error;
	}
	throw new Error('expected operation to reject');
}

describe('HanamiTimelinePartitionMaintenanceProcessorService', () => {
	test('logs and delegates to partition maintenance', async () => {
		const partitionService = { maintainCurrentAndNextTwoMonths: jest.fn(async () => undefined) };
		const logger = { info: jest.fn(), succ: jest.fn() };
		const queueLoggerService = { logger: { createSubLogger: jest.fn(() => logger) } };
		const service = new HanamiTimelinePartitionMaintenanceProcessorService(partitionService as never, queueLoggerService as never);

		await service.process();

		expect(queueLoggerService.logger.createSubLogger).toHaveBeenCalledWith('hanami-timeline-partitions');
		expect(logger.info).toHaveBeenCalledWith('hanami timeline partitions: maintenance start');
		expect(partitionService.maintainCurrentAndNextTwoMonths).toHaveBeenCalledTimes(1);
		expect(logger.succ).toHaveBeenCalledWith('hanami timeline partitions: maintenance done');
	});

	test('propagates failures without logging success', async () => {
		const error = new Error('maintenance failed');
		const partitionService = { maintainCurrentAndNextTwoMonths: jest.fn(async () => { throw error; }) };
		const logger = { info: jest.fn(), succ: jest.fn() };
		const queueLoggerService = { logger: { createSubLogger: jest.fn(() => logger) } };
		const service = new HanamiTimelinePartitionMaintenanceProcessorService(partitionService as never, queueLoggerService as never);

		await expect(service.process()).rejects.toThrow(error);
		expect(logger.info).toHaveBeenCalledWith('hanami timeline partitions: maintenance start');
		expect(logger.succ).not.toHaveBeenCalled();
	});

	test.each([
		undefined,
		'string rejection',
		{ reason: 'object rejection' },
	] as const)('normalizes non-Error maintenance rejection %# and retains its cause', async (rejection) => {
		const partitionService = { maintainCurrentAndNextTwoMonths: jest.fn(() => Promise.reject(rejection)) };
		const logger = { info: jest.fn(), succ: jest.fn() };
		const queueLoggerService = { logger: { createSubLogger: jest.fn(() => logger) } };
		const service = new HanamiTimelinePartitionMaintenanceProcessorService(partitionService as never, queueLoggerService as never);

		const error = await captureRejection(service.process());

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('non-Error value');
		expect((error as Error & { cause?: unknown }).cause).toBe(rejection);
		expect(logger.succ).not.toHaveBeenCalled();
	});

	test('preserves Error identity at the maintenance processor boundary', async () => {
		const rejection = new Error('maintenance error identity');
		const partitionService = { maintainCurrentAndNextTwoMonths: jest.fn(() => Promise.reject(rejection)) };
		const queueLoggerService = { logger: { createSubLogger: jest.fn(() => ({ info: jest.fn(), succ: jest.fn() })) } };
		const service = new HanamiTimelinePartitionMaintenanceProcessorService(partitionService as never, queueLoggerService as never);

		await expect(service.process()).rejects.toBe(rejection);
	});
});
