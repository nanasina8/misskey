/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { QueueService } from '@/core/QueueService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';

/**
 * Focused tests for the fingerprint queue seams in QueueService:
 * source-scoped active-job deduplication, merged job options, and the no-op when the queue is
 * not configured. The queue implementation is mocked, but every assertion
 * verifies the exact ID/options the service hands to BullMQ.
 */
describe('QueueService emoji image fingerprint jobs', () => {
	const NOOP_QUEUE = {
		add: async () => ({}),
		getJobCounts: async () => ({}),
		isPaused: async () => false,
		getMetrics: async () => ({ meta: {}, data: [], count: 0 }),
		clean: async () => [],
	};
	const REQUIRED_QUEUE_TOKENS = [
		'queue:system',
		'queue:endedPollNotification',
		'queue:postScheduledNote',
		'queue:deliver',
		'queue:inbox',
		'queue:db',
		'queue:relationship',
		'queue:objectStorage',
		'queue:userWebhookDeliver',
		'queue:systemWebhookDeliver',
		'queue:hanamiGeneration',
	] as const;

	function makeService(emojiQueue?: unknown, hanamiQueue?: unknown): QueueService {
		return new QueueService(
			{} as Config,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			NOOP_QUEUE as never,
			hanamiQueue as never,
			emojiQueue as never,
		);
	}

	function sha256hex(value: string): string {
		return createHash('sha256').update(value).digest('hex');
	}

	test('uses source-scoped active-job deduplication with production options', async () => {
		const add = jest.fn<(...args: any[]) => Promise<unknown>>(async () => ({}));
		const service = makeService({ add });

		const data = { emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: 'example.com' };
		await service.createEmojiImageFingerprintJob(data);
		await service.createEmojiImageFingerprintJob(data);

		expect(add).toHaveBeenCalledTimes(2);

		const expectedDeduplicationId = sha256hex('abc\0https://example.com/x.png');
		expect(expectedDeduplicationId).toBe('5f0847262f38babe51d7f216121e5257dd756d63ce8a5d076c732fff5fd0d420');

		const [name, jobData, opts] = add.mock.calls[0];
		expect(name).toBe('compute');
		expect(jobData).toEqual(data);
		expect(opts.jobId).toMatch(/^emoji-image-fingerprint-[0-9a-f-]{36}$/);
		expect(add.mock.calls[1][2].jobId).toMatch(/^emoji-image-fingerprint-[0-9a-f-]{36}$/);
		expect(add.mock.calls[1][2].jobId).not.toBe(opts.jobId);
		expect(opts.deduplication).toEqual({ id: expectedDeduplicationId });
		expect(add.mock.calls[1][2].deduplication).toEqual({ id: expectedDeduplicationId });

		expect(opts.attempts).toBe(2);
		expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
		expect(opts.removeOnComplete).toEqual({ age: 3600 * 24 * 7, count: 100 });
		expect(opts.removeOnFail).toEqual({ age: 3600 * 24 * 7, count: 100 });
	});

	test('recomputes after an A→B→A source transition despite retained completed jobs', async () => {
		const add = jest.fn<(...args: any[]) => Promise<unknown>>(async () => ({}));
		const service = makeService({ add });

		await service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: 'example.com' });
		await service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/y.png', host: 'example.com' });

		await service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: 'example.com' });

		const [first, second, third] = add.mock.calls.map(([, , opts]) => opts);
		expect(first.jobId).not.toBe(second.jobId);
		expect(second.jobId).not.toBe(third.jobId);
		expect(first.jobId).not.toBe(third.jobId);
		expect(first.deduplication).toEqual({ id: sha256hex('abc\0https://example.com/x.png') });
		expect(second.deduplication).toEqual({ id: sha256hex('abc\0https://example.com/y.png') });
		expect(third.deduplication).toEqual(first.deduplication);
	});

	test('does not key active-job deduplication by host, only emojiId and sourceUrl', async () => {
		const add = jest.fn<(...args: any[]) => Promise<unknown>>(async () => ({}));
		const service = makeService({ add });

		await service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: 'example.com' });
		await service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: 'other.example' });

		expect(add.mock.calls[0][2].deduplication).toEqual(add.mock.calls[1][2].deduplication);
	});

	test('deduplicates the default backfill job on a stable start key with a unique job id', async () => {
		const add = jest.fn<(...args: any[]) => Promise<unknown>>(async () => ({}));
		const service = makeService({ add });

		await service.createEmojiImageFingerprintBackfillJob();
		await service.createEmojiImageFingerprintBackfillJob();

		expect(add).toHaveBeenCalledTimes(2);
		const [name, data, opts] = add.mock.calls[0];
		expect(name).toBe('backfill');
		expect(data).toEqual({});
		// 固定jobIdだとremoveOnCompleteのcountで押し出された時点で重複排除にならず、
		// 保持されている間は最終失敗したページからチェーンを再開できなくなる。
		expect(opts.jobId).toMatch(/^emoji-image-fingerprint-backfill-[0-9a-f-]{36}$/);
		expect(add.mock.calls[1][2].jobId).not.toBe(opts.jobId);
		expect(opts.deduplication).toEqual({ id: 'emoji-image-fingerprint-backfill-all-*-start' });
		expect(add.mock.calls[1][2].deduplication).toEqual(opts.deduplication);
		expect(opts.jobId).not.toContain(':');
		expect(opts.attempts).toBe(2);
	});

	test('deduplicates a backfill job by its cursor', async () => {
		const add = jest.fn<(...args: any[]) => Promise<unknown>>(async () => ({}));
		const service = makeService({ add });

		await service.createEmojiImageFingerprintBackfillJob({ cursor: '9sometinyid' });

		expect(add).toHaveBeenCalledTimes(1);
		const [name, data, opts] = add.mock.calls[0];
		expect(name).toBe('backfill');
		expect(data).toEqual({ cursor: '9sometinyid' });
		expect(opts.jobId).toMatch(/^emoji-image-fingerprint-backfill-[0-9a-f-]{36}$/);
		expect(opts.deduplication).toEqual({ id: 'emoji-image-fingerprint-backfill-all-*-9sometinyid' });
		expect(opts.jobId).not.toContain(':');
	});

	test('keys the local-scoped backfill separately so it never blocks on the full scan', async () => {
		const add = jest.fn<(...args: any[]) => Promise<unknown>>(async () => ({}));
		const service = makeService({ add });

		await service.createEmojiImageFingerprintBackfillJob({ scope: 'local' });
		await service.createEmojiImageFingerprintBackfillJob({ scope: 'all' });
		await service.createEmojiImageFingerprintBackfillJob({ scope: 'all', host: 'remote.example' });

		const [local, all, host] = add.mock.calls.map(([, , opts]) => opts.deduplication.id);
		expect(local).toBe('emoji-image-fingerprint-backfill-local-*-start');
		expect(all).toBe('emoji-image-fingerprint-backfill-all-*-start');
		expect(host).toBe('emoji-image-fingerprint-backfill-all-remote.example-start');
		// スコープが混ざると片方が他方を重複排除で潰してしまう
		expect(new Set([local, all, host]).size).toBe(3);
	});

	test('no-ops when the fingerprint queue is not configured', async () => {
		const service = makeService(undefined, NOOP_QUEUE);

		await expect(service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: null })).resolves.toBeUndefined();
		await expect(service.createEmojiImageFingerprintBackfillJob()).resolves.toBeUndefined();
		await expect(service.queueGetQueues()).resolves.toHaveLength(11);
		await expect(service.queueGetQueues()).resolves.not.toContainEqual(expect.objectContaining({ name: 'emojiImageFingerprint' }));
		await expect(service.queueClear('emojiImageFingerprint', 'failed')).rejects.toThrow('Emoji image fingerprint queue is not available');
		await expect(service.queueGetQueue('emojiImageFingerprint')).rejects.toThrow('Emoji image fingerprint queue is not available');
	});

	test('resolves through Nest without the optional fingerprint queue provider', async () => {
		const module = await Test.createTestingModule({
			providers: [
				QueueService,
				{ provide: DI.config, useValue: {} },
				...REQUIRED_QUEUE_TOKENS.map(provide => ({ provide, useValue: NOOP_QUEUE })),
			],
		}).compile();
		const service = module.get(QueueService);

		await expect(service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: null })).resolves.toBeUndefined();
		await expect(service.queueGetQueues()).resolves.toHaveLength(11);
		await expect(service.queueGetQueues()).resolves.not.toContainEqual(expect.objectContaining({ name: 'emojiImageFingerprint' }));
		await expect(service.queueGetQueue('emojiImageFingerprint')).rejects.toThrow('Emoji image fingerprint queue is not available');

		await module.close();
	});

	test('makes a configured fingerprint queue available to queue administration', async () => {
		const emojiQueue = {
			...NOOP_QUEUE,
			getJobCounts: jest.fn(async () => ({ waiting: 0 })),
			isPaused: jest.fn(async () => false),
			getMetrics: jest.fn(async () => ({ meta: {}, data: [], count: 0 })),
			clean: jest.fn(async () => []),
			qualifiedName: 'bull:emojiImageFingerprint',
			client: Promise.resolve({
				info: jest.fn(async () => 'redis_version:7.0.0\r\nredis_mode:standalone\r\nrun_id:run\r\nprocess_id:1\r\ntcp_port:6379\r\nos:Linux\r\nuptime_in_seconds:1\r\ntotal_system_memory:1\r\nused_memory:1\r\nmem_fragmentation_ratio:1\r\nused_memory_peak:1\r\nconnected_clients:1\r\nblocked_clients:0\r\n'),
			}),
		};
		const service = makeService(emojiQueue, NOOP_QUEUE);

		const queues = await service.queueGetQueues();
		const fingerprintQueue = queues.find(queue => queue.name === 'emojiImageFingerprint');
		expect(fingerprintQueue?.counts).toEqual({ waiting: 0 });
		expect(emojiQueue.getJobCounts).toHaveBeenCalledTimes(1);

		await service.queueClear('emojiImageFingerprint', 'failed');
		expect(emojiQueue.clean).toHaveBeenCalledWith(0, 0, 'failed');

		await expect(service.queueGetQueue('emojiImageFingerprint')).resolves.toMatchObject({
			name: 'emojiImageFingerprint',
			qualifiedName: 'bull:emojiImageFingerprint',
		});
	});
});
