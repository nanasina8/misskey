/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';

const PARTITION_PARENTS = [
	'hanami_common_candidate',
	'hanami_common_feed_entry',
	'hanami_trend_snapshot_entry',
	'hanami_trend_snapshot_representative_note',
] as const;

const PARTITION_LOCK_TIMEOUT_MS = 5_000;
const PARTITION_STATEMENT_TIMEOUT_MS = 30_000;

const PARTITION_DEADLINE_CONFIG_SQL = `
			WITH budget AS (
				SELECT FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - pg_catalog.clock_timestamp())) * 1000)::bigint - 1 AS remaining_ms
			)
			SELECT set_config('lock_timeout', LEAST($2::bigint, budget.remaining_ms)::text || 'ms', TRUE),
				set_config('statement_timeout', LEAST($3::bigint, budget.remaining_ms)::text || 'ms', TRUE)
			FROM budget
			WHERE budget.remaining_ms > 0
		`;

const PARTITION_DEADLINE_GUARD_SQL = `
			SELECT pg_catalog.clock_timestamp() < $1::timestamptz AS before_deadline
		`;

export type HanamiTimelinePartitionOperationContext = {
	readonly signal?: AbortSignal;
	readonly databaseDeadlineAt?: string;
};

type PartitionParent = typeof PARTITION_PARENTS[number];

type ParentCatalogRow = {
	schema_name: string;
	relkind: string;
	is_partitioned: boolean;
	partition_strategy: string | null;
	partition_key_count: number | null;
	partition_attribute_number: number | null;
	partition_column: string | null;
	partition_key_definition: string | null;
};

type ChildCatalogRow = {
	schema_name: string;
	relkind: string;
	relispartition: boolean;
	parent_name: string | null;
	parent_schema_name: string | null;
	partition_bound: string | null;
};

type PartitionMonth = {
	yyyymm: string;
	from: string;
	to: string;
};

type SchemaRow = {
	schema_name: string | null;
};

@Injectable()
export class HanamiTimelinePartitionService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,
	) {}

	@bindThis
	public async maintainCurrentAndNextTwoMonths(now: Date = new Date()): Promise<void> {
		if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
			throw new Error('now must be a valid Date');
		}

		const currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
		const months = [0, 1, 2].map((offset) => this.monthFromDate(new Date(Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth() + offset,
			1,
		))));

		if (currentMonth !== months[0]!.date.getTime()) {
			throw new Error('failed to compute current UTC month');
		}

		await this.maintainMonths(months.map((month) => month.partitionMonth));
	}

	@bindThis
	public async ensureMonthAvailable(generatedMonth: Date, context?: HanamiTimelinePartitionOperationContext): Promise<void> {
		this.assertUtcMonthStart(generatedMonth, 'generatedMonth');
		await this.maintainMonths([this.monthFromDate(generatedMonth).partitionMonth], context);
	}

	private async maintainMonths(months: PartitionMonth[], context?: HanamiTimelinePartitionOperationContext): Promise<void> {
		const queryRunner = this.db.createQueryRunner();
		let connected = false;
		let transactionStarted = false;
		let hasPrimaryError = false;
		let primaryError: unknown;
		let connectAttempted = false;
		let connectPromise: Promise<void> | undefined;
		let connectSettled = false;
		let startPromise: Promise<void> | undefined;
		let startSettled = false;
		let commitPromise: Promise<void> | undefined;
		let commitSettled = false;
		let releasePromise: Promise<void> | undefined;
		let releaseSettled = false;

		try {
			this.assertNotAborted(context);
			connectAttempted = true;
			connectPromise = Promise.resolve(queryRunner.connect());
			void connectPromise.then(() => { connectSettled = true; }, () => { connectSettled = true; });
			await this.waitForOperation(connectPromise, context);
			connected = true;
			this.assertNotAborted(context);

			startPromise = Promise.resolve(queryRunner.startTransaction());
			void startPromise.then(() => { startSettled = true; }, () => { startSettled = true; });
			await this.waitForOperation(startPromise, context);
			transactionStarted = true;
			this.assertNotAborted(context);

			if (context?.databaseDeadlineAt == null) {
				await this.runSql(queryRunner, `SET LOCAL lock_timeout = '5s'`, [], context);
				await this.runSql(queryRunner, `SET LOCAL statement_timeout = '30s'`, [], context);
			}
			await this.operationQuery(queryRunner, `SET LOCAL DateStyle = 'ISO, YMD'`, [], context);
			await this.operationQuery(queryRunner, `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hanami.timeline.partition-maintenance', 0))`, [], context);
			const schema = await this.resolveCurrentSchema(queryRunner, context);

			for (const parent of PARTITION_PARENTS) {
				this.assertNotAborted(context);
				await this.validateParent(queryRunner, schema, parent, context);
			}

			for (const month of months) {
				for (const parent of PARTITION_PARENTS) {
					this.assertNotAborted(context);
					const child = `${parent}_${month.yyyymm}`;
					const existing = await this.getChild(queryRunner, schema, child, context);

					// Application callers serialize here; external manual DDL races intentionally surface for BullMQ/request retry.
					if (existing == null) {
						await this.operationQuery(
							queryRunner,
							`CREATE TABLE ${this.qualifiedIdent(schema, child)} PARTITION OF ${this.qualifiedIdent(schema, parent)} FOR VALUES FROM ('${month.from}') TO ('${month.to}')`,
							[],
							context,
						);
					}

					await this.validateChild(queryRunner, schema, parent, child, month, context);
				}
			}

			if (context?.databaseDeadlineAt != null) {
				const guardRows = await this.operationQuery<Array<{ before_deadline: boolean }>>(
					queryRunner,
					PARTITION_DEADLINE_GUARD_SQL,
					[context.databaseDeadlineAt],
					context,
				);
				if (guardRows[0]?.before_deadline !== true) throw this.databaseDeadlineExpiredError();
			}
			this.assertNotAborted(context);

			commitPromise = Promise.resolve(queryRunner.commitTransaction());
			void commitPromise.then(() => { commitSettled = true; }, () => { commitSettled = true; });
			await this.waitForOperation(commitPromise, context);
			transactionStarted = false;
			this.assertNotAborted(context);

			releasePromise = Promise.resolve(queryRunner.release());
			void releasePromise.then(() => { releaseSettled = true; }, () => { releaseSettled = true; });
			await this.waitForOperation(releasePromise, context);
			connected = false;
		} catch (error) {
			hasPrimaryError = true;
			primaryError = error;
		}

		if (hasPrimaryError) {
			if (connectPromise != null && !connectSettled && !connected) {
				this.scheduleLateCleanup(queryRunner, connectPromise, false, primaryError);
			} else if (startPromise != null && !startSettled && connected && !transactionStarted) {
				this.scheduleLateCleanup(queryRunner, startPromise, true, primaryError);
			} else if (commitPromise != null && !commitSettled && transactionStarted) {
				this.scheduleLateCleanup(queryRunner, commitPromise, false, primaryError, true);
			} else if (releasePromise != null) {
				if (!releaseSettled) {
					void releasePromise.catch((lateReleaseError) => this.attachCleanupError(primaryError, lateReleaseError));
				}
			} else if (connectAttempted) {
				await this.runBoundedCleanup(
					queryRunner,
					transactionStarted || queryRunner.isTransactionActive,
					context,
					primaryError,
				);
			}
			throw primaryError;
		}
	}

	private async resolveCurrentSchema(queryRunner: QueryRunner, context?: HanamiTimelinePartitionOperationContext): Promise<string> {
		const rows = await this.operationQuery<SchemaRow[]>(queryRunner, `SELECT pg_catalog.current_schema() AS schema_name`, [], context);
		const schema = rows[0]?.schema_name;

		if (schema == null || schema === '') {
			throw new Error('Hanami partition maintenance requires a non-empty active schema');
		}

		return schema;
	}

	private assertNotAborted(context?: HanamiTimelinePartitionOperationContext): void {
		if (context?.signal?.aborted === true) throw context.signal.reason;
	}

	private async waitForOperation<T>(promise: Promise<T>, context?: HanamiTimelinePartitionOperationContext): Promise<T> {
		const signal = context?.signal;
		if (signal == null) return await promise;

		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (operation: () => void): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', onAbort);
				operation();
			};
			const onAbort = (): void => finish(() => reject(signal.reason));
			signal.addEventListener('abort', onAbort, { once: true });
			void promise.then((value) => {
				if (signal.aborted) {
					onAbort();
				} else {
					finish(() => resolve(value));
				}
			}, (error) => {
				if (signal.aborted) {
					onAbort();
				} else {
					finish(() => reject(error));
				}
			});
			if (signal.aborted) onAbort();
		});
	}

	private async runSql<T extends unknown[] = unknown[]>(
		queryRunner: QueryRunner,
		sql: string,
		values: unknown[],
		context?: HanamiTimelinePartitionOperationContext,
	): Promise<T> {
		this.assertNotAborted(context);
		const result = await this.waitForOperation(Promise.resolve(queryRunner.query(sql, values)) as Promise<T>, context);
		this.assertNotAborted(context);
		return result;
	}

	private async configureOperationDeadline(queryRunner: QueryRunner, context: HanamiTimelinePartitionOperationContext): Promise<void> {
		const deadlineAt = context.databaseDeadlineAt;
		if (deadlineAt == null) return;

		const rows = await this.runSql<unknown[]>(queryRunner, PARTITION_DEADLINE_CONFIG_SQL, [
			deadlineAt,
			String(PARTITION_LOCK_TIMEOUT_MS),
			String(PARTITION_STATEMENT_TIMEOUT_MS),
		], context);
		if (rows.length !== 1) throw this.databaseDeadlineExpiredError();
	}

	private async operationQuery<T extends unknown[] = unknown[]>(
		queryRunner: QueryRunner,
		sql: string,
		values: unknown[] = [],
		context?: HanamiTimelinePartitionOperationContext,
	): Promise<T> {
		this.assertNotAborted(context);
		if (context?.databaseDeadlineAt != null) await this.configureOperationDeadline(queryRunner, context);
		this.assertNotAborted(context);
		return await this.runSql<T>(queryRunner, sql, values, context);
	}

	private databaseDeadlineExpiredError(): Error {
		return new Error('Hanami timeline partition operation database deadline expired');
	}

	private attachCleanupError(primaryError: unknown, cleanupError: unknown): void {
		try {
			if (primaryError instanceof Error) {
				const errorWithCleanup = primaryError as Error & { cleanupErrors?: unknown[] };
				errorWithCleanup.cleanupErrors = [...(errorWithCleanup.cleanupErrors ?? []), cleanupError];
			}
		} catch {
			// Cleanup diagnostics must never replace the primary failure.
		}
	}

	private async validateParent(queryRunner: QueryRunner, schema: string, parent: PartitionParent, context?: HanamiTimelinePartitionOperationContext): Promise<void> {
		const rows = await this.operationQuery<ParentCatalogRow[]>(queryRunner, `
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
		`, [schema, parent], context);

		const row = rows[0];
		if (row == null) {
			throw new Error(`Hanami partition parent ${parent} does not exist in active schema`);
		}

		if (row.relkind !== 'p' || row.is_partitioned !== true) {
			throw new Error(`Hanami partition parent ${parent} in schema ${row.schema_name} must be a partitioned table; got relkind=${row.relkind}, isPartitioned=${row.is_partitioned}`);
		}

		if (row.partition_strategy !== 'r'
			|| row.partition_key_count !== 1
			|| row.partition_attribute_number == null
			|| row.partition_attribute_number <= 0
			|| row.partition_column !== 'generatedMonth') {
			throw new Error(`Hanami partition parent ${parent} in schema ${row.schema_name} must use RANGE partitioning on exactly one plain column named generatedMonth; got strategy=${row.partition_strategy ?? '?'}, keyCount=${row.partition_key_count ?? '?'}, attributeNumber=${row.partition_attribute_number ?? '?'}, column=${row.partition_column ?? '?'}, definition=${row.partition_key_definition ?? '?'}`);
		}
	}

	private async getChild(queryRunner: QueryRunner, schema: string, child: string, context?: HanamiTimelinePartitionOperationContext): Promise<ChildCatalogRow | null> {
		const rows = await this.operationQuery<ChildCatalogRow[]>(queryRunner, `
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
		`, [schema, child], context);

		return rows[0] ?? null;
	}

	private async validateChild(queryRunner: QueryRunner, schema: string, parent: PartitionParent, child: string, month: PartitionMonth, context?: HanamiTimelinePartitionOperationContext): Promise<void> {
		const row = await this.getChild(queryRunner, schema, child, context);

		if (row == null) {
			throw new Error(`Hanami partition child ${child} was not created for parent ${parent}`);
		}

		if (row.relkind !== 'r' || row.relispartition !== true) {
			throw new Error(`Hanami partition child ${child} must be an ordinary partition table; got relkind=${row.relkind}, relispartition=${row.relispartition}`);
		}

		if (row.parent_name !== parent || row.parent_schema_name !== row.schema_name) {
			throw new Error(`Hanami partition child ${child} must inherit directly from ${parent} in schema ${row.schema_name}; got parent=${row.parent_schema_name ?? '?'}.${row.parent_name ?? '?'}`);
		}

		const expectedBound = `FOR VALUES FROM ('${month.from}') TO ('${month.to}')`;
		if (row.partition_bound !== expectedBound) {
			throw new Error(`Hanami partition child ${child} has wrong bounds; expected ${expectedBound}, got ${row.partition_bound ?? '?'}`);
		}
	}

	private scheduleLateCleanup(
		queryRunner: QueryRunner,
		pending: Promise<void>,
		rollbackAfterSuccess: boolean,
		primaryError: unknown,
		commitPhase = false,
	): void {
		void pending.then(async () => {
			await this.cleanupQueryRunner(queryRunner, rollbackAfterSuccess, primaryError);
		}, async (lateDriverError) => {
			this.attachCleanupError(primaryError, lateDriverError);
			await this.cleanupQueryRunner(queryRunner, commitPhase || queryRunner.isTransactionActive, primaryError);
		}).catch((lateCleanupError) => this.attachCleanupError(primaryError, lateCleanupError));
	}

	private async runBoundedCleanup(
		queryRunner: QueryRunner,
		rollback: boolean,
		context: HanamiTimelinePartitionOperationContext | undefined,
		primaryError: unknown,
	): Promise<void> {
		const cleanup = this.cleanupQueryRunner(queryRunner, rollback, primaryError);
		const signal = context?.signal;
		if (signal?.aborted === true) {
			void cleanup;
			return;
		}

		try {
			await this.waitForOperation(cleanup, context);
		} catch (cleanupWaitError) {
			if (context?.signal?.aborted !== true) this.attachCleanupError(primaryError, cleanupWaitError);
		}
	}

	private async cleanupQueryRunner(queryRunner: QueryRunner, rollback: boolean, primaryError: unknown): Promise<void> {
		if (rollback) {
			try {
				await queryRunner.rollbackTransaction();
			} catch (rollbackError) {
				this.attachCleanupError(primaryError, rollbackError);
			}
		}

		try {
			await queryRunner.release();
		} catch (releaseError) {
			this.attachCleanupError(primaryError, releaseError);
		}
	}

	private assertUtcMonthStart(date: Date, name: string): void {
		if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
			throw new Error(`${name} must be a valid Date`);
		}

		if (date.getUTCDate() !== 1
			|| date.getUTCHours() !== 0
			|| date.getUTCMinutes() !== 0
			|| date.getUTCSeconds() !== 0
			|| date.getUTCMilliseconds() !== 0) {
			throw new Error(`${name} must be a UTC midnight first-of-month Date`);
		}
	}

	private monthFromDate(date: Date): { date: Date; partitionMonth: PartitionMonth } {
		this.assertUtcMonthStart(date, 'generatedMonth');

		const fromDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
		const toDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
		const yyyymm = `${fromDate.getUTCFullYear()}${String(fromDate.getUTCMonth() + 1).padStart(2, '0')}`;

		return {
			date: fromDate,
			partitionMonth: {
				yyyymm,
				from: this.formatDateLiteral(fromDate),
				to: this.formatDateLiteral(toDate),
			},
		};
	}

	private formatDateLiteral(date: Date): string {
		return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
	}

	private quoteIdent(identifier: string): string {
		return `"${identifier.replaceAll('"', '""')}"`;
	}

	private qualifiedIdent(schema: string, identifier: string): string {
		return `${this.quoteIdent(schema)}.${this.quoteIdent(identifier)}`;
	}
}
