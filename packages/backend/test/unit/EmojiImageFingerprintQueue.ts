/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import { QueueService } from '@/core/QueueService.js';
import type { Config } from '@/config.js';

/**
 * Focused tests for the fingerprint queue seams in QueueService:
 * source-scoped active-job deduplication, merged job options, and the no-op when the queue is
 * not configured. The queue implementation is mocked, but every assertion
 * verifies the exact ID/options the service hands to BullMQ.
 */
describe('QueueService emoji image fingerprint jobs', () => {
	const NOOP_QUEUE = { add: async () => ({}) };

	function makeService(emojiQueue?: unknown): QueueService {
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
			undefined,
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
		expect(opts.deduplication).toEqual({ id: 'emoji-image-fingerprint-backfill-start' });
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
		expect(opts.deduplication).toEqual({ id: 'emoji-image-fingerprint-backfill-9sometinyid' });
		expect(opts.jobId).not.toContain(':');
	});

	test('no-ops when the fingerprint queue is not configured', async () => {
		const service = makeService(undefined);

		await expect(service.createEmojiImageFingerprintJob({ emojiId: 'abc', sourceUrl: 'https://example.com/x.png', host: null })).resolves.toBeUndefined();
		await expect(service.createEmojiImageFingerprintBackfillJob()).resolves.toBeUndefined();
	});
});
