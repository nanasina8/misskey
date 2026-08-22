/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import type { Config } from '@/config.js';
import { HanamiCommonGenerationService } from '@/core/hanami/HanamiCommonGenerationService.js';
import type {
	HanamiCommonComputationPort,
	HanamiCommonFeedMaterialization,
	HanamiCommonGenerationLifecyclePort,
	HanamiCommonGenerationReadPort,
	HanamiCommonSourceBundle,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';

const timestamp = '2026-08-20T00:00:00.000Z';

const makeBundle = (): HanamiCommonSourceBundle => ({
	version: 1,
	capturedAt: timestamp,
	sourceAsOf: {
		version: 1,
		capturedAt: timestamp,
		featuredAt: timestamp,
		trendAt: timestamp,
		axisConfigAt: timestamp,
	},
	enabledAxes: ['globalPopular', 'trending', 'exploration'],
	candidates: {
		globalPopular: [{ noteId: 'note-global', authorId: 'author-global', baseScore: 3, metadata: {} }],
		trending: [{ noteId: 'note-trend', authorId: 'author-trend', baseScore: 2, metadata: { term: 'term' } }],
		exploration: [{ noteId: 'note-explore', authorId: 'author-explore', baseScore: 1, metadata: {} }],
	},
	trendSnapshot: {
		terms: [{ term: 'term', score: 2, distinctAuthors: 1, representativeNoteIds: ['note-trend'] }],
	},
});

const makeMaterialization = (): HanamiCommonFeedMaterialization => ({
	items: [
		{ noteId: 'note-global', authorId: 'author-global', source: 'globalPopular', sources: ['globalPopular'] },
		{ noteId: 'note-trend', authorId: 'author-trend', source: 'trending', sources: ['trending'] },
		{ noteId: 'note-explore', authorId: 'author-explore', source: 'exploration', sources: ['exploration'] },
	],
	segmentLengths: [3],
});

const config = {
	hanamiCommonGenerationIntervalMs: 600_000,
	hanamiGenerationWorkerTimeoutMs: 60_000,
	hanamiGenerationLeaseMs: 75_000,
} as Config;

const computation: HanamiCommonComputationPort = {
	algorithmVersion: 'unit-v1',
	buildSourceBundle: async () => makeBundle(),
	materializeFeed: () => makeMaterialization(),
};

type ServiceInternals = {
	validateSourceBundle(source: HanamiCommonSourceBundle): unknown[];
	validateSnapshotRepresentativeEligibility(source: HanamiCommonSourceBundle): Promise<void>;
	validateMaterialization(source: HanamiCommonSourceBundle, materialization: HanamiCommonFeedMaterialization): void;
};

const makeService = (
	db: object = {},
	ids: string[] = ['generation-id', 'snapshot-id'],
	filterCommonEligibleNotes: (noteIds: readonly string[]) => Promise<ReadonlyMap<string, string>> = async (noteIds) => new Map(noteIds.map((noteId) => [noteId, `author:${noteId}`])),
	configOverrides: Partial<Config> = {},
	computationOverride: HanamiCommonComputationPort = computation,
): HanamiCommonGenerationService => {
	let idIndex = 0;
	return new HanamiCommonGenerationService(
		db as never,
		{ ...config, ...configOverrides } as Config,
		{ gen: jest.fn(() => ids[idIndex++] ?? `id-${idIndex}`) } as never,
		{ ensureMonthAvailable: jest.fn(async () => undefined) } as never,
		{ filterCommonEligibleNotes: jest.fn(filterCommonEligibleNotes) } as never,
		computationOverride,
	);
};

const makeRunner = () => {
	const runner = {
		isTransactionActive: false,
		connect: jest.fn(async () => undefined),
		startTransaction: jest.fn(async () => {
			runner.isTransactionActive = true;
		}),
		commitTransaction: jest.fn(async () => {
			runner.isTransactionActive = false;
		}),
		rollbackTransaction: jest.fn(async () => {
			runner.isTransactionActive = false;
		}),
		release: jest.fn(async () => undefined),
		query: jest.fn(async (_sql: string, _values?: unknown[]) => [] as unknown[]),
	};
	return runner;
};

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

describe('HanamiCommonGenerationService', () => {
	test('implements both frozen lifecycle and read ports', () => {
		const service = makeService();
		const lifecycle: HanamiCommonGenerationLifecyclePort = service;
		const read: HanamiCommonGenerationReadPort = service;

		expect(lifecycle.requestCommonGeneration).toBeInstanceOf(Function);
		expect(lifecycle.runCommonGeneration).toBeInstanceOf(Function);
		expect(lifecycle.findDispatchableCommonGeneration).toBeInstanceOf(Function);
		expect(read.getLatestReadyCommonHead).toBeInstanceOf(Function);
		expect(read.loadReadyCommonCandidates).toBeInstanceOf(Function);
	});

	test('loads ready common candidates on a caller-owned runner without using the DataSource or managing the runner', async () => {
		const dataSourceQuery = jest.fn(async () => []);
		const runner = makeRunner();
		runner.query.mockResolvedValueOnce([{
			axis: 'trending',
			rank: '9007199254740993',
			note_id: 'note-1',
			base_score: 1.25,
			metadata: { term: 'hanami' },
		}]);
		const service = makeService({ query: dataSourceQuery });
		const controller = new AbortController();

		await expect(service.loadReadyCommonCandidates('generation-1', {
			queryRunner: runner as never,
			signal: controller.signal,
			databaseDeadlineAt: '2026-08-20T00:01:00.000Z',
		})).resolves.toEqual([{
			axis: 'trending',
			rank: '9007199254740993',
			noteId: 'note-1',
			baseScore: 1.25,
			metadata: { term: 'hanami' },
		}]);

		expect(dataSourceQuery).not.toHaveBeenCalled();
		expect(runner.query).toHaveBeenCalledTimes(1);
		const [sql, values] = runner.query.mock.calls[0]!;
		expect(sql).toContain('c."generatedMonth" = date_trunc(\'month\', g."startedAt")::date');
		expect(sql).toContain('c."generationFence" = g."generationFence"');
		expect(sql).toContain('g."status" = \'ready\'');
		expect(sql).toContain('c."rank"::text AS rank');
		expect(sql).toContain('ORDER BY CASE c."axis"');
		expect(sql).not.toContain('set_config');
		expect(sql).not.toContain('LIMIT');
		expect(values).toEqual(['generation-1']);
		expect(runner.connect).not.toHaveBeenCalled();
		expect(runner.startTransaction).not.toHaveBeenCalled();
		expect(runner.commitTransaction).not.toHaveBeenCalled();
		expect(runner.release).not.toHaveBeenCalled();
	});

	test('propagates caller aborts before and after the caller-owned runner query', async () => {
		const dataSourceQuery = jest.fn(async () => []);
		const service = makeService({ query: dataSourceQuery });
		const beforeRunner = makeRunner();
		const beforeController = new AbortController();
		const beforeError = new Error('aborted before common read');
		beforeController.abort(beforeError);

		await expect(service.loadReadyCommonCandidates('generation-before', {
			queryRunner: beforeRunner as never,
			signal: beforeController.signal,
			databaseDeadlineAt: '2026-08-20T00:01:00.000Z',
		})).rejects.toBe(beforeError);
		expect(beforeRunner.query).not.toHaveBeenCalled();

		const afterRunner = makeRunner();
		const afterController = new AbortController();
		const afterError = new Error('aborted after common read');
		afterRunner.query.mockImplementationOnce(async () => {
			afterController.abort(afterError);
			return [];
		});

		await expect(service.loadReadyCommonCandidates('generation-after', {
			queryRunner: afterRunner as never,
			signal: afterController.signal,
			databaseDeadlineAt: '2026-08-20T00:01:00.000Z',
		})).rejects.toBe(afterError);
		expect(afterRunner.query).toHaveBeenCalledTimes(1);
		expect(dataSourceQuery).not.toHaveBeenCalled();
	});

	test('keeps the legacy one-argument common candidate read on the DataSource', async () => {
		const dataSourceQuery = jest.fn(async (_sql: string, _values?: unknown[]) => [{
			axis: 'globalPopular',
			rank: '1',
			note_id: 'legacy-note',
			base_score: 3,
			metadata: {},
		}]);
		const service = makeService({ query: dataSourceQuery });

		await expect(service.loadReadyCommonCandidates('legacy-generation')).resolves.toEqual([{
			axis: 'globalPopular',
			rank: '1',
			noteId: 'legacy-note',
			baseScore: 3,
			metadata: {},
		}]);
		expect(dataSourceQuery).toHaveBeenCalledTimes(1);
		expect(dataSourceQuery.mock.calls[0]![1]).toEqual(['legacy-generation']);
	});

	test('serializes a seed request, keeps bigint values as decimal text, and creates generation plus snapshot IDs', async () => {
		const runner = makeRunner();
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		runner.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) {
				return [{
					epoch_id: null,
					latest_sequence: '0',
					earliest_retained_sequence: '0',
					latest_ready_generation_id: null,
					generating_generation_id: null,
					generation_lease_owner: null,
					generation_lease_expires_at: null,
					generation_fence: '9007199254740993',
					lease_is_live: false,
				}];
			}
			if (sql.includes('COALESCE(MAX(g."ordinal"')) return [{ ordinal: '9007199254740994' }];
			if (sql.includes('UPDATE "hanami_common_feed_state"') && sql.includes('RETURNING "generationFence"::text')) {
				return [{ generation_fence: '9007199254740993' }];
			}
			return [];
		});
		const service = makeService({ createQueryRunner: () => runner }, ['generation-id', 'snapshot-id']);

		await expect(service.requestCommonGeneration('seed')).resolves.toEqual({ kind: 'dispatch', generationId: 'generation-id' });
		expect(calls[0]!.sql).toContain("pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hanami.timeline.common-generation', 0))");
		const generationInsert = calls.find((call) => call.sql.includes('WITH inserted_generation'))!;
		expect(generationInsert.values).toEqual([
			'generation-id',
			'9007199254740994',
			'unit-v1',
			'9007199254740993',
			'snapshot-id',
		]);
		expect(generationInsert.sql).toContain('clock_timestamp()');
		expect(generationInsert.sql).toContain("'{}'::jsonb");
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('guards scheduled requests by UTC interval bucket rather than exact elapsed duration', async () => {
		const runner = makeRunner();
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		runner.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) {
				return [{
					epoch_id: 'epoch-1',
					latest_sequence: '3',
					earliest_retained_sequence: '1',
					latest_ready_generation_id: 'ready-1',
					generating_generation_id: null,
					generation_lease_owner: null,
					generation_lease_expires_at: null,
					generation_fence: '9007199254740993',
					lease_is_live: false,
				}];
			}
			if (sql.includes('AS due')) return [{ due: false }];
			return [];
		});
		const service = makeService({ createQueryRunner: () => runner });

		await expect(service.requestCommonGeneration('scheduled')).resolves.toEqual({ kind: 'noop', reason: 'notDue' });
		const dueCall = calls.find((call) => call.sql.includes('AS due'))!;
		expect(dueCall.values).toEqual(['600000']);
		expect(dueCall.sql).toContain('floor(EXTRACT(EPOCH FROM g."startedAt") * 1000 / $1::numeric)');
		expect(dueCall.sql).toContain('floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 / $1::numeric)');
		expect(dueCall.sql).not.toContain('g."startedAt" +');
	});

	test('uses a PostgreSQL-derived deadline despite app wall-clock skew and retains it through staging', async () => {
		const appWallClock = Date.parse('1999-01-01T00:00:00.000Z');
		const databaseDeadline = '2026-08-20T00:01:00.123456Z';
		let sourceSignal: AbortSignal | undefined;
		const deadlineComputation: HanamiCommonComputationPort = {
			...computation,
			buildSourceBundle: async (input) => {
				sourceSignal = input.signal;
				return makeBundle();
			},
		};
		const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(appWallClock);
		const runner = makeRunner();
		const calls: Array<{ sql: string; values: unknown[] }> = [];
		let leaseOwner: string | undefined;
		let stateLocks = 0;
		runner.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (sql.includes('pg_catalog.clock_timestamp() +')) return [{ deadline_at: databaseDeadline }];
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) {
				stateLocks++;
				return [{
					epoch_id: null,
					latest_sequence: '0',
					earliest_retained_sequence: '0',
					latest_ready_generation_id: null,
					generating_generation_id: 'generation-id',
					generation_lease_owner: stateLocks === 1 ? null : leaseOwner,
					generation_lease_expires_at: stateLocks === 1 ? null : new Date('2026-08-20T00:02:00.000Z'),
					generation_fence: stateLocks === 1 ? '0' : '1',
					lease_is_live: stateLocks !== 1,
				}];
			}
			if (sql.includes('FROM "hanami_common_generation" g') && sql.includes('FOR UPDATE')) {
				return [{
					status: stateLocks === 1 ? 'pending' : 'generating',
					ordinal: '1',
					started_at: timestamp,
					generation_fence: stateLocks === 1 ? '0' : '1',
				}];
			}
			if (sql.includes('SET "generationFence" = "generationFence" +')) {
				leaseOwner = values[2] as string;
				return [{ generation_fence: '1', epoch_id: null }];
			}
			if (sql.includes('SET "status" = \'generating\'')) return [{ started_at: timestamp, generation_fence: '1' }];
			if (sql.includes('SET "sourceAsOf"')) return [{ generation_fence: '1' }];
			if (sql.includes('SET "generationLeaseExpiresAt"') && sql.includes('clock_timestamp() < $6::timestamptz')) return [{ generation_fence: '1' }];
			return [];
		});
		const service = makeService(
			{
				createQueryRunner: () => runner,
				query: async () => [],
			},
			['generation-id', 'snapshot-id'],
			undefined,
			{},
			deadlineComputation,
		);
		const publication = service as unknown as {
			publishGeneration: (...args: unknown[]) => Promise<{ kind: 'published' }>;
		};
		publication.publishGeneration = jest.fn(async (): Promise<{ kind: 'published' }> => ({ kind: 'published' }));

		try {
			await expect(service.runCommonGeneration('generation-id')).resolves.toEqual({
				kind: 'published',
				generationId: 'generation-id',
				generationFence: '1',
				itemCount: 3,
			});
		} finally {
			nowSpy.mockRestore();
		}

		const budgetCalls = calls.filter((call) => call.sql.includes("set_config('statement_timeout'"));
		expect(calls[0]!.sql).toContain('pg_catalog.clock_timestamp() +');
		expect(calls[0]!.values).toHaveLength(1);
		expect(budgetCalls.length).toBeGreaterThan(2);
		expect(new Set(budgetCalls.map((call) => call.values[0]))).toEqual(new Set([databaseDeadline]));
		const stagingCas = calls.find((call) => call.sql.includes('clock_timestamp() < $6::timestamptz'))!;
		expect(stagingCas.values[5]).toBe(databaseDeadline);
		const partitionService = (service as unknown as {
			partitionService: { ensureMonthAvailable: (date: Date, context?: { signal?: AbortSignal; databaseDeadlineAt?: string }) => Promise<void> };
		}).partitionService;
		const partitionCall = jest.mocked(partitionService.ensureMonthAvailable).mock.calls[0]!;
		expect(partitionCall[0]).toEqual(new Date('2026-08-01T00:00:00.000Z'));
		expect(partitionCall[1]?.signal).toBe(sourceSignal);
		expect(partitionCall[1]?.databaseDeadlineAt).toBe(databaseDeadline);
		expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
	});

	test('bounds a never-settling QueryRunner.connect without starting transaction work', async () => {
		const runner = makeRunner();
		const neverConnect = deferred<void>();
		runner.connect.mockImplementation(async () => {
			await neverConnect.promise;
			return undefined;
		});
		const service = makeService(
			{ createQueryRunner: () => runner },
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 },
		);

		await expect(service.runCommonGeneration('never-connect')).rejects.toThrow('worker timeout');
		expect(runner.startTransaction).not.toHaveBeenCalled();
		expect(runner.query).not.toHaveBeenCalled();
		expect(runner.release).not.toHaveBeenCalled();
		neverConnect.resolve();
		await sleep(0);
		await sleep(0);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('performs diagnostic-only late release when connect settles after the budget', async () => {
		const runner = makeRunner();
		const lateConnect = deferred<void>();
		runner.connect.mockImplementation(async () => {
			await lateConnect.promise;
			return undefined;
		});
		const service = makeService(
			{ createQueryRunner: () => runner },
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 },
		);

		await expect(service.runCommonGeneration('late-connect')).rejects.toThrow('worker timeout');
		lateConnect.resolve();
		await sleep(0);
		await sleep(0);

		expect(runner.startTransaction).not.toHaveBeenCalled();
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('bounds a never-settling startTransaction before SQL or business work', async () => {
		const runner = makeRunner();
		const neverStart = deferred<void>();
		runner.startTransaction.mockImplementation(async () => await neverStart.promise);
		runner.query.mockImplementation(async (sql: string) => sql.includes('pg_catalog.clock_timestamp() +')
			? [{ deadline_at: '2026-08-20T00:01:00.000000Z' }]
			: []);
		const service = makeService(
			{ createQueryRunner: () => runner },
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 },
		);

		await expect(service.runCommonGeneration('never-start')).rejects.toThrow('worker timeout');
		expect(runner.query).not.toHaveBeenCalled();
		expect(runner.rollbackTransaction).not.toHaveBeenCalled();
		expect(runner.release).not.toHaveBeenCalled();
		neverStart.resolve();
		await sleep(0);
		await sleep(0);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('rolls back and releases when startTransaction settles after the budget', async () => {
		const runner = makeRunner();
		const lateStart = deferred<void>();
		runner.startTransaction.mockImplementation(async () => {
			await lateStart.promise;
			runner.isTransactionActive = true;
		});
		runner.query.mockImplementation(async (sql: string) => sql.includes('pg_catalog.clock_timestamp() +')
			? [{ deadline_at: '2026-08-20T00:01:00.000000Z' }]
			: []);
		const service = makeService(
			{ createQueryRunner: () => runner },
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 },
		);

		await expect(service.runCommonGeneration('late-start')).rejects.toThrow('worker timeout');
		lateStart.resolve();
		await sleep(0);
		await sleep(0);

		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('does not continue a claim callback when its blocked query settles after rejection', async () => {
		const runner = makeRunner();
		const lateState = deferred<unknown[]>();
		const calls: string[] = [];
		runner.query.mockImplementation(async (sql: string) => {
			calls.push(sql);
			if (sql.includes('pg_catalog.clock_timestamp() +')) return [{ deadline_at: '2026-08-20T00:01:00.000000Z' }];
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) return await lateState.promise;
			return [];
		});
		const service = makeService(
			{ createQueryRunner: () => runner },
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 25, hanamiGenerationLeaseMs: 100 },
		);

		await expect(service.runCommonGeneration('late-query')).rejects.toThrow('worker timeout');
		lateState.resolve([]);
		await sleep(0);
		await sleep(0);

		expect(calls.some((sql) => sql.includes('FROM "hanami_common_generation" g') && sql.includes('FOR UPDATE'))).toBe(false);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('does not start failure resolution after the monotonic budget expires', async () => {
		jest.useFakeTimers();
		const monotonicNow = jest.spyOn(performance, 'now').mockReturnValue(1_000);
		const runner = makeRunner();
		const source = deferred<HanamiCommonSourceBundle>();
		const sourceStarted = deferred<void>();
		let sourceSignal: AbortSignal | undefined;
		const createQueryRunner = jest.fn(() => runner);
		runner.query.mockImplementation(async (sql: string) => {
			if (sql.includes('pg_catalog.clock_timestamp() +')) return [{ deadline_at: '2026-08-20T00:01:00.000000Z' }];
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) {
				return [{
					epoch_id: null,
					latest_sequence: '0',
					earliest_retained_sequence: '0',
					latest_ready_generation_id: null,
					generating_generation_id: 'generation-id',
					generation_lease_owner: null,
					generation_lease_expires_at: null,
					generation_fence: '0',
					lease_is_live: false,
				}];
			}
			if (sql.includes('FROM "hanami_common_generation" g') && sql.includes('FOR UPDATE')) {
				return [{ status: 'pending', ordinal: '1', started_at: timestamp, generation_fence: '0' }];
			}
			if (sql.includes('SET "generationFence" = "generationFence" +')) return [{ generation_fence: '1', epoch_id: null }];
			if (sql.includes('SET "status" = \'generating\'')) return [{ started_at: timestamp, generation_fence: '1' }];
			return [];
		});
		const timeoutComputation: HanamiCommonComputationPort = {
			algorithmVersion: 'timeout-v1',
			buildSourceBundle: async (input) => {
				sourceSignal = input.signal;
				sourceStarted.resolve();
				return await source.promise;
			},
			materializeFeed: () => makeMaterialization(),
		};
		const service = makeService(
			{
				createQueryRunner,
				query: async (sql: string) => sql.includes('UPDATE "hanami_common_feed_state" s') ? [{ generation_fence: '1' }] : [],
			},
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 35, hanamiGenerationLeaseMs: 100 },
			timeoutComputation,
		);

		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			const operation = service.runCommonGeneration('generation-id');
			const outcome = operation.catch((error: unknown) => error);
			await sourceStarted.promise;

			// Reproduce the boundary: the hard timer fires while a fresh floor() can still report 1ms.
			monotonicNow.mockReturnValue(1_034);
			await jest.advanceTimersByTimeAsync(35);
			const timeoutError = sourceSignal!.reason;

			expect(await outcome).toBe(timeoutError);
			expect(timeoutError).toBeInstanceOf(Error);
			expect(createQueryRunner).toHaveBeenCalledTimes(1);
			expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
			expect(runner.release).toHaveBeenCalledTimes(1);
			expect(runner.query.mock.calls.some(([sql]) => (sql as string).includes('FROM "hanami_trend_snapshot" t'))).toBe(false);
			expect(runner.query.mock.calls.some(([sql]) => (sql as string).includes('SET "status" = \'failed\''))).toBe(false);

			source.resolve(makeBundle());
			await jest.advanceTimersByTimeAsync(0);
			await Promise.resolve();
			expect(createQueryRunner).toHaveBeenCalledTimes(1);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
			monotonicNow.mockRestore();
			jest.useRealTimers();
		}
	});

	test('resolves a non-timeout source failure while guarded budget remains', async () => {
		const primary = new Error('source failed before deadline');
		const claimRunner = makeRunner();
		const failureRunner = makeRunner();
		let leaseOwner: string | undefined;

		claimRunner.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
			if (sql.includes('pg_catalog.clock_timestamp() +')) return [{ deadline_at: '2026-08-20T00:01:00.000000Z' }];
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) {
				return [{
					epoch_id: null,
					latest_sequence: '0',
					earliest_retained_sequence: '0',
					latest_ready_generation_id: null,
					generating_generation_id: 'generation-id',
					generation_lease_owner: null,
					generation_lease_expires_at: null,
					generation_fence: '0',
					lease_is_live: false,
				}];
			}
			if (sql.includes('FROM "hanami_common_generation" g') && sql.includes('FOR UPDATE')) {
				return [{ status: 'pending', ordinal: '1', started_at: timestamp, generation_fence: '0' }];
			}
			if (sql.includes('SET "generationFence" = "generationFence" +')) {
				leaseOwner = values[2] as string;
				return [{ generation_fence: '1', epoch_id: null }];
			}
			if (sql.includes('SET "status" = \'generating\'')) return [{ started_at: timestamp, generation_fence: '1' }];
			return [];
		});
		failureRunner.query.mockImplementation(async (sql: string) => {
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('FROM "hanami_common_feed_state" s') && sql.includes('FOR UPDATE')) {
				return [{
					epoch_id: null,
					latest_sequence: '0',
					earliest_retained_sequence: '0',
					latest_ready_generation_id: null,
					generating_generation_id: 'generation-id',
					generation_lease_owner: leaseOwner,
					generation_lease_expires_at: new Date('2026-08-20T00:02:00.000Z'),
					generation_fence: '1',
					lease_is_live: true,
				}];
			}
			if (sql.includes('FROM "hanami_common_generation" g') && sql.includes('FOR UPDATE')) {
				return [{ status: 'generating', ordinal: '1', started_at: timestamp, generation_fence: '1' }];
			}
			if (sql.includes('FROM "hanami_trend_snapshot" t')) return [{ status: 'pending' }];
			if (sql.includes('UPDATE "hanami_common_generation"') && sql.includes('SET "status" = \'failed\'')) return [{ generation_fence: '1' }];
			if (sql.includes('UPDATE "hanami_trend_snapshot"') && sql.includes('SET "status" = \'failed\'')) return [{ ordinal: '1' }];
			if (sql.includes('SET "generatingGenerationId" = NULL')) return [{ generation_fence: '1' }];
			return [];
		});
		const createQueryRunner = jest.fn()
			.mockReturnValueOnce(claimRunner)
			.mockReturnValueOnce(failureRunner);
		const failingComputation: HanamiCommonComputationPort = {
			...computation,
			buildSourceBundle: async () => {
				throw primary;
			},
		};
		const service = makeService(
			{ createQueryRunner, query: async () => [] },
			[],
			undefined,
			{},
			failingComputation,
		);

		await expect(service.runCommonGeneration('generation-id')).rejects.toBe(primary);
		expect(createQueryRunner).toHaveBeenCalledTimes(2);
		expect(failureRunner.query.mock.calls.some(([sql]) => (sql as string).includes('FROM "hanami_trend_snapshot" t'))).toBe(true);
		expect(failureRunner.query.mock.calls.some(([sql]) => (sql as string).includes('SET "status" = \'failed\''))).toBe(true);
		expect(failureRunner.query.mock.calls.some(([sql]) => (sql as string).includes('SET "generatingGenerationId" = NULL'))).toBe(true);
		expect(failureRunner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(failureRunner.release).toHaveBeenCalledTimes(1);
	});

	test('bounds a stuck rollback without replacing the primary transaction error', async () => {
		const runner = makeRunner();
		const primary = new Error('claim query failed');
		const neverRollback = deferred<void>();
		runner.rollbackTransaction.mockImplementation(async () => await neverRollback.promise);
		runner.query.mockImplementation(async (sql: string) => {
			if (sql.includes('pg_catalog.clock_timestamp() +')) return [{ deadline_at: '2026-08-20T00:01:00.000000Z' }];
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			throw primary;
		});
		const service = makeService(
			{ createQueryRunner: () => runner },
			[],
			undefined,
			{ hanamiGenerationWorkerTimeoutMs: 35, hanamiGenerationLeaseMs: 100 },
		);

		await expect(service.runCommonGeneration('stuck-cleanup')).rejects.toBe(primary);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).not.toHaveBeenCalled();
		neverRollback.resolve();
		await sleep(0);
		await sleep(0);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('validates the canonical source and materialized shape', () => {
		const internals = makeService() as unknown as ServiceInternals;
		const bundle = makeBundle();

		expect(internals.validateSourceBundle(bundle)).toHaveLength(3);
		expect(() => internals.validateMaterialization(bundle, makeMaterialization())).not.toThrow();
	});

	test('allows trend snapshot representatives outside a disabled timeline candidate axis', () => {
		const internals = makeService() as unknown as ServiceInternals;
		const bundle = makeBundle();
		const trendOnlySnapshot: HanamiCommonSourceBundle = {
			...bundle,
			enabledAxes: ['globalPopular', 'exploration'],
			candidates: { ...bundle.candidates, trending: [] },
			trendSnapshot: {
				terms: [{ term: 'widget-only', score: 1, distinctAuthors: 2, representativeNoteIds: ['widget-note'] }],
			},
		};

		expect(() => internals.validateSourceBundle(trendOnlySnapshot)).not.toThrow();
	});

	test('enforces snapshot bounds without coupling representatives to feed candidates', () => {
		const internals = makeService() as unknown as ServiceInternals;
		const bundle = makeBundle();
		const tooManyTerms = {
			...bundle,
			trendSnapshot: {
				terms: Array.from({ length: 31 }, (_, index) => ({
					term: `term-${index}`,
					score: index,
					distinctAuthors: index,
					representativeNoteIds: [],
				})),
			},
		} satisfies HanamiCommonSourceBundle;
		expect(() => internals.validateSourceBundle(tooManyTerms)).toThrow('term limit of 30 exceeded');

		const tooManyRepresentatives = {
			...bundle,
			trendSnapshot: {
				terms: [{
					...bundle.trendSnapshot.terms[0]!,
					representativeNoteIds: Array.from({ length: 6 }, (_, index) => `snapshot-note-${index}`),
				}],
			},
		} satisfies HanamiCommonSourceBundle;
		expect(() => internals.validateSourceBundle(tooManyRepresentatives)).toThrow('representative Note limit of 5 exceeded');
	});

	test('rejects snapshot representatives that are missing or fail common eligibility', async () => {
		const internals = makeService({}, [], async () => new Map()) as unknown as ServiceInternals;
		const bundle = makeBundle();
		const snapshotOnly = {
			...bundle,
			trendSnapshot: {
				terms: [{ term: 'widget-only', score: 1, distinctAuthors: 2, representativeNoteIds: ['widget-note'] }],
			},
		} satisfies HanamiCommonSourceBundle;

		await expect(internals.validateSnapshotRepresentativeEligibility(snapshotOnly)).rejects.toThrow('missing or not common-eligible');
	});

	test('rejects disabled candidates and non-finite source or trend values', () => {
		const internals = makeService() as unknown as ServiceInternals;
		let bundle = makeBundle();
		bundle = { ...bundle, enabledAxes: ['trending', 'exploration'] };
		expect(() => internals.validateSourceBundle(bundle)).toThrow('Disabled Hanami common axis globalPopular must be empty');

		bundle = makeBundle();
		bundle = {
			...bundle,
			candidates: {
				...bundle.candidates,
				globalPopular: [{ ...bundle.candidates.globalPopular[0]!, baseScore: Number.NaN }],
			},
		};
		expect(() => internals.validateSourceBundle(bundle)).toThrow('baseScore must be finite');

		bundle = makeBundle();
		bundle = {
			...bundle,
			trendSnapshot: { terms: [{ ...bundle.trendSnapshot.terms[0]!, score: Number.POSITIVE_INFINITY }] },
		};
		expect(() => internals.validateSourceBundle(bundle)).toThrow('trend score must be finite');
	});

	test('rejects invalid materialized source, duplicate Notes, zero items, and segment mismatch', () => {
		const internals = makeService() as unknown as ServiceInternals;
		const bundle = makeBundle();

		expect(() => internals.validateMaterialization(bundle, { items: [], segmentLengths: [] })).toThrow('1..210 items');
		const duplicate = makeMaterialization();
		expect(() => internals.validateMaterialization(bundle, {
			...duplicate,
			items: [duplicate.items[0]!, duplicate.items[0]!],
			segmentLengths: [2],
		})).toThrow('duplicate Note');
		expect(() => internals.validateMaterialization(bundle, {
			...makeMaterialization(),
			segmentLengths: [2],
		})).toThrow('do not match');
		expect(() => internals.validateMaterialization(bundle, {
			items: [{
				noteId: 'note-global',
				authorId: 'author-global',
				source: 'trending',
				sources: ['trending'],
			}],
			segmentLengths: [1],
		})).toThrow('not present in source axis trending');
	});

	test('preserves literal undefined through rollback and release failures', async () => {
		const runner = makeRunner();
		runner.query.mockImplementationOnce(async () => Promise.reject(undefined));
		runner.rollbackTransaction.mockRejectedValueOnce(new Error('rollback failed') as never);
		runner.release.mockRejectedValueOnce(new Error('release failed') as never);
		const service = makeService({ createQueryRunner: () => runner });

		await expect(service.requestCommonGeneration('seed')).rejects.toBeUndefined();
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test('preserves the exact frozen primary error when cleanup annotation is hostile', async () => {
		const runner = makeRunner();
		const primary = new Error('frozen failure');
		Object.defineProperty(primary, 'cleanupErrors', {
			get: () => {
				throw new Error('hostile getter');
			},
		});
		Object.freeze(primary);
		runner.query.mockRejectedValueOnce(primary as never);
		runner.rollbackTransaction.mockRejectedValueOnce(new Error('rollback failed') as never);
		runner.release.mockRejectedValueOnce(new Error('release failed') as never);
		const service = makeService({ createQueryRunner: () => runner });

		await expect(service.requestCommonGeneration('seed')).rejects.toBe(primary);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});
});
