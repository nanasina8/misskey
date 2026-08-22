/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import type { Config } from '@/config.js';
import { HanamiCommonHeadQueries } from '@/core/hanami/HanamiCommonHeadQueries.js';
import { HanamiPersistedFeedReadService } from '@/core/hanami/HanamiPersistedFeedReadService.js';
import { HanamiUserFeedGenerationService } from '@/core/hanami/HanamiUserFeedGenerationService.js';
import { HanamiUserFeedRequestService } from '@/core/hanami/HanamiUserFeedRequestService.js';
import type {
	HanamiPersonalFeedComputationPort,
	HanamiPersonalFeedComputationResult,
	HanamiPersistedFeedReadPort,
	HanamiUserFeedGenerationLifecyclePort,
	HanamiUserFeedRequestPort,
} from '@/core/hanami/HanamiUserFeedContracts.js';

const computation: HanamiPersonalFeedComputationPort = {
	algorithmVersion: 'unit-v1',
	computePersonalFeed: async () => ({ confidence: 'none', items: [], segmentLengths: [] }),
};

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
	hanamiGenerationSyncWaitMs: 0,
	hanamiGenerationWorkerTimeoutMs: 60_000,
	hanamiGenerationLeaseMs: 75_000,
	hanamiGenerationMaxAttempts: 3,
	...overrides,
} as Config);

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
};

const sleep = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('Hanami Phase 5 workstream B unit contracts', () => {
	test('implements all three frozen ports and rejects a malformed refresh before touching dependencies', async () => {
		const db = { createQueryRunner: jest.fn(), query: jest.fn() };
		const request = new HanamiUserFeedRequestService(
			db as never,
			makeConfig(),
			{ gen: jest.fn() } as never,
			{ getUserPolicies: jest.fn() } as never,
			{ enqueueHanamiUserFeedGeneration: jest.fn() } as never,
			{ getLogger: () => ({ warn: jest.fn() }) } as never,
			new HanamiCommonHeadQueries(),
		);
		const generation = new HanamiUserFeedGenerationService(db as never, makeConfig(), { gen: jest.fn() } as never, computation);
		const read = new HanamiPersistedFeedReadService(db as never);

		const requestPort: HanamiUserFeedRequestPort = request;
		const lifecyclePort: HanamiUserFeedGenerationLifecyclePort = generation;
		const readPort: HanamiPersistedFeedReadPort = read;
		expect(requestPort.checkAvailability).toBeInstanceOf(Function);
		expect(requestPort.evaluateCursorless).toBeInstanceOf(Function);
		expect(lifecyclePort.reconcileUserFeedGeneration).toBeInstanceOf(Function);
		expect(readPort.scanReadyEntries).toBeInstanceOf(Function);
		expect(readPort.resumeReadyEntries).toBeInstanceOf(Function);
		await expect(request.requestRefresh('user', 'not-base64url')).resolves.toEqual({ kind: 'invalidRefreshToken' });
		expect(db.createQueryRunner).not.toHaveBeenCalled();
		expect(db.query).not.toHaveBeenCalled();
	});

	test.each([
		{ policy: false, profileEnabled: false, expected: { kind: 'roleDisabled' }, expectsProfile: false },
		{ policy: true, profileEnabled: false, expected: { kind: 'recommendationDisabled', head: null }, expectsProfile: true },
		{ policy: true, profileEnabled: true, expected: { kind: 'available' }, expectsProfile: true },
	] as const)('checks availability without durable or queue side effects: $expected.kind', async ({ policy, profileEnabled, expected, expectsProfile }) => {
		const calls: string[] = [];
		const runner = {
			isTransactionActive: false,
			manager: undefined as unknown,
			connect: jest.fn(async () => undefined),
			startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
			commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			release: jest.fn(async () => undefined),
			query: jest.fn(async (sql: string) => {
				calls.push(sql.replaceAll(/\s+/g, ' ').trim());
				if (sql.includes('FROM "user" u')) return [{ id: 'user-1', is_hibernated: false }];
				if (sql.includes('FROM "user_profile" p')) return [{ enabled: profileEnabled }];
				return [];
			}),
		};
		runner.manager = { query: runner.query };
		const ids = { gen: jest.fn() };
		const role = { getUserPolicies: jest.fn(async () => ({ hanamiTlAvailable: policy })) };
		const queue = { enqueueHanamiUserFeedGeneration: jest.fn() };
		const db = { createQueryRunner: () => runner, query: jest.fn() };
		const service = new HanamiUserFeedRequestService(
			db as never,
			makeConfig({ hanamiGenerationSyncWaitMs: 1_000 }),
			ids as never,
			role as never,
			queue as never,
			{ getLogger: () => ({ warn: jest.fn() }) } as never,
			new HanamiCommonHeadQueries(),
		);

		await expect(service.checkAvailability('user-1')).resolves.toEqual(expected);
		expect(calls.some((sql) => sql.includes('FROM "user_profile" p'))).toBe(expectsProfile);
		expect(calls.every((sql) => !/^(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
		expect(ids.gen).not.toHaveBeenCalled();
		expect(queue.enqueueHanamiUserFeedGeneration).not.toHaveBeenCalled();
		expect(db.query).not.toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('common-head locking returns bigint text and validates the referenced ready generation', async () => {
		const calls: string[] = [];
		const scope = {
			query: jest.fn(async (sql: string) => {
				calls.push(sql.replaceAll(/\s+/g, ' ').trim());
				if (sql.includes('hanami_common_feed_state')) {
					return [{ epoch_id: 'common-epoch', generation_id: 'common-generation', head_sequence: '9007199254740993' }];
				}
				return [{ id: 'common-generation', status: 'ready' }];
			}),
		};
		const queries = new HanamiCommonHeadQueries();
		await expect(queries.lockLatestReadyCommonHead(scope as never)).resolves.toEqual({
			epochId: 'common-epoch', generationId: 'common-generation', headSequence: '9007199254740993',
		});
		expect(calls[0]).toContain('s."latestSequence"::text AS head_sequence');
		expect(calls[0]).toContain('FOR UPDATE OF s');
		expect(calls[1]).toContain('FOR UPDATE OF g');

		scope.query.mockImplementation(async (sql: string) => sql.includes('hanami_common_feed_state')
			? [{ epoch_id: 'common-epoch', generation_id: 'common-generation', head_sequence: '3' }]
			: [{ id: 'common-generation', status: 'generating' }]);
		await expect(queries.lockLatestReadyCommonHead(scope as never)).rejects.toThrow('expected ready');
	});

	test('validates bounded personal computation shape before publication', () => {
		const service = new HanamiUserFeedGenerationService({} as never, makeConfig(), {} as never, computation);
		const internals = service as unknown as { validateComputation(result: HanamiPersonalFeedComputationResult): void };
		const valid: HanamiPersonalFeedComputationResult = {
			confidence: 'high',
			items: [{
				noteId: 'note-1', source: 'catchup', sources: ['catchup'], origin: 'personalCandidate',
				reasonMetadata: { version: 1, bucket: 'recent' },
			}],
			segmentLengths: [1],
		};
		expect(() => internals.validateComputation(valid)).not.toThrow();
		expect(() => internals.validateComputation({ ...valid, segmentLengths: [2] })).toThrow('do not match');
		expect(() => internals.validateComputation({ ...valid, items: [valid.items[0]!, valid.items[0]!], segmentLengths: [2] })).toThrow('duplicate Note');
	});

	test('hard-bounds a claim whose QueryRunner connection never settles and releases it if connection settles late', async () => {
		const connected = deferred<void>();
		const runner = {
			isTransactionActive: false,
			connect: jest.fn(async () => await connected.promise),
			startTransaction: jest.fn(async () => undefined),
			commitTransaction: jest.fn(async () => undefined),
			rollbackTransaction: jest.fn(async () => undefined),
			release: jest.fn(async () => undefined),
			query: jest.fn(async () => []),
		};
		const service = new HanamiUserFeedGenerationService(
			{ createQueryRunner: () => runner } as never,
			makeConfig({ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 }),
			{ gen: jest.fn() } as never,
			computation,
		);

		await expect(service.runUserFeedGeneration('blocked-batch')).rejects.toThrow('worker timeout');
		expect(runner.startTransaction).not.toHaveBeenCalled();
		connected.resolve();
		await sleep();
		await sleep();
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test.each(['base-common readiness', 'heartbeat'] as const)('deadline-routes a stalled %s query through its own QueryRunner and cleans up', async (operation) => {
		const stalled = deferred<unknown[]>();
		const calls: string[] = [];
		const runner = {
			isTransactionActive: false,
			connect: jest.fn(async () => undefined),
			startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
			commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			release: jest.fn(async () => undefined),
			query: jest.fn(async (sql: string) => {
				calls.push(sql.replaceAll(/\s+/g, ' ').trim());
				if (sql.includes("set_config('statement_timeout'")) return [{}];
				return await stalled.promise;
			}),
		};
		const dataSourceQuery = jest.fn(async () => {
			throw new Error('deadline-scoped worker SQL must not use DataSource.query');
		});
		const service = new HanamiUserFeedGenerationService(
			{ createQueryRunner: () => runner, query: dataSourceQuery } as never,
			makeConfig({ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 }),
			{ gen: jest.fn() } as never,
			computation,
		);
		const timeoutError = new Error(`${operation} timed out`);
		const budget = {
			controller: new AbortController(),
			monotonicDeadline: performance.now() + 25,
			databaseDeadlineAt: '2099-08-20T00:00:00.000000Z',
			timeoutError,
			dispose: () => undefined,
		};
		const claim = {
			batchId: 'batch-1',
			userId: 'user-1',
			epochId: 'epoch-1',
			trigger: 'initial' as const,
			attempt: 2,
			leaseOwner: 'owner-2',
			baseCommonGenerationId: 'common-1',
			generatedAt: '2026-08-20T00:00:00.000000Z',
		};
		const internals = service as unknown as {
			confirmBaseCommonGenerationReady(activeClaim: typeof claim, activeBudget: typeof budget): Promise<void>;
			heartbeat(activeClaim: typeof claim, activeBudget: typeof budget): Promise<boolean>;
		};

		const invocation = operation === 'base-common readiness'
			? internals.confirmBaseCommonGenerationReady(claim, budget)
			: internals.heartbeat(claim, budget);
		await expect(invocation).rejects.toBe(timeoutError);
		stalled.resolve([]);
		await sleep();
		await sleep();

		expect(dataSourceQuery).not.toHaveBeenCalled();
		expect(calls.filter((sql) => sql.includes("set_config('statement_timeout'"))).toHaveLength(2);
		const stalledSql = calls.at(-1)!;
		if (operation === 'base-common readiness') {
			expect(stalledSql).toContain('FROM "hanami_common_generation" g');
		} else {
			expect(stalledSql).toContain('UPDATE "hanami_user_feed_batch" b');
			expect(stalledSql).toContain('b."leaseOwner" = $2 AND b."attempts" = $3');
			expect(stalledSql).toContain('b."leaseExpiresAt" > clock_timestamp()');
		}
		expect(calls.some((sql) => sql.includes('SET "status" = \'failed\'') || sql.includes('SET "status" = \'pending\''))).toBe(false);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('raw scans use ready-parent joins, strict bounds, descending order, and scanLimit plus one', async () => {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const query = jest.fn(async (sql: string, values: unknown[] = []) => {
				calls.push({ sql: sql.replaceAll(/\s+/g, ' ').trim(), values });
				if (sql.includes('FROM "user" u')) return [{ id: 'user-1', is_hibernated: false }];
				if (sql.includes('FROM "hanami_user_feed_state" s')) return [{ epoch_id: 'epoch-1', mode: 'common', earliest_retained_sequence: '1' }];
				if (sql.includes('FROM "hanami_user_feed_epoch" e')) return [{ epoch_id: 'epoch-1', retired_at: null }];
				if (sql.includes('FROM "hanami_user_feed_batch" b') && sql.includes('FOR UPDATE OF b')) return [{ id: 'batch-1' }];
				return [
					{ epoch_id: 'epoch-1', sequence: '9', batch_id: 'batch-1', note_id: 'note-1', source: 'catchup', sources: ['catchup'], origin: 'personalCandidate', reason_metadata: { version: 1 } },
					{ epoch_id: 'epoch-1', sequence: '8', batch_id: 'batch-1', note_id: 'note-2', source: 'catchup', sources: ['catchup'], origin: 'personalCandidate', reason_metadata: { version: 1 } },
				];
			});
		const runner = {
			isTransactionActive: false,
			connect: jest.fn(async () => undefined),
			startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
			commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			release: jest.fn(async () => undefined),
			query,
		};
		const db = { createQueryRunner: () => runner };
		const service = new HanamiPersistedFeedReadService(db as never);
		await expect(service.scanReadyEntries({
			requesterUserId: 'user-1',
			head: { mode: 'personalized', kind: 'personal', feedEpochId: 'epoch-1', headBatchId: 'batch-1', headSequence: '9' },
			beforeSequence: null,
			scanLimit: 1,
		})).resolves.toMatchObject({ kind: 'page', hasMore: true, lastScannedSequence: '9' });
		expect(calls.map((call) => call.sql)).toEqual([
			expect.stringMatching(/FROM "user" u .*FOR UPDATE OF u/),
			expect.stringMatching(/FROM "hanami_user_feed_state" s .*FOR UPDATE OF s/),
			expect.stringMatching(/FROM "hanami_user_feed_epoch" e .*FOR UPDATE OF e/),
			expect.stringMatching(/FROM "hanami_user_feed_batch" b .*FOR UPDATE OF b/),
			expect.stringMatching(/JOIN "hanami_user_feed_batch" b .*b\."status" = 'ready'.*e\."sequence" <= \$3::bigint.*e\."sequence" < \$4::bigint.*ORDER BY e\."sequence" DESC/),
		]);
		expect(calls[4]!.values.at(-1)).toBe(2);
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('personal cursor resume uses the current ready head, ignores mode, and never looks up the anchor or falls through to common', async () => {
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		const query = jest.fn(async (sql: string, values: unknown[] = []) => {
			calls.push({ sql: sql.replaceAll(/\s+/g, ' ').trim(), values });
			if (sql.includes('FROM "user" u')) return [{ id: 'user-1', is_hibernated: false }];
			if (sql.includes('FROM "hanami_user_feed_state" s')) {
				return [{
					epoch_id: 'epoch-1',
					latest_ready_batch_id: 'batch-new',
					latest_sequence: '12',
					earliest_retained_sequence: '1',
					mode: 'common',
				}];
			}
			if (sql.includes('FROM "hanami_user_feed_epoch" e')) return [{ epoch_id: 'epoch-1', retired_at: null }];
			if (sql.includes('FROM "hanami_user_feed_batch" b') && sql.includes('FOR UPDATE OF b')) return [{ id: 'batch-new' }];
			return [
				{ epoch_id: 'epoch-1', sequence: '8', batch_id: 'batch-old', note_id: 'note-1', source: 'catchup', sources: ['catchup'], origin: 'personalCandidate', reason_metadata: { version: 1 } },
				{ epoch_id: 'epoch-1', sequence: '7', batch_id: 'batch-old', note_id: 'note-2', source: 'catchup', sources: ['catchup'], origin: 'personalCandidate', reason_metadata: { version: 1 } },
			];
		});
		const runner = {
			isTransactionActive: false,
			connect: jest.fn(async () => undefined),
			startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
			commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
			release: jest.fn(async () => undefined),
			query,
		};
		const service = new HanamiPersistedFeedReadService({ createQueryRunner: () => runner } as never);

		await expect(service.resumeReadyEntries({
			requesterUserId: 'user-1',
			cursor: { kind: 'personal', feedEpochId: 'epoch-1', sequence: '9' },
			scanLimit: 1,
		})).resolves.toMatchObject({
			kind: 'page',
			head: { kind: 'personal', headBatchId: 'batch-new', headSequence: '12' },
			entries: [{ sequence: '8' }],
			lastScannedSequence: '8',
			hasMore: true,
		});
		expect(calls.map((call) => call.sql)).toEqual([
			expect.stringMatching(/FROM "user" u .*FOR UPDATE OF u/),
			expect.stringMatching(/FROM "hanami_user_feed_state" s .*FOR UPDATE OF s/),
			expect.stringMatching(/FROM "hanami_user_feed_epoch" e .*FOR UPDATE OF e/),
			expect.stringMatching(/FROM "hanami_user_feed_batch" b .*b\."status" = 'ready'.*FOR UPDATE OF b/),
			expect.stringMatching(/JOIN "hanami_user_feed_batch" b .*b\."status" = 'ready'.*e\."sequence" < \$3::bigint.*ORDER BY e\."sequence" DESC/),
		]);
		expect(calls.some((call) => call.sql.includes('hanami_common_feed'))).toBe(false);
		expect(calls[4]!.values).toEqual(['user-1', 'epoch-1', '9', 2]);
		expect(calls[4]!.sql).not.toMatch(/e\."sequence"\s*=\s*\$\d/);
	});
});
