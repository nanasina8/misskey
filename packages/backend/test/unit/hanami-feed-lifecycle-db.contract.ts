/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';
import { HanamiFeedLifecycleService } from '@/core/hanami/HanamiFeedLifecycleService.js';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;
type DbQuery = <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;

type SchemaContext = {
	schema: string;
	query: DbQuery;
	openClient: () => Promise<Client>;
};

type SeedUserOptions = {
	profileEnabled?: boolean;
	isHibernated?: boolean;
	work?: 'pending' | 'generating';
	terminalWork?: boolean;
	initialGenerationState?: string;
	initialGenerationAttemptedAt?: Date | null;
	latestSequence?: string;
	earliestSequence?: string;
	common?: {
		epochId: string;
		generationId: string;
		headSequence: string;
	} | null;
};

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const transition = new Date('2026-08-20T12:34:56.000Z');
const terminalTime = new Date('2026-08-01T00:00:00.000Z');

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
};

const delay = async (milliseconds: number): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
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

const queryFor = (client: Client): DbQuery => async <T extends DbRow = DbRow>(
	sql: string,
	values: unknown[] = [],
): Promise<T[]> => (await client.query<T>(sql, values)).rows;

const withMigratedSchema = async (run: (context: SchemaContext) => Promise<void>): Promise<void> => {
	const schema = `hanami_lifecycle_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const schemaName = quoteIdent(schema);
	const client = new Client({ connectionString: databaseUrl });
	const query = queryFor(client);
	const openClient = async (): Promise<Client> => {
		const opened = new Client({ connectionString: databaseUrl });
		await opened.connect();
		await opened.query(`SET search_path TO ${schemaName}, public`);
		await opened.query('SET TIME ZONE \'UTC\'');
		return opened;
	};

	try {
		await client.connect();
		const versions = await query<{ server_version: string }>('SHOW server_version');
		expect(versions.at(0)?.server_version).toMatch(/^18\./);
		await query(`CREATE SCHEMA ${schemaName}`);
		await query(`SET search_path TO ${schemaName}, public`);
		await query('SET TIME ZONE \'UTC\'');
		await query(`CREATE TABLE "user" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"isHibernated" boolean NOT NULL DEFAULT false
		)`);
		await query(`CREATE TABLE "user_profile" (
			"userId" character varying(32) NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
			"hanamiRecommendationEnabled" boolean NOT NULL DEFAULT true
		)`);
		await query('CREATE TABLE "note" ("id" character varying(32) NOT NULL PRIMARY KEY)');
		await query(`CREATE TABLE "hanami_recommendation_event" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"userId" character varying(32) NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"eventType" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL
		)`);
		await new HanamiPersistedTimelinePhase11787097600000().up({ query } as never);
		await run({ schema, query, openClient });
	} catch (error) {
		if (isDbConnectionError(error)) {
			console.warn('PostgreSQL is not reachable for the Hanami feed lifecycle DB contract suite.');
		}
		throw error;
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

const inTransaction = async <T>(client: Client, operation: (query: DbQuery) => Promise<T>): Promise<T> => {
	const query = queryFor(client);
	await query('BEGIN');
	try {
		const result = await operation(query);
		await query('COMMIT');
		return result;
	} catch (error) {
		await query('ROLLBACK').catch(() => undefined);
		throw error;
	}
};

const insertGeneration = async (
	query: DbQuery,
	id: string,
	ordinal: number,
	status: 'pending' | 'generating' | 'ready' | 'failed' | 'obsolete' = 'ready',
): Promise<void> => {
	await query(`INSERT INTO "hanami_common_generation"
		("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "generationFence")
		VALUES ($1, $2::bigint, $3::varchar, $4::timestamptz,
			CASE WHEN $3::varchar IN ('ready', 'failed', 'obsolete') THEN $4::timestamptz ELSE NULL END,
			'lifecycle-contract', 0)`, [
		id,
		String(ordinal),
		status,
		terminalTime,
	]);
};

const installCommonHead = async (
	query: DbQuery,
	head: { epochId: string; generationId: string; latestSequence: string },
): Promise<void> => {
	await query(`INSERT INTO "hanami_common_feed_state"
		("singletonId", "epochId", "latestSequence", "earliestRetainedSequence", "latestReadyGenerationId", "generationFence", "updatedAt")
		VALUES ('singleton', $1, $2::bigint, 1, $3, 0, $4)
		ON CONFLICT ("singletonId") DO UPDATE SET
			"epochId" = EXCLUDED."epochId",
			"latestSequence" = EXCLUDED."latestSequence",
			"earliestRetainedSequence" = EXCLUDED."earliestRetainedSequence",
			"latestReadyGenerationId" = EXCLUDED."latestReadyGenerationId",
			"generatingGenerationId" = NULL,
			"generationLeaseOwner" = NULL,
			"generationLeaseExpiresAt" = NULL,
			"updatedAt" = EXCLUDED."updatedAt"`, [head.epochId, head.latestSequence, head.generationId, transition]);
};

const seedUserState = async (query: DbQuery, userId: string, options: SeedUserOptions = {}): Promise<void> => {
	const epochId = `${userId}-epoch-0`;
	const readyBatchId = options.work == null ? null : `${userId}-ready`;
	const activeBatchId = options.work == null ? null : `${userId}-active`;
	const common = options.common ?? null;
	await query('INSERT INTO "user" ("id", "isHibernated") VALUES ($1, $2)', [userId, options.isHibernated ?? false]);
	await query('INSERT INTO "user_profile" ("userId", "hanamiRecommendationEnabled") VALUES ($1, $2)', [userId, options.profileEnabled ?? true]);
	await query(`INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
		VALUES ($1, $2, $3, NULL)`, [epochId, userId, terminalTime]);

	if (readyBatchId != null && activeBatchId != null && options.work != null) {
		await query(`INSERT INTO "hanami_user_feed_batch"
			("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "finishedAt", "itemCount", "checksum", "baseCommonGenerationId")
			VALUES ($1, $2, $3, 'initial', 'ready', 1, $4, $4, $4, 12, 'ready-checksum', 'base-generation')`, [
			readyBatchId,
			userId,
			epochId,
			terminalTime,
		]);
		await query(`INSERT INTO "hanami_user_feed_batch"
			("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "leaseOwner", "leaseExpiresAt", "startedAt", "baseCommonGenerationId")
			VALUES ($1, $2, $3, 'refresh', $4::varchar, 2, $5::timestamptz, $5::timestamptz,
				$6, $7::timestamptz, $8::timestamptz, 'base-generation')`, [
			activeBatchId,
			userId,
			epochId,
			options.work,
			terminalTime,
			options.work === 'generating' ? 'worker-1' : null,
			options.work === 'generating' ? transition : null,
			options.work === 'generating' ? terminalTime : null,
		]);

		if (options.terminalWork) {
			await query(`INSERT INTO "hanami_user_feed_batch"
				("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "finishedAt", "baseCommonGenerationId")
				VALUES
					($1, $3, $4, 'refresh', 'failed', 3, $5, $5, $5, 'base-generation'),
					($2, $3, $4, 'refresh', 'obsolete', 4, $5, $5, $5, 'base-generation')`, [
				`${userId}-failed`,
				`${userId}-obsolete`,
				userId,
				epochId,
				terminalTime,
			]);
		}
	}

	await query(`INSERT INTO "hanami_user_feed_state"
		("userId", "epochId", "mode", "initialGenerationState", "initialGenerationAttemptedAt",
		 "latestReadyBatchId", "generatingBatchId", "latestSequence", "earliestRetainedSequence",
		 "commonEpochId", "commonHeadGenerationId", "commonHeadSequence", "updatedAt")
		VALUES ($1, $2, 'personalized', $3, $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11::bigint, $12)`, [
		userId,
		epochId,
		options.initialGenerationState ?? 'requested',
		options.initialGenerationAttemptedAt ?? terminalTime,
		readyBatchId,
		activeBatchId,
		options.latestSequence ?? (options.work == null ? '0' : '12'),
		options.earliestSequence ?? (options.work == null ? '0' : '3'),
		common?.epochId ?? null,
		common?.generationId ?? null,
		common?.headSequence ?? null,
		terminalTime,
	]);

	if (readyBatchId != null && activeBatchId != null) {
		await query(`INSERT INTO "hanami_user_feed_refresh"
			("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt")
			VALUES ($1, $2, $3, $4, 'pending', $5, $6)`, [userId, epochId, Buffer.alloc(32, 1), activeBatchId, terminalTime, transition]);

		if (options.terminalWork) {
			await query(`INSERT INTO "hanami_user_feed_refresh"
				("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "resultMode", "resultFeedEpochId",
				 "resultHeadBatchId", "resultHeadSequence", "status", "createdAt", "expiresAt")
				VALUES
					($1, $2, $3, $6, 'personalized', $2, $6, 12, 'ready', $7, $8),
					($1, $2, $4, $6, 'common', 'terminal-common', $6, 9, 'failed', $7, $8),
					($1, $2, $5, $6, NULL, NULL, NULL, NULL, 'obsolete', $7, $8)`, [
				userId,
				epochId,
				Buffer.alloc(32, 2),
				Buffer.alloc(32, 3),
				Buffer.alloc(32, 4),
				readyBatchId,
				terminalTime,
				transition,
			]);
		}
	}
};

const makeLifecycle = (options: {
	idPrefix?: string;
	policies?: Readonly<Record<string, boolean>>;
} = {}) => {
	let idSequence = 0;
	const idService = {
		gen: jest.fn(() => `${options.idPrefix ?? 'new-epoch'}-${++idSequence}`),
	};
	const roleCalls: string[] = [];
	const roleService = {
		getUserPolicies: jest.fn(async (userId: string, manager: unknown) => {
			expect(manager).toBeDefined();
			roleCalls.push(userId);
			return { hanamiTlAvailable: options.policies?.[userId] ?? true };
		}),
	};
	return {
		idService,
		roleCalls,
		roleService,
		service: new HanamiFeedLifecycleService(idService as never, roleService as never),
	};
};

const expectConstraintViolation = async (operation: Promise<unknown>, constraint: string): Promise<void> => {
	try {
		await operation;
		throw new Error(`Expected ${constraint} to reject the statement`);
	} catch (error) {
		expect((error as { constraint?: string }).constraint).toBe(constraint);
	}
};

const countRows = async (query: DbQuery, table: string): Promise<number> => {
	const rows = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdent(table)}`);
	return Number(rows.at(0)?.count ?? '-1');
};

describe('Hanami feed lifecycle PostgreSQL contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the Hanami feed lifecycle DB contract suite.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('enforces every lifecycle CHECK with positive and negative rows', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await insertGeneration(query, 'base-generation', 1);
			const userIds = [
				'checkstate',
				'bpending',
				'bgenerating',
				'bready',
				'bbadgen',
				'bbadpending',
				'bhalfowner',
				'bhalfexpiry',
				'rpending',
				'robsolete',
				'rready',
				'rfailed',
			];
			await query('INSERT INTO "user" ("id") SELECT id FROM unnest($1::varchar[]) AS input(id)', [userIds]);
			await query(`INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
				SELECT id || '-epoch', id, $2, NULL FROM unnest($1::varchar[]) AS input(id)`, [userIds, terminalTime]);

			const names = await query<{ conname: string }>(`
				SELECT c.conname
				FROM pg_constraint c
				JOIN pg_class t ON t.oid = c.conrelid
				JOIN pg_namespace n ON n.oid = t.relnamespace
				WHERE n.nspname = $1 AND c.conname = ANY($2::text[])
				ORDER BY c.conname
			`, [schema, [
				'CHK_hanami_user_feed_batch_lease',
				'CHK_hanami_user_feed_refresh_result',
				'CHK_hanami_user_feed_state_common_head',
				'CHK_hanami_user_feed_state_sequences',
			]]);
			expect(names.map((row) => row.conname)).toEqual([
				'CHK_hanami_user_feed_batch_lease',
				'CHK_hanami_user_feed_refresh_result',
				'CHK_hanami_user_feed_state_common_head',
				'CHK_hanami_user_feed_state_sequences',
			]);

			await query(`INSERT INTO "hanami_user_feed_state"
				("userId", "epochId", "mode", "initialGenerationState", "latestSequence", "earliestRetainedSequence", "updatedAt")
				VALUES ('checkstate', 'checkstate-epoch', 'common', 'notEvaluated', 0, 0, $1)`, [transition]);
			await query(`UPDATE "hanami_user_feed_state" SET
				"latestSequence" = 9, "earliestRetainedSequence" = 2,
				"commonEpochId" = 'common-epoch', "commonHeadGenerationId" = 'base-generation', "commonHeadSequence" = 9
				WHERE "userId" = 'checkstate'`);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_state" SET "commonHeadSequence" = 0 WHERE "userId" = \'checkstate\''),
				'CHK_hanami_user_feed_state_common_head',
			);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_state" SET "commonEpochId" = NULL WHERE "userId" = \'checkstate\''),
				'CHK_hanami_user_feed_state_common_head',
			);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_state" SET "latestSequence" = 0, "earliestRetainedSequence" = 1 WHERE "userId" = \'checkstate\''),
				'CHK_hanami_user_feed_state_sequences',
			);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_state" SET "latestSequence" = 1, "earliestRetainedSequence" = 2 WHERE "userId" = \'checkstate\''),
				'CHK_hanami_user_feed_state_sequences',
			);
			await query(`UPDATE "hanami_user_feed_state" SET
				"latestSequence" = 0, "earliestRetainedSequence" = 0,
				"commonEpochId" = NULL, "commonHeadGenerationId" = NULL, "commonHeadSequence" = NULL
				WHERE "userId" = 'checkstate'`);

			await query(`INSERT INTO "hanami_user_feed_batch"
				("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "baseCommonGenerationId")
				VALUES
					('batch-pending', 'bpending', 'bpending-epoch', 'initial', 'pending', $1, $1, 'base-generation'),
					('batch-ready', 'bready', 'bready-epoch', 'initial', 'ready', $1, $1, 'base-generation')`, [terminalTime]);
			await query(`INSERT INTO "hanami_user_feed_batch"
				("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "leaseOwner", "leaseExpiresAt", "baseCommonGenerationId")
				VALUES ('batch-generating', 'bgenerating', 'bgenerating-epoch', 'initial', 'generating', $1, $1, 'worker', $2, 'base-generation')`, [terminalTime, transition]);
			await expectConstraintViolation(
				query(`INSERT INTO "hanami_user_feed_batch"
					("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "baseCommonGenerationId")
					VALUES ('batch-bad-generating', 'bbadgen', 'bbadgen-epoch', 'initial', 'generating', $1, $1, 'base-generation')`, [terminalTime]),
				'CHK_hanami_user_feed_batch_lease',
			);
			await expectConstraintViolation(
				query(`INSERT INTO "hanami_user_feed_batch"
					("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "leaseOwner", "leaseExpiresAt", "baseCommonGenerationId")
					VALUES ('batch-bad-pending', 'bbadpending', 'bbadpending-epoch', 'initial', 'pending', $1, $1, 'worker', $2, 'base-generation')`, [terminalTime, transition]),
				'CHK_hanami_user_feed_batch_lease',
			);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_batch" SET "leaseOwner" = \'worker\', "leaseExpiresAt" = $1 WHERE "id" = \'batch-ready\'', [transition]),
				'CHK_hanami_user_feed_batch_lease',
			);
			await expectConstraintViolation(
				query(`INSERT INTO "hanami_user_feed_batch"
					("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "leaseOwner", "baseCommonGenerationId")
					VALUES ('batch-half-owner', 'bhalfowner', 'bhalfowner-epoch', 'initial', 'generating', $1, $1, 'worker', 'base-generation')`, [terminalTime]),
				'CHK_hanami_user_feed_batch_lease',
			);
			await expectConstraintViolation(
				query(`INSERT INTO "hanami_user_feed_batch"
					("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "leaseExpiresAt", "baseCommonGenerationId")
					VALUES ('batch-half-expiry', 'bhalfexpiry', 'bhalfexpiry-epoch', 'initial', 'generating', $1, $1, $2, 'base-generation')`, [terminalTime, transition]),
				'CHK_hanami_user_feed_batch_lease',
			);

			for (const userId of ['rpending', 'robsolete', 'rready', 'rfailed']) {
				await query(`INSERT INTO "hanami_user_feed_batch"
					("id", "userId", "epochId", "trigger", "status", "createdAt", "availableAt", "baseCommonGenerationId")
					VALUES ($1, $2, $3, 'initial', 'ready', $4, $4, 'base-generation')`, [
					`${userId}-batch`,
					userId,
					`${userId}-epoch`,
					terminalTime,
				]);
			}
			await query(`INSERT INTO "hanami_user_feed_refresh"
				("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt")
				VALUES
					('rpending', 'rpending-epoch', $1, 'rpending-batch', 'pending', $3, $4),
					('robsolete', 'robsolete-epoch', $2, 'robsolete-batch', 'obsolete', $3, $4)`, [
				Buffer.alloc(32, 1),
				Buffer.alloc(32, 2),
				terminalTime,
				transition,
			]);
			await query(`INSERT INTO "hanami_user_feed_refresh"
				("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "resultMode", "resultFeedEpochId",
				 "resultHeadBatchId", "resultHeadSequence", "status", "createdAt", "expiresAt")
				VALUES
					('rready', 'rready-epoch', $1, 'rready-batch', 'personalized', 'rready-epoch', 'rready-batch', 1, 'ready', $3, $4),
					('rfailed', 'rfailed-epoch', $2, 'rfailed-batch', 'common', 'common-epoch', 'rfailed-batch', 2, 'failed', $3, $4)`, [
				Buffer.alloc(32, 3),
				Buffer.alloc(32, 4),
				terminalTime,
				transition,
			]);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_refresh" SET "resultMode" = \'common\' WHERE "userId" = \'rpending\''),
				'CHK_hanami_user_feed_refresh_result',
			);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_refresh" SET "resultHeadSequence" = 0 WHERE "userId" = \'rready\''),
				'CHK_hanami_user_feed_refresh_result',
			);
			await expectConstraintViolation(
				query('UPDATE "hanami_user_feed_refresh" SET "resultHeadBatchId" = NULL WHERE "userId" = \'rfailed\''),
				'CHK_hanami_user_feed_refresh_result',
			);
			await expectConstraintViolation(
				query(`UPDATE "hanami_user_feed_refresh" SET
					"resultMode" = 'common', "resultFeedEpochId" = 'common-epoch', "resultHeadBatchId" = 'batch', "resultHeadSequence" = 1
					WHERE "userId" = 'robsolete'`),
				'CHK_hanami_user_feed_refresh_result',
			);
		});
	});

	test('hibernates and revives existing states while preserving terminal and historical work', async () => {
		await withMigratedSchema(async ({ query, openClient }) => {
			await insertGeneration(query, 'base-generation', 1);
			await insertGeneration(query, 'common-ready', 2);
			await installCommonHead(query, { epochId: 'common-epoch-ready', generationId: 'common-ready', latestSequence: '42' });
			await seedUserState(query, 'hready', {
				work: 'generating',
				terminalWork: true,
				initialGenerationState: 'ready',
				initialGenerationAttemptedAt: terminalTime,
				common: { epochId: 'common-old', generationId: 'base-generation', headSequence: '7' },
			});
			await seedUserState(query, 'hnocommon', { work: 'pending', initialGenerationState: 'notEvaluated' });
			await query('INSERT INTO "user" ("id") VALUES (\'nostate\')');
			await query('INSERT INTO "user_profile" ("userId", "hanamiRecommendationEnabled") VALUES (\'nostate\', true)');
			await seedUserState(query, 'rready', { work: 'generating', terminalWork: true });
			await query('INSERT INTO "note" ("id") VALUES (\'old-note\')');
			await query(`INSERT INTO "hanami_user_feed_entry"
				("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
				VALUES ('old-entry', 'rready', 'rready-epoch-0', 5, 'rready-ready', 0, 'old-note', 'unit', '[]', 'personalCandidate', '{}', $1)`, [terminalTime]);

			const before = {
				batches: await countRows(query, 'hanami_user_feed_batch'),
				epochs: await countRows(query, 'hanami_user_feed_epoch'),
				generations: await countRows(query, 'hanami_common_generation'),
				refreshes: await countRows(query, 'hanami_user_feed_refresh'),
			};
			expect(before).toEqual({ batches: 10, epochs: 3, generations: 2, refreshes: 9 });

			const runtime = makeLifecycle({ idPrefix: 'revived' });
			const hibernateClient = await openClient();
			try {
				await inTransaction(hibernateClient, async (tx) => {
					await tx('SELECT "id" FROM "user" WHERE "id" = ANY($1::varchar[]) ORDER BY "id" FOR UPDATE', [['hready', 'nostate']]);
					await runtime.service.hibernateUsers({ query: tx } as never, ['nostate', 'hready', 'hready'], transition);
					await runtime.service.reviveUser({ query: tx } as never, 'nostate', transition);
				});
			} finally {
				await hibernateClient.end();
			}

			const hibernated = await query<{
				user_id: string;
				epoch_id: string;
				mode: string;
				initial_state: string;
				attempted_at: Date | null;
				ready_batch_id: string | null;
				generating_batch_id: string | null;
				latest_sequence: string;
				earliest_sequence: string;
				common_epoch_id: string | null;
				common_generation_id: string | null;
				common_sequence: string | null;
			}>(`SELECT "userId" AS user_id, "epochId" AS epoch_id, "mode" AS mode,
				"initialGenerationState" AS initial_state, "initialGenerationAttemptedAt" AS attempted_at,
				"latestReadyBatchId" AS ready_batch_id, "generatingBatchId" AS generating_batch_id,
				"latestSequence"::text AS latest_sequence, "earliestRetainedSequence"::text AS earliest_sequence,
				"commonEpochId" AS common_epoch_id, "commonHeadGenerationId" AS common_generation_id,
				"commonHeadSequence"::text AS common_sequence
				FROM "hanami_user_feed_state" WHERE "userId" = 'hready'`);
			expect(hibernated).toEqual([{
				user_id: 'hready',
				epoch_id: 'hready-epoch-0',
				mode: 'common',
				initial_state: 'ready',
				attempted_at: terminalTime,
				ready_batch_id: 'hready-ready',
				generating_batch_id: null,
				latest_sequence: '12',
				earliest_sequence: '3',
				common_epoch_id: 'common-epoch-ready',
				common_generation_id: 'common-ready',
				common_sequence: '42',
			}]);
			expect(await query('SELECT "epochId" FROM "hanami_user_feed_epoch" WHERE "userId" = \'nostate\'')).toEqual([]);
			expect(await query('SELECT "userId" FROM "hanami_user_feed_state" WHERE "userId" = \'nostate\'')).toEqual([]);

			const hibernateBatches = await query<{ id: string; status: string; owner: string | null; expires_at: Date | null; finished_at: Date | null }>(`
				SELECT "id" AS id, "status" AS status, "leaseOwner" AS owner, "leaseExpiresAt" AS expires_at, "finishedAt" AS finished_at
				FROM "hanami_user_feed_batch" WHERE "userId" = 'hready' ORDER BY "id"
			`);
			expect(hibernateBatches).toEqual([
				{ id: 'hready-active', status: 'obsolete', owner: null, expires_at: null, finished_at: transition },
				{ id: 'hready-failed', status: 'failed', owner: null, expires_at: null, finished_at: terminalTime },
				{ id: 'hready-obsolete', status: 'obsolete', owner: null, expires_at: null, finished_at: terminalTime },
				{ id: 'hready-ready', status: 'ready', owner: null, expires_at: null, finished_at: terminalTime },
			]);
			const hibernateRefreshes = await query<{ status: string; mode: string | null; epoch_id: string | null; batch_id: string | null; sequence: string | null }>(`
				SELECT "status" AS status, "resultMode" AS mode, "resultFeedEpochId" AS epoch_id,
					"resultHeadBatchId" AS batch_id, "resultHeadSequence"::text AS sequence
				FROM "hanami_user_feed_refresh" WHERE "userId" = 'hready' ORDER BY "status", "refreshTokenDigest"
			`);
			expect(hibernateRefreshes).toEqual(expect.arrayContaining([
				{ status: 'obsolete', mode: null, epoch_id: null, batch_id: null, sequence: null },
				{ status: 'ready', mode: 'personalized', epoch_id: 'hready-epoch-0', batch_id: 'hready-ready', sequence: '12' },
				{ status: 'failed', mode: 'common', epoch_id: 'terminal-common', batch_id: 'hready-ready', sequence: '9' },
			]));

			await query('DELETE FROM "hanami_common_feed_state" WHERE "singletonId" = \'singleton\'');
			const noCommonClient = await openClient();
			try {
				await inTransaction(noCommonClient, async (tx) => {
					await tx('SELECT "id" FROM "user" WHERE "id" = \'hnocommon\' FOR UPDATE');
					await runtime.service.hibernateUsers({ query: tx } as never, ['hnocommon'], transition);
				});
			} finally {
				await noCommonClient.end();
			}
			expect(await query(`SELECT "commonEpochId", "commonHeadGenerationId", "commonHeadSequence"::text
				FROM "hanami_user_feed_state" WHERE "userId" = 'hnocommon'`)).toEqual([{
				commonEpochId: null,
				commonHeadGenerationId: null,
				commonHeadSequence: null,
			}]);
			expect(await query(`SELECT "status", "leaseOwner", "leaseExpiresAt", "finishedAt"
				FROM "hanami_user_feed_batch" WHERE "id" = 'hnocommon-active'`)).toEqual([{
				status: 'obsolete',
				leaseOwner: null,
				leaseExpiresAt: null,
				finishedAt: transition,
			}]);
			expect(await query(`SELECT "status", "resultMode", "resultFeedEpochId", "resultHeadBatchId", "resultHeadSequence"::text
				FROM "hanami_user_feed_refresh" WHERE "userId" = 'hnocommon'`)).toEqual([{
				status: 'obsolete',
				resultMode: null,
				resultFeedEpochId: null,
				resultHeadBatchId: null,
				resultHeadSequence: null,
			}]);

			await installCommonHead(query, { epochId: 'common-epoch-ready', generationId: 'common-ready', latestSequence: '42' });
			const reviveClient = await openClient();
			try {
				await inTransaction(reviveClient, async (tx) => {
					await tx('SELECT "id" FROM "user" WHERE "id" = \'rready\' FOR UPDATE');
					await runtime.service.reviveUser({ query: tx } as never, 'rready', transition);
				});
			} finally {
				await reviveClient.end();
			}

			const revivedState = await query<DbRow>(`SELECT "epochId", "mode", "initialGenerationState", "initialGenerationAttemptedAt",
				"latestReadyBatchId", "generatingBatchId", "latestSequence"::text, "earliestRetainedSequence"::text,
				"commonEpochId", "commonHeadGenerationId", "commonHeadSequence"::text
				FROM "hanami_user_feed_state" WHERE "userId" = 'rready'`);
			expect(revivedState).toEqual([{
				epochId: 'revived-1',
				mode: 'common',
				initialGenerationState: 'notEvaluated',
				initialGenerationAttemptedAt: null,
				latestReadyBatchId: null,
				generatingBatchId: null,
				latestSequence: '0',
				earliestRetainedSequence: '0',
				commonEpochId: 'common-epoch-ready',
				commonHeadGenerationId: 'common-ready',
				commonHeadSequence: '42',
			}]);
			const revivedEpochs = await query<{ epoch_id: string; retired_at: Date | null }>(`
				SELECT "epochId" AS epoch_id, "retiredAt" AS retired_at
				FROM "hanami_user_feed_epoch" WHERE "userId" = 'rready' ORDER BY "createdAt", "epochId"
			`);
			expect(revivedEpochs).toEqual([
				{ epoch_id: 'rready-epoch-0', retired_at: transition },
				{ epoch_id: 'revived-1', retired_at: null },
			]);
			expect(await query('SELECT "id" FROM "hanami_user_feed_entry" WHERE "id" = \'old-entry\'')).toEqual([{ id: 'old-entry' }]);
			expect(await query(`SELECT "status", "leaseOwner", "leaseExpiresAt", "finishedAt"
				FROM "hanami_user_feed_batch" WHERE "id" = 'rready-active'`)).toEqual([{
				status: 'obsolete',
				leaseOwner: null,
				leaseExpiresAt: null,
				finishedAt: transition,
			}]);
			expect(await query('SELECT "status", "finishedAt" FROM "hanami_user_feed_batch" WHERE "id" = \'rready-ready\'')).toEqual([{
				status: 'ready',
				finishedAt: terminalTime,
			}]);
			expect(await query(`SELECT "status", "resultMode", "resultFeedEpochId", "resultHeadBatchId", "resultHeadSequence"::text
				FROM "hanami_user_feed_refresh" WHERE "userId" = 'rready' AND "status" IN ('ready', 'failed') ORDER BY "status"`)).toEqual([
				{ status: 'failed', resultMode: 'common', resultFeedEpochId: 'terminal-common', resultHeadBatchId: 'rready-ready', resultHeadSequence: '9' },
				{ status: 'ready', resultMode: 'personalized', resultFeedEpochId: 'rready-epoch-0', resultHeadBatchId: 'rready-ready', resultHeadSequence: '12' },
			]);
			expect(await query(`SELECT "status", "resultMode", "resultFeedEpochId", "resultHeadBatchId", "resultHeadSequence"::text
				FROM "hanami_user_feed_refresh" WHERE "userId" = 'rready' AND "refreshTokenDigest" = $1`, [Buffer.alloc(32, 1)])).toEqual([{
				status: 'obsolete',
				resultMode: null,
				resultFeedEpochId: null,
				resultHeadBatchId: null,
				resultHeadSequence: null,
			}]);
			expect(await query('SELECT "isHibernated" FROM "user" WHERE "id" IN (\'hready\', \'hnocommon\', \'rready\') ORDER BY "id"')).toEqual([
				{ isHibernated: false },
				{ isHibernated: false },
				{ isHibernated: false },
			]);
			expect(await countRows(query, 'hanami_common_generation')).toBe(2);
			expect(await countRows(query, 'hanami_user_feed_batch')).toBe(10);
			expect(await countRows(query, 'hanami_user_feed_refresh')).toBe(9);
			expect(await countRows(query, 'hanami_user_feed_epoch')).toBe(4);
			expect(runtime.roleCalls).toEqual(['rready']);
			expect(runtime.idService.gen).toHaveBeenCalledTimes(1);
		});
	});

	test('revival applies role-first availability and treats a missing common head as a null tuple', async () => {
		await withMigratedSchema(async ({ query, openClient }) => {
			await seedUserState(query, 'roleoff', { profileEnabled: true, initialGenerationAttemptedAt: null });
			await seedUserState(query, 'profileoff', { profileEnabled: false, initialGenerationAttemptedAt: null });
			await seedUserState(query, 'nocommon', { profileEnabled: true, initialGenerationAttemptedAt: null });
			const runtime = makeLifecycle({
				idPrefix: 'available-epoch',
				policies: { roleoff: false, profileoff: true, nocommon: true },
			});

			const profileReads = new Map<string, number>();
			for (const userId of ['roleoff', 'profileoff', 'nocommon']) {
				const client = await openClient();
				try {
					await inTransaction(client, async (tx) => {
						await tx('SELECT "id" FROM "user" WHERE "id" = $1 FOR UPDATE', [userId]);
						const recordingQuery: DbQuery = async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
							if (sql.includes('FROM "user_profile"')) profileReads.set(userId, (profileReads.get(userId) ?? 0) + 1);
							return await tx<T>(sql, values);
						};
						await runtime.service.reviveUser({ query: recordingQuery } as never, userId, transition);
					});
				} finally {
					await client.end();
				}
			}

			expect(profileReads.get('roleoff') ?? 0).toBe(0);
			expect(profileReads.get('profileoff')).toBe(1);
			expect(profileReads.get('nocommon')).toBe(1);
			expect(runtime.roleCalls).toEqual(['roleoff', 'profileoff', 'nocommon']);
			const states = await query<{
				user_id: string;
				initial_state: string;
				common_epoch_id: string | null;
				common_generation_id: string | null;
				common_sequence: string | null;
			}>(`SELECT "userId" AS user_id, "initialGenerationState" AS initial_state,
				"commonEpochId" AS common_epoch_id, "commonHeadGenerationId" AS common_generation_id,
				"commonHeadSequence"::text AS common_sequence
				FROM "hanami_user_feed_state" ORDER BY "userId"`);
			expect(states).toEqual([
				{ user_id: 'nocommon', initial_state: 'notEvaluated', common_epoch_id: null, common_generation_id: null, common_sequence: null },
				{ user_id: 'profileoff', initial_state: 'skippedUnavailable', common_epoch_id: null, common_generation_id: null, common_sequence: null },
				{ user_id: 'roleoff', initial_state: 'skippedUnavailable', common_epoch_id: null, common_generation_id: null, common_sequence: null },
			]);
			const epochCounts = await query<{ user_id: string; total: string; active: string }>(`
				SELECT "userId" AS user_id, COUNT(*)::text AS total,
					COUNT(*) FILTER (WHERE "retiredAt" IS NULL)::text AS active
				FROM "hanami_user_feed_epoch" GROUP BY "userId" ORDER BY "userId"
			`);
			expect(epochCounts).toEqual([
				{ user_id: 'nocommon', total: '2', active: '1' },
				{ user_id: 'profileoff', total: '2', active: '1' },
				{ user_id: 'roleoff', total: '2', active: '1' },
			]);
			expect(await countRows(query, 'hanami_common_generation')).toBe(0);
			expect(await countRows(query, 'hanami_user_feed_batch')).toBe(0);
		});
	});

	test('caller user locks serialize simultaneous revival attempts to one deterministic epoch', async () => {
		await withMigratedSchema(async ({ query, openClient }) => {
			await seedUserState(query, 'concurrent', { isHibernated: true, initialGenerationAttemptedAt: null });
			const runtime = makeLifecycle({ idPrefix: 'concurrent-epoch' });
			const firstHolding = deferred<void>();
			const releaseFirst = deferred<void>();
			const firstClient = await openClient();
			const secondClient = await openClient();

			const reviveIfHibernated = async (client: Client, hold: boolean): Promise<boolean> => {
				return await inTransaction(client, async (tx) => {
					const users = await tx<{ is_hibernated: boolean }>(`
						SELECT "isHibernated" AS is_hibernated FROM "user" WHERE "id" = 'concurrent' FOR UPDATE
					`);
					if (users.at(0)?.is_hibernated !== true) return false;
					await runtime.service.reviveUser({ query: tx } as never, 'concurrent', transition);
					await tx('UPDATE "user" SET "isHibernated" = false WHERE "id" = \'concurrent\'');
					if (hold) {
						firstHolding.resolve();
						await releaseFirst.promise;
					}
					return true;
				});
			};

			try {
				const first = reviveIfHibernated(firstClient, true);
				await firstHolding.promise;
				let secondSettled = false;
				const second = reviveIfHibernated(secondClient, false).finally(() => {
					secondSettled = true;
				});
				await delay(30);
				expect(secondSettled).toBe(false);
				releaseFirst.resolve();
				expect(await Promise.all([first, second])).toEqual([true, false]);
			} finally {
				releaseFirst.resolve();
				await firstClient.end().catch(() => undefined);
				await secondClient.end().catch(() => undefined);
			}

			expect(runtime.idService.gen).toHaveBeenCalledTimes(1);
			expect(runtime.roleCalls).toEqual(['concurrent']);
			expect(await query(`SELECT "epochId" FROM "hanami_user_feed_epoch"
				WHERE "userId" = 'concurrent' AND "retiredAt" IS NULL`)).toEqual([{ epochId: 'concurrent-epoch-1' }]);
			expect(await query('SELECT COUNT(*)::text AS count FROM "hanami_user_feed_epoch" WHERE "userId" = \'concurrent\'')).toEqual([{ count: '2' }]);
			expect(await query('SELECT "epochId" FROM "hanami_user_feed_state" WHERE "userId" = \'concurrent\'')).toEqual([{ epochId: 'concurrent-epoch-1' }]);
		});
	});

	test('common publication races pin a wholly old or wholly new tuple, never a mixed tuple', async () => {
		await withMigratedSchema(async ({ query, openClient }) => {
			await insertGeneration(query, 'race-old-1', 1);
			await insertGeneration(query, 'race-new-1', 2, 'generating');
			await insertGeneration(query, 'race-old-2', 3);
			await insertGeneration(query, 'race-new-2', 4, 'generating');
			await installCommonHead(query, { epochId: 'race-common-old-1', generationId: 'race-old-1', latestSequence: '10' });
			await seedUserState(query, 'raceold', { initialGenerationAttemptedAt: null });
			await seedUserState(query, 'racenew', { initialGenerationAttemptedAt: null });
			const runtime = makeLifecycle();

			const lifecycleLockedCommon = deferred<void>();
			const releaseLifecycle = deferred<void>();
			const lifecycleClient = await openClient();
			const publisherClient = await openClient();
			try {
				const lifecycle = inTransaction(lifecycleClient, async (tx) => {
					await tx('SELECT "id" FROM "user" WHERE "id" = \'raceold\' FOR UPDATE');
					const pausingQuery: DbQuery = async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
						const rows = await tx<T>(sql, values);
						if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE OF s')) {
							lifecycleLockedCommon.resolve();
							await releaseLifecycle.promise;
						}
						return rows;
					};
					await runtime.service.hibernateUsers({ query: pausingQuery } as never, ['raceold'], transition);
				});
				await lifecycleLockedCommon.promise;

				let publisherLocked = false;
				const publisher = inTransaction(publisherClient, async (tx) => {
					await tx('SELECT "singletonId" FROM "hanami_common_feed_state" WHERE "singletonId" = \'singleton\' FOR UPDATE');
					publisherLocked = true;
					await tx('UPDATE "hanami_common_generation" SET "status" = \'ready\', "finishedAt" = $1 WHERE "id" = \'race-new-1\'', [transition]);
					await tx(`UPDATE "hanami_common_feed_state" SET
						"epochId" = 'race-common-new-1', "latestReadyGenerationId" = 'race-new-1',
						"latestSequence" = 20, "earliestRetainedSequence" = 1, "updatedAt" = $1
						WHERE "singletonId" = 'singleton'`, [transition]);
				});
				await delay(30);
				expect(publisherLocked).toBe(false);
				releaseLifecycle.resolve();
				await Promise.all([lifecycle, publisher]);
			} finally {
				releaseLifecycle.resolve();
				await lifecycleClient.end().catch(() => undefined);
				await publisherClient.end().catch(() => undefined);
			}

			await installCommonHead(query, { epochId: 'race-common-old-2', generationId: 'race-old-2', latestSequence: '30' });
			const publisherFirstClient = await openClient();
			const lifecycleSecondClient = await openClient();
			try {
				await queryFor(publisherFirstClient)('BEGIN');
				await queryFor(publisherFirstClient)(`SELECT "singletonId" FROM "hanami_common_feed_state"
					WHERE "singletonId" = 'singleton' FOR UPDATE`);
				let lifecycleSettled = false;
				const lifecycle = inTransaction(lifecycleSecondClient, async (tx) => {
					await tx('SELECT "id" FROM "user" WHERE "id" = \'racenew\' FOR UPDATE');
					await runtime.service.hibernateUsers({ query: tx } as never, ['racenew'], transition);
				}).finally(() => {
					lifecycleSettled = true;
				});
				await delay(30);
				expect(lifecycleSettled).toBe(false);
				await queryFor(publisherFirstClient)(`UPDATE "hanami_common_generation"
					SET "status" = 'ready', "finishedAt" = $1 WHERE "id" = 'race-new-2'`, [transition]);
				await queryFor(publisherFirstClient)(`UPDATE "hanami_common_feed_state" SET
					"epochId" = 'race-common-new-2', "latestReadyGenerationId" = 'race-new-2',
					"latestSequence" = 40, "earliestRetainedSequence" = 1, "updatedAt" = $1
					WHERE "singletonId" = 'singleton'`, [transition]);
				await queryFor(publisherFirstClient)('COMMIT');
				await lifecycle;
			} finally {
				await queryFor(publisherFirstClient)('ROLLBACK').catch(() => undefined);
				await publisherFirstClient.end().catch(() => undefined);
				await lifecycleSecondClient.end().catch(() => undefined);
			}

			const pinned = await query<{
				user_id: string;
				epoch_id: string | null;
				generation_id: string | null;
				head_sequence: string | null;
			}>(`SELECT "userId" AS user_id, "commonEpochId" AS epoch_id,
				"commonHeadGenerationId" AS generation_id, "commonHeadSequence"::text AS head_sequence
				FROM "hanami_user_feed_state" WHERE "userId" IN ('raceold', 'racenew') ORDER BY "userId"`);
			expect(pinned).toEqual([
				{ user_id: 'racenew', epoch_id: 'race-common-new-2', generation_id: 'race-new-2', head_sequence: '40' },
				{ user_id: 'raceold', epoch_id: 'race-common-old-1', generation_id: 'race-old-1', head_sequence: '10' },
			]);
		});
	});
});
