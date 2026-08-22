/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';
import type { Config } from '@/config.js';
import { HanamiCommonHeadQueries } from '@/core/hanami/HanamiCommonHeadQueries.js';
import { HanamiFeedLifecycleService } from '@/core/hanami/HanamiFeedLifecycleService.js';
import { HanamiPersistedFeedReadService } from '@/core/hanami/HanamiPersistedFeedReadService.js';
import { HanamiUserFeedGenerationService } from '@/core/hanami/HanamiUserFeedGenerationService.js';
import { HanamiUserFeedRequestService } from '@/core/hanami/HanamiUserFeedRequestService.js';
import type { HanamiPersonalFeedComputationInput, HanamiPersonalFeedComputationPort, HanamiPersonalFeedComputationResult } from '@/core/hanami/HanamiUserFeedContracts.js';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;
type DbQuery = <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;
type DataSourceLike = ReturnType<typeof makeDataSource>;

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
};

const sleep = async (milliseconds: number): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const makeDataSource = (schema: string) => {
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
				manager: undefined as unknown as { query: DbQuery },
				connect: async (): Promise<void> => {
					client = new Client({ connectionString: databaseUrl });
					await initialize(client);
				},
				startTransaction: async (): Promise<void> => {
					if (client == null) throw new Error('query runner is not connected');
					await client.query('BEGIN');
					runner.isTransactionActive = true;
				},
				commitTransaction: async (): Promise<void> => {
					if (client == null) throw new Error('query runner is not connected');
					await client.query('COMMIT');
					runner.isTransactionActive = false;
				},
				rollbackTransaction: async (): Promise<void> => {
					if (client == null) throw new Error('query runner is not connected');
					await client.query('ROLLBACK');
					runner.isTransactionActive = false;
				},
				release: async (): Promise<void> => {
					await client?.end();
				},
				query: async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
					if (client == null) throw new Error('query runner is not connected');
					return (await client.query<T>(sql, values)).rows;
				},
			};
			runner.manager = { query: runner.query };
			return runner;
		},
	};
};

const makeIdService = (prefix: string) => {
	let sequence = 0;
	return { gen: (): string => `${prefix}${String(++sequence).padStart(20, '0')}` };
};

class Computation implements HanamiPersonalFeedComputationPort {
	public readonly algorithmVersion = 'workstream-b-v1';
	public inputs: HanamiPersonalFeedComputationInput[] = [];
	public compute: (input: HanamiPersonalFeedComputationInput) => Promise<HanamiPersonalFeedComputationResult>;

	constructor(result: HanamiPersonalFeedComputationResult = personalResult('personal-note-1')) {
		this.compute = async () => result;
	}

	public async computePersonalFeed(input: HanamiPersonalFeedComputationInput): Promise<HanamiPersonalFeedComputationResult> {
		this.inputs.push(input);
		return await this.compute(input);
	}
}

const personalResult = (...noteIds: string[]): HanamiPersonalFeedComputationResult => ({
	confidence: 'high',
	items: noteIds.map((noteId, index) => ({
		noteId,
		source: index % 2 === 0 ? 'globalPopular' : 'catchup',
		sources: [index % 2 === 0 ? 'globalPopular' : 'catchup'],
		origin: index % 2 === 0 ? 'commonCandidate' : 'personalCandidate',
		reasonMetadata: { version: 1, bucket: 'recent' },
	})),
	segmentLengths: noteIds.length === 0 ? [] : [noteIds.length],
});

const config = (overrides: Partial<Config> = {}): Config => ({
	hanamiGenerationSyncWaitMs: 0,
	hanamiGenerationWorkerTimeoutMs: 3_000,
	hanamiGenerationLeaseMs: 5_000,
	hanamiGenerationMaxAttempts: 3,
	...overrides,
} as Config);

const makeRuntime = (schema: string, options: {
	computation?: Computation;
	config?: Partial<Config>;
	queue?: (batchId: string) => Promise<unknown>;
	idPrefix?: string;
	policy?: boolean;
} = {}) => {
	const db = makeDataSource(schema);
	const ids = makeIdService(options.idPrefix ?? 'wb');
	const computation = options.computation ?? new Computation();
	const queueCalls: string[] = [];
	const queue = {
		enqueueHanamiUserFeedGeneration: async (batchId: string): Promise<unknown> => {
			queueCalls.push(batchId);
			return await (options.queue?.(batchId) ?? Promise.resolve(undefined));
		},
	};
	const warnings: unknown[][] = [];
	const loggerService = { getLogger: () => ({ warn: (...args: unknown[]) => warnings.push(args) }) };
	const role = { getUserPolicies: async (_userId: string, manager: unknown) => {
		expect(manager).toBeDefined();
		return { hanamiTlAvailable: options.policy ?? true };
	} };
	const runtimeConfig = config(options.config);
	const common = new HanamiCommonHeadQueries();
	const generation = new HanamiUserFeedGenerationService(db as never, runtimeConfig, ids as never, computation);
	const request = new HanamiUserFeedRequestService(
		db as never,
		runtimeConfig,
		ids as never,
		role as never,
		queue as never,
		loggerService as never,
		common,
	);
	const read = new HanamiPersistedFeedReadService(db as never);
	const lifecycle = new HanamiFeedLifecycleService(ids as never, role as never, common);
	return { common, computation, db, generation, lifecycle, queueCalls, read, request, warnings };
};

const withMigratedSchema = async (run: (context: { schema: string; query: DbQuery }) => Promise<void>): Promise<void> => {
	const schema = `hanami_workstream_b_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const client = new Client({ connectionString: databaseUrl });
	const query: DbQuery = async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, values)).rows;
	try {
		await client.connect();
		await query(`CREATE SCHEMA ${quoteIdent(schema)}`);
		await query(`SET search_path TO ${quoteIdent(schema)}, public`);
		await query(`SET TIME ZONE 'UTC'`);
		await query(`CREATE TABLE "user" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"isHibernated" boolean NOT NULL DEFAULT false
		)`);
		await query(`CREATE TABLE "user_profile" (
			"userId" character varying(32) NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
			"hanamiRecommendationEnabled" boolean NOT NULL DEFAULT true
		)`);
		await query(`CREATE TABLE "note" ("id" character varying(32) NOT NULL PRIMARY KEY)`);
		await query(`CREATE TABLE "hanami_recommendation_event" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"userId" character varying(32) NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"eventType" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL
		)`);
		await new HanamiPersistedTimelinePhase11787097600000().up({ query } as never);
		await query(`INSERT INTO "note" ("id") SELECT id FROM unnest($1::varchar[]) input(id)`, [[
			'common-note-1', 'common-note-2', 'common-note-3',
			'personal-note-1', 'personal-note-2', 'personal-note-3', 'personal-note-4',
		]]);
		await query(`INSERT INTO "hanami_common_generation"
			("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "generationFence")
			VALUES ('common-generation-1', 1, 'ready', '2026-08-20T00:00:00Z', '2026-08-20T00:00:01Z', 'test', 1)`);
		await query(`INSERT INTO "hanami_common_feed_state"
			("singletonId", "epochId", "latestSequence", "earliestRetainedSequence", "latestReadyGenerationId", "generationFence", "updatedAt")
			VALUES ('singleton', 'common-epoch-1', 3, 1, 'common-generation-1', 1, clock_timestamp())`);
		await query(`INSERT INTO "hanami_common_feed_entry"
			("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt")
			VALUES
			('2026-08-01', 'common-entry-1', 'common-epoch-1', 3, 'common-generation-1', 0, 'common-note-1', 'globalPopular', '["globalPopular"]', '2026-08-20T00:00:00Z'),
			('2026-08-01', 'common-entry-2', 'common-epoch-1', 2, 'common-generation-1', 1, 'common-note-2', 'trending', '["trending"]', '2026-08-20T00:00:00Z'),
			('2026-08-01', 'common-entry-3', 'common-epoch-1', 1, 'common-generation-1', 2, 'common-note-3', 'exploration', '["exploration"]', '2026-08-20T00:00:00Z')`);
		const versions = await query<{ server_version: string }>('SHOW server_version');
		expect(versions.at(0)?.server_version).toMatch(/^18\./);
		await run({ schema, query });
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

const seedUser = async (query: DbQuery, userId: string, enabled = true): Promise<void> => {
	await query(`INSERT INTO "user" ("id") VALUES ($1)`, [userId]);
	await query(`INSERT INTO "user_profile" ("userId", "hanamiRecommendationEnabled") VALUES ($1, $2)`, [userId, enabled]);
};

const token = (byte: number): string => Buffer.alloc(32, byte).toString('base64url');

describe('Hanami Phase 5 workstream B PostgreSQL contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for workstream B DB contracts.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('checks role before profile and returns recommendation heads without creating durable work', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'role-precedence');
			await query(`DELETE FROM "user_profile" WHERE "userId" = 'role-precedence'`);
			const roleDisabled = makeRuntime(schema, { policy: false, idPrefix: 'ap' });
			await expect(roleDisabled.request.checkAvailability('role-precedence')).resolves.toEqual({ kind: 'roleDisabled' });

			await seedUser(query, 'recommendation-head', false);
			const recommendationDisabled = makeRuntime(schema, { idPrefix: 'ah' });
			await expect(recommendationDisabled.request.checkAvailability('recommendation-head')).resolves.toEqual({
				kind: 'recommendationDisabled',
				head: {
					mode: 'common',
					kind: 'common',
					feedEpochId: 'common-epoch-1',
					headBatchId: 'common-generation-1',
					headSequence: '3',
				},
			});

			await query(`DELETE FROM "hanami_common_feed_state" WHERE "singletonId" = 'singleton'`);
			await seedUser(query, 'recommendation-null', false);
			const noCommon = makeRuntime(schema, { idPrefix: 'an' });
			await expect(noCommon.request.checkAvailability('recommendation-null')).resolves.toEqual({
				kind: 'recommendationDisabled', head: null,
			});

			expect(roleDisabled.queueCalls).toEqual([]);
			expect(recommendationDisabled.queueCalls).toEqual([]);
			expect(noCommon.queueCalls).toEqual([]);
			expect(await query<{ states: string; epochs: string; batches: string; refreshes: string }>(`
				SELECT
					(SELECT COUNT(*)::text FROM "hanami_user_feed_state") AS states,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_epoch") AS epochs,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_batch") AS batches,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_refresh") AS refreshes
			`)).toEqual([{ states: '0', epochs: '0', batches: '0', refreshes: '0' }]);

			await expect(noCommon.request.evaluateCursorless('recommendation-null')).resolves.toEqual({
				kind: 'recommendationDisabled', head: null,
			});
			await query(`INSERT INTO "hanami_common_feed_state"
				("singletonId", "epochId", "latestSequence", "earliestRetainedSequence", "latestReadyGenerationId", "generationFence", "updatedAt")
				VALUES ('singleton', 'common-epoch-1', 3, 1, 'common-generation-1', 1, clock_timestamp())`);
			await expect(noCommon.request.checkAvailability('recommendation-null')).resolves.toMatchObject({
				kind: 'recommendationDisabled', head: { kind: 'common', headBatchId: 'common-generation-1', headSequence: '3' },
			});
			expect(await query<{ states: string; epochs: string; batches: string; refreshes: string }>(`
				SELECT
					(SELECT COUNT(*)::text FROM "hanami_user_feed_state" WHERE "userId" = 'recommendation-null') AS states,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_epoch" WHERE "userId" = 'recommendation-null') AS epochs,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_batch" WHERE "userId" = 'recommendation-null') AS batches,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_refresh" WHERE "userId" = 'recommendation-null') AS refreshes
			`)).toEqual([{ states: '1', epochs: '1', batches: '0', refreshes: '0' }]);
		});
	}, 20_000);

	test('commits initial durable state before enqueue, repairs a lost enqueue, publishes contiguous entries, and performs raw personal scans', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'request-user');
			let observedCommitted = false;
			const runtime = makeRuntime(schema, {
				config: { hanamiGenerationSyncWaitMs: 1_000 },
				queue: async (batchId) => {
					const rows = await makeDataSource(schema).query<{ batch_status: string; pointer: string; initial_state: string }>(`
						SELECT b."status" AS batch_status, s."generatingBatchId" AS pointer,
							s."initialGenerationState" AS initial_state
						FROM "hanami_user_feed_batch" b
						JOIN "hanami_user_feed_state" s ON s."userId" = b."userId"
						WHERE b."id" = $1
					`, [batchId]);
					observedCommitted = rows.at(0)?.pointer === batchId && rows.at(0)?.initial_state === 'requested';
					throw new Error('simulated queue outage');
				},
			});

			const requested = await runtime.request.evaluateCursorless('request-user');
			expect(requested).toMatchObject({ kind: 'serve', generationPending: true });
			if (requested.kind !== 'serve' || !requested.generationPending) throw new Error('expected pending request');
			expect(observedCommitted).toBe(true);
			expect(runtime.warnings).toHaveLength(1);
			const reconcile = await runtime.generation.reconcileUserFeedGeneration(10);
			expect(reconcile.batchIdsToEnqueue).toEqual([requested.requestedBatchId]);

			await expect(runtime.generation.runUserFeedGeneration(requested.requestedBatchId)).resolves.toMatchObject({
				kind: 'published', itemCount: 1, headSequence: '1',
			});
			const ready = await runtime.request.evaluateCursorless('request-user');
			expect(ready).toMatchObject({
				kind: 'serve', generationPending: false,
				head: { kind: 'personal', headSequence: '1' },
			});
			if (ready.kind !== 'serve') throw new Error('expected ready personal head');
			await query(`UPDATE "user_profile" SET "hanamiRecommendationEnabled" = FALSE WHERE "userId" = 'request-user'`);
			await expect(runtime.request.checkAvailability('request-user')).resolves.toEqual({
				kind: 'recommendationDisabled', head: ready.head,
			});

			const scan = await runtime.read.scanReadyEntries({
				requesterUserId: 'request-user',
				head: ready.head,
				beforeSequence: null,
				scanLimit: 1,
			});
			expect(scan).toMatchObject({ kind: 'page', hasMore: false, lastScannedSequence: '1' });
			if (scan.kind === 'page') expect(scan.entries.map((entry) => entry.noteId)).toEqual(['personal-note-1']);
			await query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'request-user'`);
			await expect(runtime.request.checkAvailability('request-user')).resolves.toMatchObject({
				kind: 'recommendationDisabled', head: { kind: 'common', headBatchId: 'common-generation-1', headSequence: '3' },
			});
			await expect(runtime.read.scanReadyEntries({
				requesterUserId: 'request-user', head: ready.head, beforeSequence: null, scanLimit: 1,
			})).resolves.toEqual({ kind: 'cursorExpired' });
			await query(`UPDATE "user" SET "isHibernated" = FALSE WHERE "id" = 'request-user'`);
			await expect(runtime.read.scanReadyEntries({
				requesterUserId: 'request-user', head: ready.head, beforeSequence: '0', scanLimit: 1,
			})).resolves.toEqual({ kind: 'cursorExpired' });

			const sequenceRows = await query<{ sequence: string; status: string; pointer: string | null }>(`
				SELECT e."sequence"::text AS sequence, b."status" AS status, s."generatingBatchId" AS pointer
				FROM "hanami_user_feed_entry" e
				JOIN "hanami_user_feed_batch" b ON b."id" = e."batchId"
				JOIN "hanami_user_feed_state" s ON s."userId" = e."userId"
				WHERE e."userId" = 'request-user'
			`);
			expect(sequenceRows).toEqual([{ sequence: '1', status: 'ready', pointer: null }]);
		});
	}, 20_000);

	test('records unavailable first evaluation without work, rolls back an available first request without common, and honors synchronous wait', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'hibernated-unused');
			await query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'hibernated-unused'`);
			const hibernatedUnused = makeRuntime(schema, { idPrefix: 'ph' });
			await expect(hibernatedUnused.request.evaluateCursorless('hibernated-unused')).resolves.toMatchObject({
				kind: 'serve', generationPending: false, requestedBatchId: null,
				head: { kind: 'common', headBatchId: 'common-generation-1', headSequence: '3' },
			});
			await expect(hibernatedUnused.request.requestRefresh('hibernated-unused', token(10))).resolves.toMatchObject({
				kind: 'serve', generationPending: false, requestedBatchId: null,
				head: { kind: 'common', headBatchId: 'common-generation-1', headSequence: '3' },
			});
			expect(hibernatedUnused.queueCalls).toEqual([]);
			expect(await query<{ states: string; epochs: string; batches: string; refreshes: string }>(`
				SELECT
					(SELECT COUNT(*)::text FROM "hanami_user_feed_state" WHERE "userId" = 'hibernated-unused') AS states,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_epoch" WHERE "userId" = 'hibernated-unused') AS epochs,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_batch" WHERE "userId" = 'hibernated-unused') AS batches,
					(SELECT COUNT(*)::text FROM "hanami_user_feed_refresh" WHERE "userId" = 'hibernated-unused') AS refreshes
			`)).toEqual([{ states: '0', epochs: '0', batches: '0', refreshes: '0' }]);

			await seedUser(query, 'role-disabled');
			const roleDisabled = makeRuntime(schema, { policy: false, idPrefix: 'pd' });
			await expect(roleDisabled.request.evaluateCursorless('role-disabled')).resolves.toEqual({ kind: 'roleDisabled' });
			expect(await query(`SELECT "initialGenerationState", "commonHeadGenerationId", "commonHeadSequence"::text
				FROM "hanami_user_feed_state" WHERE "userId" = 'role-disabled'`)).toEqual([{
				initialGenerationState: 'skippedUnavailable', commonHeadGenerationId: 'common-generation-1', commonHeadSequence: '3',
			}]);
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_batch" WHERE "userId" = 'role-disabled'`)).toEqual([{ count: '0' }]);
			await query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'role-disabled'`);
			await expect(roleDisabled.request.requestRefresh('role-disabled', token(12))).resolves.toMatchObject({
				kind: 'serve', generationPending: false, requestedBatchId: null,
				head: { kind: 'common', headBatchId: 'common-generation-1', headSequence: '3' },
			});
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_refresh" WHERE "userId" = 'role-disabled'`)).toEqual([{ count: '0' }]);

			await seedUser(query, 'profile-disabled', false);
			const profileDisabled = makeRuntime(schema, { idPrefix: 'pe' });
			await expect(profileDisabled.request.requestRefresh('profile-disabled', token(11))).resolves.toMatchObject({
				kind: 'recommendationDisabled', head: { kind: 'common' },
			});
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_refresh" WHERE "userId" = 'profile-disabled'`)).toEqual([{ count: '0' }]);

			await seedUser(query, 'no-common');
			await query(`DELETE FROM "hanami_common_feed_state" WHERE "singletonId" = 'singleton'`);
			const noCommon = makeRuntime(schema, { idPrefix: 'pf' });
			await expect(noCommon.request.evaluateCursorless('no-common')).resolves.toEqual({ kind: 'commonNotReady' });
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_state" WHERE "userId" = 'no-common'`)).toEqual([{ count: '0' }]);
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_epoch" WHERE "userId" = 'no-common'`)).toEqual([{ count: '0' }]);
			await seedUser(query, 'hibernated-no-common');
			await query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'hibernated-no-common'`);
			await expect(noCommon.request.requestRefresh('hibernated-no-common', token(13))).resolves.toEqual({ kind: 'commonNotReady' });
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_state" WHERE "userId" = 'hibernated-no-common'`)).toEqual([{ count: '0' }]);

			await query(`INSERT INTO "hanami_common_feed_state"
				("singletonId", "epochId", "latestSequence", "earliestRetainedSequence", "latestReadyGenerationId", "generationFence", "updatedAt")
				VALUES ('singleton', 'common-epoch-1', 3, 1, 'common-generation-1', 1, clock_timestamp())`);
			await seedUser(query, 'sync-user');
			const generationHolder: { service?: HanamiUserFeedGenerationService } = {};
			const synchronous = makeRuntime(schema, {
				idPrefix: 'pg',
				config: { hanamiGenerationSyncWaitMs: 2_000 },
				queue: async (batchId) => {
					void generationHolder.service!.runUserFeedGeneration(batchId);
				},
			});
			generationHolder.service = synchronous.generation;
			const syncResult = await synchronous.request.evaluateCursorless('sync-user');
			expect(syncResult).toMatchObject({
				kind: 'serve', generationPending: false,
				head: { kind: 'personal', headSequence: '1' },
			});
			expect(synchronous.queueCalls).toHaveLength(1);

			await seedUser(query, 'never-enqueue-user');
			const neverEnqueue = makeRuntime(schema, {
				idPrefix: 'pn',
				config: { hanamiGenerationSyncWaitMs: 100 },
				queue: async () => await new Promise<never>(() => undefined),
			});
			const enqueueStartedAt = Date.now();
			const enqueueTimeout = await neverEnqueue.request.evaluateCursorless('never-enqueue-user');
			expect(Date.now() - enqueueStartedAt).toBeLessThan(1_000);
			expect(enqueueTimeout).toMatchObject({ kind: 'serve', generationPending: true, head: { kind: 'common' } });
			expect(neverEnqueue.queueCalls).toHaveLength(1);
			const durableRows = await query<{ status: string; pointer: string }>(`
				SELECT b."status" AS status, s."generatingBatchId" AS pointer
				FROM "hanami_user_feed_batch" b JOIN "hanami_user_feed_state" s ON s."userId" = b."userId"
				WHERE b."userId" = 'never-enqueue-user'
			`);
			expect(durableRows).toEqual([{ status: 'pending', pointer: expect.any(String) }]);

			await seedUser(query, 'late-enqueue-reject');
			const lateEnqueue = deferred<unknown>();
			const lateReject = makeRuntime(schema, {
				idPrefix: 'po',
				config: { hanamiGenerationSyncWaitMs: 50 },
				queue: async () => await lateEnqueue.promise,
			});
			await expect(lateReject.request.evaluateCursorless('late-enqueue-reject')).resolves.toMatchObject({
				kind: 'serve', generationPending: true,
			});
			lateEnqueue.reject(new Error('late queue rejection'));
			await sleep(0);
			expect(lateReject.warnings).toHaveLength(1);
		});
	}, 20_000);

	test('terminal refresh failure resets failed or skippedUnavailable reloads to failed while preserving ready', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const failingComputation = new Computation();
			failingComputation.compute = async () => { throw new Error('terminal generation failure'); };

			await seedUser(query, 'failed-reload');
			const failedRuntime = makeRuntime(schema, {
				idPrefix: 'rf', computation: failingComputation, config: { hanamiGenerationMaxAttempts: 1 },
			});
			const initial = await failedRuntime.request.evaluateCursorless('failed-reload');
			if (initial.kind !== 'serve' || !initial.generationPending) throw new Error('expected failed-reload initial batch');
			await failedRuntime.generation.runUserFeedGeneration(initial.requestedBatchId);
			expect(await query(`SELECT "initialGenerationState" FROM "hanami_user_feed_state" WHERE "userId" = 'failed-reload'`))
				.toEqual([{ initialGenerationState: 'failed' }]);
			const failedRefresh = await failedRuntime.request.requestRefresh('failed-reload', token(21));
			if (failedRefresh.kind !== 'serve' || !failedRefresh.generationPending) throw new Error('expected refresh from failed');
			expect(await query(`SELECT "initialGenerationState" FROM "hanami_user_feed_state" WHERE "userId" = 'failed-reload'`))
				.toEqual([{ initialGenerationState: 'requested' }]);
			await failedRuntime.generation.runUserFeedGeneration(failedRefresh.requestedBatchId);
			expect(await query(`SELECT "initialGenerationState" FROM "hanami_user_feed_state" WHERE "userId" = 'failed-reload'`))
				.toEqual([{ initialGenerationState: 'failed' }]);

			await seedUser(query, 'skipped-reload', false);
			const skippedRuntime = makeRuntime(schema, { idPrefix: 'rs', config: { hanamiGenerationMaxAttempts: 1 } });
			await skippedRuntime.request.evaluateCursorless('skipped-reload');
			await query(`UPDATE "user_profile" SET "hanamiRecommendationEnabled" = TRUE WHERE "userId" = 'skipped-reload'`);
			const skippedRefresh = await skippedRuntime.request.requestRefresh('skipped-reload', token(22));
			if (skippedRefresh.kind !== 'serve' || !skippedRefresh.generationPending) throw new Error('expected refresh from skippedUnavailable');
			await query(`UPDATE "hanami_user_feed_batch" SET "attempts" = 1 WHERE "id" = $1`, [skippedRefresh.requestedBatchId]);
			await expect(skippedRuntime.generation.reconcileUserFeedGeneration(10)).resolves.toMatchObject({ failedBatchCount: 1 });
			expect(await query(`SELECT "initialGenerationState" FROM "hanami_user_feed_state" WHERE "userId" = 'skipped-reload'`))
				.toEqual([{ initialGenerationState: 'failed' }]);
			expect(await query(`SELECT "status", "resultMode", "resultHeadBatchId", "resultHeadSequence"::text
				FROM "hanami_user_feed_refresh" WHERE "userId" = 'skipped-reload'`)).toEqual([{
				status: 'failed', resultMode: 'common', resultHeadBatchId: 'common-generation-1', resultHeadSequence: '3',
			}]);

			await seedUser(query, 'ready-reload');
			const readyRuntime = makeRuntime(schema, { idPrefix: 'rr' });
			const readyInitial = await readyRuntime.request.evaluateCursorless('ready-reload');
			if (readyInitial.kind !== 'serve' || !readyInitial.generationPending) throw new Error('expected ready-reload initial batch');
			await readyRuntime.generation.runUserFeedGeneration(readyInitial.requestedBatchId);
			const readyRefresh = await readyRuntime.request.requestRefresh('ready-reload', token(23));
			if (readyRefresh.kind !== 'serve' || !readyRefresh.generationPending) throw new Error('expected refresh from ready');
			await query(`UPDATE "hanami_user_feed_batch" SET "attempts" = 3 WHERE "id" = $1`, [readyRefresh.requestedBatchId]);
			await readyRuntime.generation.reconcileUserFeedGeneration(10);
			expect(await query(`SELECT "initialGenerationState" FROM "hanami_user_feed_state" WHERE "userId" = 'ready-reload'`))
				.toEqual([{ initialGenerationState: 'ready' }]);
		});
	}, 20_000);

	test('joins same-token and different-token concurrency, enforces the DB-clock rate boundary, and freezes terminal refresh results', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'refresh-user');
			const firstRuntime = makeRuntime(schema, { idPrefix: 'ra' });
			const initial = await firstRuntime.request.evaluateCursorless('refresh-user');
			if (initial.kind !== 'serve' || !initial.generationPending) throw new Error('expected initial batch');
			await firstRuntime.generation.runUserFeedGeneration(initial.requestedBatchId);

			const sameTokenResults = await Promise.all(Array.from({ length: 6 }, () => firstRuntime.request.requestRefresh('refresh-user', token(1))));
			const requestedIds = sameTokenResults.map((result) => result.kind === 'serve' ? result.requestedBatchId : null);
			expect(new Set(requestedIds).size).toBe(1);
			const refreshBatchId = requestedIds[0]!;
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_refresh" WHERE "userId" = 'refresh-user'`)).toEqual([{ count: '1' }]);

			const joined = await Promise.all([2, 3].map((value) => firstRuntime.request.requestRefresh('refresh-user', token(value))));
			expect(joined.every((result) => result.kind === 'serve' && result.requestedBatchId === refreshBatchId)).toBe(true);
			await expect(firstRuntime.request.requestRefresh('refresh-user', token(4))).resolves.toEqual({ kind: 'refreshRateLimited' });

			await query(`UPDATE "hanami_user_feed_refresh" SET "createdAt" = clock_timestamp() - INTERVAL '1 minute'
				WHERE "userId" = 'refresh-user' AND "refreshTokenDigest" = $1`, [createDigest(token(2))]);
			await expect(firstRuntime.request.requestRefresh('refresh-user', token(4))).resolves.toMatchObject({ kind: 'serve', generationPending: true, requestedBatchId: refreshBatchId });

			firstRuntime.computation.compute = async () => personalResult('personal-note-2', 'personal-note-3');
			await expect(firstRuntime.generation.runUserFeedGeneration(refreshBatchId)).resolves.toMatchObject({ kind: 'published', itemCount: 2, headSequence: '3' });
			const terminal = await firstRuntime.request.requestRefresh('refresh-user', token(1));
			expect(terminal).toMatchObject({
				kind: 'serve', generationPending: false, requestedBatchId: refreshBatchId,
				head: { kind: 'personal', headBatchId: refreshBatchId, headSequence: '3' },
			});
			const entries = await query<{ position: number; sequence: string }>(`
				SELECT "position" AS position, "sequence"::text AS sequence
				FROM "hanami_user_feed_entry" WHERE "batchId" = $1 ORDER BY "position"
			`, [refreshBatchId]);
			expect(entries).toEqual([{ position: 0, sequence: '3' }, { position: 1, sequence: '2' }]);
		});
	}, 20_000);

	test('fences stale publication and failure across reclaim and hibernation, and terminalizes the final attempt with immutable fallback mappings', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'fence-user');
			const oldComputation = new Computation();
			const entered = deferred<void>();
			const held = deferred<HanamiPersonalFeedComputationResult>();
			oldComputation.compute = async () => {
				entered.resolve();
				return await held.promise;
			};
			const oldRuntime = makeRuntime(schema, { computation: oldComputation, idPrefix: 'fa' });
			const initial = await oldRuntime.request.requestRefresh('fence-user', token(8));
			if (initial.kind !== 'serve' || !initial.generationPending) throw new Error('expected initial refresh batch');
			const oldRun = oldRuntime.generation.runUserFeedGeneration(initial.requestedBatchId);
			await entered.promise;
			await query(`UPDATE "hanami_user_feed_batch" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = $1`, [initial.requestedBatchId]);

			const failing = new Computation();
			failing.compute = async () => { throw new Error('new owner failed'); };
			const newRuntime = makeRuntime(schema, { computation: failing, idPrefix: 'fb', config: { hanamiGenerationMaxAttempts: 2 } });
			await expect(newRuntime.generation.runUserFeedGeneration(initial.requestedBatchId)).resolves.toEqual({
				kind: 'failed', batchId: initial.requestedBatchId, attempt: 2, terminal: true,
			});
			held.reject(new Error('stale owner failed later'));
			await expect(oldRun).resolves.toEqual({ kind: 'stale', batchId: initial.requestedBatchId, attempt: 1 });

			const terminal = await newRuntime.request.requestRefresh('fence-user', token(8));
			expect(terminal).toMatchObject({ kind: 'serve', generationPending: false, head: { kind: 'common', headSequence: '3' } });
			expect(await query(`SELECT "status", "attempts", "leaseOwner" FROM "hanami_user_feed_batch" WHERE "id" = $1`, [initial.requestedBatchId])).toEqual([{
				status: 'failed', attempts: 2, leaseOwner: null,
			}]);

			await seedUser(query, 'hibernate-user');
			const hibernatingComputation = new Computation();
			const hibernateEntered = deferred<void>();
			const hibernateHeld = deferred<HanamiPersonalFeedComputationResult>();
			hibernatingComputation.compute = async () => {
				hibernateEntered.resolve();
				return await hibernateHeld.promise;
			};
			const hibernateRuntime = makeRuntime(schema, { computation: hibernatingComputation, idPrefix: 'hc' });
			const hibernateRequest = await hibernateRuntime.request.evaluateCursorless('hibernate-user');
			if (hibernateRequest.kind !== 'serve' || !hibernateRequest.generationPending) throw new Error('expected hibernation batch');
			const hibernateRun = hibernateRuntime.generation.runUserFeedGeneration(hibernateRequest.requestedBatchId);
			await hibernateEntered.promise;
			const db = makeDataSource(schema);
			const runner = db.createQueryRunner();
			await runner.connect();
			await runner.startTransaction();
			try {
				await runner.query(`SELECT "id" FROM "user" WHERE "id" = 'hibernate-user' FOR UPDATE`);
				await hibernateRuntime.lifecycle.hibernateUsers(runner.manager as never, ['hibernate-user'], new Date());
				await runner.query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'hibernate-user'`);
				await runner.commitTransaction();
			} finally {
				await runner.release();
			}
			hibernateHeld.resolve(personalResult('personal-note-4'));
			await expect(hibernateRun).resolves.toEqual({ kind: 'stale', batchId: hibernateRequest.requestedBatchId, attempt: 1 });
			expect(await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_entry" WHERE "userId" = 'hibernate-user'`)).toEqual([{ count: '0' }]);
		});
	}, 20_000);

	test('resumes personal cursors below a stable boundary across prepends, mode changes, and anchor deletion', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'personal-resume');
			const computation = new Computation(personalResult('personal-note-1', 'personal-note-2', 'personal-note-3'));
			const runtime = makeRuntime(schema, { computation, idPrefix: 'pr' });
			const initial = await runtime.request.evaluateCursorless('personal-resume');
			if (initial.kind !== 'serve' || !initial.generationPending) throw new Error('expected personal resume initial batch');
			const publication = await runtime.generation.runUserFeedGeneration(initial.requestedBatchId);
			if (publication.kind !== 'published') throw new Error('expected personal resume publication');
			const personalEpochId = publication.feedEpochId;

			const first = await runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume',
				cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '3' },
				scanLimit: 1,
			});
			expect(first).toMatchObject({
				kind: 'page',
				head: { kind: 'personal', headBatchId: initial.requestedBatchId, headSequence: '3' },
				entries: [{ sequence: '2', batchId: initial.requestedBatchId }],
				lastScannedSequence: '2',
				hasMore: true,
			});

			await query(`DELETE FROM "hanami_user_feed_entry"
				WHERE "userId" = 'personal-resume' AND "epochId" = $1 AND "sequence" = 3`, [personalEpochId]);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume',
				cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '3' },
				scanLimit: 2,
			})).resolves.toMatchObject({
				kind: 'page', entries: [{ sequence: '2' }, { sequence: '1' }], hasMore: false,
			});

			computation.compute = async () => personalResult('personal-note-4');
			const refresh = await runtime.request.requestRefresh('personal-resume', token(31));
			if (refresh.kind !== 'serve' || !refresh.generationPending) throw new Error('expected personal resume refresh batch');
			await runtime.generation.runUserFeedGeneration(refresh.requestedBatchId);
			await query(`UPDATE "hanami_user_feed_state" SET "mode" = 'common' WHERE "userId" = 'personal-resume'`);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume',
				cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '3' },
				scanLimit: 2,
			})).resolves.toMatchObject({
				kind: 'page',
				head: { mode: 'personalized', kind: 'personal', headBatchId: refresh.requestedBatchId, headSequence: '4' },
				entries: [{ sequence: '2' }, { sequence: '1' }],
			});

			await query(`UPDATE "hanami_user_feed_batch" SET "status" = 'obsolete' WHERE "id" = $1`, [initial.requestedBatchId]);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume',
				cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '3' },
				scanLimit: 2,
			})).resolves.toMatchObject({ kind: 'page', entries: [], lastScannedSequence: null, hasMore: false });

			await query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'personal-resume'`);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume', cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '3' }, scanLimit: 2,
			})).resolves.toEqual({ kind: 'cursorExpired' });
			await query(`UPDATE "user" SET "isHibernated" = FALSE WHERE "id" = 'personal-resume'`);

			await query(`UPDATE "hanami_user_feed_state" SET "earliestRetainedSequence" = 2 WHERE "userId" = 'personal-resume'`);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume', cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '1' }, scanLimit: 2,
			})).resolves.toEqual({ kind: 'cursorExpired' });

			await query(`UPDATE "hanami_user_feed_epoch" SET "retiredAt" = clock_timestamp()
				WHERE "userId" = 'personal-resume' AND "epochId" = $1`, [personalEpochId]);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'personal-resume', cursor: { kind: 'personal', feedEpochId: personalEpochId, sequence: '3' }, scanLimit: 2,
			})).resolves.toEqual({ kind: 'cursorExpired' });
		});
	}, 20_000);

	test('resumes common cursors after personal readiness and newer common publication without requiring the anchor', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'common-resume');
			const runtime = makeRuntime(schema, { idPrefix: 'cr' });
			const commonCursor = { kind: 'common' as const, feedEpochId: 'common-epoch-1', sequence: '3' };
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'common-resume', cursor: commonCursor, scanLimit: 1,
			})).resolves.toMatchObject({
				kind: 'page', head: { headBatchId: 'common-generation-1', headSequence: '3' },
				entries: [{ sequence: '2' }], hasMore: true,
			});

			const personal = await runtime.request.evaluateCursorless('common-resume');
			if (personal.kind !== 'serve' || !personal.generationPending) throw new Error('expected common resume personal batch');
			await runtime.generation.runUserFeedGeneration(personal.requestedBatchId);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'common-resume', cursor: commonCursor, scanLimit: 2,
			})).resolves.toMatchObject({ kind: 'page', entries: [{ sequence: '2' }, { sequence: '1' }] });

			await query(`INSERT INTO "hanami_common_generation"
				("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "generationFence")
				VALUES ('common-generation-2', 2, 'ready', '2026-08-20T00:10:00Z', '2026-08-20T00:10:01Z', 'test', 2)`);
			await query(`INSERT INTO "hanami_common_feed_entry"
				("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt")
				VALUES
				('2026-08-01', 'common-entry-4', 'common-epoch-1', 5, 'common-generation-2', 0, 'personal-note-3', 'globalPopular', '["globalPopular"]', '2026-08-20T00:10:00Z'),
				('2026-08-01', 'common-entry-5', 'common-epoch-1', 4, 'common-generation-2', 1, 'personal-note-4', 'trending', '["trending"]', '2026-08-20T00:10:00Z')`);
			await query(`UPDATE "hanami_common_feed_state"
				SET "latestReadyGenerationId" = 'common-generation-2', "latestSequence" = 5, "generationFence" = 2
				WHERE "singletonId" = 'singleton'`);
			await query(`DELETE FROM "hanami_common_feed_entry" WHERE "epochId" = 'common-epoch-1' AND "sequence" = 3`);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'common-resume', cursor: commonCursor, scanLimit: 2,
			})).resolves.toMatchObject({
				kind: 'page',
				head: { kind: 'common', headBatchId: 'common-generation-2', headSequence: '5' },
				entries: [{ sequence: '2' }, { sequence: '1' }],
				lastScannedSequence: '1', hasMore: false,
			});

			await query(`UPDATE "hanami_common_generation" SET "status" = 'obsolete' WHERE "id" = 'common-generation-1'`);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'common-resume', cursor: commonCursor, scanLimit: 2,
			})).resolves.toMatchObject({ kind: 'page', entries: [], lastScannedSequence: null, hasMore: false });

			await query(`UPDATE "hanami_common_feed_state" SET "earliestRetainedSequence" = 3 WHERE "singletonId" = 'singleton'`);
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'common-resume',
				cursor: { kind: 'common', feedEpochId: 'common-epoch-1', sequence: '2' },
				scanLimit: 2,
			})).resolves.toEqual({ kind: 'cursorExpired' });
			await expect(runtime.read.resumeReadyEntries({
				requesterUserId: 'common-resume',
				cursor: { kind: 'common', feedEpochId: 'old-common-epoch', sequence: '3' },
				scanLimit: 2,
			})).resolves.toEqual({ kind: 'cursorExpired' });
		});
	}, 20_000);

	test('enforces hard timeout without post-deadline terminal cleanup and scans stable common history with retention expiration', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'timeout-user');
			const computation = new Computation();
			computation.compute = async (input) => await new Promise<HanamiPersonalFeedComputationResult>((_resolve, reject) => {
				input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
			});
			const runtime = makeRuntime(schema, {
				computation,
				config: { hanamiGenerationWorkerTimeoutMs: 300, hanamiGenerationLeaseMs: 1_000 },
			});
			const requested = await runtime.request.evaluateCursorless('timeout-user');
			if (requested.kind !== 'serve' || !requested.generationPending) throw new Error('expected timeout batch');
			await expect(runtime.generation.runUserFeedGeneration(requested.requestedBatchId)).rejects.toThrow('worker timeout');
			const rows = await query<{ status: string; owner: string; pointer: string }>(`
				SELECT b."status" AS status, b."leaseOwner" AS owner, s."generatingBatchId" AS pointer
				FROM "hanami_user_feed_batch" b JOIN "hanami_user_feed_state" s ON s."userId" = b."userId"
				WHERE b."id" = $1
			`, [requested.requestedBatchId]);
			expect(rows).toEqual([{ status: 'generating', owner: expect.any(String), pointer: requested.requestedBatchId }]);

			const commonHead = { mode: 'common' as const, kind: 'common' as const, feedEpochId: 'common-epoch-1', headBatchId: 'common-generation-1', headSequence: '3' };
			const first = await runtime.read.scanReadyEntries({ requesterUserId: 'timeout-user', head: commonHead, beforeSequence: null, scanLimit: 2 });
			expect(first).toMatchObject({ kind: 'page', hasMore: true, lastScannedSequence: '2' });
			const second = await runtime.read.scanReadyEntries({ requesterUserId: 'timeout-user', head: commonHead, beforeSequence: '2', scanLimit: 2 });
			expect(second).toMatchObject({ kind: 'page', hasMore: false, lastScannedSequence: '1' });

			await query(`INSERT INTO "hanami_common_generation"
				("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "generationFence")
				VALUES ('common-generation-2', 2, 'ready', '2026-08-20T00:10:00Z', '2026-08-20T00:10:01Z', 'test', 2)`);
			await query(`UPDATE "hanami_common_feed_state" SET "latestReadyGenerationId" = 'common-generation-2', "updatedAt" = clock_timestamp()`);
			await expect(runtime.read.scanReadyEntries({ requesterUserId: 'timeout-user', head: commonHead, beforeSequence: '2', scanLimit: 2 }))
				.resolves.toMatchObject({ kind: 'page', lastScannedSequence: '1' });
			await query(`UPDATE "hanami_common_feed_state" SET "earliestRetainedSequence" = 3`);
			await expect(runtime.read.scanReadyEntries({ requesterUserId: 'timeout-user', head: commonHead, beforeSequence: '2', scanLimit: 2 }))
				.resolves.toEqual({ kind: 'cursorExpired' });
		});
	}, 20_000);

	test('linearizes personal scans with hibernation and common scans with retention updates across connections', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'read-race-user');
			const runtime = makeRuntime(schema, { idPrefix: 'lr' });
			const initial = await runtime.request.evaluateCursorless('read-race-user');
			if (initial.kind !== 'serve' || !initial.generationPending) throw new Error('expected read-race initial batch');
			await runtime.generation.runUserFeedGeneration(initial.requestedBatchId);
			const ready = await runtime.request.evaluateCursorless('read-race-user');
			if (ready.kind !== 'serve') throw new Error('expected read-race ready head');

			const hibernationWriter = makeDataSource(schema).createQueryRunner();
			await hibernationWriter.connect();
			await hibernationWriter.startTransaction();
			try {
				await hibernationWriter.query(`SELECT "id" FROM "user" WHERE "id" = 'read-race-user' FOR UPDATE`);
				await runtime.lifecycle.hibernateUsers(hibernationWriter.manager as never, ['read-race-user'], new Date());
				await hibernationWriter.query(`UPDATE "user" SET "isHibernated" = TRUE WHERE "id" = 'read-race-user'`);
				let personalSettled = false;
				const personalScan = runtime.read.scanReadyEntries({
					requesterUserId: 'read-race-user', head: ready.head, beforeSequence: null, scanLimit: 1,
				}).finally(() => { personalSettled = true; });
				let personalResumeSettled = false;
				const personalResume = runtime.read.resumeReadyEntries({
					requesterUserId: 'read-race-user',
					cursor: { kind: 'personal', feedEpochId: ready.head.feedEpochId, sequence: ready.head.headSequence },
					scanLimit: 1,
				}).finally(() => { personalResumeSettled = true; });
				await sleep(40);
				expect(personalSettled).toBe(false);
				expect(personalResumeSettled).toBe(false);
				await hibernationWriter.commitTransaction();
				expect(await personalScan).toEqual({ kind: 'cursorExpired' });
				expect(await personalResume).toEqual({ kind: 'cursorExpired' });
			} finally {
				if (hibernationWriter.isTransactionActive) await hibernationWriter.rollbackTransaction().catch(() => undefined);
				await hibernationWriter.release();
			}

			const commonHead = { mode: 'common' as const, kind: 'common' as const, feedEpochId: 'common-epoch-1', headBatchId: 'common-generation-1', headSequence: '3' };
			const retentionWriter = makeDataSource(schema).createQueryRunner();
			await retentionWriter.connect();
			await retentionWriter.startTransaction();
			try {
				await retentionWriter.query(`SELECT "singletonId" FROM "hanami_common_feed_state" WHERE "singletonId" = 'singleton' FOR UPDATE`);
				await retentionWriter.query(`UPDATE "hanami_common_feed_state" SET "earliestRetainedSequence" = 3 WHERE "singletonId" = 'singleton'`);
				let commonSettled = false;
				const commonScan = runtime.read.scanReadyEntries({
					requesterUserId: 'read-race-user', head: commonHead, beforeSequence: '2', scanLimit: 2,
				}).finally(() => { commonSettled = true; });
				let commonResumeSettled = false;
				const commonResume = runtime.read.resumeReadyEntries({
					requesterUserId: 'read-race-user',
					cursor: { kind: 'common', feedEpochId: commonHead.feedEpochId, sequence: '2' },
					scanLimit: 2,
				}).finally(() => { commonResumeSettled = true; });
				await sleep(40);
				expect(commonSettled).toBe(false);
				expect(commonResumeSettled).toBe(false);
				await retentionWriter.commitTransaction();
				expect(await commonScan).toEqual({ kind: 'cursorExpired' });
				expect(await commonResume).toEqual({ kind: 'cursorExpired' });
			} finally {
				if (retentionWriter.isTransactionActive) await retentionWriter.rollbackTransaction().catch(() => undefined);
				await retentionWriter.release();
			}
		});
	}, 20_000);

	test('reconciliation is independently bounded for active batches and expired refresh rows and reports remaining work', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const runtime = makeRuntime(schema, { idPrefix: 'rc' });
			for (const userId of ['bound-a', 'bound-b', 'bound-c']) {
				await seedUser(query, userId);
				const result = await runtime.request.requestRefresh(userId, token(userId.charCodeAt(userId.length - 1)));
				expect(result).toMatchObject({ kind: 'serve', generationPending: true });
			}
			await query(`UPDATE "hanami_user_feed_refresh" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second'`);
			const first = await runtime.generation.reconcileUserFeedGeneration(1);
			expect(first.batchIdsToEnqueue).toHaveLength(1);
			expect(first.deletedRefreshCount).toBe(1);
			expect(first.hasMore).toBe(true);
			const second = await runtime.generation.reconcileUserFeedGeneration(10);
			expect(second.batchIdsToEnqueue).toHaveLength(3);
			expect(second.deletedRefreshCount).toBe(2);
			expect(second.hasMore).toBe(false);
		});
	}, 20_000);
});

function createDigest(value: string): Buffer {
	return createHash('sha256').update(value, 'ascii').digest();
}
