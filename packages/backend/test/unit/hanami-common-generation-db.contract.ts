/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { jest } from '@jest/globals';
import type { Config } from '@/config.js';
import { HanamiCommonGenerationService } from '@/core/hanami/HanamiCommonGenerationService.js';
import { HanamiTimelinePartitionService } from '@/core/hanami/HanamiTimelinePartitionService.js';
import type {
	HanamiCommonComputationPort,
	HanamiCommonFeedBuildInput,
	HanamiCommonFeedMaterialization,
	HanamiCommonSourceBuildInput,
	HanamiCommonSourceBundle,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;
type DbQuery = <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;

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

const eventually = async (assertion: () => Promise<void>, timeoutMs = 2_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	do {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
			await sleep(20);
		}
	} while (Date.now() < deadline);
	throw lastError;
};

const isDbConnectionError = (error: unknown): boolean => {
	if (typeof error !== 'object' || error == null) return false;
	const candidate = error as { code?: string; message?: string };
	return candidate.code === 'ECONNREFUSED'
		|| candidate.code === 'ENOTFOUND'
		|| candidate.code === 'EHOSTUNREACH'
		|| candidate.code === 'ETIMEDOUT'
		|| /connection refused|could not connect/i.test(candidate.message ?? '');
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
			return runner;
		},
	};
};

const openSchemaClient = async (schema: string): Promise<Client> => {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
	await client.query(`SET TIME ZONE 'UTC'`);
	return client;
};

class FakeComputation implements HanamiCommonComputationPort {
	public readonly algorithmVersion = 'db-contract-v1';
	public buildInputs: HanamiCommonSourceBuildInput[] = [];
	public feedInputs: HanamiCommonFeedBuildInput[] = [];
	public build: (input: HanamiCommonSourceBuildInput) => Promise<HanamiCommonSourceBundle>;
	public materialize: (input: HanamiCommonFeedBuildInput) => HanamiCommonFeedMaterialization;

	constructor(bundle: HanamiCommonSourceBundle, materialization: HanamiCommonFeedMaterialization) {
		this.build = async () => bundle;
		this.materialize = () => materialization;
	}

	public async buildSourceBundle(input: HanamiCommonSourceBuildInput): Promise<HanamiCommonSourceBundle> {
		this.buildInputs.push(input);
		return await this.build(input);
	}

	public materializeFeed(input: HanamiCommonFeedBuildInput): HanamiCommonFeedMaterialization {
		this.feedInputs.push(input);
		return this.materialize(input);
	}
}

const sourceTimestamp = '2026-08-20T00:00:00.000Z';

const makeBundle = (suffix = ''): HanamiCommonSourceBundle => ({
	version: 1,
	capturedAt: sourceTimestamp,
	sourceAsOf: {
		version: 1,
		capturedAt: sourceTimestamp,
		featuredAt: sourceTimestamp,
		trendAt: sourceTimestamp,
		axisConfigAt: sourceTimestamp,
	},
	enabledAxes: ['globalPopular', 'trending', 'exploration'],
	candidates: {
		globalPopular: [{ noteId: `note-global${suffix}`, authorId: 'author-global', baseScore: 3, metadata: { source: 'global' } }],
		trending: [{ noteId: `note-trend${suffix}`, authorId: 'author-trend', baseScore: 2, metadata: { term: `term${suffix}` } }],
		exploration: [{ noteId: `note-explore${suffix}`, authorId: 'author-explore', baseScore: 1, metadata: { source: 'explore' } }],
	},
	trendSnapshot: {
		terms: [{ term: `term${suffix}`, score: 2, distinctAuthors: 1, representativeNoteIds: [`note-trend${suffix}`] }],
	},
});

const makeMaterialization = (suffix = ''): HanamiCommonFeedMaterialization => ({
	items: [
		{ noteId: `note-global${suffix}`, authorId: 'author-global', source: 'globalPopular', sources: ['globalPopular'] },
		{ noteId: `note-trend${suffix}`, authorId: 'author-trend', source: 'trending', sources: ['trending'] },
		{ noteId: `note-explore${suffix}`, authorId: 'author-explore', source: 'exploration', sources: ['exploration'] },
	],
	segmentLengths: [3],
});

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
	hanamiCommonGenerationIntervalMs: 600_000,
	hanamiGenerationWorkerTimeoutMs: 3_000,
	hanamiGenerationLeaseMs: 5_000,
	...overrides,
} as Config);

const makeIdService = (prefix: string) => {
	let sequence = 0;
	return {
		gen: (): string => `${prefix}${String(++sequence).padStart(20, '0')}`,
	};
};

type RuntimeOptions = {
	prefix?: string;
	config?: Partial<Config>;
	computation?: FakeComputation;
	partition?: { ensureMonthAvailable(date: Date): Promise<void> };
};

const makeRuntime = (schema: string, options: RuntimeOptions = {}) => {
	const dataSource = makeDataSource(schema);
	const computation = options.computation ?? new FakeComputation(makeBundle(), makeMaterialization());
	const partition = options.partition ?? new HanamiTimelinePartitionService(dataSource as never);
	const safety = {
		filterCommonEligibleNotes: async (noteIds: readonly string[]): Promise<ReadonlyMap<string, string>> => {
			if (noteIds.length === 0) return new Map();
			const rows = await dataSource.query<{ id: string }>(`SELECT "id" FROM "note" WHERE "id" = ANY($1::varchar[])`, [noteIds]);
			return new Map(rows.map((row) => [row.id, `author:${row.id}`]));
		},
	};
	const service = new HanamiCommonGenerationService(
		dataSource as never,
		makeConfig(options.config),
		makeIdService(options.prefix ?? 'id') as never,
		partition as never,
		safety as never,
		computation,
	);
	return { service, computation, partition, dataSource };
};

const insertNotes = async (query: DbQuery, noteIds: string[]): Promise<void> => {
	if (noteIds.length === 0) return;
	await query(`INSERT INTO "note" ("id") SELECT input.id FROM unnest($1::varchar[]) AS input(id) ON CONFLICT ("id") DO NOTHING`, [noteIds]);
};

const withMigratedSchema = async (run: (context: { schema: string; query: DbQuery }) => Promise<void>): Promise<void> => {
	const schema = `hanami_common_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const schemaName = quoteIdent(schema);
	const client = new Client({ connectionString: databaseUrl });
	const query: DbQuery = async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
		return (await client.query<T>(sql, values)).rows;
	};

	try {
		await client.connect();
		await query(`CREATE SCHEMA ${schemaName}`);
		await query(`SET search_path TO ${schemaName}, public`);
		await query(`SET TIME ZONE 'UTC'`);
		await query(`CREATE TABLE "user" ("id" character varying(32) NOT NULL PRIMARY KEY)`);
		await query(`CREATE TABLE "note" ("id" character varying(32) NOT NULL PRIMARY KEY)`);
		await query(`CREATE TABLE "hanami_recommendation_event" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"userId" character varying(32) NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"eventType" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL
		)`);
		await new HanamiPersistedTimelinePhase11787097600000().up({ query } as never);
		await run({ schema, query });
	} catch (error) {
		if (isDbConnectionError(error)) {
			console.warn('PostgreSQL is not reachable for the Hanami common-generation DB contract suite.');
		}
		throw error;
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

describe('Hanami common generation PostgreSQL contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the Hanami common-generation DB contract suite.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('bootstraps the nullable pre-seed singleton, rejects impossible lifecycle shapes, and serializes requests', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const versionRows = await query<{ server_version: string }>(`SHOW server_version`);
			expect(versionRows[0]!.server_version).toMatch(/^18\./);
			const { service } = makeRuntime(schema, { prefix: 'rq' });

			expect(await service.getLatestReadyCommonHead()).toBeNull();
			const requests = await Promise.all(Array.from({ length: 8 }, () => service.requestCommonGeneration('scheduled')));
			expect(requests.filter((result) => result.kind === 'dispatch')).toHaveLength(1);
			expect(requests.filter((result) => result.kind === 'noop' && result.reason === 'active')).toHaveLength(7);

			const stateRows = await query<{
				epoch_id: string | null;
				latest_sequence: string;
				earliest_sequence: string;
				ready_id: string | null;
				generating_id: string | null;
				owner: string | null;
				expires_at: Date | null;
				fence: string;
			}>(`SELECT "epochId" AS epoch_id,
				"latestSequence"::text AS latest_sequence,
				"earliestRetainedSequence"::text AS earliest_sequence,
				"latestReadyGenerationId" AS ready_id,
				"generatingGenerationId" AS generating_id,
				"generationLeaseOwner" AS owner,
				"generationLeaseExpiresAt" AS expires_at,
				"generationFence"::text AS fence
				FROM "hanami_common_feed_state"`);
			expect(stateRows).toEqual([{
				epoch_id: null,
				latest_sequence: '0',
				earliest_sequence: '0',
				ready_id: null,
				generating_id: expect.any(String),
				owner: null,
				expires_at: null,
				fence: '0',
			}]);
			expect(await service.findDispatchableCommonGeneration()).toEqual({
				generationId: stateRows[0]!.generating_id,
				reason: 'pending',
			});

			await expect(query(`UPDATE "hanami_common_feed_state" SET "generationLeaseOwner" = 'orphan-owner'`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_common_feed_state" SET "epochId" = 'orphan-epoch'`)).rejects.toThrow();

			const generationId = stateRows[0]!.generating_id!;
			await query(`UPDATE "hanami_common_generation" SET "status" = 'failed', "finishedAt" = clock_timestamp() WHERE "id" = $1`, [generationId]);
			await query(`UPDATE "hanami_trend_snapshot" SET "status" = 'failed' WHERE "commonGenerationId" = $1`, [generationId]);
			await query(`UPDATE "hanami_common_feed_state" SET "generatingGenerationId" = NULL, "generationLeaseOwner" = NULL, "generationLeaseExpiresAt" = NULL`);

			expect(await service.requestCommonGeneration('scheduled')).toEqual({ kind: 'noop', reason: 'notDue' });
			expect((await service.requestCommonGeneration('seed')).kind).toBe('dispatch');
			const counts = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_common_generation"`);
			expect(counts[0]!.count).toBe('2');
		});
	});

	test('allows the next UTC interval bucket despite processing jitter and rejects a duplicate in that bucket', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const clockRows = await query<{ now_ms: string }>(`
				SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint::text AS now_ms
			`);
			const nowMs = Number(clockRows[0]!.now_ms);
			let intervalMs: number | undefined;
			for (let candidate = 120_000; candidate <= 240_000; candidate++) {
				if (candidate - (nowMs % candidate) > 60_000) {
					intervalMs = candidate;
					break;
				}
			}
			if (intervalMs == null) throw new Error('failed to select a stable test interval bucket');

			const runtime = makeRuntime(schema, {
				prefix: 'bu',
				config: { hanamiCommonGenerationIntervalMs: intervalMs },
			});
			const previous = await runtime.service.requestCommonGeneration('scheduled');
			if (previous.kind !== 'dispatch') throw new Error('expected initial bucket dispatch');

			const currentBucket = Math.floor(nowMs / intervalMs);
			const currentOffset = nowMs % intervalMs;
			const previousStartedAt = new Date(((currentBucket - 1) * intervalMs) + currentOffset + 5_000).toISOString();
			await query(`UPDATE "hanami_common_generation"
				SET "status" = 'failed', "finishedAt" = clock_timestamp(), "startedAt" = $2::timestamptz
				WHERE "id" = $1`, [previous.generationId, previousStartedAt]);
			await query(`UPDATE "hanami_trend_snapshot" SET "status" = 'failed' WHERE "commonGenerationId" = $1`, [previous.generationId]);
			await query(`UPDATE "hanami_common_feed_state"
				SET "generatingGenerationId" = NULL, "generationLeaseOwner" = NULL, "generationLeaseExpiresAt" = NULL`);

			const next = await runtime.service.requestCommonGeneration('scheduled');
			expect(next.kind).toBe('dispatch');
			if (next.kind !== 'dispatch') throw new Error('expected next bucket dispatch');
			await query(`UPDATE "hanami_common_generation" SET "status" = 'failed', "finishedAt" = clock_timestamp() WHERE "id" = $1`, [next.generationId]);
			await query(`UPDATE "hanami_trend_snapshot" SET "status" = 'failed' WHERE "commonGenerationId" = $1`, [next.generationId]);
			await query(`UPDATE "hanami_common_feed_state"
				SET "generatingGenerationId" = NULL, "generationLeaseOwner" = NULL, "generationLeaseExpiresAt" = NULL`);

			await expect(runtime.service.requestCommonGeneration('scheduled')).resolves.toEqual({ kind: 'noop', reason: 'notDue' });
		});
	});

	test('publishes first and later sequence ranges atomically while preserving exact bigint values and epoch', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, [
				'note-global', 'note-trend', 'note-explore',
				'note-global-2', 'note-trend-2', 'note-explore-2',
			]);
			const firstComputation = new FakeComputation(makeBundle(), makeMaterialization());
			const partitionDataSource = makeDataSource(schema);
			const realPartition = new HanamiTimelinePartitionService(partitionDataSource as never);
			let partitionObservedBeforeWrites = false;
			const first = makeRuntime(schema, {
				prefix: 'pa',
				computation: firstComputation,
				partition: {
					ensureMonthAvailable: async (date: Date) => {
						const lockProbe = await partitionDataSource.query<{ singleton_id: string }>(`
							SELECT "singletonId" AS singleton_id FROM "hanami_common_feed_state" FOR UPDATE NOWAIT
						`);
						const candidateCount = await partitionDataSource.query<{ count: string }>(`
							SELECT COUNT(*)::text AS count FROM "hanami_common_candidate"
						`);
						expect(lockProbe).toEqual([{ singleton_id: 'singleton' }]);
						expect(candidateCount[0]!.count).toBe('0');
						partitionObservedBeforeWrites = true;
						await realPartition.ensureMonthAvailable(date);
					},
				},
			});
			const firstRequest = await first.service.requestCommonGeneration('seed');
			expect(firstRequest.kind).toBe('dispatch');
			if (firstRequest.kind !== 'dispatch') throw new Error('expected first dispatch');

			await expect(first.service.runCommonGeneration(firstRequest.generationId)).resolves.toEqual({
				kind: 'published',
				generationId: firstRequest.generationId,
				generationFence: '1',
				itemCount: 3,
			});
			expect(partitionObservedBeforeWrites).toBe(true);
			const firstHead = await first.service.getLatestReadyCommonHead();
			expect(firstHead).toEqual({
				epochId: expect.any(String),
				generationId: firstRequest.generationId,
				generationOrdinal: '1',
				generationFence: '1',
				latestSequence: '3',
				earliestRetainedSequence: '1',
			});
			const epochId = firstHead!.epochId;

			const firstEntries = await query<{ position: number; sequence: string; exact_timestamp: boolean }>(`
				SELECT e."position" AS position, e."sequence"::text AS sequence,
					(e."generatedAt" = g."startedAt") AS exact_timestamp
				FROM "hanami_common_feed_entry" e
				JOIN "hanami_common_generation" g ON g."id" = e."generationId"
				WHERE e."generationId" = $1 ORDER BY e."position"
			`, [firstRequest.generationId]);
			expect(firstEntries.map((row) => row.sequence)).toEqual(['3', '2', '1']);
			expect(firstEntries.every((row) => row.exact_timestamp)).toBe(true);
			expect(firstComputation.buildInputs[0]!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

			const candidates = await first.service.loadReadyCommonCandidates(firstRequest.generationId);
			expect(candidates.map((candidate) => [candidate.axis, candidate.rank, candidate.noteId])).toEqual([
				['globalPopular', '0', 'note-global'],
				['trending', '0', 'note-trend'],
				['exploration', '0', 'note-explore'],
			]);
			await expect(first.service.runCommonGeneration(firstRequest.generationId)).resolves.toEqual({
				kind: 'alreadyReady',
				generationId: firstRequest.generationId,
			});

			const durableFirstCount = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "hanami_common_feed_entry"`);
			expect(durableFirstCount[0]!.count).toBe('3');
			await query(`UPDATE "hanami_common_feed_state" SET "latestSequence" = '9007199254740993'::bigint WHERE "singletonId" = 'singleton'`);
			await query(`UPDATE "hanami_common_generation" SET "ordinal" = '9007199254740993'::bigint, "startedAt" = clock_timestamp() - INTERVAL '20 minutes' WHERE "id" = $1`, [firstRequest.generationId]);

			const secondComputation = new FakeComputation(makeBundle('-2'), makeMaterialization('-2'));
			const second = makeRuntime(schema, { prefix: 'pb', computation: secondComputation });
			const secondRequest = await second.service.requestCommonGeneration('scheduled');
			expect(secondRequest.kind).toBe('dispatch');
			if (secondRequest.kind !== 'dispatch') throw new Error('expected second dispatch');
			await expect(second.service.runCommonGeneration(secondRequest.generationId)).resolves.toMatchObject({
				kind: 'published',
				generationId: secondRequest.generationId,
				generationFence: '2',
				itemCount: 3,
			});

			const secondEntries = await query<{ position: number; sequence: string; epoch_id: string }>(`
				SELECT "position" AS position, "sequence"::text AS sequence, "epochId" AS epoch_id
				FROM "hanami_common_feed_entry" WHERE "generationId" = $1 ORDER BY "position"
			`, [secondRequest.generationId]);
			expect(secondEntries.map((row) => row.sequence)).toEqual([
				'9007199254740996',
				'9007199254740995',
				'9007199254740994',
			]);
			expect(new Set(secondEntries.map((row) => row.epoch_id))).toEqual(new Set([epochId]));

			const secondHead = await second.service.getLatestReadyCommonHead();
			expect(secondHead).toEqual({
				epochId,
				generationId: secondRequest.generationId,
				generationOrdinal: '9007199254740994',
				generationFence: '2',
				latestSequence: '9007199254740996',
				earliestRetainedSequence: '1',
			});
			const trendRows = await query<{ entries: string; representatives: string; snapshot_status: string; generation_status: string }>(`
				SELECT
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_entry" e WHERE e."snapshotId" = t."id") AS entries,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_representative_note" r WHERE r."snapshotId" = t."id") AS representatives,
					t."status" AS snapshot_status,
					g."status" AS generation_status
				FROM "hanami_trend_snapshot" t JOIN "hanami_common_generation" g ON g."id" = t."commonGenerationId"
				WHERE t."commonGenerationId" = $1
			`, [secondRequest.generationId]);
			expect(trendRows).toEqual([{ entries: '1', representatives: '1', snapshot_status: 'ready', generation_status: 'ready' }]);
		});
	});

	test('uses exact inclusive lower and exclusive upper 30-minute history boundaries across a UTC month rollover', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const noteIds = ['history-lower', 'history-before', 'history-current', 'history-upper', 'note-global', 'note-trend', 'note-explore'];
			await insertNotes(query, noteIds);
			await query(`INSERT INTO "hanami_common_generation" ("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "sourceAsOf", "generationFence") VALUES
				('history-g1', 1, 'ready', '2026-08-31T23:40:00Z', '2026-08-31T23:40:01Z', 'history', '{}'::jsonb, 0),
				('history-g2', 2, 'ready', '2026-08-31T23:39:59.999Z', '2026-08-31T23:40:01Z', 'history', '{}'::jsonb, 0),
				('history-g3', 3, 'ready', '2026-09-01T00:00:00Z', '2026-09-01T00:00:01Z', 'history', '{}'::jsonb, 0),
				('history-g4', 4, 'ready', '2026-09-01T00:10:00Z', '2026-09-01T00:10:01Z', 'history', '{}'::jsonb, 0)`);
			await query(`INSERT INTO "hanami_common_feed_entry" ("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt") VALUES
				('2026-08-01', 'history-e1', 'history-epoch', 1, 'history-g1', 0, 'history-lower', 'globalPopular', '["globalPopular"]'::jsonb, '2026-08-31T23:40:00Z'),
				('2026-08-01', 'history-e2', 'history-epoch', 2, 'history-g2', 0, 'history-before', 'globalPopular', '["globalPopular"]'::jsonb, '2026-08-31T23:39:59.999Z'),
				('2026-09-01', 'history-e3', 'history-epoch', 3, 'history-g3', 0, 'history-current', 'globalPopular', '["globalPopular"]'::jsonb, '2026-09-01T00:00:00Z'),
				('2026-09-01', 'history-e4', 'history-epoch', 4, 'history-g4', 0, 'history-upper', 'globalPopular', '["globalPopular"]'::jsonb, '2026-09-01T00:10:00Z')`);

			const computation = new FakeComputation(makeBundle(), makeMaterialization());
			const { service } = makeRuntime(schema, { prefix: 'hb', computation });
			const request = await service.requestCommonGeneration('seed');
			expect(request.kind).toBe('dispatch');
			if (request.kind !== 'dispatch') throw new Error('expected boundary dispatch');
			await query(`UPDATE "hanami_common_generation" SET "startedAt" = '2026-09-01T00:10:00Z' WHERE "id" = $1`, [request.generationId]);
			await query(`UPDATE "hanami_trend_snapshot" SET "generatedAt" = '2026-09-01T00:10:00Z' WHERE "commonGenerationId" = $1`, [request.generationId]);

			await expect(service.runCommonGeneration(request.generationId)).resolves.toMatchObject({ kind: 'published' });
			expect(computation.feedInputs).toHaveLength(1);
			expect([...computation.feedInputs[0]!.recentCommonNoteIds].sort()).toEqual(['history-current', 'history-lower']);
		});
	});

	test('derives staging and final guards from PostgreSQL under deliberate app wall-clock skew', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const runtime = makeRuntime(schema, { prefix: 'sk' });
			const request = await runtime.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected clock-skew dispatch');
			const dateNow = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('1999-01-01T00:00:00.000Z'));

			try {
				await expect(runtime.service.runCommonGeneration(request.generationId)).resolves.toMatchObject({
					kind: 'published',
					generationFence: '1',
				});
			} finally {
				dateNow.mockRestore();
			}

			const rows = await query<{ generation_status: string; snapshot_status: string; entries: string }>(`
				SELECT g."status" AS generation_status, t."status" AS snapshot_status,
					(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS entries
				FROM "hanami_common_generation" g
				JOIN "hanami_trend_snapshot" t ON t."commonGenerationId" = g."id"
				WHERE g."id" = $1
			`, [request.generationId]);
			expect(rows).toEqual([{ generation_status: 'ready', snapshot_status: 'ready', entries: '3' }]);
		});
	});

	test('does not commit late future partition DDL or generation output after the worker deadline', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const baseline = makeRuntime(schema, { prefix: 'pd' });
			const baselineRequest = await baseline.service.requestCommonGeneration('seed');
			if (baselineRequest.kind !== 'dispatch') throw new Error('expected partition-deadline baseline dispatch');
			await expect(baseline.service.runCommonGeneration(baselineRequest.generationId)).resolves.toMatchObject({ kind: 'published' });
			const readyHead = await baseline.service.getLatestReadyCommonHead();
			expect(readyHead).not.toBeNull();

			await query(`UPDATE "hanami_common_generation" SET "startedAt" = clock_timestamp() - INTERVAL '20 minutes' WHERE "id" = $1`, [baselineRequest.generationId]);
			const delayed = makeRuntime(schema, {
				prefix: 'pe',
				config: { hanamiGenerationWorkerTimeoutMs: 700, hanamiGenerationLeaseMs: 2_000 },
			});
			const delayedRequest = await delayed.service.requestCommonGeneration('scheduled');
			if (delayedRequest.kind !== 'dispatch') throw new Error('expected partition-deadline delayed dispatch');
			await query(`UPDATE "hanami_common_generation" SET "startedAt" = '2026-10-01T00:00:00Z' WHERE "id" = $1`, [delayedRequest.generationId]);
			await query(`UPDATE "hanami_trend_snapshot" SET "generatedAt" = '2026-10-01T00:00:00Z' WHERE "commonGenerationId" = $1`, [delayedRequest.generationId]);

			const holder = await openSchemaClient(schema);
			try {
				await holder.query('BEGIN');
				await holder.query(`LOCK TABLE "hanami_common_candidate" IN ACCESS EXCLUSIVE MODE`);

				const startedAt = Date.now();
				await expect(delayed.service.runCommonGeneration(delayedRequest.generationId)).rejects.toBeInstanceOf(Error);
				expect(Date.now() - startedAt).toBeLessThan(2_000);
			} finally {
				await holder.query('ROLLBACK').catch(() => undefined);
				await holder.end().catch(() => undefined);
			}

			// Releasing the blocker must not let a detached partition continuation create or commit DDL.
			await sleep(750);
			const futurePartitions = await query<{ relname: string }>(`
				SELECT c.relname
				FROM pg_catalog.pg_class c
				JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
			`, [schema, [
				'hanami_common_candidate_202610',
				'hanami_common_feed_entry_202610',
				'hanami_trend_snapshot_entry_202610',
				'hanami_trend_snapshot_representative_note_202610',
			]]);
			expect(futurePartitions).toEqual([]);

			const rows = await query<{
				generation_status: string;
				snapshot_status: string;
				ready_head: string;
				candidates: string;
				feed_entries: string;
				trend_entries: string;
				representatives: string;
			}>(`
				SELECT g."status" AS generation_status, t."status" AS snapshot_status,
					s."latestReadyGenerationId" AS ready_head,
					(SELECT COUNT(*)::text FROM "hanami_common_candidate" c WHERE c."generationId" = g."id") AS candidates,
					(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS feed_entries,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_entry" e WHERE e."snapshotId" = t."id") AS trend_entries,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_representative_note" r WHERE r."snapshotId" = t."id") AS representatives
				FROM "hanami_common_generation" g
				JOIN "hanami_trend_snapshot" t ON t."commonGenerationId" = g."id"
				CROSS JOIN "hanami_common_feed_state" s
				WHERE g."id" = $1
			`, [delayedRequest.generationId]);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.generation_status).not.toBe('ready');
			expect(rows[0]!.snapshot_status).not.toBe('ready');
			expect(rows[0]!.ready_head).toBe(readyHead!.generationId);
			expect(rows[0]!.candidates).toBe('0');
			expect(rows[0]!.feed_entries).toBe('0');
			expect(rows[0]!.trend_entries).toBe('0');
			expect(rows[0]!.representatives).toBe('0');
			expect(await baseline.service.getLatestReadyCommonHead()).toEqual(readyHead);
		});
	}, 15_000);

	test('claims once, heartbeats only a live tuple, then reclaims the same generation with a higher fence after expiry', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const computation = new FakeComputation(makeBundle(), makeMaterialization());
			const enteredBuild = deferred<void>();
			const neverBuild = deferred<HanamiCommonSourceBundle>();
			computation.build = async () => {
				enteredBuild.resolve();
				return await neverBuild.promise;
			};
			const runtime = makeRuntime(schema, {
				prefix: 'cl',
				computation,
				config: { hanamiGenerationWorkerTimeoutMs: 1_500, hanamiGenerationLeaseMs: 2_400 },
			});
			const request = await runtime.service.requestCommonGeneration('seed');
			expect(request.kind).toBe('dispatch');
			if (request.kind !== 'dispatch') throw new Error('expected claim dispatch');

			const firstRun = runtime.service.runCommonGeneration(request.generationId);
			await enteredBuild.promise;
			const firstClaimRows = await query<{ fence: string; owner: string; expires_at: Date }>(`
				SELECT "generationFence"::text AS fence, "generationLeaseOwner" AS owner,
					"generationLeaseExpiresAt" AS expires_at
				FROM "hanami_common_feed_state"
			`);
			expect(firstClaimRows[0]!.fence).toBe('1');
			expect(firstClaimRows[0]!.owner).toEqual(expect.any(String));
			await expect(runtime.service.runCommonGeneration(request.generationId)).resolves.toEqual({
				kind: 'notClaimed',
				generationId: request.generationId,
				reason: 'leased',
			});

			await sleep(850);
			const heartbeatRows = await query<{ expires_at: Date }>(`SELECT "generationLeaseExpiresAt" AS expires_at FROM "hanami_common_feed_state"`);
			expect(heartbeatRows[0]!.expires_at.getTime()).toBeGreaterThan(firstClaimRows[0]!.expires_at.getTime());
			await query(`UPDATE "hanami_common_feed_state" SET "generationLeaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'`);
			expect(await runtime.service.findDispatchableCommonGeneration()).toEqual({ generationId: request.generationId, reason: 'leaseExpired' });

			await expect(firstRun).rejects.toThrow('worker timeout');
			const expiredRows = await query<{ status: string; fence: string; owner: string | null }>(`
				SELECT g."status" AS status, s."generationFence"::text AS fence, s."generationLeaseOwner" AS owner
				FROM "hanami_common_feed_state" s JOIN "hanami_common_generation" g ON g."id" = s."generatingGenerationId"
			`);
			expect(expiredRows).toEqual([{ status: 'generating', fence: '1', owner: expect.any(String) }]);

			computation.build = async () => makeBundle();
			await expect(runtime.service.runCommonGeneration(request.generationId)).resolves.toEqual({
				kind: 'published',
				generationId: request.generationId,
				generationFence: '2',
				itemCount: 3,
			});
			const readyRows = await query<{ generation_fence: string; state_fence: string; pointer: string | null }>(`
				SELECT g."generationFence"::text AS generation_fence,
					s."generationFence"::text AS state_fence,
					s."generatingGenerationId" AS pointer
				FROM "hanami_common_generation" g CROSS JOIN "hanami_common_feed_state" s
				WHERE g."id" = $1
			`, [request.generationId]);
			expect(readyRows).toEqual([{ generation_fence: '2', state_fence: '2', pointer: null }]);
		});
	}, 15_000);

	test('times out a blocked claim within the absolute budget and leaves it dispatchable', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const blocked = makeRuntime(schema, {
				prefix: 'bc',
				config: { hanamiGenerationWorkerTimeoutMs: 300, hanamiGenerationLeaseMs: 2_000 },
			});
			const request = await blocked.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected blocked-claim dispatch');

			const holder = await openSchemaClient(schema);
			try {
				await holder.query('BEGIN');
				await holder.query(`SELECT "singletonId" FROM "hanami_common_feed_state" WHERE "singletonId" = 'singleton' FOR UPDATE`);

				const startedAt = Date.now();
				await expect(blocked.service.runCommonGeneration(request.generationId)).rejects.toBeInstanceOf(Error);
				const elapsed = Date.now() - startedAt;
				expect(elapsed).toBeGreaterThanOrEqual(150);
				expect(elapsed).toBeLessThan(2_000);
				expect(blocked.computation.buildInputs).toHaveLength(0);

				const blockedRows = await query<{
					status: string;
					owner: string | null;
					fence: string;
					feed_entries: string;
				}>(`
					SELECT g."status" AS status, s."generationLeaseOwner" AS owner,
						s."generationFence"::text AS fence,
						(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS feed_entries
					FROM "hanami_common_generation" g CROSS JOIN "hanami_common_feed_state" s
					WHERE g."id" = $1
				`, [request.generationId]);
				expect(blockedRows).toEqual([{ status: 'pending', owner: null, fence: '0', feed_entries: '0' }]);
			} finally {
				await holder.query('ROLLBACK').catch(() => undefined);
				await holder.end().catch(() => undefined);
			}

			await eventually(async () => {
				await expect(query(`SELECT "singletonId" FROM "hanami_common_feed_state" FOR UPDATE NOWAIT`)).resolves.toHaveLength(1);
			});
			const recovery = makeRuntime(schema, {
				prefix: 'bd',
				config: { hanamiGenerationWorkerTimeoutMs: 3_000, hanamiGenerationLeaseMs: 5_000 },
			});
			expect(await recovery.service.findDispatchableCommonGeneration()).toEqual({
				generationId: request.generationId,
				reason: 'pending',
			});
			await expect(recovery.service.runCommonGeneration(request.generationId)).resolves.toMatchObject({
				kind: 'published',
				generationFence: '1',
			});
		});
	}, 15_000);

	test('rolls back blocked candidate staging at the deadline and permits expired-lease reclaim', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const blocked = makeRuntime(schema, {
				prefix: 'bs',
				config: { hanamiGenerationWorkerTimeoutMs: 1_500, hanamiGenerationLeaseMs: 500 },
			});
			const request = await blocked.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected blocked-staging dispatch');

			const holder = await openSchemaClient(schema);
			try {
				await holder.query('BEGIN');
				await holder.query(`SELECT "id" FROM "note" WHERE "id" = 'note-global' FOR UPDATE`);

				const startedAt = Date.now();
				await expect(blocked.service.runCommonGeneration(request.generationId)).rejects.toThrow(/timeout/i);
				const elapsed = Date.now() - startedAt;
				expect(elapsed).toBeGreaterThanOrEqual(750);
				expect(elapsed).toBeLessThan(3_000);

				const stagedRows = await query<{
					status: string;
					fence: string;
					lease_expired: boolean;
					candidates: string;
					feed_entries: string;
				}>(`
					SELECT g."status" AS status, s."generationFence"::text AS fence,
						s."generationLeaseExpiresAt" <= clock_timestamp() AS lease_expired,
						(SELECT COUNT(*)::text FROM "hanami_common_candidate" c WHERE c."generationId" = g."id") AS candidates,
						(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS feed_entries
					FROM "hanami_common_generation" g CROSS JOIN "hanami_common_feed_state" s
					WHERE g."id" = $1
				`, [request.generationId]);
				expect(stagedRows).toEqual([{
					status: 'generating',
					fence: '1',
					lease_expired: true,
					candidates: '0',
					feed_entries: '0',
				}]);
				await eventually(async () => {
					await expect(query(`SELECT "singletonId" FROM "hanami_common_feed_state" FOR UPDATE NOWAIT`)).resolves.toHaveLength(1);
				});
				expect(await blocked.service.findDispatchableCommonGeneration()).toEqual({
					generationId: request.generationId,
					reason: 'leaseExpired',
				});
			} finally {
				await holder.query('ROLLBACK').catch(() => undefined);
				await holder.end().catch(() => undefined);
			}

			const recovery = makeRuntime(schema, {
				prefix: 'bt',
				config: { hanamiGenerationWorkerTimeoutMs: 3_000, hanamiGenerationLeaseMs: 5_000 },
			});
			await expect(recovery.service.runCommonGeneration(request.generationId)).resolves.toMatchObject({
				kind: 'published',
				generationFence: '2',
			});
		});
	}, 15_000);

	test('keeps old-fence candidates isolated when a staged worker is reclaimed', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const oldBundle = makeBundle();
			const newBundle: HanamiCommonSourceBundle = {
				...makeBundle(),
				candidates: {
					...makeBundle().candidates,
					globalPopular: [{ ...makeBundle().candidates.globalPopular[0]!, baseScore: 99 }],
				},
			};
			const oldComputation = new FakeComputation(oldBundle, makeMaterialization());
			const oldRuntime = makeRuntime(schema, { prefix: 'oa', computation: oldComputation });
			const request = await oldRuntime.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected old-fence dispatch');

			type PublishHook = (...args: unknown[]) => Promise<unknown>;
			const publication = oldRuntime.service as unknown as { publishGeneration: PublishHook };
			const originalPublish = publication.publishGeneration.bind(oldRuntime.service);
			const staged = deferred<void>();
			const releasePublish = deferred<void>();
			publication.publishGeneration = async (...args: unknown[]): Promise<unknown> => {
				staged.resolve();
				await releasePublish.promise;
				return await originalPublish(...args);
			};

			const oldRun = oldRuntime.service.runCommonGeneration(request.generationId);
			await staged.promise;
			const oldRows = await query<{ count: string }>(`
				SELECT COUNT(*)::text AS count FROM "hanami_common_candidate"
				WHERE "generationId" = $1 AND "generationFence" = 1
			`, [request.generationId]);
			expect(oldRows[0]!.count).toBe('3');
			await query(`UPDATE "hanami_common_feed_state" SET "generationLeaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'`);

			const newComputation = new FakeComputation(newBundle, makeMaterialization());
			const newRuntime = makeRuntime(schema, { prefix: 'ob', computation: newComputation });
			await expect(newRuntime.service.runCommonGeneration(request.generationId)).resolves.toMatchObject({
				kind: 'published',
				generationFence: '2',
			});
			releasePublish.resolve();
			await expect(oldRun).resolves.toEqual({ kind: 'stale', generationId: request.generationId });
			await expect(newRuntime.service.runCommonGeneration(request.generationId)).resolves.toEqual({
				kind: 'alreadyReady',
				generationId: request.generationId,
			});

			const fenceRows = await query<{ fence: string; count: string }>(`
				SELECT "generationFence"::text AS fence, COUNT(*)::text AS count
				FROM "hanami_common_candidate" WHERE "generationId" = $1
				GROUP BY "generationFence" ORDER BY "generationFence"
			`, [request.generationId]);
			expect(fenceRows).toEqual([{ fence: '1', count: '3' }, { fence: '2', count: '3' }]);
			const visible = await newRuntime.service.loadReadyCommonCandidates(request.generationId);
			expect(visible).toHaveLength(3);
			expect(visible.find((candidate) => candidate.axis === 'globalPopular')?.baseScore).toBe(99);
		});
	});

	test('does not let a stale source failure clear a reclaimed owner', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const oldComputation = new FakeComputation(makeBundle(), makeMaterialization());
			const oldEntered = deferred<void>();
			const oldSource = deferred<HanamiCommonSourceBundle>();
			oldComputation.build = async () => {
				oldEntered.resolve();
				return await oldSource.promise;
			};
			const oldRuntime = makeRuntime(schema, { prefix: 'sf', computation: oldComputation });
			const request = await oldRuntime.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected stale-failure dispatch');
			const oldRun = oldRuntime.service.runCommonGeneration(request.generationId);
			await oldEntered.promise;
			await query(`UPDATE "hanami_common_feed_state" SET "generationLeaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'`);

			const newComputation = new FakeComputation(makeBundle(), makeMaterialization());
			const newEntered = deferred<void>();
			const newSource = deferred<HanamiCommonSourceBundle>();
			newComputation.build = async () => {
				newEntered.resolve();
				return await newSource.promise;
			};
			const newRuntime = makeRuntime(schema, { prefix: 'sg', computation: newComputation });
			const newRun = newRuntime.service.runCommonGeneration(request.generationId);
			await newEntered.promise;
			oldSource.reject(new Error('old source failed'));
			await expect(oldRun).resolves.toEqual({ kind: 'stale', generationId: request.generationId });

			const ownedRows = await query<{ status: string; fence: string; pointer: string }>(`
				SELECT g."status" AS status, s."generationFence"::text AS fence, s."generatingGenerationId" AS pointer
				FROM "hanami_common_feed_state" s JOIN "hanami_common_generation" g ON g."id" = s."generatingGenerationId"
			`);
			expect(ownedRows).toEqual([{ status: 'generating', fence: '2', pointer: request.generationId }]);
			newSource.resolve(makeBundle());
			await expect(newRun).resolves.toMatchObject({ kind: 'published', generationFence: '2' });
		});
	});

	test('does not let a stale publisher mutate a newly reclaimed live owner', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const oldRuntime = makeRuntime(schema, { prefix: 'sp' });
			const request = await oldRuntime.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected stale-publisher dispatch');

			type PublishHook = (...args: unknown[]) => Promise<unknown>;
			const publication = oldRuntime.service as unknown as { publishGeneration: PublishHook };
			const originalPublish = publication.publishGeneration.bind(oldRuntime.service);
			const staged = deferred<void>();
			const releaseOldPublisher = deferred<void>();
			publication.publishGeneration = async (...args: unknown[]): Promise<unknown> => {
				staged.resolve();
				await releaseOldPublisher.promise;
				return await originalPublish(...args);
			};
			const oldRun = oldRuntime.service.runCommonGeneration(request.generationId);
			await staged.promise;
			await query(`UPDATE "hanami_common_feed_state" SET "generationLeaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'`);

			const newComputation = new FakeComputation(makeBundle(), makeMaterialization());
			const newEntered = deferred<void>();
			const newSource = deferred<HanamiCommonSourceBundle>();
			newComputation.build = async () => {
				newEntered.resolve();
				return await newSource.promise;
			};
			const newRuntime = makeRuntime(schema, { prefix: 'sq', computation: newComputation });
			const newRun = newRuntime.service.runCommonGeneration(request.generationId);
			await newEntered.promise;

			releaseOldPublisher.resolve();
			await expect(oldRun).resolves.toEqual({ kind: 'stale', generationId: request.generationId });
			const liveRows = await query<{ status: string; fence: string; pointer: string }>(`
				SELECT g."status" AS status, s."generationFence"::text AS fence, s."generatingGenerationId" AS pointer
				FROM "hanami_common_feed_state" s JOIN "hanami_common_generation" g ON g."id" = s."generatingGenerationId"
			`);
			expect(liveRows).toEqual([{ status: 'generating', fence: '2', pointer: request.generationId }]);

			newSource.resolve(makeBundle());
			await expect(newRun).resolves.toMatchObject({ kind: 'published', generationFence: '2' });
		});
	});

	test('acknowledges an ambiguous error after a durable publication without duplicating its range', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const runtime = makeRuntime(schema, { prefix: 'am' });
			const request = await runtime.service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected ambiguous-publication dispatch');

			type PublishHook = (...args: unknown[]) => Promise<unknown>;
			const publication = runtime.service as unknown as { publishGeneration: PublishHook };
			const originalPublish = publication.publishGeneration.bind(runtime.service);
			publication.publishGeneration = async (...args: unknown[]): Promise<unknown> => {
				await originalPublish(...args);
				throw new Error('ambiguous publish acknowledgement');
			};

			await expect(runtime.service.runCommonGeneration(request.generationId)).resolves.toEqual({
				kind: 'published',
				generationId: request.generationId,
				generationFence: '1',
				itemCount: 3,
			});
			await expect(runtime.service.runCommonGeneration(request.generationId)).resolves.toEqual({
				kind: 'alreadyReady',
				generationId: request.generationId,
			});
			const rows = await query<{ entries: string; latest: string }>(`
				SELECT (SELECT COUNT(*)::text FROM "hanami_common_feed_entry" WHERE "generationId" = $1) AS entries,
					"latestSequence"::text AS latest
				FROM "hanami_common_feed_state"
			`, [request.generationId]);
			expect(rows).toEqual([{ entries: '3', latest: '3' }]);
		});
	});

	test('rolls back publication that crosses the hard deadline while its lease remains live', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const baseline = makeRuntime(schema, { prefix: 'dl' });
			const baselineRequest = await baseline.service.requestCommonGeneration('seed');
			if (baselineRequest.kind !== 'dispatch') throw new Error('expected baseline deadline dispatch');
			await expect(baseline.service.runCommonGeneration(baselineRequest.generationId)).resolves.toMatchObject({ kind: 'published' });
			const readyHead = await baseline.service.getLatestReadyCommonHead();
			expect(readyHead).not.toBeNull();

			await query(`UPDATE "hanami_common_generation" SET "startedAt" = clock_timestamp() - INTERVAL '20 minutes' WHERE "id" = $1`, [baselineRequest.generationId]);
			const delayed = makeRuntime(schema, {
				prefix: 'dm',
				config: { hanamiGenerationWorkerTimeoutMs: 250, hanamiGenerationLeaseMs: 2_000 },
			});
			const delayedRequest = await delayed.service.requestCommonGeneration('scheduled');
			if (delayedRequest.kind !== 'dispatch') throw new Error('expected delayed publication dispatch');

			await query(`CREATE FUNCTION delay_hanami_common_feed_insert() RETURNS trigger AS $$
				BEGIN
					PERFORM pg_sleep(0.75);
					RETURN NEW;
				END
			$$ LANGUAGE plpgsql`);
			await query(`CREATE TRIGGER delay_hanami_common_feed_insert_trigger
				BEFORE INSERT ON "hanami_common_feed_entry"
				FOR EACH ROW EXECUTE FUNCTION delay_hanami_common_feed_insert()`);

			await expect(delayed.service.runCommonGeneration(delayedRequest.generationId)).rejects.toBeInstanceOf(Error);

			const rows = await query<{
				generation_status: string;
				snapshot_status: string;
				ready_head: string;
				generating_id: string | null;
				feed_entries: string;
				trend_entries: string;
				representatives: string;
			}>(`
				SELECT g."status" AS generation_status,
					t."status" AS snapshot_status,
					s."latestReadyGenerationId" AS ready_head,
					s."generatingGenerationId" AS generating_id,
					(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS feed_entries,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_entry" e WHERE e."snapshotId" = t."id") AS trend_entries,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_representative_note" r WHERE r."snapshotId" = t."id") AS representatives
				FROM "hanami_common_generation" g
				JOIN "hanami_trend_snapshot" t ON t."commonGenerationId" = g."id"
				CROSS JOIN "hanami_common_feed_state" s
				WHERE g."id" = $1
			`, [delayedRequest.generationId]);
			expect(rows).toEqual([{
				generation_status: 'generating',
				snapshot_status: 'pending',
				ready_head: readyHead!.generationId,
				generating_id: delayedRequest.generationId,
				feed_entries: '0',
				trend_entries: '0',
				representatives: '0',
			}]);

			await query(`DROP TRIGGER delay_hanami_common_feed_insert_trigger ON "hanami_common_feed_entry"`);
			await query(`DROP FUNCTION delay_hanami_common_feed_insert()`);
			await query(`UPDATE "hanami_common_feed_state" SET "generationLeaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'`);
			expect(await delayed.service.findDispatchableCommonGeneration()).toEqual({
				generationId: delayedRequest.generationId,
				reason: 'leaseExpired',
			});
			const recovery = makeRuntime(schema, { prefix: 'dn' });
			await expect(recovery.service.runCommonGeneration(delayedRequest.generationId)).resolves.toMatchObject({
				kind: 'published',
				generationFence: '3',
			});
		});
	}, 15_000);

	test('publishes a 30-by-5 snapshot whose representatives extend beyond the top-eight feed pool', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const terms = Array.from({ length: 30 }, (_, termRank) => ({
				term: `trend-${termRank}`,
				score: 100 - termRank,
				distinctAuthors: termRank + 1,
				representativeNoteIds: Array.from({ length: 5 }, (_, position) => `trend-note-${termRank}-${position}`),
			}));
			const trendingCandidates = terms.slice(0, 8).flatMap((term) => term.representativeNoteIds.map((noteId, index) => ({
				noteId,
				authorId: `trend-author-${index}`,
				baseScore: term.score - index / 10,
				metadata: { term: term.term },
			})));
			await insertNotes(query, terms.flatMap((term) => term.representativeNoteIds));
			const bundle: HanamiCommonSourceBundle = {
				version: 1,
				capturedAt: sourceTimestamp,
				sourceAsOf: { version: 1, capturedAt: sourceTimestamp, featuredAt: sourceTimestamp, trendAt: sourceTimestamp, axisConfigAt: sourceTimestamp },
				enabledAxes: ['trending'],
				candidates: { globalPopular: [], trending: trendingCandidates, exploration: [] },
				trendSnapshot: { terms },
			};
			const first = trendingCandidates[0]!;
			const materialization: HanamiCommonFeedMaterialization = {
				items: [{ noteId: first.noteId, authorId: first.authorId, source: 'trending', sources: ['trending'] }],
				segmentLengths: [1],
			};
			const computation = new FakeComputation(bundle, materialization);
			const { service } = makeRuntime(schema, { prefix: 'tr', computation });
			const request = await service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected trend dispatch');
			await expect(service.runCommonGeneration(request.generationId)).resolves.toMatchObject({ kind: 'published' });

			const snapshotRows = await query<{
				item_count: number;
				entry_count: string;
				representative_count: string;
				max_rank: string;
				max_position: number;
				snapshot_only_representatives: string;
				generation_status: string;
				snapshot_status: string;
			}>(`
				SELECT t."itemCount" AS item_count,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_entry" e WHERE e."snapshotId" = t."id") AS entry_count,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_representative_note" r WHERE r."snapshotId" = t."id") AS representative_count,
					(SELECT MAX(e."rank")::text FROM "hanami_trend_snapshot_entry" e WHERE e."snapshotId" = t."id") AS max_rank,
					(SELECT MAX(r."position") FROM "hanami_trend_snapshot_representative_note" r WHERE r."snapshotId" = t."id") AS max_position,
					(SELECT COUNT(*)::text
					 FROM "hanami_trend_snapshot_representative_note" r
					 WHERE r."snapshotId" = t."id"
					   AND NOT EXISTS (
						   SELECT 1 FROM "hanami_common_candidate" c
						   WHERE c."generationId" = t."commonGenerationId" AND c."noteId" = r."noteId"
					   )) AS snapshot_only_representatives,
					g."status" AS generation_status, t."status" AS snapshot_status
				FROM "hanami_trend_snapshot" t JOIN "hanami_common_generation" g ON g."id" = t."commonGenerationId"
				WHERE t."commonGenerationId" = $1
			`, [request.generationId]);
			expect(snapshotRows).toEqual([{
				item_count: 30,
				entry_count: '30',
				representative_count: '150',
				max_rank: '29',
				max_position: 4,
				snapshot_only_representatives: '110',
				generation_status: 'ready',
				snapshot_status: 'ready',
			}]);
		});
	});

	test('marks an owned ordinal loser obsolete without publishing entries', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const { service } = makeRuntime(schema, { prefix: 'ol' });
			const request = await service.requestCommonGeneration('seed');
			if (request.kind !== 'dispatch') throw new Error('expected ordinal-loser dispatch');
			await query(`INSERT INTO "hanami_common_generation" ("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "sourceAsOf", "generationFence")
				VALUES ('newer-ready', 2, 'ready', clock_timestamp(), clock_timestamp(), 'newer', '{}'::jsonb, 0)`);
			await query(`UPDATE "hanami_common_feed_state" SET
				"epochId" = 'existing-epoch',
				"latestReadyGenerationId" = 'newer-ready',
				"latestSequence" = 1,
				"earliestRetainedSequence" = 1
				WHERE "singletonId" = 'singleton'`);

			await expect(service.runCommonGeneration(request.generationId)).resolves.toEqual({ kind: 'stale', generationId: request.generationId });
			const rows = await query<{ generation_status: string; snapshot_status: string; entries: string; head: string; pointer: string | null }>(`
				SELECT g."status" AS generation_status, t."status" AS snapshot_status,
					(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS entries,
					s."latestReadyGenerationId" AS head, s."generatingGenerationId" AS pointer
				FROM "hanami_common_generation" g
				JOIN "hanami_trend_snapshot" t ON t."commonGenerationId" = g."id"
				CROSS JOIN "hanami_common_feed_state" s
				WHERE g."id" = $1
			`, [request.generationId]);
			expect(rows).toEqual([{
				generation_status: 'obsolete',
				snapshot_status: 'obsolete',
				entries: '0',
				head: 'newer-ready',
				pointer: null,
			}]);
		});
	});

	test('preserves the ready head on source, partition, zero-result, timeout, and publication rollback failures', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertNotes(query, ['note-global', 'note-trend', 'note-explore']);
			const baseline = makeRuntime(schema, { prefix: 'fa' });
			const baselineRequest = await baseline.service.requestCommonGeneration('seed');
			if (baselineRequest.kind !== 'dispatch') throw new Error('expected baseline dispatch');
			await baseline.service.runCommonGeneration(baselineRequest.generationId);
			const readyHead = await baseline.service.getLatestReadyCommonHead();
			expect(readyHead).not.toBeNull();

			const requestNext = async (prefix: string) => {
				await query(`UPDATE "hanami_common_generation" SET "startedAt" = clock_timestamp() - INTERVAL '20 minutes'`);
				const requester = makeRuntime(schema, { prefix });
				const request = await requester.service.requestCommonGeneration('scheduled');
				if (request.kind !== 'dispatch') throw new Error(`expected ${prefix} dispatch`);
				return request.generationId;
			};
			const assertFailedAndPreserved = async (generationId: string): Promise<void> => {
				expect(await baseline.service.getLatestReadyCommonHead()).toEqual(readyHead);
				const rows = await query<{ generation_status: string; snapshot_status: string; pointer: string | null }>(`
					SELECT g."status" AS generation_status, t."status" AS snapshot_status, s."generatingGenerationId" AS pointer
					FROM "hanami_common_generation" g
					JOIN "hanami_trend_snapshot" t ON t."commonGenerationId" = g."id"
					CROSS JOIN "hanami_common_feed_state" s WHERE g."id" = $1
				`, [generationId]);
				expect(rows).toEqual([{ generation_status: 'failed', snapshot_status: 'failed', pointer: null }]);
			};

			const sourceFailureId = await requestNext('fb');
			const sourceFailureComputation = new FakeComputation(makeBundle(), makeMaterialization());
			sourceFailureComputation.build = async () => { throw new Error('source failure'); };
			const sourceFailure = makeRuntime(schema, { prefix: 'fc', computation: sourceFailureComputation });
			await expect(sourceFailure.service.runCommonGeneration(sourceFailureId)).rejects.toThrow('source failure');
			await assertFailedAndPreserved(sourceFailureId);

			const partitionFailureId = await requestNext('fd');
			const partitionFailure = makeRuntime(schema, {
				prefix: 'fe',
				partition: { ensureMonthAvailable: async () => { throw new Error('partition failure'); } },
			});
			await expect(partitionFailure.service.runCommonGeneration(partitionFailureId)).rejects.toThrow('partition failure');
			await assertFailedAndPreserved(partitionFailureId);

			const zeroFailureId = await requestNext('ff');
			const zeroComputation = new FakeComputation(makeBundle(), { items: [], segmentLengths: [] });
			const zeroFailure = makeRuntime(schema, { prefix: 'fg', computation: zeroComputation });
			await expect(zeroFailure.service.runCommonGeneration(zeroFailureId)).rejects.toThrow('1..210 items');
			await assertFailedAndPreserved(zeroFailureId);

			const validationFailureId = await requestNext('fh');
			const validBundle = makeBundle();
			const invalidBundle: HanamiCommonSourceBundle = {
				...validBundle,
				candidates: {
					...validBundle.candidates,
					globalPopular: [{ ...validBundle.candidates.globalPopular[0]!, baseScore: Number.NaN }],
				},
			};
			const validationComputation = new FakeComputation(invalidBundle, makeMaterialization());
			const validationFailure = makeRuntime(schema, { prefix: 'fi', computation: validationComputation });
			await expect(validationFailure.service.runCommonGeneration(validationFailureId)).rejects.toThrow('baseScore must be finite');
			await assertFailedAndPreserved(validationFailureId);

			const timeoutFailureId = await requestNext('fj');
			const timeoutComputation = new FakeComputation(makeBundle(), makeMaterialization());
			timeoutComputation.build = async () => await deferred<HanamiCommonSourceBundle>().promise;
			const timeoutFailure = makeRuntime(schema, {
				prefix: 'fk',
				computation: timeoutComputation,
				config: { hanamiGenerationWorkerTimeoutMs: 100, hanamiGenerationLeaseMs: 500 },
			});
			await expect(timeoutFailure.service.runCommonGeneration(timeoutFailureId)).rejects.toThrow('worker timeout');
			expect(await baseline.service.getLatestReadyCommonHead()).toEqual(readyHead);
			const timedOutRows = await query<{ generation_status: string; snapshot_status: string; pointer: string | null }>(`
				SELECT g."status" AS generation_status, t."status" AS snapshot_status, s."generatingGenerationId" AS pointer
				FROM "hanami_common_generation" g
				JOIN "hanami_trend_snapshot" t ON t."commonGenerationId" = g."id"
				CROSS JOIN "hanami_common_feed_state" s WHERE g."id" = $1
			`, [timeoutFailureId]);
			expect(timedOutRows).toEqual([{
				generation_status: 'generating',
				snapshot_status: 'pending',
				pointer: timeoutFailureId,
			}]);
			await query(`UPDATE "hanami_common_feed_state" SET "generationLeaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'`);
			expect(await timeoutFailure.service.findDispatchableCommonGeneration()).toEqual({ generationId: timeoutFailureId, reason: 'leaseExpired' });
			await query(`UPDATE "hanami_common_generation" SET "status" = 'failed', "finishedAt" = clock_timestamp() WHERE "id" = $1`, [timeoutFailureId]);
			await query(`UPDATE "hanami_trend_snapshot" SET "status" = 'failed' WHERE "commonGenerationId" = $1`, [timeoutFailureId]);
			await query(`UPDATE "hanami_common_feed_state"
				SET "generatingGenerationId" = NULL, "generationLeaseOwner" = NULL, "generationLeaseExpiresAt" = NULL`);

			const rollbackFailureId = await requestNext('fl');
			await query(`CREATE FUNCTION reject_hanami_common_publish() RETURNS trigger AS $$
				BEGIN
					IF NEW."latestReadyGenerationId" IS DISTINCT FROM OLD."latestReadyGenerationId" THEN
						RAISE EXCEPTION 'forced publication rollback';
					END IF;
					RETURN NEW;
				END
			$$ LANGUAGE plpgsql`);
			await query(`CREATE TRIGGER reject_hanami_common_publish_trigger
				BEFORE UPDATE ON "hanami_common_feed_state"
				FOR EACH ROW EXECUTE FUNCTION reject_hanami_common_publish()`);
			const rollbackFailure = makeRuntime(schema, { prefix: 'fm' });
			await expect(rollbackFailure.service.runCommonGeneration(rollbackFailureId)).rejects.toThrow('forced publication rollback');
			await assertFailedAndPreserved(rollbackFailureId);
			const rolledBackRows = await query<{ feed_entries: string; trend_entries: string; checksum: string | null }>(`
				SELECT
					(SELECT COUNT(*)::text FROM "hanami_common_feed_entry" e WHERE e."generationId" = g."id") AS feed_entries,
					(SELECT COUNT(*)::text FROM "hanami_trend_snapshot_entry" e JOIN "hanami_trend_snapshot" t ON t."id" = e."snapshotId" WHERE t."commonGenerationId" = g."id") AS trend_entries,
					g."checksum" AS checksum
				FROM "hanami_common_generation" g WHERE g."id" = $1
			`, [rollbackFailureId]);
			expect(rolledBackRows).toEqual([{ feed_entries: '0', trend_entries: '0', checksum: null }]);
		});
	}, 20_000);
});
