/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import * as Bull from 'bullmq';
import { QueueService } from '@/core/QueueService.js';
import { HanamiRecommendationEventCacheRepairProcessorService } from '@/queue/processors/HanamiRecommendationEventCacheRepairProcessorService.js';
import { meta, paramDef } from '@/server/api/endpoints/notes/hanami-timeline-seen.js';

function queueHarness() {
	const queue = {
		add: jest.fn<(name: string, data: Record<string, unknown>, options: Record<string, unknown>) => Promise<void>>(async () => undefined),
	};
	const service = Object.create(QueueService.prototype) as QueueService;
	service.hanamiGenerationQueue = queue as never;
	return { queue, service };
}

function job(data: unknown) {
	return {
		name: 'hanamiRecommendationEventCacheRepair',
		data,
	};
}

function replayJob(data: unknown) {
	return {
		name: 'hanamiRecommendationEventCacheReplay',
		data,
	};
}

describe('Hanami Phase 5 workstream D queue and endpoint contracts', () => {
	test('enqueues a bounded deterministic cache-repair job without a scheduler', async () => {
		const { queue, service } = queueHarness();
		await service.enqueueHanamiRecommendationEventCacheRepair(['event-b', 'event-a', 'event-a']);
		await service.enqueueHanamiRecommendationEventCacheRepair(['event-a', 'event-b']);

		expect(queue.add).toHaveBeenCalledTimes(2);
		for (const call of queue.add.mock.calls) {
			expect(call[0]).toBe('hanamiRecommendationEventCacheRepair');
			expect(call[1]).toEqual({ eventIds: ['event-a', 'event-b'] });
			expect(call[2]).toMatchObject({
				attempts: 3,
				backoff: { type: 'exponential', delay: 1000 },
				removeOnComplete: true,
				removeOnFail: true,
				jobId: expect.stringMatching(/^hanamiRecommendationEventCacheRepair-[a-f0-9]{64}$/),
			});
		}
		expect(queue.add.mock.calls[0]![2]!.jobId).toBe(queue.add.mock.calls[1]![2]!.jobId);
	});

	test.each([
		[],
		Array.from({ length: 101 }, (_, index) => `event-${index}`),
		[''],
		[1],
		null,
	])('rejects invalid enqueue input %p', async (eventIds) => {
		const { queue, service } = queueHarness();
		expect(() => service.enqueueHanamiRecommendationEventCacheRepair(eventIds as never)).toThrow(TypeError);
		expect(queue.add).not.toHaveBeenCalled();
	});

	test('processor validates the exact payload and delegates only event IDs', async () => {
		const provenance = {
			repairRecommendationEventCache: jest.fn(async () => undefined),
		};
		const processor = new HanamiRecommendationEventCacheRepairProcessorService(provenance as never, {} as never);

		await processor.process(job({ eventIds: ['event-1', 'event-1'] }) as never);
		expect(provenance.repairRecommendationEventCache).toHaveBeenCalledWith(['event-1', 'event-1']);

		for (const invalid of [
			{},
			{ eventIds: [] },
			{ eventIds: ['event-1'], extra: true },
			{ eventIds: [1] },
			{ eventIds: Array.from({ length: 101 }, (_, index) => `event-${index}`) },
			null,
		]) {
			await expect(processor.process(job(invalid) as never)).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		}
		expect(provenance.repairRecommendationEventCache).toHaveBeenCalledTimes(1);
	});

	test('enqueues deterministic bounded replay continuations on the existing queue', async () => {
		const { queue, service } = queueHarness();
		const continuation = {
			asOf: '2026-08-20T10:00:00.000Z',
			fromOccurredAt: '2026-08-13T10:00:00.000Z',
			ownerToken: 'owner-1',
			cursor: { occurredAt: '2026-08-19T10:00:00.000Z', eventId: 'event-100' },
		};

		await service.enqueueHanamiRecommendationEventCacheReplay(continuation);
		await service.enqueueHanamiRecommendationEventCacheReplay(continuation);

		expect(queue.add).toHaveBeenCalledTimes(2);
		for (const call of queue.add.mock.calls) {
			expect(call[0]).toBe('hanamiRecommendationEventCacheReplay');
			expect(call[1]).toEqual(continuation);
			expect(call[2]).toMatchObject({
				attempts: 3,
				backoff: { type: 'exponential', delay: 1000 },
				removeOnComplete: true,
				removeOnFail: true,
				jobId: expect.stringMatching(/^hanamiRecommendationEventCacheReplay-[a-f0-9]{64}$/),
			});
		}
		expect(queue.add.mock.calls[0]![2]!.jobId).toBe(queue.add.mock.calls[1]![2]!.jobId);
	});

	test('replay processor accepts only root or exact cursor payloads and enqueues the returned continuation', async () => {
		const continuation = {
			asOf: '2026-08-20T10:00:00.000Z',
			fromOccurredAt: '2026-08-13T10:00:00.000Z',
			ownerToken: 'owner-1',
			cursor: { occurredAt: '2026-08-19T10:00:00.000Z', eventId: 'event-100' },
		};
		const provenance = {
			replayRecommendationEventCache: jest.fn(async () => continuation),
		};
		const queue = {
			enqueueHanamiRecommendationEventCacheReplay: jest.fn(async () => undefined),
		};
		const processor = new HanamiRecommendationEventCacheRepairProcessorService(provenance as never, queue as never);

		await processor.processReplay(replayJob({}) as never);
		expect(provenance.replayRecommendationEventCache).toHaveBeenCalledWith({});
		expect(queue.enqueueHanamiRecommendationEventCacheReplay).toHaveBeenCalledWith(continuation);

		for (const invalid of [
			{ asOf: continuation.asOf },
			{ ...continuation, extra: true },
			{ ...continuation, ownerToken: '' },
			{ ...continuation, cursor: { occurredAt: 'invalid', eventId: 'event-100' } },
			{ ...continuation, cursor: { occurredAt: continuation.cursor.occurredAt, eventId: '' } },
			null,
		]) {
			await expect(processor.processReplay(replayJob(invalid) as never)).rejects.toBeInstanceOf(Bull.UnrecoverableError);
		}
		expect(provenance.replayRecommendationEventCache).toHaveBeenCalledTimes(1);
	});

	test('seen endpoint exposes only the locator and Note pair contract', () => {
		expect(paramDef).toEqual({
			type: 'object',
			additionalProperties: false,
			properties: {
				items: {
					type: 'array',
					minItems: 1,
					maxItems: 100,
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							feedEntryId: { type: 'string', minLength: 1, maxLength: 512 },
							noteId: { type: 'string', format: 'misskey:id' },
						},
						required: ['feedEntryId', 'noteId'],
					},
				},
			},
			required: ['items'],
		});
		expect(meta.res).toEqual({
			type: 'object',
			optional: false,
			nullable: false,
			additionalProperties: false,
			properties: {
				ok: { type: 'boolean', optional: false, nullable: false },
			},
		});
		expect(meta.errors.invalidFeedEntry).toMatchObject({ code: 'INVALID_FEED_ENTRY', httpStatusCode: 400 });
		expect(JSON.stringify(paramDef)).not.toMatch(/noteIds|kind|home/);
	});
});
