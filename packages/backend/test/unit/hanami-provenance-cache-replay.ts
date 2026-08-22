/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';

const AS_OF = '2026-08-20T10:00:00.000Z';

type CacheEventRow = {
	event_id: string;
	user_id: string;
	event_type: 'served' | 'seen';
	feed_entry_id: string;
	feed_kind: 'personal' | 'common';
	feed_epoch_id: string;
	note_id: string;
	source: string;
	occurred_at: string;
	cache_now: string;
};

function row(index: number, eventType: 'served' | 'seen' = 'seen'): CacheEventRow {
	return {
		event_id: `event-${String(index).padStart(3, '0')}`,
		user_id: 'user-1',
		event_type: eventType,
		feed_entry_id: `entry-${index}`,
		feed_kind: 'personal',
		feed_epoch_id: 'epoch-1',
		note_id: `note-${String(index).padStart(3, '0')}`,
		source: 'catchup',
		occurred_at: new Date(Date.parse(AS_OF) - index * 1000).toISOString(),
		cache_now: AS_OF,
	};
}

function redisHarness(initiallyFailing: boolean) {
	let failing = initiallyFailing;
	let leaseOwner: string | null = null;
	let watermark: number | null = null;
	const transactions: Array<Array<[string, ...unknown[]]>> = [];
	const redis = {
		zscore: jest.fn(async () => {
			if (failing) throw new Error('Redis unavailable');
			return watermark == null ? null : String(watermark);
		}),
		set: jest.fn(async (_key: string, ownerToken: string) => {
			if (failing) throw new Error('Redis unavailable');
			if (leaseOwner != null) return null;
			leaseOwner = ownerToken;
			return 'OK';
		}),
		eval: jest.fn(async (script: string, _keyCount: number, ...args: string[]) => {
			if (failing) throw new Error('Redis unavailable');
			if (script.includes('pexpire')) return leaseOwner === args[1] ? 1 : 0;
			if (script.includes("redis.call('zadd'")) {
				if (leaseOwner !== args[2]) return 0;
				watermark = Math.max(watermark ?? Number.NEGATIVE_INFINITY, Number(args[3]));
				leaseOwner = null;
				return 1;
			}
			throw new Error('unexpected script');
		}),
		multi: jest.fn(() => {
			const commands: Array<[string, ...unknown[]]> = [];
			transactions.push(commands);
			const transaction = {
				zadd: (key: string, ...args: unknown[]) => {
					commands.push(['zadd', key, ...args]);
					return transaction;
				},
				zremrangebyscore: (key: string, ...args: unknown[]) => {
					commands.push(['zremrangebyscore', key, ...args]);
					return transaction;
				},
				expire: (key: string, ...args: unknown[]) => {
					commands.push(['expire', key, ...args]);
					return transaction;
				},
				exec: async () => {
					if (failing) throw new Error('Redis unavailable');
					return commands.map(() => [null, 1]);
				},
			};
			return transaction;
		}),
	};
	return {
		redis,
		transactions,
		setFailing: (value: boolean) => { failing = value; },
		expireLease: () => { leaseOwner = null; },
		getLeaseOwner: () => leaseOwner,
		getWatermark: () => watermark,
	};
}

function serviceWith(rowsForPage: (cursor: string | null) => CacheEventRow[], initiallyFailing = false) {
	const cache = redisHarness(initiallyFailing);
	const queries: Array<{ sql: string; parameters: unknown[] }> = [];
	const query = jest.fn(async (sql: string, parameters: unknown[] = []) => {
		queries.push({ sql, parameters });
		if (sql.includes('AS replay_as_of')) return [{ replay_as_of: AS_OF }];
		return rowsForPage((parameters[3] as string | null) ?? null);
	});
	const queue = {
		enqueueHanamiRecommendationEventCacheRepair: jest.fn(async () => {
			throw new Error('BullMQ unavailable');
		}),
	};
	const repository = { manager: { connection: { query } } };
	const service = new HanamiForYouProvenanceService(repository as never, {} as never, cache.redis as never, queue as never);
	return { cache, queries, queue, service };
}

describe('Hanami recommendation event cache replay', () => {
	test('does not fail the request-side hook when cache and enqueue both fail, then recovers from PostgreSQL', async () => {
		const event = row(1, 'served');
		const fixture = serviceWith(() => [event], true);
		const internals = fixture.service as unknown as {
			cacheCommittedEvents(events: readonly unknown[]): Promise<void>;
		};
		const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await expect(internals.cacheCommittedEvents([{
				eventId: event.event_id,
				userId: event.user_id,
				eventType: event.event_type,
				feedEntryId: event.feed_entry_id,
				feedKind: event.feed_kind,
				feedEpochId: event.feed_epoch_id,
				noteId: event.note_id,
				source: event.source,
				occurredAt: event.occurred_at,
				cacheNow: event.cache_now,
			}])).resolves.toBeUndefined();
			expect(fixture.queue.enqueueHanamiRecommendationEventCacheRepair).toHaveBeenCalledWith([event.event_id]);

			fixture.cache.setFailing(false);
			await expect(fixture.service.replayRecommendationEventCache({})).resolves.toBeNull();
			expect(fixture.cache.transactions.flat()).toContainEqual(expect.arrayContaining([
				'zadd',
				'hanami:rec:served:user-1',
				'GT',
			]));
			expect(fixture.cache.getWatermark()).toBe(Date.parse(AS_OF));
			expect(fixture.cache.getLeaseOwner()).toBeNull();
		} finally {
			errorLog.mockRestore();
		}
	});

	test('uses deterministic PostgreSQL keyset ordering and advances only after exact 100-row pages finish', async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) => row(index));
		const fixture = serviceWith(cursor => cursor == null ? firstPage : []);

		const continuation = await fixture.service.replayRecommendationEventCache({});
		expect(continuation).toEqual({
			asOf: AS_OF,
			fromOccurredAt: '2026-08-13T10:00:00.000Z',
			ownerToken: expect.any(String),
			cursor: {
				occurredAt: firstPage[99]!.occurred_at,
				eventId: firstPage[99]!.event_id,
			},
		});
		expect(fixture.cache.getWatermark()).toBeNull();
		expect(fixture.cache.getLeaseOwner()).toBe(continuation!.ownerToken);
		const pageQuery = fixture.queries[1]!;
		expect(pageQuery.sql).toContain('ORDER BY e."occurredAt" DESC, e."id" DESC, e."noteId" ASC');
		expect(pageQuery.sql).toContain('LIMIT $5');
		expect(pageQuery.sql).toContain(`e."eventType" = 'served'`);
		expect(pageQuery.sql).toContain(`e."eventType" = 'seen'`);
		expect(pageQuery.parameters).toEqual([
			'2026-08-13T10:00:00.000Z',
			AS_OF,
			null,
			null,
			100,
		]);

		await expect(fixture.service.replayRecommendationEventCache(continuation!)).resolves.toBeNull();
		expect(fixture.queries[2]!.parameters).toEqual([
			continuation!.fromOccurredAt,
			continuation!.asOf,
			continuation!.cursor.occurredAt,
			continuation!.cursor.eventId,
			100,
		]);
		expect(fixture.cache.getWatermark()).toBe(Date.parse(AS_OF));
		expect(fixture.cache.getLeaseOwner()).toBeNull();
	});

	test('single-flights roots and fences expired owners from renewing or completing a newer chain', async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) => row(index));
		const fixture = serviceWith(cursor => cursor == null ? firstPage : []);
		const first = await fixture.service.replayRecommendationEventCache({});
		expect(first).not.toBeNull();
		const queryCount = fixture.queries.length;

		await expect(fixture.service.replayRecommendationEventCache({})).resolves.toBeNull();
		expect(fixture.queries).toHaveLength(queryCount);
		expect(fixture.cache.getLeaseOwner()).toBe(first!.ownerToken);

		fixture.cache.expireLease();
		const replacement = await fixture.service.replayRecommendationEventCache({});
		expect(replacement).not.toBeNull();
		expect(replacement!.ownerToken).not.toBe(first!.ownerToken);
		expect(fixture.cache.getLeaseOwner()).toBe(replacement!.ownerToken);

		const beforeStale = fixture.queries.length;
		await expect(fixture.service.replayRecommendationEventCache(first!)).resolves.toBeNull();
		expect(fixture.queries).toHaveLength(beforeStale);
		expect(fixture.cache.getLeaseOwner()).toBe(replacement!.ownerToken);
		expect(fixture.cache.getWatermark()).toBeNull();

		await expect(fixture.service.replayRecommendationEventCache(replacement!)).resolves.toBeNull();
		expect(fixture.cache.getWatermark()).toBe(Date.parse(AS_OF));
		expect(fixture.cache.getLeaseOwner()).toBeNull();
	});
});
