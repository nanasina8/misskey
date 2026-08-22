/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { HanamiTimelinePartitionService } from '@/core/hanami/HanamiTimelinePartitionService.js';

const parents = [
	'hanami_common_candidate',
	'hanami_common_feed_entry',
	'hanami_trend_snapshot_entry',
	'hanami_trend_snapshot_representative_note',
] as const;

type ParentInfo = {
	schema_name: string;
	relkind: string;
	is_partitioned: boolean;
	partition_strategy: string | null;
	partition_key_count: number | null;
	partition_attribute_number: number | null;
	partition_column: string | null;
	partition_key_definition: string | null;
};

type ChildInfo = {
	schema_name: string;
	relkind: string;
	relispartition: boolean;
	parent_name: string | null;
	parent_schema_name: string | null;
	partition_bound: string | null;
};

const currentSchemaSql = 'SELECT pg_catalog.current_schema() AS schema_name';
const parentCatalogSql = `
			SELECT
				n.nspname AS schema_name,
				c.relkind,
				p.partrelid IS NOT NULL AS is_partitioned,
				p.partstrat AS partition_strategy,
				p.partnatts AS partition_key_count,
				p.partattrs[0] AS partition_attribute_number,
				a.attname AS partition_column,
				pg_catalog.pg_get_partkeydef(p.partrelid) AS partition_key_definition
			FROM pg_catalog.pg_class c
			JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_catalog.pg_partitioned_table p ON p.partrelid = c.oid
			LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = p.partattrs[0]
			WHERE n.nspname = $1 AND c.relname = $2
		`;
const childCatalogSql = `
			SELECT
				child_ns.nspname AS schema_name,
				child.relkind,
				child.relispartition,
				parent.relname AS parent_name,
				parent_ns.nspname AS parent_schema_name,
				pg_catalog.pg_get_expr(child.relpartbound, child.oid, true) AS partition_bound
			FROM pg_catalog.pg_class child
			JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
			LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = child.oid
			LEFT JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
			LEFT JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
			WHERE child_ns.nspname = $1 AND child.relname = $2
		`;
const databaseDeadline = '2026-10-01T00:01:00.123456Z';

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

const validParent = (schema = 'public'): ParentInfo => ({
	schema_name: schema,
	relkind: 'p',
	is_partitioned: true,
	partition_strategy: 'r',
	partition_key_count: 1,
	partition_attribute_number: 1,
	partition_column: 'generatedMonth',
	partition_key_definition: 'RANGE ("generatedMonth")',
});

const validChild = (child: string, parent: string, from: string, to: string, schema = 'public'): ChildInfo => ({
	schema_name: schema,
	relkind: 'r',
	relispartition: true,
	parent_name: parent,
	parent_schema_name: schema,
	partition_bound: `FOR VALUES FROM ('${from}') TO ('${to}')`,
});

const makeHarness = (children = new Map<string, ChildInfo>(), schema = 'public', parentRows = new Map<string, ParentInfo>()) => {
	const calls: string[] = [];
	const query = jest.fn(async (sql: string, values?: unknown[]) => {
		calls.push(sql);
		if (sql.includes("set_config('lock_timeout'")) return [{}];
		if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];

		if (sql === currentSchemaSql) {
			return [{ schema_name: schema }];
		}

		if (sql === parentCatalogSql) {
			const parent = values?.[1] as string;
			if (!parents.includes(parent as never)) return [];
			return [parentRows.get(parent) ?? validParent(schema)];
		}

		if (sql === childCatalogSql) {
			const child = values?.[1] as string;
			const row = children.get(child);
			return row == null ? [] : [row];
		}

		if (sql.startsWith('CREATE TABLE ')) {
			const match = /^CREATE TABLE "((?:[^"]|"")+)"\."((?:[^"]|"")+)" PARTITION OF "((?:[^"]|"")+)"\."((?:[^"]|"")+)" FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$/.exec(sql);
			if (match == null) throw new Error(`unexpected create SQL: ${sql}`);
			children.set(match[2]!.replaceAll('""', '"'), validChild(match[2]!.replaceAll('""', '"'), match[4]!.replaceAll('""', '"'), match[5]!, match[6]!, match[1]!.replaceAll('""', '"')));
			return [];
		}

		return [];
	});

	const queryRunner = {
		isTransactionActive: false,
		connect: jest.fn(async () => undefined),
		startTransaction: jest.fn(async () => {
			queryRunner.isTransactionActive = true;
		}),
		commitTransaction: jest.fn(async () => {
			queryRunner.isTransactionActive = false;
		}),
		rollbackTransaction: jest.fn(async () => {
			queryRunner.isTransactionActive = false;
		}),
		release: jest.fn(async () => undefined),
		query,
	};

	const db = {
		createQueryRunner: jest.fn(() => queryRunner),
	};

	return {
		service: new HanamiTimelinePartitionService(db as never),
		queryRunner,
		children,
		calls,
	};
};

describe('HanamiTimelinePartitionService', () => {
	test('maintains the current UTC month and the next two months across year rollover', async () => {
		const { service, calls } = makeHarness();

		await service.maintainCurrentAndNextTwoMonths(new Date('2026-12-31T23:59:59.999Z'));

		const createCalls = calls.filter((sql) => sql.startsWith('CREATE TABLE '));
		expect(createCalls).toHaveLength(12);
		expect(createCalls[0]).toBe('CREATE TABLE "public"."hanami_common_candidate_202612" PARTITION OF "public"."hanami_common_candidate" FOR VALUES FROM (\'2026-12-01\') TO (\'2027-01-01\')');
		expect(createCalls[4]).toContain('_202701" PARTITION OF');
		expect(createCalls[4]).toContain("FROM ('2027-01-01') TO ('2027-02-01')");
		expect(createCalls[8]).toContain('_202702" PARTITION OF');
		expect(createCalls[8]).toContain("FROM ('2027-02-01') TO ('2027-03-01')");
	});

	test('uses exact timeouts, DateStyle, advisory lock, identifiers, bounds, and order for August 2026', async () => {
		const { service, calls, queryRunner } = makeHarness(undefined, 'hanami_schema');

		await service.maintainCurrentAndNextTwoMonths(new Date('2026-08-19T12:34:56.789Z'));

		expect(queryRunner.connect).toHaveBeenCalledTimes(1);
		expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
		expect(calls[0]).toBe("SET LOCAL lock_timeout = '5s'");
		expect(calls[1]).toBe("SET LOCAL statement_timeout = '30s'");
		expect(calls[2]).toBe("SET LOCAL DateStyle = 'ISO, YMD'");
		expect(calls[3]).toBe("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hanami.timeline.partition-maintenance', 0))");
		expect(calls[4]).toBe(currentSchemaSql);
		expect(calls[5]).toBe(parentCatalogSql);
		expect(calls[9]).toBe(childCatalogSql);

		const createCalls = calls.filter((sql) => sql.startsWith('CREATE TABLE '));
		expect(createCalls).toEqual([
			'CREATE TABLE "hanami_schema"."hanami_common_candidate_202608" PARTITION OF "hanami_schema"."hanami_common_candidate" FOR VALUES FROM (\'2026-08-01\') TO (\'2026-09-01\')',
			'CREATE TABLE "hanami_schema"."hanami_common_feed_entry_202608" PARTITION OF "hanami_schema"."hanami_common_feed_entry" FOR VALUES FROM (\'2026-08-01\') TO (\'2026-09-01\')',
			'CREATE TABLE "hanami_schema"."hanami_trend_snapshot_entry_202608" PARTITION OF "hanami_schema"."hanami_trend_snapshot_entry" FOR VALUES FROM (\'2026-08-01\') TO (\'2026-09-01\')',
			'CREATE TABLE "hanami_schema"."hanami_trend_snapshot_representative_note_202608" PARTITION OF "hanami_schema"."hanami_trend_snapshot_representative_note" FOR VALUES FROM (\'2026-08-01\') TO (\'2026-09-01\')',
			'CREATE TABLE "hanami_schema"."hanami_common_candidate_202609" PARTITION OF "hanami_schema"."hanami_common_candidate" FOR VALUES FROM (\'2026-09-01\') TO (\'2026-10-01\')',
			'CREATE TABLE "hanami_schema"."hanami_common_feed_entry_202609" PARTITION OF "hanami_schema"."hanami_common_feed_entry" FOR VALUES FROM (\'2026-09-01\') TO (\'2026-10-01\')',
			'CREATE TABLE "hanami_schema"."hanami_trend_snapshot_entry_202609" PARTITION OF "hanami_schema"."hanami_trend_snapshot_entry" FOR VALUES FROM (\'2026-09-01\') TO (\'2026-10-01\')',
			'CREATE TABLE "hanami_schema"."hanami_trend_snapshot_representative_note_202609" PARTITION OF "hanami_schema"."hanami_trend_snapshot_representative_note" FOR VALUES FROM (\'2026-09-01\') TO (\'2026-10-01\')',
			'CREATE TABLE "hanami_schema"."hanami_common_candidate_202610" PARTITION OF "hanami_schema"."hanami_common_candidate" FOR VALUES FROM (\'2026-10-01\') TO (\'2026-11-01\')',
			'CREATE TABLE "hanami_schema"."hanami_common_feed_entry_202610" PARTITION OF "hanami_schema"."hanami_common_feed_entry" FOR VALUES FROM (\'2026-10-01\') TO (\'2026-11-01\')',
			'CREATE TABLE "hanami_schema"."hanami_trend_snapshot_entry_202610" PARTITION OF "hanami_schema"."hanami_trend_snapshot_entry" FOR VALUES FROM (\'2026-10-01\') TO (\'2026-11-01\')',
			'CREATE TABLE "hanami_schema"."hanami_trend_snapshot_representative_note_202610" PARTITION OF "hanami_schema"."hanami_trend_snapshot_representative_note" FOR VALUES FROM (\'2026-10-01\') TO (\'2026-11-01\')',
		]);
		expect(queryRunner.query).toHaveBeenCalledWith(parentCatalogSql, ['hanami_schema', 'hanami_common_candidate']);
		expect(queryRunner.query).toHaveBeenCalledWith(childCatalogSql, ['hanami_schema', 'hanami_common_candidate_202608']);
	});

	test('quotes embedded schema quotes in qualified DDL', async () => {
		const { service, calls } = makeHarness(undefined, 'hanami"schema');

		await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'));

		expect(calls.filter((sql) => sql.startsWith('CREATE TABLE '))[0]).toBe('CREATE TABLE "hanami""schema"."hanami_common_candidate_202610" PARTITION OF "hanami""schema"."hanami_common_candidate" FOR VALUES FROM (\'2026-10-01\') TO (\'2026-11-01\')');
	});

	test('rejects invalid ensureMonthAvailable inputs before opening a connection', async () => {
		const { service, queryRunner } = makeHarness();

		await expect(service.ensureMonthAvailable(new Date('2026-08-02T00:00:00.000Z'))).rejects.toThrow('UTC midnight first-of-month');
		await expect(service.ensureMonthAvailable(new Date('2026-08-01T00:00:00.001Z'))).rejects.toThrow('UTC midnight first-of-month');
		await expect(service.ensureMonthAvailable(new Date(Number.NaN))).rejects.toThrow('valid Date');
		expect(queryRunner.connect).not.toHaveBeenCalled();
	});

	test('uses the authoritative database deadline for bounded transaction settings and the final commit guard', async () => {
		const { service, calls, queryRunner } = makeHarness();
		const controller = new AbortController();

		await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'), {
			signal: controller.signal,
			databaseDeadlineAt: databaseDeadline,
		});

		const deadlineCalls = queryRunner.query.mock.calls.filter(([sql]) => sql.includes("set_config('lock_timeout'"));
		expect(deadlineCalls.length).toBeGreaterThan(1);
		expect(deadlineCalls.every(([, values]) => JSON.stringify(values) === JSON.stringify([databaseDeadline, '5000', '30000']))).toBe(true);
		expect(calls).not.toContain("SET LOCAL lock_timeout = '5s'");
		expect(calls).not.toContain("SET LOCAL statement_timeout = '30s'");
		expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('AS before_deadline'), [databaseDeadline]);
		expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
	});

	test('aborts a deferred connect and performs only late best-effort release', async () => {
		const { service, queryRunner } = makeHarness();
		const entered = deferred<void>();
		const lateConnect = deferred<void>();
		queryRunner.connect.mockImplementation(async () => {
			entered.resolve();
			await lateConnect.promise;
		});
		const controller = new AbortController();
		const primary = new Error('partition connect aborted');
		const operation = service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'), {
			signal: controller.signal,
			databaseDeadlineAt: databaseDeadline,
		});
		await entered.promise;

		controller.abort(primary);
		await expect(operation).rejects.toBe(primary);
		expect(queryRunner.startTransaction).not.toHaveBeenCalled();
		expect(queryRunner.query).not.toHaveBeenCalled();
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).not.toHaveBeenCalled();

		lateConnect.resolve();
		await sleep(0);
		await sleep(0);
		expect(queryRunner.startTransaction).not.toHaveBeenCalled();
		expect(queryRunner.query).not.toHaveBeenCalled();
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('aborts a deferred startTransaction and only rolls back after its late success', async () => {
		const { service, queryRunner } = makeHarness();
		const entered = deferred<void>();
		const lateStart = deferred<void>();
		queryRunner.startTransaction.mockImplementation(async () => {
			entered.resolve();
			await lateStart.promise;
			queryRunner.isTransactionActive = true;
		});
		const controller = new AbortController();
		const primary = new Error('partition start aborted');
		const operation = service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'), {
			signal: controller.signal,
			databaseDeadlineAt: databaseDeadline,
		});
		await entered.promise;

		controller.abort(primary);
		await expect(operation).rejects.toBe(primary);
		expect(queryRunner.query).not.toHaveBeenCalled();
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).not.toHaveBeenCalled();

		lateStart.resolve();
		await sleep(0);
		await sleep(0);
		expect(queryRunner.query).not.toHaveBeenCalled();
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('does not advance after a deferred catalog query settles following abort', async () => {
		const { service, queryRunner } = makeHarness();
		const originalQuery = queryRunner.query.getMockImplementation();
		if (originalQuery == null) throw new Error('missing partition query implementation');
		const entered = deferred<void>();
		const lateCatalog = deferred<Array<{ schema_name: string }>>();
		queryRunner.query.mockImplementation(async (sql: string, values?: unknown[]) => {
			if (sql === currentSchemaSql) {
				entered.resolve();
				return await lateCatalog.promise;
			}
			return await originalQuery(sql, values);
		});
		const controller = new AbortController();
		const primary = new Error('partition catalog aborted');
		const operation = service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'), {
			signal: controller.signal,
			databaseDeadlineAt: databaseDeadline,
		});
		await entered.promise;

		controller.abort(primary);
		await expect(operation).rejects.toBe(primary);
		const queryCountAfterAbort = queryRunner.query.mock.calls.length;
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);

		lateCatalog.resolve([{ schema_name: 'public' }]);
		await sleep(0);
		await sleep(0);
		expect(queryRunner.query).toHaveBeenCalledTimes(queryCountAfterAbort);
		expect(queryRunner.query.mock.calls.some(([sql]) => sql === parentCatalogSql)).toBe(false);
		expect(queryRunner.query.mock.calls.some(([sql]) => sql.startsWith('CREATE TABLE '))).toBe(false);
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
	});

	test('does not validate or commit after a deferred DDL query settles following abort', async () => {
		const { service, queryRunner } = makeHarness();
		const originalQuery = queryRunner.query.getMockImplementation();
		if (originalQuery == null) throw new Error('missing partition query implementation');
		const entered = deferred<void>();
		const lateDdl = deferred<Array<Record<string, never>>>();
		queryRunner.query.mockImplementation(async (sql: string, values?: unknown[]) => {
			if (sql.startsWith('CREATE TABLE ')) {
				entered.resolve();
				return await lateDdl.promise;
			}
			return await originalQuery(sql, values);
		});
		const controller = new AbortController();
		const primary = new Error('partition DDL aborted');
		const operation = service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'), {
			signal: controller.signal,
			databaseDeadlineAt: databaseDeadline,
		});
		await entered.promise;

		controller.abort(primary);
		await expect(operation).rejects.toBe(primary);
		const queryCountAfterAbort = queryRunner.query.mock.calls.length;
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);

		lateDdl.resolve([]);
		await sleep(0);
		await sleep(0);
		expect(queryRunner.query).toHaveBeenCalledTimes(queryCountAfterAbort);
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
	});

	test('is idempotent when valid children already exist', async () => {
		const children = new Map<string, ChildInfo>();
		for (const parent of parents) {
			children.set(`${parent}_202610`, validChild(`${parent}_202610`, parent, '2026-10-01', '2026-11-01'));
		}
		const { service, calls } = makeHarness(children);

		await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'));

		expect(calls.some((sql) => sql.startsWith('CREATE TABLE '))).toBe(false);
	});

	test.each([
		{
			name: 'LIST strategy',
			override: { partition_strategy: 'l', partition_key_definition: 'LIST ("generatedMonth")' },
		},
		{
			name: 'multiple keys',
			override: { partition_key_count: 2, partition_key_definition: 'RANGE ("generatedMonth", id)' },
		},
		{
			name: 'wrong column',
			override: { partition_attribute_number: 2, partition_column: 'generatedAt', partition_key_definition: 'RANGE ("generatedAt")' },
		},
		{
			name: 'expression key',
			override: { partition_attribute_number: 0, partition_column: null, partition_key_definition: 'RANGE ((date_trunc(\'month\', "generatedAt")))' },
		},
	] satisfies Array<{ name: string; override: Partial<ParentInfo> }>)('rejects a parent with $name and reports the observed key', async ({ override }) => {
		const row = { ...validParent(), ...override };
		const parentRows = new Map<string, ParentInfo>([[parents[0], row]]);
		const { service } = makeHarness(undefined, 'public', parentRows);

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow(
			`Hanami partition parent hanami_common_candidate in schema public must use RANGE partitioning on exactly one plain column named generatedMonth; got strategy=${row.partition_strategy ?? '?'}, keyCount=${row.partition_key_count ?? '?'}, attributeNumber=${row.partition_attribute_number ?? '?'}, column=${row.partition_column ?? '?'}, definition=${row.partition_key_definition ?? '?'}`,
		);
	});

	test('fails with actionable context for parent, child, and bound mismatches', async () => {
		let harness = makeHarness();
		harness.queryRunner.query.mockImplementation(async (sql: string, values?: unknown[]) => {
			if (sql === currentSchemaSql) return [{ schema_name: 'public' }];
			if (sql === parentCatalogSql && values?.[1] === 'hanami_common_candidate') return [];
			if (sql === parentCatalogSql) return [validParent()];
			return [];
		});
		await expect(harness.service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('parent hanami_common_candidate does not exist');

		harness = makeHarness(new Map([
			['hanami_common_candidate_202610', { ...validChild('hanami_common_candidate_202610', 'hanami_common_candidate', '2026-10-01', '2026-11-01'), relkind: 'r', relispartition: false }],
		]));
		await expect(harness.service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('must be an ordinary partition table');

		harness = makeHarness(new Map([
			['hanami_common_candidate_202610', validChild('hanami_common_candidate_202610', 'hanami_common_feed_entry', '2026-10-01', '2026-11-01')],
		]));
		await expect(harness.service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('must inherit directly from hanami_common_candidate');

		harness = makeHarness(new Map([
			['hanami_common_candidate_202610', validChild('hanami_common_candidate_202610', 'hanami_common_candidate', '2026-09-01', '2026-10-01')],
		]));
		await expect(harness.service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('wrong bounds');
	});

	test('rolls back and propagates errors', async () => {
		const { service, queryRunner } = makeHarness();
		const error = new Error('DDL failed');
		queryRunner.query.mockImplementation(async (sql: string, values?: unknown[]) => {
			if (sql.startsWith('CREATE TABLE ')) throw error;
			if (sql === currentSchemaSql) return [{ schema_name: 'public' }];
			if (sql === parentCatalogSql) return [validParent()];
			if (sql === childCatalogSql || values) return [];
			return [];
		});

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('DDL failed');
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('releases and preserves connect failure without rollback', async () => {
		const { service, queryRunner } = makeHarness();
		const error = new Error('connect failed');
		queryRunner.connect.mockRejectedValueOnce(error as never);

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(error);
		expect(queryRunner.startTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('releases and preserves undefined connect rejection without rollback', async () => {
		const { service, queryRunner } = makeHarness();
		queryRunner.connect.mockImplementationOnce(async () => Promise.reject(undefined));

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBeUndefined();
		expect(queryRunner.startTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('releases and preserves startTransaction failure before active without rollback', async () => {
		const { service, queryRunner } = makeHarness();
		const error = new Error('start failed');
		queryRunner.startTransaction.mockRejectedValueOnce(error as never);

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(error);
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('rolls back and preserves startTransaction failure after TypeORM marks active', async () => {
		const { service, queryRunner } = makeHarness();
		const error = new Error('start active failed');
		queryRunner.startTransaction.mockImplementationOnce(async () => {
			queryRunner.isTransactionActive = true;
			throw error;
		});

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(error);
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('rolls back, releases, and preserves undefined query rejection when cleanup fails', async () => {
		const { service, queryRunner } = makeHarness();
		queryRunner.rollbackTransaction.mockRejectedValueOnce(new Error('rollback failed') as never);
		queryRunner.release.mockRejectedValueOnce(new Error('release failed') as never);
		queryRunner.query.mockImplementation(async (sql: string) => {
			if (sql === "SET LOCAL DateStyle = 'ISO, YMD'") return Promise.reject(undefined);
			return [];
		});

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBeUndefined();
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('preserves primary DDL error when rollback fails and attaches cleanup error', async () => {
		const { service, queryRunner } = makeHarness();
		const error = new Error('DDL failed');
		const rollbackError = new Error('rollback failed');
		queryRunner.rollbackTransaction.mockRejectedValueOnce(rollbackError as never);
		queryRunner.query.mockImplementation(async (sql: string) => {
			if (sql.startsWith('CREATE TABLE ')) throw error;
			if (sql === currentSchemaSql) return [{ schema_name: 'public' }];
			if (sql === parentCatalogSql) return [validParent()];
			return [];
		});

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(error);
		expect((error as Error & { cleanupErrors?: unknown[] }).cleanupErrors).toEqual([rollbackError]);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('releases and rethrows the exact frozen primary Error when rollback, release, and cleanup annotation fail', async () => {
		const { service, queryRunner } = makeHarness();
		const error = new Error('frozen primary failure');
		Object.defineProperty(error, 'cleanupErrors', {
			get: () => {
				throw new Error('hostile cleanupErrors getter');
			},
		});
		Object.freeze(error);
		queryRunner.rollbackTransaction.mockRejectedValueOnce(new Error('rollback failed') as never);
		queryRunner.release.mockRejectedValueOnce(new Error('release failed') as never);
		queryRunner.query.mockImplementation(async (sql: string) => {
			if (sql === "SET LOCAL DateStyle = 'ISO, YMD'") throw error;
			return [];
		});

		await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(error);
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
	});

	test('preserves primary error when release fails, but surfaces release failure on success', async () => {
		let harness = makeHarness();
		const ddlError = new Error('DDL failed');
		const releaseAfterError = new Error('release after error failed');
		harness.queryRunner.release.mockRejectedValueOnce(releaseAfterError as never);
		harness.queryRunner.query.mockImplementation(async (sql: string) => {
			if (sql.startsWith('CREATE TABLE ')) throw ddlError;
			if (sql === currentSchemaSql) return [{ schema_name: 'public' }];
			if (sql === parentCatalogSql) return [validParent()];
			return [];
		});

		await expect(harness.service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(ddlError);
		expect((ddlError as Error & { cleanupErrors?: unknown[] }).cleanupErrors).toEqual([releaseAfterError]);

		harness = makeHarness();
		const releaseAfterSuccess = new Error('release after success failed');
		harness.queryRunner.release.mockRejectedValueOnce(releaseAfterSuccess as never);

		await expect(harness.service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toBe(releaseAfterSuccess);
		expect(harness.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
	});
});
