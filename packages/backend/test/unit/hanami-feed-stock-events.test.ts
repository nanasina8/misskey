/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, describe, expect, test, vi as jest } from 'vitest';
import {
	HANAMI_FEED_DAILY_KEY_PREFIX,
	HANAMI_FEED_EVENTS_KEY,
	HANAMI_FEED_EVENTS_MAX,
	recordHanamiFeedEvent,
	clearHanamiFeedEventWarnThrottle,
} from '@/core/hanami/HanamiFeedStockEvents.js';

function fakeRedis() {
	const chain = {
		lpush: jest.fn(() => chain),
		ltrim: jest.fn(() => chain),
		expire: jest.fn(() => chain),
		hincrby: jest.fn(() => chain),
		exec: jest.fn(async () => [] as Array<[Error | null, unknown]>),
	};
	const multi = jest.fn(() => chain);
	return { chain, multi };
}

beforeEach(() => clearHanamiFeedEventWarnThrottle());

describe('recordHanamiFeedEvent', () => {
	test('pushes the event, trims to 5000, and expires both keys with the daily HINCRBY', async () => {
		const redis = fakeRedis();
		await recordHanamiFeedEvent({ multi: redis.multi } as never, {
			at: '2026-11-02T00:00:00.000Z',
			userId: 'user-1',
			kind: 'open',
			outcome: 'stock',
			durationMs: 12,
		});

		expect(redis.multi).toHaveBeenCalledTimes(1);
		expect(redis.chain.lpush).toHaveBeenCalledWith(HANAMI_FEED_EVENTS_KEY, expect.stringContaining('"kind":"open"'));
		expect(redis.chain.ltrim).toHaveBeenCalledWith(HANAMI_FEED_EVENTS_KEY, 0, HANAMI_FEED_EVENTS_MAX - 1);
		expect(redis.chain.expire).toHaveBeenCalledWith(HANAMI_FEED_EVENTS_KEY, 14 * 24 * 60 * 60);
		expect(redis.chain.hincrby).toHaveBeenCalledWith(expect.stringContaining(HANAMI_FEED_DAILY_KEY_PREFIX), 'open.stock', 1);
		expect(redis.chain.expire).toHaveBeenCalledWith(expect.stringContaining(HANAMI_FEED_DAILY_KEY_PREFIX), 40 * 24 * 60 * 60);
		expect(redis.chain.exec).toHaveBeenCalledTimes(1);
	});

	test('never throws when Redis fails', async () => {
		const redis = fakeRedis();
		redis.multi.mockImplementation(() => {
			throw new Error('redis down');
		});
		await expect(recordHanamiFeedEvent({ multi: redis.multi } as never, {
			at: '2026-11-02T00:00:00.000Z', userId: 'user-1', kind: 'discard', outcome: 'stale',
		})).resolves.toBeUndefined();
	});

	test('never throws when the multi transaction reports an error', async () => {
		const redis = fakeRedis();
		redis.chain.exec.mockResolvedValue([[new Error('aborted'), null]]);
		await expect(recordHanamiFeedEvent({ multi: redis.multi } as never, {
			at: '2026-11-02T00:00:00.000Z', userId: 'user-1', kind: 'publish', outcome: 'head',
		})).resolves.toBeUndefined();
	});
});
