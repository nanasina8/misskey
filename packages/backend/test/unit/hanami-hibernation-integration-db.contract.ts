/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client } from 'pg';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import { UserService } from '@/core/UserService.js';
import { HanamiFeedLifecycleService } from '@/core/hanami/HanamiFeedLifecycleService.js';
import { HibernationSweepProcessorService } from '@/queue/processors/HibernationSweepProcessorService.js';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;
type DbQuery = <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;

type SchemaContext = {
	schema: string;
	query: DbQuery;
};

type TransactionHooks = {
	afterActivityUserLocked?: (userId: string) => Promise<void>;
	afterSweepCandidatesLocked?: (userIds: string[]) => Promise<void>;
	beforeFollowingUpdate?: () => Promise<void>;
};

type SeedUserOptions = {
	isHibernated?: boolean;
	lastActiveDate?: Date;
	withState?: boolean;
	withGeneratingBatch?: boolean;
};

type InternalEventsMock = {
	publishInternalEvent: jest.MockedFunction<(type: string, body: { id: string }) => void>;
};

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const DAY_MS = 86_400_000;
const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

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

const openSchemaClient = async (schema: string): Promise<Client> => {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
	await client.query('SET TIME ZONE \'UTC\'');
	return client;
};

const withMigratedSchema = async (run: (context: SchemaContext) => Promise<void>): Promise<void> => {
	const schema = `hanami_hibernation_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const schemaName = quoteIdent(schema);
	const client = new Client({ connectionString: databaseUrl });
	const query = queryFor(client);

	try {
		await client.connect();
		const versions = await query<{ server_version: string }>('SHOW server_version');
		expect(versions.at(0)?.server_version).toMatch(/^18\./);
		await query(`CREATE SCHEMA ${schemaName}`);
		await query(`SET search_path TO ${schemaName}, public`);
		await query('SET TIME ZONE \'UTC\'');
		await query(`CREATE TABLE "user" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"host" character varying(128),
			"isHibernated" boolean NOT NULL DEFAULT false,
			"lastActiveDate" TIMESTAMP WITH TIME ZONE
		)`);
		await query(`CREATE TABLE "user_profile" (
			"userId" character varying(32) NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
			"hanamiRecommendationEnabled" boolean NOT NULL DEFAULT true
		)`);
		await query(`CREATE TABLE "following" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"followerId" character varying(32) NOT NULL,
			"followeeId" character varying(32) NOT NULL,
			"followerHost" character varying(128),
			"isFollowerHibernated" boolean NOT NULL DEFAULT false
		)`);
		await query('CREATE TABLE "note" ("id" character varying(32) NOT NULL PRIMARY KEY)');
		await query(`CREATE TABLE "hanami_recommendation_event" (
			"id" character varying(32) NOT NULL PRIMARY KEY,
			"userId" character varying(32) NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"eventType" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL
		)`);
		await query(`CREATE INDEX "IDX_user_hibernation_candidates" ON "user" ("lastActiveDate")
			WHERE "host" IS NULL AND "isHibernated" = false AND "lastActiveDate" IS NOT NULL`);
		await new HanamiPersistedTimelinePhase11787097600000().up({ query } as never);
		await run({ schema, query });
	} catch (error) {
		if (isDbConnectionError(error)) {
			console.warn('PostgreSQL is not reachable for the Hanami hibernation integration DB contract suite.');
		}
		throw error;
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

const criterionValues = (criterion: unknown): string[] => {
	if (typeof criterion === 'string') return [criterion];
	if (typeof criterion !== 'object' || criterion == null) throw new Error('Unsupported update criterion');
	const operator = criterion as { value?: unknown; _value?: unknown };
	const value = operator.value ?? operator._value;
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new Error('Unsupported update criterion value');
	}
	return value as string[];
};

const makeDataSource = (schema: string, hooks: TransactionHooks = {}) => ({
	transaction: async <T>(operation: (manager: ReturnType<typeof makeManager>) => Promise<T>): Promise<T> => {
		const client = await openSchemaClient(schema);
		const manager = makeManager(client, hooks);
		await client.query('BEGIN');
		try {
			const result = await operation(manager);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			await client.end().catch(() => undefined);
		}
	},
});

const makeManager = (client: Client, hooks: TransactionHooks) => ({
	query: async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
		const rows = (await client.query<T>(sql, values)).rows;
		if (sql.includes('FROM "user"') && sql.includes('FOR UPDATE SKIP LOCKED')) {
			await hooks.afterSweepCandidatesLocked?.(rows.map((row) => String(row.id)));
		}
		return rows;
	},
	findOne: async (entity: unknown, options: unknown): Promise<DbRow | null> => {
		if (entity !== MiUser) throw new Error('Unsupported findOne entity');
		const userId = (options as { where: { id: string } }).where.id;
		const result = await client.query<{
			id: string;
			isHibernated: boolean;
			lastActiveDate: Date | null;
		}>(`SELECT "id", "isHibernated", "lastActiveDate"
			FROM "user" WHERE "id" = $1 FOR UPDATE`, [userId]);
		await hooks.afterActivityUserLocked?.(userId);
		return result.rows.at(0) ?? null;
	},
	update: async (entity: unknown, criteria: unknown, patch: unknown): Promise<{ affected: number }> => {
		const values = patch as { isHibernated?: boolean; isFollowerHibernated?: boolean; lastActiveDate?: Date };
		if (entity === MiUser) {
			if (typeof criteria === 'object' && criteria != null && values.lastActiveDate != null) {
				const userCriteria = criteria as { id?: string; isHibernated?: boolean };
				if (typeof userCriteria.id === 'string' && userCriteria.isHibernated === false) {
					const result = await client.query(`UPDATE "user"
						SET "lastActiveDate" = $2 WHERE "id" = $1 AND "isHibernated" = false`, [userCriteria.id, values.lastActiveDate]);
					await hooks.afterActivityUserLocked?.(userCriteria.id);
					return { affected: result.rowCount ?? 0 };
				}
			}
			if (typeof criteria === 'string' && values.isHibernated === false && values.lastActiveDate != null) {
				const result = await client.query(`UPDATE "user"
					SET "lastActiveDate" = $2, "isHibernated" = false WHERE "id" = $1`, [criteria, values.lastActiveDate]);
				return { affected: result.rowCount ?? 0 };
			}
			if (typeof criteria === 'string' && values.lastActiveDate != null) {
				const result = await client.query('UPDATE "user" SET "lastActiveDate" = $2 WHERE "id" = $1', [criteria, values.lastActiveDate]);
				return { affected: result.rowCount ?? 0 };
			}
			if (values.isHibernated === true) {
				const ids = criterionValues((criteria as { id: unknown }).id);
				const result = await client.query(`UPDATE "user" SET "isHibernated" = true
					WHERE "id" = ANY($1::varchar[]) AND "isHibernated" = false`, [ids]);
				return { affected: result.rowCount ?? 0 };
			}
		}
		if (entity === MiFollowing && values.isFollowerHibernated != null) {
			await hooks.beforeFollowingUpdate?.();
			const followerCriterion = (criteria as { followerId: unknown }).followerId;
			const ids = criterionValues(followerCriterion);
			const expected = (criteria as { isFollowerHibernated?: boolean }).isFollowerHibernated;
			const result = await client.query(`UPDATE "following"
				SET "isFollowerHibernated" = $2
				WHERE "followerId" = ANY($1::varchar[])
					AND ($3::boolean IS NULL OR "isFollowerHibernated" = $3)`, [ids, values.isFollowerHibernated, expected ?? null]);
			return { affected: result.rowCount ?? 0 };
		}
		throw new Error('Unsupported update operation');
	},
});

const seedUser = async (query: DbQuery, userId: string, options: SeedUserOptions = {}): Promise<void> => {
	const lastActiveDate = options.lastActiveDate ?? new Date(Date.now() - (60 * DAY_MS));
	const epochId = `${userId}-epoch-0`;
	await query(`INSERT INTO "user" ("id", "host", "isHibernated", "lastActiveDate")
		VALUES ($1, NULL, $2, $3)`, [userId, options.isHibernated ?? false, lastActiveDate]);
	await query('INSERT INTO "user_profile" ("userId", "hanamiRecommendationEnabled") VALUES ($1, true)', [userId]);
	await query(`INSERT INTO "following"
		("id", "followerId", "followeeId", "followerHost", "isFollowerHibernated")
		VALUES ($1, $2, $3, NULL, $4)`, [`${userId}-following`, userId, `${userId}-followee`, options.isHibernated ?? false]);
	if (options.withState === false) return;

	await query(`INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
		VALUES ($1, $2, $3, NULL)`, [epochId, userId, lastActiveDate]);
	let generatingBatchId: string | null = null;
	if (options.withGeneratingBatch) {
		generatingBatchId = `${userId}-batch-0`;
		await query(`INSERT INTO "hanami_common_generation"
			("id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion", "generationFence")
			VALUES ('base-generation', 1, 'ready', $1, $1, 'hibernation-contract', 0)
			ON CONFLICT ("id") DO NOTHING`, [lastActiveDate]);
		await query(`INSERT INTO "hanami_user_feed_batch"
			("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt",
			 "leaseOwner", "leaseExpiresAt", "startedAt", "baseCommonGenerationId")
			VALUES ($1, $2, $3, 'initial', 'generating', 1, $4, $4, 'stale-worker', $5, $4, 'base-generation')`, [
			generatingBatchId,
			userId,
			epochId,
			lastActiveDate,
			new Date(Date.now() + DAY_MS),
		]);
	}
	await query(`INSERT INTO "hanami_user_feed_state"
		("userId", "epochId", "mode", "initialGenerationState", "initialGenerationAttemptedAt",
		 "generatingBatchId", "latestSequence", "earliestRetainedSequence", "updatedAt")
		VALUES ($1, $2, 'personalized', 'requested', $3, $4, 0, 0, $3)`, [
		userId,
		epochId,
		lastActiveDate,
		generatingBatchId,
	]);
};

const makeRuntime = () => {
	let epochSequence = 0;
	const idService = {
		gen: jest.fn(() => `revived-epoch-${++epochSequence}`),
	};
	const roleService = {
		getUserPolicies: jest.fn(async (_userId: string, _manager: unknown) => ({ hanamiTlAvailable: true })),
	};
	const lifecycle = new HanamiFeedLifecycleService(idService as never, roleService as never);
	const makeUserService = (dataSource: ReturnType<typeof makeDataSource>, events = { publishInternalEvent: jest.fn<(type: string, body: { id: string }) => void>() }) => ({
		events,
		service: new UserService(dataSource as never, {} as never, {} as never, events as never, lifecycle),
	});
	const makeSweepService = (dataSource: ReturnType<typeof makeDataSource>, events: InternalEventsMock = { publishInternalEvent: jest.fn<(type: string, body: { id: string }) => void>() }) => {
		const logger = { succ: jest.fn() };
		return {
			events,
			logger,
			service: new HibernationSweepProcessorService(
				dataSource as never,
				{ userHibernationDays: 50 } as never,
				{ logger: { createSubLogger: () => logger } } as never,
				lifecycle,
				events as never,
			),
		};
	};
	return { idService, lifecycle, makeSweepService, makeUserService, roleService };
};

describe('Hanami hibernation integration PostgreSQL contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the Hanami hibernation integration DB contract suite.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('activity and sweep serialize correctly in both user-row lock orders', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const runtime = makeRuntime();
			await seedUser(query, 'activity-first');

			const activityLocked = deferred<void>();
			const releaseActivity = deferred<void>();
			let pauseActivity = true;
			const activityDataSource = makeDataSource(schema, {
				afterActivityUserLocked: async (userId) => {
					if (userId !== 'activity-first' || !pauseActivity) return;
					pauseActivity = false;
					activityLocked.resolve();
					await releaseActivity.promise;
				},
			});
			const activity = runtime.makeUserService(activityDataSource);
			const activityUser = {
				id: 'activity-first',
				isHibernated: false,
				lastActiveDate: new Date(0),
			} as MiUser;
			const activityPromise = activity.service.updateLastActiveDate(activityUser);
			await activityLocked.promise;

			const skippedSweep = runtime.makeSweepService(makeDataSource(schema));
			let skippedSweepSettled = false;
			const skippedSweepPromise = skippedSweep.service.process().finally(() => {
				skippedSweepSettled = true;
			});
			await delay(30);
			expect(skippedSweepSettled).toBe(false);
			releaseActivity.resolve();
			await Promise.all([activityPromise, skippedSweepPromise]);
			expect(skippedSweep.events.publishInternalEvent).not.toHaveBeenCalled();

			const firstRows = await query<{
				isHibernated: boolean;
				isFollowerHibernated: boolean;
				mode: string;
			}>(`SELECT u."isHibernated", f."isFollowerHibernated", s."mode"
				FROM "user" u JOIN "following" f ON f."followerId" = u."id"
				JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
				WHERE u."id" = 'activity-first'`);
			expect(firstRows).toEqual([{ isHibernated: false, isFollowerHibernated: false, mode: 'personalized' }]);
			await seedUser(query, 'sweep-first');

			const sweepLocked = deferred<void>();
			const releaseSweep = deferred<void>();
			let pauseSweep = true;
			const sweep = runtime.makeSweepService(makeDataSource(schema, {
				afterSweepCandidatesLocked: async (userIds) => {
					if (!pauseSweep || !userIds.includes('sweep-first')) return;
					pauseSweep = false;
					sweepLocked.resolve();
					await releaseSweep.promise;
				},
			}));
			const sweepPromise = sweep.service.process();
			await sweepLocked.promise;

			const revival = runtime.makeUserService(makeDataSource(schema));
			const revivalUser = {
				id: 'sweep-first',
				isHibernated: false,
				lastActiveDate: new Date(0),
			} as MiUser;
			let revivalSettled = false;
			const revivalPromise = revival.service.updateLastActiveDate(revivalUser).finally(() => {
				revivalSettled = true;
			});
			await delay(30);
			expect(revivalSettled).toBe(false);
			releaseSweep.resolve();
			await Promise.all([sweepPromise, revivalPromise]);

			const secondRows = await query<{
				isHibernated: boolean;
				isFollowerHibernated: boolean;
				mode: string;
				active_epochs: string;
				total_epochs: string;
			}>(`SELECT u."isHibernated", f."isFollowerHibernated", s."mode",
				COUNT(e.*) FILTER (WHERE e."retiredAt" IS NULL)::text AS active_epochs,
				COUNT(e.*)::text AS total_epochs
				FROM "user" u JOIN "following" f ON f."followerId" = u."id"
				JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
				JOIN "hanami_user_feed_epoch" e ON e."userId" = u."id"
				WHERE u."id" = 'sweep-first'
				GROUP BY u."isHibernated", f."isFollowerHibernated", s."mode"`);
			expect(secondRows).toEqual([{
				isHibernated: false,
				isFollowerHibernated: false,
				mode: 'common',
				active_epochs: '1',
				total_epochs: '2',
			}]);
			expect(revival.events.publishInternalEvent).toHaveBeenCalledTimes(1);
		});
	});

	test('two sweep workers split a full chunk with SKIP LOCKED and transition each unused user once', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			const ids = Array.from({ length: 1001 }, (_, index) => `bulk-${String(index).padStart(4, '0')}`);
			const staleDate = new Date(Date.now() - (60 * DAY_MS));
			await query(`INSERT INTO "user" ("id", "host", "isHibernated", "lastActiveDate")
				SELECT id, NULL, false, $2 FROM unnest($1::varchar[]) AS input(id)`, [ids, staleDate]);
			await query(`INSERT INTO "following" ("id", "followerId", "followeeId", "followerHost", "isFollowerHibernated")
				SELECT id || '-f', id, id || '-to', NULL, false FROM unnest($1::varchar[]) AS input(id)`, [ids]);

			const runtime = makeRuntime();
			const firstLocked = deferred<void>();
			const releaseFirst = deferred<void>();
			let pauseFirst = true;
			const first = runtime.makeSweepService(makeDataSource(schema, {
				afterSweepCandidatesLocked: async (userIds) => {
					if (!pauseFirst || userIds.length === 0) return;
					pauseFirst = false;
					expect(userIds).toHaveLength(1000);
					firstLocked.resolve();
					await releaseFirst.promise;
				},
			}));
			const second = runtime.makeSweepService(makeDataSource(schema));
			const firstPromise = first.service.process();
			await firstLocked.promise;
			let secondSettled = false;
			const secondPromise = second.service.process().finally(() => {
				secondSettled = true;
			});
			await delay(30);
			expect(secondSettled).toBe(false);
			releaseFirst.resolve();
			await Promise.all([firstPromise, secondPromise]);

			const counts = await query<{
				hibernated_users: string;
				hibernated_followings: string;
				states: string;
			}>(`SELECT
				(SELECT COUNT(*) FROM "user" WHERE "isHibernated")::text AS hibernated_users,
				(SELECT COUNT(*) FROM "following" WHERE "isFollowerHibernated")::text AS hibernated_followings,
				(SELECT COUNT(*) FROM "hanami_user_feed_state")::text AS states`);
			expect(counts).toEqual([{ hibernated_users: '1001', hibernated_followings: '1001', states: '0' }]);
			const eventIds = [...first.events.publishInternalEvent.mock.calls, ...second.events.publishInternalEvent.mock.calls]
				.map((call) => (call[1] as { id: string }).id);
			expect(eventIds).toHaveLength(1001);
			expect(new Set(eventIds).size).toBe(1001);
			expect(runtime.idService.gen).not.toHaveBeenCalled();
		});
	});

	test('blocking tail waits for an unrelated lock and hibernates the still-eligible user in the same run', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'tail-locked', { withState: false });
			await seedUser(query, 'tail-free', { withState: false });
			const locker = await openSchemaClient(schema);
			await locker.query('BEGIN');
			await locker.query('SELECT "id" FROM "user" WHERE "id" = \'tail-locked\' FOR UPDATE');
			const freeTransitioned = deferred<void>();
			const events = {
				publishInternalEvent: jest.fn((_type: string, body: { id: string }) => {
					if (body.id === 'tail-free') freeTransitioned.resolve();
				}),
			};
			const sweep = makeRuntime().makeSweepService(makeDataSource(schema), events);
			let sweepSettled = false;
			const sweepPromise = sweep.service.process().finally(() => {
				sweepSettled = true;
			});

			try {
				await freeTransitioned.promise;
				await delay(30);
				expect(sweepSettled).toBe(false);
				expect(await query('SELECT "isHibernated" FROM "user" WHERE "id" = \'tail-free\'')).toEqual([{ isHibernated: true }]);
				await locker.query('COMMIT');
				await sweepPromise;
			} finally {
				await locker.query('ROLLBACK').catch(() => undefined);
				await locker.end().catch(() => undefined);
				await sweepPromise.catch(() => undefined);
			}

			expect(await query('SELECT "id", "isHibernated" FROM "user" ORDER BY "id"')).toEqual([
				{ id: 'tail-free', isHibernated: true },
				{ id: 'tail-locked', isHibernated: true },
			]);
			const eventIds = events.publishInternalEvent.mock.calls.map(call => call[1].id);
			expect(eventIds.sort()).toEqual(['tail-free', 'tail-locked']);
		});
	});

	test('blocking tail rechecks eligibility after a lock holder records activity', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'tail-active', { withState: false });
			await seedUser(query, 'tail-other', { withState: false });
			const locker = await openSchemaClient(schema);
			await locker.query('BEGIN');
			await locker.query('SELECT "id" FROM "user" WHERE "id" = \'tail-active\' FOR UPDATE');
			await locker.query('UPDATE "user" SET "lastActiveDate" = NOW() WHERE "id" = \'tail-active\'');
			const otherTransitioned = deferred<void>();
			const events = {
				publishInternalEvent: jest.fn((_type: string, body: { id: string }) => {
					if (body.id === 'tail-other') otherTransitioned.resolve();
				}),
			};
			const sweep = makeRuntime().makeSweepService(makeDataSource(schema), events);
			let sweepSettled = false;
			const sweepPromise = sweep.service.process().finally(() => {
				sweepSettled = true;
			});

			try {
				await otherTransitioned.promise;
				await delay(30);
				expect(sweepSettled).toBe(false);
				await locker.query('COMMIT');
				await sweepPromise;
			} finally {
				await locker.query('ROLLBACK').catch(() => undefined);
				await locker.end().catch(() => undefined);
				await sweepPromise.catch(() => undefined);
			}

			expect(await query('SELECT "id", "isHibernated" FROM "user" ORDER BY "id"')).toEqual([
				{ id: 'tail-active', isHibernated: false },
				{ id: 'tail-other', isHibernated: true },
			]);
			expect(events.publishInternalEvent).toHaveBeenCalledTimes(1);
			expect(events.publishInternalEvent).toHaveBeenCalledWith('localUserUpdated', { id: 'tail-other' });
		});
	});

	test('lifecycle and both flag tables roll back atomically without an event', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'rollback-user');
			const runtime = makeRuntime();
			const failure = new Error('following update failed');
			const sweep = runtime.makeSweepService(makeDataSource(schema, {
				beforeFollowingUpdate: async () => {
					throw failure;
				},
			}));

			await expect(sweep.service.process()).rejects.toBe(failure);

			const rows = await query<{
				isHibernated: boolean;
				isFollowerHibernated: boolean;
				mode: string;
			}>(`SELECT u."isHibernated", f."isFollowerHibernated", s."mode"
				FROM "user" u JOIN "following" f ON f."followerId" = u."id"
				JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
				WHERE u."id" = 'rollback-user'`);
			expect(rows).toEqual([{ isHibernated: false, isFollowerHibernated: false, mode: 'personalized' }]);
			expect(sweep.events.publishInternalEvent).not.toHaveBeenCalled();
		});
	});

	test('concurrent activity creates exactly one revival epoch and one transition event', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'concurrent-user', { isHibernated: true });
			const runtime = makeRuntime();
			const firstLocked = deferred<void>();
			const releaseFirst = deferred<void>();
			let pauseFirst = true;
			const first = runtime.makeUserService(makeDataSource(schema, {
				afterActivityUserLocked: async () => {
					if (!pauseFirst) return;
					pauseFirst = false;
					firstLocked.resolve();
					await releaseFirst.promise;
				},
			}));
			const second = runtime.makeUserService(makeDataSource(schema));
			const firstUser = { id: 'concurrent-user', isHibernated: true, lastActiveDate: new Date(0) } as MiUser;
			const secondUser = { id: 'concurrent-user', isHibernated: true, lastActiveDate: new Date(0) } as MiUser;
			const firstPromise = first.service.updateLastActiveDate(firstUser);
			await firstLocked.promise;
			let secondSettled = false;
			const secondPromise = second.service.updateLastActiveDate(secondUser).finally(() => {
				secondSettled = true;
			});
			await delay(30);
			expect(secondSettled).toBe(false);
			releaseFirst.resolve();
			await Promise.all([firstPromise, secondPromise]);

			const epochs = await query<{ total: string; active: string }>(`SELECT COUNT(*)::text AS total,
				COUNT(*) FILTER (WHERE "retiredAt" IS NULL)::text AS active
				FROM "hanami_user_feed_epoch" WHERE "userId" = 'concurrent-user'`);
			expect(epochs).toEqual([{ total: '2', active: '1' }]);
			expect(runtime.idService.gen).toHaveBeenCalledTimes(1);
			expect(runtime.roleService.getUserPolicies).toHaveBeenCalledTimes(1);
			expect(runtime.roleService.getUserPolicies.mock.calls[0]?.[1]).toBeDefined();
			expect(first.events.publishInternalEvent).toHaveBeenCalledTimes(1);
			expect(second.events.publishInternalEvent).not.toHaveBeenCalled();
			expect(secondUser.isHibernated).toBe(false);
			expect(secondUser.lastActiveDate).toEqual(firstUser.lastActiveDate);
		});
	});

	test('stale personal publication cannot cross hibernation and revival epochs', async () => {
		await withMigratedSchema(async ({ schema, query }) => {
			await seedUser(query, 'stale-publish', { withGeneratingBatch: true });
			await query('INSERT INTO "note" ("id") VALUES (\'stale-note\')');
			const runtime = makeRuntime();
			const sweep = runtime.makeSweepService(makeDataSource(schema));
			await sweep.service.process();
			const activity = runtime.makeUserService(makeDataSource(schema));
			const user = { id: 'stale-publish', isHibernated: true, lastActiveDate: new Date(0) } as MiUser;
			await activity.service.updateLastActiveDate(user);

			const staleClient = await openSchemaClient(schema);
			try {
				await staleClient.query('BEGIN');
				const publication = await staleClient.query(`INSERT INTO "hanami_user_feed_entry"
					("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "origin", "generatedAt")
					SELECT 'stale-entry', s."userId", 'stale-publish-epoch-0', 1, 'stale-publish-batch-0', 0,
						'stale-note', 'contract', 'personalCandidate', NOW()
					FROM "hanami_user_feed_state" s
					JOIN "hanami_user_feed_batch" b ON b."userId" = s."userId"
						AND b."epochId" = 'stale-publish-epoch-0' AND b."id" = 'stale-publish-batch-0'
					WHERE s."userId" = 'stale-publish' AND s."epochId" = 'stale-publish-epoch-0'
						AND b."status" = 'generating'
					RETURNING "id"`);
				expect(publication.rows).toEqual([]);
				await staleClient.query('COMMIT');
			} finally {
				await staleClient.query('ROLLBACK').catch(() => undefined);
				await staleClient.end().catch(() => undefined);
			}

			const rows = await query<{
				batch_status: string;
				current_epoch: string;
				isHibernated: boolean;
				isFollowerHibernated: boolean;
				entries: string;
			}>(`SELECT b."status" AS batch_status, s."epochId" AS current_epoch,
				u."isHibernated", f."isFollowerHibernated",
				(SELECT COUNT(*) FROM "hanami_user_feed_entry" WHERE "userId" = u."id")::text AS entries
				FROM "user" u JOIN "following" f ON f."followerId" = u."id"
				JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
				JOIN "hanami_user_feed_batch" b ON b."userId" = u."id"
				WHERE u."id" = 'stale-publish'`);
			expect(rows).toEqual([{
				batch_status: 'obsolete',
				current_epoch: 'revived-epoch-1',
				isHibernated: false,
				isFollowerHibernated: false,
				entries: '0',
			}]);
			expect(await query('SELECT COUNT(*)::text AS count FROM "hanami_common_generation"')).toEqual([{ count: '1' }]);
		});
	});
});
