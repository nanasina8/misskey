/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DI } from '@/di-symbols.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { QueueModule } from '@/core/QueueModule.js';
import { QUEUE_TYPES, QueueService } from '@/core/QueueService.js';
import { HanamiCommonComputationService } from '@/core/hanami/HanamiCommonComputationService.js';
import { HanamiCommonGenerationService } from '@/core/hanami/HanamiCommonGenerationService.js';
import {
	HANAMI_COMMON_COMPUTATION,
	HANAMI_COMMON_GENERATION_LIFECYCLE,
	HANAMI_COMMON_GENERATION_READ,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import { HanamiTimelinePartitionService } from '@/core/hanami/HanamiTimelinePartitionService.js';
import { QUEUE } from '@/queue/const.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';

const NOW = new Date('2026-08-20T12:03:04.321Z');
const SEVEN_DAYS_SECONDS = 3600 * 24 * 7;
const JOB_OPTIONS = {
	attempts: 1,
	removeOnComplete: { age: SEVEN_DAYS_SECONDS },
	removeOnFail: { age: SEVEN_DAYS_SECONDS },
};
const SEED_JOB_OPTIONS = {
	...JOB_OPTIONS,
	jobId: `hanamiCommonGenerationSeed-${Math.floor(NOW.getTime() / 600_000)}`,
	removeOnFail: true,
};

function adminQueue() {
	return {
		getJobCounts: jest.fn(async () => ({ waiting: 0 })),
		isPaused: jest.fn(async () => false),
		getMetrics: jest.fn(async () => ({ meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [], count: 0 })),
		clean: jest.fn(async () => []),
		close: jest.fn(async () => undefined),
	};
}

function createQueueService() {
	const systemQueue = {
		...adminQueue(),
		upsertJobScheduler: jest.fn(async (_name: string) => undefined),
		getJobSchedulers: jest.fn(async () => []),
		removeJobScheduler: jest.fn(async (_key: string) => undefined),
	};
	const hanamiGenerationQueue = {
		...adminQueue(),
		upsertJobScheduler: jest.fn(async () => undefined),
		add: jest.fn<(name: string, data: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>>(async () => undefined),
	};
	const otherQueues = Array.from({ length: 9 }, () => adminQueue());
	const service = new QueueService(
		{
			hanamiCommonGenerationIntervalMs: 600_000,
			hanamiGenerationReconcileIntervalMs: 5_000,
		} as never,
		systemQueue as never,
		otherQueues[0] as never,
		otherQueues[1] as never,
		otherQueues[2] as never,
		otherQueues[3] as never,
		otherQueues[4] as never,
		otherQueues[5] as never,
		otherQueues[6] as never,
		otherQueues[7] as never,
		otherQueues[8] as never,
		hanamiGenerationQueue as never,
	);

	return { service, systemQueue, hanamiGenerationQueue, otherQueues };
}

type ExistingAlias = {
	provide: symbol;
	useExisting: unknown;
};

function existingAlias(providers: readonly unknown[], token: symbol): ExistingAlias {
	const provider = providers.find((entry): entry is ExistingAlias => (
		typeof entry === 'object'
		&& entry != null
		&& 'provide' in entry
		&& entry.provide === token
		&& 'useExisting' in entry
	));
	if (provider == null) throw new Error(`missing useExisting provider for ${String(token)}`);
	return provider;
}

describe('Hanami common generation queue wiring', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test('defines a typed dedicated queue provider', () => {
		expect(QUEUE.HANAMI_GENERATION).toBe('hanamiGeneration');
		const moduleSource = readFileSync(new URL('../../src/core/QueueModule.ts', import.meta.url), 'utf8');
		const processorSource = readFileSync(new URL('../../src/queue/processors/HanamiCommonGenerationProcessorService.ts', import.meta.url), 'utf8');
		expect(moduleSource).toContain("provide: 'queue:hanamiGeneration'");
		expect(moduleSource).toContain('new Bull.Queue<HanamiGenerationJobData, unknown, HanamiGenerationJobName>(QUEUE.HANAMI_GENERATION');
		expect(moduleSource).toContain('$hanamiGeneration');
		expect(processorSource).toContain('@Inject(HANAMI_COMMON_GENERATION_LIFECYCLE)');
	});

	test('exports one concrete lifecycle through all frozen aliases and resolves the queue processor dependency', async () => {
		const coreProviders = Reflect.getMetadata('providers', CoreModule) as readonly unknown[];
		const coreExports = Reflect.getMetadata('exports', CoreModule) as readonly unknown[];
		const queueModuleSource = readFileSync(new URL('../../src/queue/QueueProcessorModule.ts', import.meta.url), 'utf8');
		const computationAlias = existingAlias(coreProviders, HANAMI_COMMON_COMPUTATION);
		const lifecycleAlias = existingAlias(coreProviders, HANAMI_COMMON_GENERATION_LIFECYCLE);
		const readAlias = existingAlias(coreProviders, HANAMI_COMMON_GENERATION_READ);

		expect(computationAlias.useExisting).toBe(HanamiCommonComputationService);
		expect(lifecycleAlias.useExisting).toBe(HanamiCommonGenerationService);
		expect(readAlias.useExisting).toBe(HanamiCommonGenerationService);
		expect(coreProviders.filter((provider) => provider === HanamiCommonComputationService)).toHaveLength(1);
		expect(coreProviders.filter((provider) => provider === HanamiCommonGenerationService)).toHaveLength(1);
		expect(coreExports).toEqual(expect.arrayContaining([
			HANAMI_COMMON_COMPUTATION,
			HANAMI_COMMON_GENERATION_LIFECYCLE,
			HANAMI_COMMON_GENERATION_READ,
		]));
		expect(queueModuleSource).toContain('imports: [\n\t\tGlobalModule,\n\t\tCoreModule,\n\t]');
		expect(queueModuleSource).toContain('\t\tHanamiCommonGenerationProcessorService,');

		const computation = {
			algorithmVersion: 'di-contract-v1',
			buildSourceBundle: jest.fn(),
			materializeFeed: jest.fn(),
		};
		const module = await Test.createTestingModule({
			providers: [
				{ provide: DI.db, useValue: {} },
				{ provide: DI.config, useValue: {} },
				{ provide: IdService, useValue: {} },
				{ provide: HanamiTimelinePartitionService, useValue: {} },
				{ provide: HanamiForYouSafetyService, useValue: {} },
				{ provide: HanamiCommonComputationService, useValue: computation },
				HanamiCommonGenerationService,
				computationAlias,
				lifecycleAlias,
				readAlias,
				{ provide: QueueService, useValue: {} },
				{
					provide: QueueLoggerService,
					useValue: { logger: { createSubLogger: jest.fn(() => ({})) } },
				},
				HanamiCommonGenerationProcessorService,
			],
		}).compile();

		const generation = module.get(HanamiCommonGenerationService);
		const processor = module.get(HanamiCommonGenerationProcessorService);
		expect(module.get(HANAMI_COMMON_COMPUTATION)).toBe(computation);
		expect(module.get(HANAMI_COMMON_GENERATION_LIFECYCLE)).toBe(generation);
		expect(module.get(HANAMI_COMMON_GENERATION_READ)).toBe(generation);
		expect((generation as unknown as { computation: unknown }).computation).toBe(computation);
		expect((processor as unknown as { lifecycle: unknown }).lifecycle).toBe(generation);
		await module.close();
	});

	test('schedules boundaries and immediately enqueues one deduplicated startup seed plus reconcile', async () => {
		const { service, systemQueue, hanamiGenerationQueue } = createQueueService();

		expect(systemQueue.upsertJobScheduler).not.toHaveBeenCalled();
		expect(systemQueue.getJobSchedulers).not.toHaveBeenCalled();
		expect(hanamiGenerationQueue.upsertJobScheduler).not.toHaveBeenCalled();
		expect(hanamiGenerationQueue.add).not.toHaveBeenCalled();
		await service.onModuleInit();

		expect(systemQueue.upsertJobScheduler).toHaveBeenCalledWith(
			'maintainHanamiTimelinePartitions',
			{ pattern: '17 0 * * *', tz: 'UTC', immediately: false },
			expect.objectContaining({ name: 'maintainHanamiTimelinePartitions' }),
		);
		expect(systemQueue.getJobSchedulers).toHaveBeenCalledTimes(1);
		expect(hanamiGenerationQueue.upsertJobScheduler).toHaveBeenCalledTimes(3);
		expect(hanamiGenerationQueue.upsertJobScheduler).toHaveBeenNthCalledWith(1,
			'hanamiCommonGenerationTick',
			{
				every: 600_000,
				startDate: new Date('2026-08-20T12:10:00.000Z'),
				immediately: false,
			},
			{
				name: 'hanamiCommonGenerationTick',
				data: { reason: 'scheduled' },
				opts: JOB_OPTIONS,
			},
		);
		expect(hanamiGenerationQueue.upsertJobScheduler).toHaveBeenNthCalledWith(2,
			'hanamiGenerationReconcile',
			{
				every: 5_000,
				startDate: new Date('2026-08-20T12:03:05.000Z'),
				immediately: false,
			},
			{
				name: 'hanamiGenerationReconcile',
				data: {},
				opts: JOB_OPTIONS,
			},
		);
		expect(hanamiGenerationQueue.upsertJobScheduler).toHaveBeenNthCalledWith(3,
			'hanamiRecommendationEventCacheReplay',
			{
				every: 60_000,
				startDate: new Date('2026-08-20T12:04:00.000Z'),
				immediately: false,
			},
			expect.objectContaining({
				name: 'hanamiRecommendationEventCacheReplay',
				data: {},
				opts: expect.objectContaining({ attempts: 3 }),
			}),
		);
		expect(hanamiGenerationQueue.add).toHaveBeenCalledTimes(2);
		expect(hanamiGenerationQueue.add).toHaveBeenNthCalledWith(1, 'hanamiCommonGenerationTick', { reason: 'seed' }, SEED_JOB_OPTIONS);
		expect(hanamiGenerationQueue.add).toHaveBeenNthCalledWith(2, 'hanamiGenerationReconcile', {}, JOB_OPTIONS);
	});

	test('rejects initialization when partition scheduler persistence fails', async () => {
		const failure = new Error('partition scheduler unavailable');
		const { service, systemQueue, hanamiGenerationQueue } = createQueueService();
		systemQueue.upsertJobScheduler.mockImplementation(async (name: string) => {
			if (name === 'maintainHanamiTimelinePartitions') throw failure;
		});

		await expect(service.onModuleInit()).rejects.toBe(failure);
		expect(systemQueue.getJobSchedulers).not.toHaveBeenCalled();
		expect(hanamiGenerationQueue.upsertJobScheduler).not.toHaveBeenCalled();
		expect(hanamiGenerationQueue.add).not.toHaveBeenCalled();
	});

	test('awaits stale system scheduler removal and propagates its rejection', async () => {
		const failure = new Error('stale scheduler removal unavailable');
		const { service, systemQueue, hanamiGenerationQueue } = createQueueService();
		systemQueue.getJobSchedulers.mockResolvedValue([{ key: 'legacyScheduler' }] as never);
		systemQueue.removeJobScheduler.mockRejectedValueOnce(failure);

		await expect(service.onModuleInit()).rejects.toBe(failure);
		expect(systemQueue.removeJobScheduler).toHaveBeenCalledWith('legacyScheduler');
		expect(hanamiGenerationQueue.upsertJobScheduler).not.toHaveBeenCalled();
		expect(hanamiGenerationQueue.add).not.toHaveBeenCalled();
	});

	test('surfaces dedicated scheduler and startup reconcile initialization failures', async () => {
		const schedulerFailure = new Error('scheduler unavailable');
		const scheduler = createQueueService();
		scheduler.hanamiGenerationQueue.upsertJobScheduler.mockRejectedValueOnce(schedulerFailure);

		await expect(scheduler.service.onModuleInit()).rejects.toBe(schedulerFailure);
		expect(scheduler.hanamiGenerationQueue.add).not.toHaveBeenCalled();

		const reconcileFailure = new Error('startup reconcile unavailable');
		const reconcile = createQueueService();
		reconcile.hanamiGenerationQueue.add.mockImplementation(async (name: string) => {
			if (name === 'hanamiGenerationReconcile') throw reconcileFailure;
		});

		await expect(reconcile.service.onModuleInit()).rejects.toBe(reconcileFailure);
		expect(reconcile.hanamiGenerationQueue.upsertJobScheduler).toHaveBeenCalledTimes(3);
		expect(reconcile.hanamiGenerationQueue.add).toHaveBeenCalledWith('hanamiCommonGenerationTick', { reason: 'seed' }, SEED_JOB_OPTIONS);
	});

	test('enqueues exact seed, generation, and reconcile payloads with one attempt', async () => {
		const { service, hanamiGenerationQueue } = createQueueService();
		hanamiGenerationQueue.add.mockClear();

		await service.enqueueHanamiCommonGenerationSeed();
		await service.enqueueHanamiCommonGeneration('generation-1');
		await service.enqueueHanamiGenerationReconcile();

		expect(hanamiGenerationQueue.add).toHaveBeenNthCalledWith(1, 'hanamiCommonGenerationTick', { reason: 'seed' }, SEED_JOB_OPTIONS);
		expect(hanamiGenerationQueue.add).toHaveBeenNthCalledWith(2, 'hanamiCommonGeneration', { generationId: 'generation-1' }, JOB_OPTIONS);
		expect(hanamiGenerationQueue.add).toHaveBeenNthCalledWith(3, 'hanamiGenerationReconcile', {}, JOB_OPTIONS);
		const generationCall = hanamiGenerationQueue.add.mock.calls[1];
		expect(Object.keys(generationCall[1])).toEqual(['generationId']);
		expect(generationCall[2]).not.toHaveProperty('jobId');
	});

	test('rejects empty generation IDs before enqueue', () => {
		const { service, hanamiGenerationQueue } = createQueueService();
		hanamiGenerationQueue.add.mockClear();

		expect(() => service.enqueueHanamiCommonGeneration('')).toThrow('generationId must be a nonempty string');
		expect(() => service.enqueueHanamiCommonGeneration('   ')).toThrow('generationId must be a nonempty string');
		expect(hanamiGenerationQueue.add).not.toHaveBeenCalled();
	});

	test('includes the dedicated queue in admin enumeration and clear', async () => {
		const { service, hanamiGenerationQueue } = createQueueService();

		expect(QUEUE_TYPES).toHaveLength(11);
		expect(QUEUE_TYPES).toContain('hanamiGeneration');
		const queues = await service.queueGetQueues();
		expect(queues).toHaveLength(11);
		expect(queues.find(queue => queue.name === 'hanamiGeneration')).toBeDefined();

		await service.queueClear('hanamiGeneration', 'failed');
		expect(hanamiGenerationQueue.clean).toHaveBeenCalledWith(0, 0, 'failed');
	});

	test('closes the dedicated queue with all eleven queue providers', async () => {
		const queues = Array.from({ length: 11 }, () => adminQueue());
		const module = new QueueModule(
			queues[0] as never,
			queues[1] as never,
			queues[2] as never,
			queues[3] as never,
			queues[4] as never,
			queues[5] as never,
			queues[6] as never,
			queues[7] as never,
			queues[8] as never,
			queues[9] as never,
			queues[10] as never,
		);

		await module.dispose();

		for (const queue of queues) {
			expect(queue.close).toHaveBeenCalledTimes(1);
		}
	});

	test('wires an isolated worker with exact concurrency, lifecycle routing, start, stop, and failure reporting', () => {
		const source = readFileSync(new URL('../../src/queue/QueueProcessorService.ts', import.meta.url), 'utf8');
		const workerStart = source.indexOf('//#region hanami common generation');
		const workerEnd = source.indexOf('//#endregion', workerStart);
		const worker = source.slice(workerStart, workerEnd);

		expect(workerStart).toBeGreaterThan(-1);
		expect(worker).toContain('concurrency: this.config.hanamiGenerationQueueConcurrency');
		expect(worker).toContain("case 'hanamiCommonGenerationTick'");
		expect(worker).toContain("case 'hanamiCommonGeneration'");
		expect(worker).toContain("case 'hanamiGenerationReconcile'");
		expect(worker).toContain("case 'hanamiRecommendationEventCacheReplay'");
		expect(worker).toContain('default: throw new Error(`unrecognized job type ${job.name} for hanamiGeneration`)');
		expect(worker).toContain('return processer(job);');
		expect(worker).toContain(".on('failed'");
		expect(worker).toContain('const error = queueErrorSummary(err);');
		expect(worker).toContain(".on('error', (err: unknown)");
		expect(worker).toContain('Sentry.captureMessage(`Queue: HanamiGeneration:');
		expect(source).toContain('this.hanamiGenerationQueueWorker.run()');
		expect(source).toContain('this.hanamiGenerationQueueWorker.close()');

		const systemStart = source.indexOf('//#region system');
		const systemEnd = source.indexOf('//#endregion', systemStart);
		const systemWorker = source.slice(systemStart, systemEnd);
		expect(systemWorker).toContain(".on('failed', (job, err: unknown)");
		expect(systemWorker).toContain(".on('error', (err: unknown)");
		expect(systemWorker.match(/const error = queueErrorSummary\(err\);/g)).toHaveLength(2);
	});
});
