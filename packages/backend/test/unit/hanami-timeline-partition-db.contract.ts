/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { HanamiTimelinePartitionService } from '@/core/hanami/HanamiTimelinePartitionService.js';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;

type QueryRunner = {
	query: <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;
};

const parents = [
	'hanami_common_candidate',
	'hanami_common_feed_entry',
	'hanami_trend_snapshot_entry',
	'hanami_trend_snapshot_representative_note',
] as const;

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;

const isDbConnectionError = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) return false;
	const maybeError = error as { code?: string; message?: string };
	return maybeError.code === 'ECONNREFUSED'
		|| maybeError.code === 'ENOTFOUND'
		|| maybeError.code === 'EHOSTUNREACH'
		|| maybeError.code === 'ETIMEDOUT'
		|| /connection refused|connecte?d|could not connect/i.test(maybeError.message ?? '');
};

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

type DataSourceOptions = {
	createTempShadow?: boolean;
	createTempCatalogShadow?: boolean;
	onRelease?: () => void;
};

const makeDataSource = (schema: string, options: DataSourceOptions = {}) => ({
	createQueryRunner: () => {
		const client = new Client({ connectionString: databaseUrl });
		const queryRunner = {
			isTransactionActive: false,
			connect: async () => {
				await client.connect();
				await client.query(`SET DateStyle TO 'SQL, DMY'`);
				await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
				if (options.createTempShadow === true) {
					await client.query('CREATE TEMP TABLE "hanami_common_candidate_202610" (id integer NOT NULL)');
				}
				if (options.createTempCatalogShadow === true) {
					await client.query('CREATE TEMP TABLE "pg_class" (spoof boolean NOT NULL)');
				}
			},
			startTransaction: async () => {
				await client.query('BEGIN');
				queryRunner.isTransactionActive = true;
			},
			commitTransaction: async () => {
				await client.query('COMMIT');
				queryRunner.isTransactionActive = false;
			},
			rollbackTransaction: async () => {
				await client.query('ROLLBACK');
				queryRunner.isTransactionActive = false;
			},
			release: async () => {
				await client.end();
				options.onRelease?.();
			},
			query: async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
				const result = await client.query<T>(sql, values);
				return result.rows;
			},
		};
		return queryRunner;
	},
});

type IndexStructure = {
	child_name: string;
	parent_index_name: string | null;
	is_primary: boolean;
	is_unique: boolean;
	columns: Array<{ name: string; direction: 'ASC' | 'DESC' }>;
};

type ConstraintStructure = {
	child_name: string;
	constraint_name: string;
	constraint_type: 'p' | 'u' | 'c' | 'f';
	definition: string;
	local_columns: string[] | string;
	referenced_table: string | null;
	referenced_columns: string[] | string;
	on_delete: string | null;
};

const expectedIndexes: Record<string, Array<Omit<IndexStructure, 'child_name'>>> = {
	hanami_common_candidate: [
		{ parent_index_name: 'PK_hanami_common_candidate', is_primary: true, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'generationId', direction: 'ASC' }, { name: 'generationFence', direction: 'ASC' }, { name: 'axis', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_common_candidate_note', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'generationId', direction: 'ASC' }, { name: 'generationFence', direction: 'ASC' }, { name: 'axis', direction: 'ASC' }, { name: 'noteId', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_common_candidate_generation', is_primary: false, is_unique: false, columns: [{ name: 'generationId', direction: 'ASC' }, { name: 'generationFence', direction: 'ASC' }, { name: 'axis', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_common_candidate_note', is_primary: false, is_unique: false, columns: [{ name: 'noteId', direction: 'ASC' }] },
	],
	hanami_common_feed_entry: [
		{ parent_index_name: 'PK_hanami_common_feed_entry', is_primary: true, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'id', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_common_feed_entry_sequence', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'epochId', direction: 'ASC' }, { name: 'sequence', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_common_feed_entry_position', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'generationId', direction: 'ASC' }, { name: 'position', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_common_feed_entry_note', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'generationId', direction: 'ASC' }, { name: 'noteId', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_common_feed_entry_page', is_primary: false, is_unique: false, columns: [{ name: 'epochId', direction: 'ASC' }, { name: 'sequence', direction: 'DESC' }] },
		{ parent_index_name: 'IDX_hanami_common_feed_entry_generation', is_primary: false, is_unique: false, columns: [{ name: 'generationId', direction: 'ASC' }, { name: 'position', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_common_feed_entry_note', is_primary: false, is_unique: false, columns: [{ name: 'noteId', direction: 'ASC' }] },
	],
	hanami_trend_snapshot_entry: [
		{ parent_index_name: 'PK_hanami_trend_snapshot_entry', is_primary: true, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'id', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_trend_snapshot_entry_rank', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'snapshotId', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_trend_snapshot_entry_term', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'snapshotId', direction: 'ASC' }, { name: 'term', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_trend_snapshot_entry_snapshot', is_primary: false, is_unique: false, columns: [{ name: 'snapshotId', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }] },
	],
	hanami_trend_snapshot_representative_note: [
		{ parent_index_name: 'PK_hanami_trend_snapshot_rep_note', is_primary: true, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'snapshotId', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }, { name: 'position', direction: 'ASC' }] },
		{ parent_index_name: 'UQ_hanami_trend_snapshot_rep_note_note', is_primary: false, is_unique: true, columns: [{ name: 'generatedMonth', direction: 'ASC' }, { name: 'snapshotId', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }, { name: 'noteId', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_trend_snapshot_rep_note_snapshot', is_primary: false, is_unique: false, columns: [{ name: 'snapshotId', direction: 'ASC' }, { name: 'rank', direction: 'ASC' }, { name: 'position', direction: 'ASC' }] },
		{ parent_index_name: 'IDX_hanami_trend_snapshot_rep_note_note', is_primary: false, is_unique: false, columns: [{ name: 'noteId', direction: 'ASC' }] },
	],
};

const expectedChecks: Record<string, string[]> = {
	hanami_common_candidate: ['check(extract(dayfromgeneratedmonth)=1)', 'check(rank>=0)', 'check(generationfence>=0)'],
	hanami_common_feed_entry: ['check(extract(dayfromgeneratedmonth)=1)', 'check(sequence>0)', 'check((position>=0)and(position<210))'],
	hanami_trend_snapshot_entry: ['check(extract(dayfromgeneratedmonth)=1)', 'check((rank>=0)and(rank<30))', 'check(distinctauthors>=0)'],
	hanami_trend_snapshot_representative_note: ['check(extract(dayfromgeneratedmonth)=1)', 'check((rank>=0)and(rank<30))', 'check((position>=0)and(position<5))'],
};

const expectedFks: Record<string, Array<Pick<ConstraintStructure, 'local_columns' | 'referenced_table' | 'referenced_columns' | 'on_delete'>>> = {
	hanami_common_candidate: [
		{ local_columns: ['generationId'], referenced_table: 'hanami_common_generation', referenced_columns: ['id'], on_delete: 'CASCADE' },
		{ local_columns: ['noteId'], referenced_table: 'note', referenced_columns: ['id'], on_delete: 'CASCADE' },
	],
	hanami_common_feed_entry: [
		{ local_columns: ['generationId'], referenced_table: 'hanami_common_generation', referenced_columns: ['id'], on_delete: 'CASCADE' },
		{ local_columns: ['noteId'], referenced_table: 'note', referenced_columns: ['id'], on_delete: 'CASCADE' },
	],
	hanami_trend_snapshot_entry: [
		{ local_columns: ['snapshotId'], referenced_table: 'hanami_trend_snapshot', referenced_columns: ['id'], on_delete: 'CASCADE' },
	],
	hanami_trend_snapshot_representative_note: [
		{ local_columns: ['snapshotId'], referenced_table: 'hanami_trend_snapshot', referenced_columns: ['id'], on_delete: 'CASCADE' },
		{ local_columns: ['noteId'], referenced_table: 'note', referenced_columns: ['id'], on_delete: 'CASCADE' },
	],
};

const normalizeCheck = (definition: string): string => definition
	.toLowerCase()
	.replaceAll('"', '')
	.replace(/::[a-z_ ]+(\[\])?/g, '')
	.replace(/\(\d+\)/g, (match) => match.slice(1, -1))
	.replace(/\s+/g, '')
	.replace(/\(extract\(dayfrom([^)]+)\)=1\)/g, '(extract(dayfrom$1)=1)')
	.replace(/^check\(\((.*)\)\)$/, 'check($1)');

const sortStructures = <T>(items: T[]): T[] => items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const pgArrayToStrings = (value: string[] | string): string[] => {
	if (Array.isArray(value)) return value;
	if (value === '{}') return [];
	return value.slice(1, -1).split(',').filter((item) => item.length > 0);
};

const withMigratedSchema = async (run: (schema: string, query: QueryRunner['query'], service: HanamiTimelinePartitionService) => Promise<void>): Promise<void> => {
	const schema = `hanami_partition_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const schemaName = quoteIdent(schema);
	const client = new Client({ connectionString: databaseUrl });
	const query: QueryRunner['query'] = async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
		const result = await client.query<T>(sql, values);
		return result.rows;
	};

	try {
		await client.connect();
		await query(`CREATE SCHEMA ${schemaName}`);
		await query(`SET search_path TO ${schemaName}, public`);
		await query(`CREATE TABLE "user" ("id" character varying(32) NOT NULL PRIMARY KEY)`);
		await query(`CREATE TABLE "note" ("id" character varying(32) NOT NULL PRIMARY KEY)`);
		await query(`CREATE TABLE "hanami_recommendation_event" (
			"id" character varying(32) NOT NULL,
			"userId" character varying(32) NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"eventType" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			PRIMARY KEY ("id")
		)`);

		await new HanamiPersistedTimelinePhase11787097600000().up({ query } as QueryRunner);
		await run(schema, query, new HanamiTimelinePartitionService(makeDataSource(schema) as never));
	} catch (error) {
		if (isDbConnectionError(error)) {
			console.warn('PostgreSQL is not reachable for Hanami partition DB contract. Set HANAMI_SCHEMA_TEST_DATABASE_URL to a live PostgreSQL database.');
		}
		throw error;
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

describe('Hanami timeline partition DB-backed contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the DB-backed Hanami partition contract suite.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL to run the DB-backed Hanami partition contract suite', () => {
				console.log('DB-backed Hanami partition contract is skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access.');
			});
		}
		return;
	}

	test('creates and validates future partitions without manual clones', async () => {
		await withMigratedSchema(async (schema, query, service) => {
			await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'));
			await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'));
			await Promise.all([
				service.ensureMonthAvailable(new Date('2026-11-01T00:00:00.000Z')),
				service.ensureMonthAvailable(new Date('2026-11-01T00:00:00.000Z')),
			]);
			await service.maintainCurrentAndNextTwoMonths(new Date('2026-12-31T23:59:59.999Z'));

			const partitions = await query<{ child_name: string; parent_name: string; partition_bound: string }>(`
				SELECT child.relname AS child_name, parent.relname AS parent_name, pg_get_expr(child.relpartbound, child.oid, true) AS partition_bound
				FROM pg_inherits i
				JOIN pg_class child ON child.oid = i.inhrelid
				JOIN pg_class parent ON parent.oid = i.inhparent
				JOIN pg_namespace n ON n.oid = child.relnamespace
				WHERE n.nspname = $1 AND parent.relname = ANY($2)
			`, [schema, parents]);

			for (const parent of parents) {
				for (const [yyyymm, from, to] of [
					['202610', '2026-10-01', '2026-11-01'],
					['202611', '2026-11-01', '2026-12-01'],
					['202612', '2026-12-01', '2027-01-01'],
					['202701', '2027-01-01', '2027-02-01'],
					['202702', '2027-02-01', '2027-03-01'],
				] as const) {
					const childName = `${parent}_${yyyymm}`;
					const row = partitions.find((partition) => partition.child_name === childName && partition.parent_name === parent);
					expect(row).toBeDefined();
					expect(row!.partition_bound).toBe(`FOR VALUES FROM ('${from}') TO ('${to}')`);
				}
			}
			expect(partitions.filter((partition) => partition.child_name.endsWith('_202610')).map((partition) => partition.child_name).sort()).toEqual(parents.map((parent) => `${parent}_202610`).sort());

			const indexRows = await query<IndexStructure>(`
				SELECT
					child.relname AS child_name,
					parent_idx.relname AS parent_index_name,
					idx.indisprimary AS is_primary,
					idx.indisunique AS is_unique,
					jsonb_agg(jsonb_build_object(
						'name', att.attname,
						'direction', CASE WHEN (idx.indoption[keys.ordinality::integer - 1] & 1) = 1 THEN 'DESC' ELSE 'ASC' END
					) ORDER BY keys.ordinality) AS columns
				FROM pg_class child
				JOIN pg_namespace n ON n.oid = child.relnamespace
				JOIN pg_index idx ON idx.indrelid = child.oid
				JOIN unnest(idx.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
				JOIN pg_attribute att ON att.attrelid = child.oid AND att.attnum = keys.attnum
				LEFT JOIN pg_inherits index_inherits ON index_inherits.inhrelid = idx.indexrelid
				LEFT JOIN pg_class parent_idx ON parent_idx.oid = index_inherits.inhparent
				WHERE n.nspname = $1 AND child.relname = ANY($2)
				GROUP BY child.relname, parent_idx.relname, idx.indisprimary, idx.indisunique, idx.indexrelid
				ORDER BY child.relname, parent_idx.relname
			`, [schema, parents.map((parent) => `${parent}_202610`)]);
			for (const parent of parents) {
				const rows = indexRows
					.filter((row) => row.child_name === `${parent}_202610`)
					.map(({ child_name: _childName, ...row }) => row);
				expect(sortStructures(rows)).toEqual(sortStructures(expectedIndexes[parent]));
			}

			const constraintRows = await query<ConstraintStructure>(`
				SELECT
					child.relname AS child_name,
					con.conname AS constraint_name,
					con.contype AS constraint_type,
					pg_get_constraintdef(con.oid) AS definition,
					COALESCE((
						SELECT array_agg(att.attname ORDER BY key_ord.ordinality)
						FROM unnest(con.conkey) WITH ORDINALITY AS key_ord(attnum, ordinality)
						JOIN pg_attribute att ON att.attrelid = child.oid AND att.attnum = key_ord.attnum
					), ARRAY[]::text[]) AS local_columns,
					ref_table.relname AS referenced_table,
					COALESCE((
						SELECT array_agg(ref_att.attname ORDER BY key_ord.ordinality)
						FROM unnest(con.confkey) WITH ORDINALITY AS key_ord(attnum, ordinality)
						JOIN pg_attribute ref_att ON ref_att.attrelid = ref_table.oid AND ref_att.attnum = key_ord.attnum
					), ARRAY[]::text[]) AS referenced_columns,
					CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'a' THEN 'NO ACTION' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE NULL END AS on_delete
				FROM pg_class child
				JOIN pg_namespace n ON n.oid = child.relnamespace
				JOIN pg_constraint con ON con.conrelid = child.oid
				LEFT JOIN pg_class ref_table ON ref_table.oid = con.confrelid
				WHERE n.nspname = $1 AND child.relname = ANY($2)
				ORDER BY child.relname, con.contype, con.conname
			`, [schema, parents.map((parent) => `${parent}_202610`)]);
			for (const parent of parents) {
				const rows = constraintRows.filter((row) => row.child_name === `${parent}_202610`);
				const keyConstraints = rows
					.filter((row) => row.constraint_type === 'p' || row.constraint_type === 'u')
					.map((row) => ({ is_primary: row.constraint_type === 'p', local_columns: pgArrayToStrings(row.local_columns) }));
				const expectedKeyConstraints = expectedIndexes[parent]
					.filter((index) => index.is_primary || index.is_unique)
					.map((index) => ({ is_primary: index.is_primary, local_columns: index.columns.map((column) => column.name) }));
				expect(sortStructures(keyConstraints)).toEqual(sortStructures(expectedKeyConstraints));

				expect(rows
					.filter((row) => row.constraint_type === 'c')
					.map((row) => normalizeCheck(row.definition))
					.sort()).toEqual(expectedChecks[parent].sort());
				if (parent === 'hanami_trend_snapshot_entry') {
					expect(rows.filter((row) => row.constraint_type === 'c').map((row) => row.constraint_name)).toContain('CHK_hanami_trend_snapshot_entry_rank');
				}
				if (parent === 'hanami_trend_snapshot_representative_note') {
					expect(rows.filter((row) => row.constraint_type === 'c').map((row) => row.constraint_name)).toEqual(expect.arrayContaining([
						'CHK_hanami_trend_snapshot_rep_note_rank',
						'CHK_hanami_trend_snapshot_rep_note_position',
					]));
				}

				expect(sortStructures(rows
					.filter((row) => row.constraint_type === 'f')
					.map((row) => ({
						local_columns: pgArrayToStrings(row.local_columns),
						referenced_table: row.referenced_table,
						referenced_columns: pgArrayToStrings(row.referenced_columns),
						on_delete: row.on_delete,
					})))).toEqual(sortStructures(expectedFks[parent]));
			}

			await query(`INSERT INTO "user" ("id") VALUES ('u-partition')`);
			await query(`INSERT INTO "note" ("id") VALUES ('n-partition'), ('n-rep')`);
			await query(`INSERT INTO "hanami_common_generation" ("id", "ordinal", "status", "startedAt", "algorithmVersion", "generationFence") VALUES ('g-partition', 1, 'ready', NOW(), 'v', 0)`);
			await query(`INSERT INTO "hanami_trend_snapshot" ("id", "ordinal", "status", "generatedAt", "commonGenerationId") VALUES ('s-partition', 1, 'ready', NOW(), 'g-partition')`);

			await query(`INSERT INTO "hanami_common_candidate" ("generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId") VALUES ('2026-10-01', 'g-partition', 0, 'unit', 0, 'n-partition')`);
			await query(`INSERT INTO "hanami_common_feed_entry" ("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt") VALUES ('2026-10-01', 'f-partition', 'epoch', '1', 'g-partition', 0, 'n-partition', 'unit', '[]'::jsonb, NOW())`);
			await query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term") VALUES ('2026-10-01', 't-partition', 's-partition', 0, 'term')`);
			await query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId") VALUES ('2026-10-01', 's-partition', 0, 0, 'n-rep')`);
			await query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term") VALUES ('2026-10-01', 't-max', 's-partition', 29, 'term-max')`);
			await query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId") VALUES ('2026-10-01', 's-partition', 29, 4, 'n-partition')`);

			await expect(query(`INSERT INTO "hanami_common_candidate" ("generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId") VALUES ('2026-10-01', 'g-partition', 0, 'unit', 1, 'n-partition')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_common_candidate" ("generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId") VALUES ('2026-10-01', 'g-partition', 0, 'unit-neg', -1, 'n-partition')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_common_candidate" ("generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId") VALUES ('2026-10-01', 'missing-generation', 0, 'unit-missing', 0, 'n-partition')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_common_candidate" ("generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId") VALUES ('2026-10-01', 'g-partition', 0, 'unit-missing-note', 0, 'missing-note')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_common_feed_entry" ("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt") VALUES ('2026-10-01', 'f-position', 'epoch', '2', 'g-partition', 210, 'n-partition', 'unit', '[]'::jsonb, NOW())`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term") VALUES ('2026-10-01', 't-negative', 's-partition', -1, 'term-neg')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term") VALUES ('2026-10-01', 't-over', 's-partition', 30, 'term-over')`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot_entry" SET "rank" = 30 WHERE "id" = 't-max'`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term") VALUES ('2026-10-01', 't-missing', 'missing-snapshot', 1, 'term-missing')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId") VALUES ('2026-10-01', 's-partition', 0, -1, 'n-rep')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId") VALUES ('2026-10-01', 's-partition', 30, 0, 'n-rep')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId") VALUES ('2026-10-01', 's-partition', 28, 5, 'n-rep')`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot_representative_note" SET "rank" = 30 WHERE "snapshotId" = 's-partition' AND "rank" = 29`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot_representative_note" SET "position" = 5 WHERE "snapshotId" = 's-partition' AND "rank" = 29`)).rejects.toThrow();

			const routedRows = await query<{ table_name: string }>(`
				SELECT tableoid::regclass::text AS table_name FROM "hanami_common_candidate" WHERE "noteId" = 'n-partition'
				UNION ALL
				SELECT tableoid::regclass::text AS table_name FROM "hanami_common_feed_entry" WHERE "id" = 'f-partition'
				UNION ALL
				SELECT tableoid::regclass::text AS table_name FROM "hanami_trend_snapshot_entry" WHERE "id" = 't-partition'
				UNION ALL
				SELECT tableoid::regclass::text AS table_name FROM "hanami_trend_snapshot_representative_note" WHERE "noteId" = 'n-rep'
			`);
			expect(routedRows.map((row) => row.table_name).sort()).toEqual(parents.map((parent) => `${parent}_202610`).sort());
		});
	});

	test('accepts partitions with non-ISO session DateStyle and temp shadowing', async () => {
		await withMigratedSchema(async (schema, query) => {
			const service = new HanamiTimelinePartitionService(makeDataSource(schema, { createTempShadow: true }) as never);
			await service.ensureMonthAvailable(new Date('2026-08-01T00:00:00.000Z'));
			await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'));

			const rows = await query<{ relname: string }>(`
				SELECT relname
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = $1 AND c.relname = 'hanami_common_candidate_202610'
			`, [schema]);
			expect(rows).toEqual([{ relname: 'hanami_common_candidate_202610' }]);
		});
	});

	test('ignores a temporary relation shadowing pg_class', async () => {
		await withMigratedSchema(async (schema, query) => {
			const service = new HanamiTimelinePartitionService(makeDataSource(schema, { createTempCatalogShadow: true }) as never);
			await service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'));

			const rows = await query<{ relname: string }>(`
				SELECT relname
				FROM pg_catalog.pg_class c
				JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = $1 AND c.relname = 'hanami_common_candidate_202610'
			`, [schema]);
			expect(rows).toEqual([{ relname: 'hanami_common_candidate_202610' }]);
		});
	});

	test('rejects a same-name wrong object', async () => {
		await withMigratedSchema(async (_schema, query, service) => {
			await query('CREATE TABLE "hanami_common_candidate_202610" (id integer NOT NULL)');
			await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('must be an ordinary partition table');
		});
	});

	test('rejects same-name wrong-parent and wrong-bound partitions', async () => {
		await withMigratedSchema(async (_schema, query, service) => {
			await query(`CREATE TABLE "hanami_common_candidate_202610" PARTITION OF "hanami_common_feed_entry" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')`);
			await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('must inherit directly from hanami_common_candidate');
		});

		await withMigratedSchema(async (_schema, query, service) => {
			await query(`CREATE TABLE "hanami_common_candidate_202610" PARTITION OF "hanami_common_candidate" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01')`);
			await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow('wrong bounds');
		});
	});

	test('fails at lock_timeout and releases while another connection holds the advisory lock', async () => {
		await withMigratedSchema(async (schema) => {
			const holder = new Client({ connectionString: databaseUrl });
			let released = false;

			try {
				await holder.connect();
				await holder.query('BEGIN');
				await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('hanami.timeline.partition-maintenance', 0))`);

				const service = new HanamiTimelinePartitionService(makeDataSource(schema, { onRelease: () => { released = true; } }) as never);
				const startedAt = Date.now();
				await expect(service.ensureMonthAvailable(new Date('2026-10-01T00:00:00.000Z'))).rejects.toThrow(/lock timeout|canceling statement/i);
				expect(Date.now() - startedAt).toBeLessThan(8000);
				expect(released).toBe(true);
			} finally {
				await holder.query('ROLLBACK').catch(() => undefined);
				await holder.end().catch(() => undefined);
			}
		});
	}, 15000);
});
