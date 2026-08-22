/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';
import { QueueService } from '@/core/QueueService.js';

describe('Hanami timeline partition queue wiring', () => {
	test('schedules the maintenance job with UTC retry contract and existing retention', async () => {
		const upsertJobScheduler = jest.fn(async (_name: string, _repeat: unknown, _template: unknown) => undefined);
		const systemQueue = {
			upsertJobScheduler,
			getJobSchedulers: jest.fn(async () => []),
			removeJobScheduler: jest.fn(async () => undefined),
		};

		const service = new QueueService(
			{} as never,
			systemQueue as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);
		expect(upsertJobScheduler).not.toHaveBeenCalled();

		await service.onModuleInit();

		const call = upsertJobScheduler.mock.calls.find((args) => args[0] === 'maintainHanamiTimelinePartitions');
		expect(call).toBeDefined();
		expect(call![1]).toEqual({ pattern: '17 0 * * *', tz: 'UTC', immediately: false });
		expect(call![2]).toEqual({
			name: 'maintainHanamiTimelinePartitions',
			opts: {
				attempts: 3,
				backoff: { type: 'exponential', delay: 60000 },
				removeOnComplete: { age: 3600 * 24 * 7 },
				removeOnFail: { age: 3600 * 24 * 7 },
			},
		});

		const existingCall = upsertJobScheduler.mock.calls.find((args) => args[0] === 'tickCharts');
		expect(existingCall![1]).toEqual({ pattern: '55 * * * *', immediately: false });
		expect(existingCall![2]).toEqual({
			name: 'tickCharts',
			opts: {
				removeOnComplete: { age: 3600 * 24 * 7 },
				removeOnFail: { age: 3600 * 24 * 7 },
			},
		});
	});

	test('processor switch includes the system job name', () => {
		const source = readFileSync(new URL('../../src/queue/QueueProcessorService.ts', import.meta.url), 'utf8');
		expect(source).toContain("case 'maintainHanamiTimelinePartitions': return this.hanamiTimelinePartitionMaintenanceProcessorService.process();");
	});
});
