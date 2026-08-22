/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';
import {
	HanamiForYouProvenanceService,
	HanamiInvalidFeedEntryError,
} from '@/core/hanami/HanamiForYouProvenanceService.js';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { HanamiRecommendationService } from '@/core/hanami/HanamiRecommendationService.js';
import {
	encodeHanamiCommonFeedEntryLocator,
	encodeHanamiPersonalFeedEntryLocator,
} from '@/core/hanami/HanamiFeedCodec.js';
import type { HanamiDurableServedEntryInput } from '@/core/hanami/HanamiTimelineContracts.js';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;
type DbQuery = <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
let eventId = 0;

function makeDataSource(schema: string) {
	const initialize = async (client: Client): Promise<void> => {
		await client.connect();
		await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
		await client.query(`SET TIME ZONE 'UTC'`);
	};
	return {
		query: async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
			const client = new Client({ connectionString: databaseUrl });
			try {
				await initialize(client);
				return (await client.query<T>(sql, values)).rows;
			} finally {
				await client.end().catch(() => undefined);
			}
		},
		createQueryRunner: () => {
			let client: Client | undefined;
			const runner = {
				isTransactionActive: false,
				connect: async (): Promise<void> => {
					client = new Client({ connectionString: databaseUrl });
					await initialize(client);
				},
				startTransaction: async (): Promise<void> => {
					await client!.query('BEGIN');
					runner.isTransactionActive = true;
				},
				commitTransaction: async (): Promise<void> => {
					await client!.query('COMMIT');
					runner.isTransactionActive = false;
				},
				rollbackTransaction: async (): Promise<void> => {
					await client!.query('ROLLBACK');
					runner.isTransactionActive = false;
				},
				release: async (): Promise<void> => {
					await client?.end();
				},
				query: async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
					return (await client!.query<T>(sql, values)).rows;
				},
			};
			return runner;
		},
	};
}

function redisHarness(fail = false) {
	let failing = fail;
	let replayWatermark: number | null = null;
	let leaseOwner: string | null = null;
	const transactions: Array<Array<[string, ...unknown[]]>> = [];
	const redis = {
		zscore: jest.fn(async () => {
			if (failing) throw new Error('simulated Redis outage');
			return replayWatermark == null ? null : String(replayWatermark);
		}),
		set: jest.fn(async (_key: string, ownerToken: string) => {
			if (failing) throw new Error('simulated Redis outage');
			if (leaseOwner != null) return null;
			leaseOwner = ownerToken;
			return 'OK';
		}),
		eval: jest.fn(async (script: string, _keyCount: number, ...args: string[]) => {
			if (failing) throw new Error('simulated Redis outage');
			if (script.includes('pexpire')) return leaseOwner === args[1] ? 1 : 0;
			if (script.includes("redis.call('zadd'")) {
				if (leaseOwner !== args[2]) return 0;
				replayWatermark = Math.max(replayWatermark ?? Number.NEGATIVE_INFINITY, Number(args[3]));
				leaseOwner = null;
				return 1;
			}
			throw new Error('unexpected Redis script');
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
					if (failing) throw new Error('simulated Redis outage');
					return commands.map(() => [null, 1]);
				},
			};
			return transaction;
		}),
	};
	return {
		redis,
		transactions,
		setFailure: (value: boolean) => { failing = value; },
	};
}

function runtime(schema: string, failRedis = false, failQueue = false) {
	const connection = makeDataSource(schema);
	const repository = { manager: { connection } };
	const ids = { gen: () => `event-${String(++eventId).padStart(20, '0')}` };
	const cache = redisHarness(failRedis);
	let queueFailing = failQueue;
	const repairBatches: string[][] = [];
	const queue = {
		enqueueHanamiRecommendationEventCacheRepair: async (eventIds: readonly string[]) => {
			if (queueFailing) throw new Error('simulated BullMQ outage');
			repairBatches.push([...eventIds]);
		},
	};
	const service = new HanamiForYouProvenanceService(repository as never, ids as never, cache.redis as never, queue as never);
	return {
		cache,
		connection,
		repairBatches,
		service,
		setQueueFailure: (value: boolean) => { queueFailing = value; },
	};
}

const personalEntry = (sequence: string, batchId: string, noteId = 'duplicate-note'): HanamiDurableServedEntryInput => ({
	feedEntryId: encodeHanamiPersonalFeedEntryLocator({ userId: 'user-1', epochId: 'personal-epoch', sequence }),
	entry: {
		kind: 'personal',
		epochId: 'personal-epoch',
		sequence,
		batchId,
		noteId,
		source: 'catchup',
		sources: ['catchup'],
		origin: 'personalCandidate',
		reasonMetadata: { version: 1 },
	},
});

const commonEntry = (rowId: string, noteId: string): HanamiDurableServedEntryInput => ({
	feedEntryId: encodeHanamiCommonFeedEntryLocator({ epochId: 'common-epoch', generatedMonth: '2026-08', rowId }),
	entry: {
		kind: 'common',
		epochId: 'common-epoch',
		sequence: rowId === 'common-row-1' ? '2' : '1',
		batchId: 'common-generation',
		noteId,
		source: 'globalPopular',
		sources: ['globalPopular'],
		generatedMonth: '2026-08',
		rowId,
	},
});

const withSchema = async (run: (context: { schema: string; query: DbQuery }) => Promise<void>): Promise<void> => {
	const schema = `hanami_provenance_d_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const client = new Client({ connectionString: databaseUrl });
	const query: DbQuery = async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, values)).rows;
	try {
		await client.connect();
		await query(`CREATE SCHEMA ${quoteIdent(schema)}`);
		await query(`SET search_path TO ${quoteIdent(schema)}, public`);
		await query(`SET TIME ZONE 'UTC'`);
		await query(`CREATE TABLE "user" ("id" varchar(32) PRIMARY KEY, "isHibernated" boolean NOT NULL DEFAULT false)`);
		await query(`CREATE TABLE "note" ("id" varchar(32) PRIMARY KEY)`);
		await query(`CREATE TABLE "hanami_recommendation_event" (
			"id" varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, "noteId" varchar(32) NOT NULL,
			"eventType" varchar(32) NOT NULL, "source" varchar(64), "createdAt" timestamptz NOT NULL
		)`);
		await new HanamiPersistedTimelinePhase11787097600000().up({ query } as never);
		await query(`INSERT INTO "user" ("id") VALUES ('user-1'), ('user-2')`);
		await query(`INSERT INTO "note" ("id") VALUES ('duplicate-note'), ('common-note'), ('unserved-note')`);
		await query(`INSERT INTO "hanami_common_generation"
			("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "generationFence")
			VALUES ('common-generation', 1, 'ready', clock_timestamp(), clock_timestamp(), 'test', 1)`);
		await query(`INSERT INTO "hanami_common_feed_state"
			("singletonId", "epochId", "latestSequence", "earliestRetainedSequence", "latestReadyGenerationId", "generationFence", "updatedAt")
			VALUES ('singleton', 'common-epoch', 2, 1, 'common-generation', 1, clock_timestamp())`);
		await query(`INSERT INTO "hanami_common_feed_entry"
			("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt") VALUES
			('2026-08-01', 'common-row-1', 'common-epoch', 2, 'common-generation', 0, 'common-note', 'globalPopular', '["globalPopular"]', clock_timestamp()),
			('2026-08-01', 'common-row-2', 'common-epoch', 1, 'common-generation', 1, 'unserved-note', 'globalPopular', '["globalPopular"]', clock_timestamp())`);
		await query(`INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt") VALUES ('personal-epoch', 'user-1', clock_timestamp())`);
		await query(`INSERT INTO "hanami_user_feed_batch"
			("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "finishedAt", "itemCount", "baseCommonGenerationId") VALUES
			('personal-batch-1', 'user-1', 'personal-epoch', 'initial', 'ready', clock_timestamp(), clock_timestamp(), clock_timestamp(), 1, 'common-generation'),
			('personal-batch-2', 'user-1', 'personal-epoch', 'refresh', 'ready', clock_timestamp(), clock_timestamp(), clock_timestamp(), 1, 'common-generation')`);
		await query(`INSERT INTO "hanami_user_feed_state"
			("userId", "epochId", "mode", "initialGenerationState", "latestReadyBatchId", "latestSequence", "earliestRetainedSequence", "updatedAt")
			VALUES ('user-1', 'personal-epoch', 'personalized', 'ready', 'personal-batch-2', 9007199254740994, 1, clock_timestamp())`);
		await query(`INSERT INTO "hanami_user_feed_entry"
			("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt") VALUES
			('personal-row-1', 'user-1', 'personal-epoch', 9007199254740993, 'personal-batch-1', 0, 'duplicate-note', 'catchup', '["catchup"]', 'personalCandidate', '{"version":1}', clock_timestamp()),
			('personal-row-2', 'user-1', 'personal-epoch', 9007199254740994, 'personal-batch-2', 0, 'duplicate-note', 'catchup', '["catchup"]', 'personalCandidate', '{"version":1}', clock_timestamp())`);
		const version = await query<{ server_version: string }>('SHOW server_version');
		expect(version[0]!.server_version).toMatch(/^18\./);
		await run({ schema, query });
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

describe('Hanami Phase 5 workstream D PostgreSQL 18 contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for workstream D DB contracts.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('records personal/common served and seen entries atomically with exact locator identity and durable recency', async () => {
		await withSchema(async ({ schema, query }) => {
			const { cache, service } = runtime(schema);
			const first = personalEntry('9007199254740993', 'personal-batch-1');
			const second = personalEntry('9007199254740994', 'personal-batch-2');
			const common = commonEntry('common-row-1', 'common-note');
			await service.recordServedFeedEntries('user-1', [first, second, common]);

			const served = await query<{
				id: string; event_type: string; feed_kind: string; feed_epoch_id: string;
				feed_entry_id: string; note_id: string; source: string; occurred_at: Date;
			}>(`SELECT "id", "eventType" AS event_type, "feedKind" AS feed_kind,
				"feedEpochId" AS feed_epoch_id, "feedEntryId" AS feed_entry_id,
				"noteId" AS note_id, "source", "occurredAt" AS occurred_at
				FROM "hanami_recommendation_event" WHERE "eventType" = 'served' ORDER BY "feedEntryId"`);
			expect(served).toHaveLength(3);
			expect(served.map(row => row.feed_kind).sort()).toEqual(['common', 'personal', 'personal']);
			expect(served.every(row => row.occurred_at instanceof Date && row.source.length > 0)).toBe(true);
			const personalZadd = cache.transactions.flat().find(command => command[0] === 'zadd' && command[1] === 'hanami:rec:served:user-1');
			expect(personalZadd?.[2]).toBe('GT');
			expect(personalZadd?.filter(value => value === 'duplicate-note')).toHaveLength(1);

			await service.recordSeenFeedEntries('user-1', [
				{ feedEntryId: first.feedEntryId, noteId: first.entry.noteId },
				{ feedEntryId: second.feedEntryId, noteId: second.entry.noteId },
				{ feedEntryId: common.feedEntryId, noteId: common.entry.noteId },
			]);
			const before = await query<{ id: string; occurred_at: Date }>(`SELECT "id", "occurredAt" AS occurred_at
				FROM "hanami_recommendation_event" WHERE "eventType" = 'seen' AND "feedEntryId" = $1`, [first.feedEntryId]);
			await query('SELECT pg_sleep(0.01)');
			await service.recordSeenFeedEntries('user-1', [{ feedEntryId: first.feedEntryId, noteId: first.entry.noteId }]);
			const after = await query<{ id: string; occurred_at: Date }>(`SELECT "id", "occurredAt" AS occurred_at
				FROM "hanami_recommendation_event" WHERE "eventType" = 'seen' AND "feedEntryId" = $1`, [first.feedEntryId]);
			expect(after[0]!.id).toBe(before[0]!.id);
			expect(after[0]!.occurred_at.getTime()).toBeGreaterThan(before[0]!.occurred_at.getTime());
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_recommendation_event" WHERE "eventType" = 'seen'`))
				.toEqual([{ count: '3' }]);

			await query(`UPDATE "hanami_recommendation_event"
				SET "createdAt" = clock_timestamp() - INTERVAL '15 days', "occurredAt" = clock_timestamp()
				WHERE "eventType" = 'seen' AND "feedEntryId" = $1`, [first.feedEntryId]);
			const batch = new HanamiForYouBatchService(makeDataSource(schema) as never, {} as never, {} as never, {} as never);
			await batch.cleanupEvents();
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_recommendation_event"
				WHERE "eventType" = 'seen' AND "feedEntryId" = $1`, [first.feedEntryId])).toEqual([{ count: '1' }]);
			await query(`UPDATE "hanami_recommendation_event" SET "occurredAt" = clock_timestamp() - INTERVAL '15 days'
				WHERE "eventType" = 'seen' AND "feedEntryId" = $1`, [first.feedEntryId]);
			await batch.cleanupEvents();
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_recommendation_event"
				WHERE "eventType" = 'seen' AND "feedEntryId" = $1`, [first.feedEntryId])).toEqual([{ count: '0' }]);
		});
	}, 20_000);

	test('rejects wrong user/kind/epoch/month/row/Note, missing served, stale parent, and the whole mixed batch', async () => {
		await withSchema(async ({ schema, query }) => {
			const { service } = runtime(schema);
			const personal = personalEntry('9007199254740993', 'personal-batch-1');
			const common = commonEntry('common-row-1', 'common-note');
			await service.recordServedFeedEntries('user-1', [personal, common]);

			const invalidSeen = [
				{ feedEntryId: encodeHanamiPersonalFeedEntryLocator({ userId: 'user-2', epochId: 'personal-epoch', sequence: '9007199254740993' }), noteId: 'duplicate-note' },
				{ feedEntryId: encodeHanamiPersonalFeedEntryLocator({ userId: 'user-1', epochId: 'wrong-epoch', sequence: '9007199254740993' }), noteId: 'duplicate-note' },
				{ feedEntryId: personal.feedEntryId, noteId: 'common-note' },
				{ feedEntryId: encodeHanamiCommonFeedEntryLocator({ epochId: 'common-epoch', generatedMonth: '2026-09', rowId: 'common-row-1' }), noteId: 'common-note' },
				{ feedEntryId: encodeHanamiCommonFeedEntryLocator({ epochId: 'common-epoch', generatedMonth: '2026-08', rowId: 'missing-row' }), noteId: 'common-note' },
				{ feedEntryId: commonEntry('common-row-2', 'unserved-note').feedEntryId, noteId: 'unserved-note' },
			];
			for (const item of invalidSeen) {
				await expect(service.recordSeenFeedEntries('user-1', [item])).rejects.toBeInstanceOf(HanamiInvalidFeedEntryError);
			}
			await expect(service.recordServedFeedEntries('user-1', [{
				...personal,
				feedEntryId: common.feedEntryId,
			}])).rejects.toBeInstanceOf(HanamiInvalidFeedEntryError);
			await expect(service.recordSeenFeedEntries('user-1', [
				{ feedEntryId: personal.feedEntryId, noteId: 'duplicate-note' },
				{ feedEntryId: common.feedEntryId, noteId: 'wrong-note' },
			])).rejects.toBeInstanceOf(HanamiInvalidFeedEntryError);
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_recommendation_event" WHERE "eventType" = 'seen'`))
				.toEqual([{ count: '0' }]);

			await query(`UPDATE "hanami_common_generation" SET "status" = 'obsolete'`);
			await expect(service.recordServedFeedEntries('user-1', [common])).rejects.toBeInstanceOf(HanamiInvalidFeedEntryError);
			await query(`UPDATE "hanami_common_generation" SET "status" = 'ready'`);
			await query(`UPDATE "user" SET "isHibernated" = true WHERE "id" = 'user-1'`);
			await expect(service.recordServedFeedEntries('user-1', [personal])).rejects.toBeInstanceOf(HanamiInvalidFeedEntryError);
		});
	}, 20_000);

	test('checks actual candidate Notes without unrelated newer recency consuming a global cap', async () => {
		await withSchema(async ({ schema, query }) => {
			await query(`INSERT INTO "note" ("id")
				SELECT 'unrelated-note-' || lpad(i::text, 4, '0') FROM generate_series(1, 2000) AS i`);
			await query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "occurredAt", "createdAt")
				SELECT 'unrelated-event-' || lpad(i::text, 4, '0'), 'user-1',
					'unrelated-note-' || lpad(i::text, 4, '0'), 'seen',
					clock_timestamp() - (i::text || ' milliseconds')::interval, clock_timestamp()
				FROM generate_series(1, 2000) AS i`);
			await query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "occurredAt", "createdAt") VALUES
				('candidate-served-event', 'user-1', 'duplicate-note', 'served', clock_timestamp() - INTERVAL '29 minutes', clock_timestamp()),
				('candidate-seen-event', 'user-1', 'common-note', 'seen', clock_timestamp() - INTERVAL '6 days', clock_timestamp())`);
			const clock = await query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
			const connection = makeDataSource(schema);
			const repository = { manager: { connection } };
			const service = new HanamiRecommendationService(repository as never, {} as never);

			const result = await service.getDurableServedSeenForCandidates({
				userId: 'user-1',
				generatedAt: clock[0]!.now.toISOString(),
				noteIds: ['duplicate-note', 'common-note', 'unserved-note'],
				signal: new AbortController().signal,
			});

			expect(result.served).toEqual(new Set(['duplicate-note']));
			expect(result.seen).toEqual(new Set(['common-note']));
		});
	}, 20_000);

	test('keeps the durable write successful on Redis failure, enqueues repair, and skips expired repair rows', async () => {
		await withSchema(async ({ schema, query }) => {
			const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			try {
				const failedCache = runtime(schema, true);
				const personal = personalEntry('9007199254740993', 'personal-batch-1');
				await expect(failedCache.service.recordServedFeedEntries('user-1', [personal])).resolves.toBeUndefined();
				const durable = await query<{ id: string }>(`SELECT "id" FROM "hanami_recommendation_event" WHERE "eventType" = 'served'`);
				expect(durable).toHaveLength(1);
				expect(failedCache.repairBatches).toEqual([[durable[0]!.id]]);

				const healthy = runtime(schema);
				await healthy.service.recordSeenFeedEntries('user-1', [{ feedEntryId: personal.feedEntryId, noteId: 'duplicate-note' }]);
				const events = await query<{ id: string; event_type: string }>(`SELECT "id", "eventType" AS event_type FROM "hanami_recommendation_event" ORDER BY "eventType"`);
				await query(`UPDATE "hanami_recommendation_event"
					SET "occurredAt" = CASE WHEN "eventType" = 'served' THEN clock_timestamp() - INTERVAL '31 minutes'
						ELSE clock_timestamp() - INTERVAL '8 days' END`);
				healthy.cache.transactions.length = 0;
				await healthy.service.repairRecommendationEventCache(events.map(event => event.id));
				expect(healthy.cache.transactions).toEqual([]);

				await query(`UPDATE "hanami_recommendation_event" SET "occurredAt" = clock_timestamp() WHERE "eventType" = 'seen'`);
				await healthy.service.repairRecommendationEventCache(events.map(event => event.id));
				const zadds = healthy.cache.transactions.flat().filter(command => command[0] === 'zadd');
				expect(zadds).toHaveLength(1);
				expect(zadds[0]![1]).toBe('hanami:rec:seen:user-1');
			} finally {
				errorLog.mockRestore();
			}
		});
	}, 20_000);

	test('eventually replays PostgreSQL after both cache and Bull enqueue fail or immediate attempts exhaust', async () => {
		await withSchema(async ({ schema, query }) => {
			const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			try {
				const outage = runtime(schema, true, true);
				const personal = personalEntry('9007199254740993', 'personal-batch-1');
				await expect(outage.service.recordServedFeedEntries('user-1', [personal])).resolves.toBeUndefined();
				const durable = await query<{ id: string }>(`SELECT "id" FROM "hanami_recommendation_event" WHERE "eventType" = 'served'`);
				expect(durable).toHaveLength(1);
				expect(outage.repairBatches).toEqual([]);

				outage.cache.setFailure(false);
				outage.setQueueFailure(false);
				await expect(outage.service.replayRecommendationEventCache({})).resolves.toBeNull();
				expect(outage.cache.transactions.flat().some(command => command[0] === 'zadd'
					&& command[1] === 'hanami:rec:served:user-1')).toBe(true);

				await query('SELECT pg_sleep(0.01)');
				outage.cache.setFailure(true);
				await expect(outage.service.recordSeenFeedEntries('user-1', [{
					feedEntryId: personal.feedEntryId,
					noteId: personal.entry.noteId,
				}])).resolves.toBeUndefined();
				const seen = await query<{ id: string }>(`SELECT "id" FROM "hanami_recommendation_event" WHERE "eventType" = 'seen'`);
				expect(seen).toHaveLength(1);
				for (let attempt = 0; attempt < 3; attempt++) {
					await expect(outage.service.repairRecommendationEventCache([seen[0]!.id])).rejects.toThrow('simulated Redis outage');
				}

				outage.cache.setFailure(false);
				outage.cache.transactions.length = 0;
				await expect(outage.service.replayRecommendationEventCache({})).resolves.toBeNull();
				expect(outage.cache.transactions.flat().some(command => command[0] === 'zadd'
					&& command[1] === 'hanami:rec:seen:user-1')).toBe(true);
			} finally {
				errorLog.mockRestore();
			}
		});
	}, 20_000);
});
