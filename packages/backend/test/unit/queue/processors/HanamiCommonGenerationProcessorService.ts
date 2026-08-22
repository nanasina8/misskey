/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import * as Bull from 'bullmq';
import type {
	HanamiCommonGenerationLifecyclePort,
	HanamiCommonGenerationRunResult,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';

function createHarness() {
	const lifecycle = {
		requestCommonGeneration: jest.fn<HanamiCommonGenerationLifecyclePort['requestCommonGeneration']>(),
		runCommonGeneration: jest.fn<HanamiCommonGenerationLifecyclePort['runCommonGeneration']>(),
		findDispatchableCommonGeneration: jest.fn<HanamiCommonGenerationLifecyclePort['findDispatchableCommonGeneration']>(),
	};
	const queueService = {
		enqueueHanamiCommonGeneration: jest.fn(async () => undefined),
	};
	const logger = {
		info: jest.fn(),
		succ: jest.fn(),
	};
	const queueLoggerService = {
		logger: {
			createSubLogger: jest.fn(() => logger),
		},
	};
	const service = new HanamiCommonGenerationProcessorService(
		lifecycle,
		queueService as never,
		queueLoggerService as never,
	);

	return { service, lifecycle, queueService, logger, queueLoggerService };
}

function job(name: string, data: unknown) {
	return {
		name,
		data,
		log: jest.fn(async () => undefined),
		updateProgress: jest.fn(async () => undefined),
	};
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error) {
		return error;
	}
	throw new Error('expected operation to reject');
}

describe('HanamiCommonGenerationProcessorService', () => {
	test.each(['scheduled', 'seed'] as const)('maps the %s tick trigger and enqueues dispatches only', async (reason) => {
		const { service, lifecycle, queueService, queueLoggerService } = createHarness();
		lifecycle.requestCommonGeneration.mockResolvedValue({ kind: 'dispatch', generationId: `generation-${reason}` });
		const tickJob = job('hanamiCommonGenerationTick', { reason });

		await expect(service.processTick(tickJob as never)).resolves.toEqual({
			kind: 'dispatch',
			generationId: `generation-${reason}`,
		});

		expect(queueLoggerService.logger.createSubLogger).toHaveBeenCalledWith('hanami-common-generation');
		expect(lifecycle.requestCommonGeneration).toHaveBeenCalledWith(reason);
		expect(queueService.enqueueHanamiCommonGeneration).toHaveBeenCalledWith(`generation-${reason}`);
		expect(tickJob.updateProgress).toHaveBeenCalledWith(100);
	});

	test.each(['active', 'notDue', 'alreadySeeded'] as const)('succeeds without enqueue for the %s request noop', async (reason) => {
		const { service, lifecycle, queueService, logger } = createHarness();
		lifecycle.requestCommonGeneration.mockResolvedValue({ kind: 'noop', reason });
		const tickJob = job('hanamiCommonGenerationTick', { reason: 'scheduled' });

		await expect(service.processTick(tickJob as never)).resolves.toEqual({ kind: 'noop', reason });

		expect(queueService.enqueueHanamiCommonGeneration).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith('hanami common generation request skipped', {
			trigger: 'scheduled',
			reason,
		});
		expect(tickJob.updateProgress).toHaveBeenCalledWith(100);
	});

	test('propagates a post-commit dispatch enqueue failure', async () => {
		const { service, lifecycle, queueService } = createHarness();
		const error = new Error('redis unavailable');
		lifecycle.requestCommonGeneration.mockResolvedValue({ kind: 'dispatch', generationId: 'generation-1' });
		queueService.enqueueHanamiCommonGeneration.mockRejectedValue(error);
		const tickJob = job('hanamiCommonGenerationTick', { reason: 'seed' });

		await expect(service.processTick(tickJob as never)).rejects.toBe(error);
		expect(lifecycle.requestCommonGeneration).toHaveBeenCalledTimes(1);
		expect(tickJob.updateProgress).not.toHaveBeenCalled();
	});

	test.each([
		{ generationId: 'generation-pending', reason: 'pending' },
		{ generationId: 'generation-expired', reason: 'leaseExpired' },
	] as const)('enqueues a $reason reconcile dispatch', async (dispatch) => {
		const { service, lifecycle, queueService, logger } = createHarness();
		lifecycle.findDispatchableCommonGeneration.mockResolvedValue(dispatch);
		const reconcileJob = job('hanamiGenerationReconcile', {});

		await expect(service.processReconcile(reconcileJob as never)).resolves.toEqual(dispatch);

		expect(queueService.enqueueHanamiCommonGeneration).toHaveBeenCalledWith(dispatch.generationId);
		expect(logger.info).toHaveBeenCalledWith('hanami common generation reconciled', dispatch);
		expect(reconcileJob.updateProgress).toHaveBeenCalledWith(100);
	});

	test('succeeds when reconcile finds no dispatchable generation', async () => {
		const { service, lifecycle, queueService } = createHarness();
		lifecycle.findDispatchableCommonGeneration.mockResolvedValue(null);
		const reconcileJob = job('hanamiGenerationReconcile', {});

		await expect(service.processReconcile(reconcileJob as never)).resolves.toBeNull();
		expect(queueService.enqueueHanamiCommonGeneration).not.toHaveBeenCalled();
		expect(reconcileJob.updateProgress).toHaveBeenCalledWith(100);
	});

	const runResults = [
		{ kind: 'published', generationId: 'generation-1', generationFence: '7', itemCount: 42 },
		{ kind: 'alreadyReady', generationId: 'generation-1' },
		{ kind: 'notClaimed', generationId: 'generation-1', reason: 'leased' },
		{ kind: 'stale', generationId: 'generation-1' },
	] satisfies HanamiCommonGenerationRunResult[];

	test.each(runResults)('treats the $kind run result as successful', async (result) => {
		const { service, lifecycle, logger } = createHarness();
		lifecycle.runCommonGeneration.mockResolvedValue(result);
		const generationJob = job('hanamiCommonGeneration', { generationId: 'generation-1' });

		await expect(service.processGeneration(generationJob as never)).resolves.toEqual(result);

		expect(lifecycle.runCommonGeneration).toHaveBeenCalledWith('generation-1');
		expect(logger.succ.mock.calls.length + logger.info.mock.calls.length).toBe(1);
		expect(generationJob.log).toHaveBeenCalledWith(`generation result: ${result.kind}`);
		expect(generationJob.updateProgress).toHaveBeenCalledWith(100);
	});

	test.each([
		['tick missing reason', 'tick', 'hanamiCommonGenerationTick', {}],
		['tick extra field', 'tick', 'hanamiCommonGenerationTick', { reason: 'seed', owner: 'worker' }],
		['tick invalid reason', 'tick', 'hanamiCommonGenerationTick', { reason: 'manual' }],
		['generation missing ID', 'generation', 'hanamiCommonGeneration', {}],
		['generation blank ID', 'generation', 'hanamiCommonGeneration', { generationId: '  ' }],
		['generation extra field', 'generation', 'hanamiCommonGeneration', { generationId: 'generation-1', fence: '2' }],
		['reconcile extra field', 'reconcile', 'hanamiGenerationReconcile', { generationId: 'generation-1' }],
	] as const)('rejects %s as unrecoverable', async (_label, method, name, data) => {
		const { service, lifecycle } = createHarness();
		const malformedJob = job(name, data);
		const operation = method === 'tick'
			? service.processTick(malformedJob as never)
			: method === 'generation'
				? service.processGeneration(malformedJob as never)
				: service.processReconcile(malformedJob as never);

		await expect(operation).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		expect(lifecycle.requestCommonGeneration).not.toHaveBeenCalled();
		expect(lifecycle.runCommonGeneration).not.toHaveBeenCalled();
		expect(lifecycle.findDispatchableCommonGeneration).not.toHaveBeenCalled();
	});

	test('propagates lifecycle rejection to the Bull worker failure path', async () => {
		const { service, lifecycle } = createHarness();
		const error = new Error('generation failed');
		lifecycle.runCommonGeneration.mockRejectedValue(error);
		const generationJob = job('hanamiCommonGeneration', { generationId: 'generation-1' });

		await expect(service.processGeneration(generationJob as never)).rejects.toBe(error);
		expect(generationJob.log).not.toHaveBeenCalled();
		expect(generationJob.updateProgress).not.toHaveBeenCalled();
	});

	test.each([
		['tick', undefined],
		['generation', 'string rejection'],
		['reconcile', { reason: 'object rejection' }],
	] as const)('normalizes a non-Error %s rejection for BullMQ and retains its cause', async (method, rejection) => {
		const { service, lifecycle } = createHarness();
		let operation: Promise<unknown>;
		if (method === 'tick') {
			lifecycle.requestCommonGeneration.mockImplementation(() => Promise.reject(rejection));
			operation = service.processTick(job('hanamiCommonGenerationTick', { reason: 'scheduled' }) as never);
		} else if (method === 'generation') {
			lifecycle.runCommonGeneration.mockImplementation(() => Promise.reject(rejection));
			operation = service.processGeneration(job('hanamiCommonGeneration', { generationId: 'generation-1' }) as never);
		} else {
			lifecycle.findDispatchableCommonGeneration.mockImplementation(() => Promise.reject(rejection));
			operation = service.processReconcile(job('hanamiGenerationReconcile', {}) as never);
		}

		const error = await captureRejection(operation);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('non-Error value');
		expect((error as Error & { cause?: unknown }).cause).toBe(rejection);
	});

	test.each(['tick', 'generation', 'reconcile'] as const)('awaits and normalizes a rejected %s job log', async (method) => {
		const { service, lifecycle } = createHarness();
		const rejection = { helper: 'log', method };
		let operation: Promise<unknown>;
		let processorJob: ReturnType<typeof job>;
		if (method === 'tick') {
			lifecycle.requestCommonGeneration.mockResolvedValue({ kind: 'noop', reason: 'active' });
			processorJob = job('hanamiCommonGenerationTick', { reason: 'scheduled' });
			processorJob.log.mockImplementation(async () => Promise.reject(rejection));
			operation = service.processTick(processorJob as never);
		} else if (method === 'generation') {
			lifecycle.runCommonGeneration.mockResolvedValue({ kind: 'alreadyReady', generationId: 'generation-1' });
			processorJob = job('hanamiCommonGeneration', { generationId: 'generation-1' });
			processorJob.log.mockImplementation(async () => Promise.reject(rejection));
			operation = service.processGeneration(processorJob as never);
		} else {
			lifecycle.findDispatchableCommonGeneration.mockResolvedValue(null);
			processorJob = job('hanamiGenerationReconcile', {});
			processorJob.log.mockImplementation(async () => Promise.reject(rejection));
			operation = service.processReconcile(processorJob as never);
		}

		const error = await captureRejection(operation);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error & { cause?: unknown }).cause).toBe(rejection);
		expect(processorJob.updateProgress).not.toHaveBeenCalled();
	});

	test.each(['tick', 'generation', 'reconcile'] as const)('awaits and normalizes a rejected %s progress update', async (method) => {
		const { service, lifecycle } = createHarness();
		const rejection = `rejected ${method} progress`;
		let operation: Promise<unknown>;
		let processorJob: ReturnType<typeof job>;
		if (method === 'tick') {
			lifecycle.requestCommonGeneration.mockResolvedValue({ kind: 'noop', reason: 'active' });
			processorJob = job('hanamiCommonGenerationTick', { reason: 'scheduled' });
			processorJob.updateProgress.mockImplementation(async () => Promise.reject(rejection));
			operation = service.processTick(processorJob as never);
		} else if (method === 'generation') {
			lifecycle.runCommonGeneration.mockResolvedValue({ kind: 'alreadyReady', generationId: 'generation-1' });
			processorJob = job('hanamiCommonGeneration', { generationId: 'generation-1' });
			processorJob.updateProgress.mockImplementation(async () => Promise.reject(rejection));
			operation = service.processGeneration(processorJob as never);
		} else {
			lifecycle.findDispatchableCommonGeneration.mockResolvedValue(null);
			processorJob = job('hanamiGenerationReconcile', {});
			processorJob.updateProgress.mockImplementation(async () => Promise.reject(rejection));
			operation = service.processReconcile(processorJob as never);
		}

		const error = await captureRejection(operation);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error & { cause?: unknown }).cause).toBe(rejection);
		expect(processorJob.log).toHaveBeenCalledTimes(1);
	});
});
