/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, test } from '@jest/globals';
import { HanamiPersistedTimelinePhase11787097600000 } from '../../migration/1787097600000-hanamiPersistedTimelinePhase1.js';

type DbRow = Record<string, unknown>;

type QueryRunner = {
	query: <T extends DbRow = DbRow>(sql: string, values?: unknown[]) => Promise<T[]>;
};

const isDbConnectionError = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) return false;
	const maybeError = error as { code?: string; message?: string };
	return maybeError.code === 'ECONNREFUSED'
		|| maybeError.code === 'ENOTFOUND'
		|| maybeError.code === 'EHOSTUNREACH'
		|| maybeError.code === 'ETIMEDOUT'
		|| /connection refused|connecte?d|could not connect/i.test(maybeError.message ?? '');
};

describe('Hanami migration DB-backed contracts', () => {
	const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;

	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the DB-backed Hanami migration contract suite.');
			});
			return;
		}

		test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL to run the DB-backed schema contract suite', () => {
			console.log('DB-backed Hanami migration contract is skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access.');
		});
		return;
	}

		test('enforces phase-1 migration constraints in an isolated PostgreSQL schema', async () => {
			const schema = `hanami_contract_${Date.now()}_${randomBytes(4).toString('hex')}`;
			const schemaName = `"${schema}"`;
			const tableName = (name: string): string => `${schemaName}."${name}"`;
			const client = new Client({ connectionString: databaseUrl });
			const query: QueryRunner['query'] = async <T extends DbRow = DbRow>(
				sql: string,
				values: unknown[] = [],
			): Promise<T[]> => {
				const result = await client.query<T>(sql, values);
				return result.rows;
			};
			const migration = new HanamiPersistedTimelinePhase11787097600000();

			const expectConstraintHasDefinition = async (table: string, constraintName: string, snippets: string[]) => {
				const rows = await query<{
					conname: string;
					condef: string;
				}>(`
					SELECT c.conname, pg_get_constraintdef(c.oid) AS condef
					FROM pg_constraint c
					JOIN pg_class t ON t.oid = c.conrelid
					JOIN pg_namespace n ON n.oid = t.relnamespace
					WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3
				`, [schema, table, constraintName]);

				const condef = (rows[0]!.condef ?? '').toLowerCase();
				const normalizedCondef = condef.replace(/\s+/g, '').replace(/\(|\)/g, '').replace(/"/g, '');

				expect(rows.length).toBe(1);
				for (const snippet of snippets) {
					const normalizedSnippet = snippet.toLowerCase().replace(/\s+/g, '').replace(/\(|\)/g, '').replace(/"/g, '');
					expect(normalizedCondef).toContain(normalizedSnippet);
				}
			};

		const expectActiveBatchIndex = async (indexName: string, tableName: string) => {
			const rows = await query<{
				index_name: string;
				table_name: string;
				schema_name: string;
				ind: boolean;
				predicate: string | null;
			}>(`
				SELECT
					idx.relname AS index_name,
					tbl.relname AS table_name,
					n.nspname AS schema_name,
					i.indisunique AS ind,
					pg_get_expr(i.indpred, i.indrelid, true) AS predicate
				FROM pg_index i
				JOIN pg_class idx ON idx.oid = i.indexrelid
				JOIN pg_class tbl ON tbl.oid = i.indrelid
				JOIN pg_namespace n ON n.oid = idx.relnamespace
				WHERE n.nspname = $1 AND idx.relname = $2
			`, [schema, indexName]);

			expect(rows.length).toBe(1);
			expect(rows[0]!.index_name).toBe(indexName);
			expect(rows[0]!.table_name).toBe(tableName);
			expect(rows[0]!.schema_name).toBe(schema);
			expect(rows[0]!.ind).toBe(true);
			expect(rows[0]!.predicate).not.toBeNull();

			const predicate = rows[0]!.predicate?.toLowerCase() ?? '';
			expect(predicate).toMatch(/\bstatus\b/);
			expect(predicate).toContain("'pending'");
			expect(predicate).toContain("'generating'");
		};

		const expectIndexStructure = async (
			indexName: string,
			table: string,
			columns: Array<{ name: string; direction: 'ASC' | 'DESC' }>,
		) => {
			const rows = await query<{
				index_name: string;
				table_name: string;
				columns: Array<{ name: string; direction: 'ASC' | 'DESC' }>;
			}>(`
				SELECT idx.relname AS index_name, tbl.relname AS table_name,
					jsonb_agg(jsonb_build_object(
						'name', att.attname,
						'direction', CASE WHEN (i.indoption[keys.ordinality::integer - 1] & 1) = 1 THEN 'DESC' ELSE 'ASC' END
					) ORDER BY keys.ordinality) AS columns
				FROM pg_index i
				JOIN pg_class idx ON idx.oid = i.indexrelid
				JOIN pg_class tbl ON tbl.oid = i.indrelid
				JOIN pg_namespace n ON n.oid = idx.relnamespace
				JOIN unnest(i.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
				JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = keys.attnum
				WHERE n.nspname = $1 AND idx.relname = $2
				GROUP BY idx.relname, tbl.relname, i.indexrelid
			`, [schema, indexName]);

			expect(rows).toEqual([{ index_name: indexName, table_name: table, columns }]);
		};

		const expectTableMissingAfterDown = async (table: string) => {
			const rows = await query<{ exists: boolean }>(
				'SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2) AS "exists"',
				[schema, table],
			);
			expect(rows[0]!.exists).toBe(false);
		};

		const rowCount = async (table: string, clause = '1=1'): Promise<number> => {
			const rows = await query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM ${tableName(table)} WHERE ${clause}`,
			);
			return Number(rows[0]!.count);
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

			await query(`INSERT INTO "user" ("id") VALUES ('u-main'), ('u-alt'), ('u-cascade'), ('u-retired')`);
			await query(`INSERT INTO "note" ("id") VALUES ('n-main'), ('n-alt'), ('n-cascade'), ('n-retired'), ('n-bigint')`);
			await query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "createdAt")
				VALUES
					('evt-legacy', 'u-main', 'n-main', 'seed', NOW()),
					('evt-user-orphan', 'u-missing', 'n-main', 'seed', NOW()),
					('evt-note-orphan', 'u-main', 'n-missing', 'seed', NOW())`);

			await migration.up({ query } as QueryRunner);

			const migratedLegacyEvents = await query<{ id: string }>(`
				SELECT "id" FROM "hanami_recommendation_event" ORDER BY "id"
			`);
			expect(migratedLegacyEvents).toEqual([{ id: 'evt-legacy' }]);

			const expectedTables = [
				'hanami_common_generation',
				'hanami_common_candidate',
				'hanami_common_candidate_202608',
				'hanami_common_candidate_202609',
				'hanami_common_feed_entry',
				'hanami_common_feed_entry_202608',
				'hanami_common_feed_entry_202609',
				'hanami_common_feed_state',
				'hanami_trend_snapshot',
				'hanami_trend_snapshot_entry',
				'hanami_trend_snapshot_entry_202608',
				'hanami_trend_snapshot_entry_202609',
				'hanami_trend_snapshot_representative_note',
				'hanami_trend_snapshot_representative_note_202608',
				'hanami_trend_snapshot_representative_note_202609',
				'hanami_user_feed_epoch',
				'hanami_user_feed_state',
				'hanami_user_feed_batch',
				'hanami_user_feed_entry',
				'hanami_user_feed_refresh',
				'hanami_user_recommendation_state',
				'hanami_user_recommendation_batch',
				'hanami_user_recommendation_entry',
				'hanami_user_recommendation_refresh',
			];

			const actualTables = new Set((
				await query<{ table_name: string }>(
					'SELECT tablename AS table_name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
					[schema],
				)
			).map((row) => row.table_name));

			for (const expected of expectedTables) {
				expect(actualTables.has(expected)).toBe(true);
			}

			const partitionParents = new Set((await query<{ relname: string }>(`
				SELECT c.relname
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				JOIN pg_partitioned_table p ON p.partrelid = c.oid
				WHERE n.nspname = $1
			`, [schema])).map((row) => row.relname));
			const expectedPartitionParents = [
				'hanami_common_candidate',
				'hanami_common_feed_entry',
				'hanami_trend_snapshot_entry',
				'hanami_trend_snapshot_representative_note',
			];
			for (const parent of expectedPartitionParents) {
				expect(partitionParents.has(parent)).toBe(true);
			}

			const partitionChildren = await query<{ child_name: string; parent_name: string }>(`
				SELECT
					child.relname AS child_name,
					parent.relname AS parent_name
				FROM pg_inherits i
				JOIN pg_class child ON child.oid = i.inhrelid
				JOIN pg_class parent ON parent.oid = i.inhparent
				JOIN pg_namespace n ON n.oid = child.relnamespace
				WHERE n.nspname = $1
			`, [schema]);

			const expectChildForParent = (parent: string, child: string): void => {
				expect(
					partitionChildren.some(
						(row) => row.parent_name === parent && row.child_name === child,
					),
				).toBe(true);
			};

			expectChildForParent('hanami_common_candidate', 'hanami_common_candidate_202608');
			expectChildForParent('hanami_common_candidate', 'hanami_common_candidate_202609');
			expectChildForParent('hanami_common_feed_entry', 'hanami_common_feed_entry_202608');
			expectChildForParent('hanami_common_feed_entry', 'hanami_common_feed_entry_202609');
			expectChildForParent('hanami_trend_snapshot_entry', 'hanami_trend_snapshot_entry_202608');
			expectChildForParent('hanami_trend_snapshot_entry', 'hanami_trend_snapshot_entry_202609');
			expectChildForParent('hanami_trend_snapshot_representative_note', 'hanami_trend_snapshot_representative_note_202608');
			expectChildForParent('hanami_trend_snapshot_representative_note', 'hanami_trend_snapshot_representative_note_202609');

			await expectActiveBatchIndex('IDX_hanami_user_feed_batch_active_user', 'hanami_user_feed_batch');
			await expectActiveBatchIndex('IDX_hanami_user_recommendation_batch_active_user', 'hanami_user_recommendation_batch');
			await expectIndexStructure('IDX_hanami_rec_event_provenance_fallback', 'hanami_recommendation_event', [
				{ name: 'userId', direction: 'ASC' },
				{ name: 'eventType', direction: 'ASC' },
				{ name: 'occurredAt', direction: 'DESC' },
				{ name: 'noteId', direction: 'ASC' },
			]);

			await expectConstraintHasDefinition('hanami_common_generation', 'PK_hanami_common_generation', ['PRIMARY KEY']);
			await expectConstraintHasDefinition('hanami_common_generation', 'UQ_hanami_common_generation_ordinal', ['UNIQUE']);
			await expectConstraintHasDefinition('hanami_common_generation', 'CHK_hanami_common_generation_status', ["'ready'", "'obsolete'"]);

			await expectConstraintHasDefinition('hanami_common_candidate', 'PK_hanami_common_candidate', ['PRIMARY KEY']);
			await expectConstraintHasDefinition('hanami_common_candidate', 'UQ_hanami_common_candidate_note', ['UNIQUE']);
			await expectConstraintHasDefinition('hanami_common_candidate', 'CHK_hanami_common_candidate_rank', ['rank']);

			await expectConstraintHasDefinition('hanami_common_feed_entry', 'PK_hanami_common_feed_entry', ['PRIMARY KEY']);
			await expectConstraintHasDefinition('hanami_common_feed_entry', 'CHK_hanami_common_feed_entry_position', ['"position" >= 0 AND "position" < 210']);
			await expectConstraintHasDefinition('hanami_common_feed_state', 'CHK_hanami_common_feed_state_epoch_seeded', ['"epochId" IS NOT NULL OR ("latestReadyGenerationId" IS NULL AND "latestSequence" = 0 AND "earliestRetainedSequence" = 0)']);
			await expectConstraintHasDefinition('hanami_trend_snapshot', 'CHK_hanami_trend_snapshot_item_count', ['"itemCount" >= 0 AND "itemCount" <= 30']);
			await expectConstraintHasDefinition('hanami_trend_snapshot_entry', 'CHK_hanami_trend_snapshot_entry_rank', ['"rank" >= 0 AND "rank" < 30']);
			await expectConstraintHasDefinition('hanami_trend_snapshot_representative_note', 'CHK_hanami_trend_snapshot_rep_note_rank', ['"rank" >= 0 AND "rank" < 30']);
			await expectConstraintHasDefinition('hanami_trend_snapshot_representative_note', 'CHK_hanami_trend_snapshot_rep_note_position', ['"position" >= 0 AND "position" < 5']);

			const commonEpochColumn = await query<{ is_nullable: string }>(`
				SELECT is_nullable
				FROM information_schema.columns
				WHERE table_schema = $1 AND table_name = 'hanami_common_feed_state' AND column_name = 'epochId'
			`, [schema]);
			expect(commonEpochColumn).toEqual([{ is_nullable: 'YES' }]);

			const userEpochColumns = await query<{ table_name: string; is_nullable: string }>(`
				SELECT table_name, is_nullable
				FROM information_schema.columns
				WHERE table_schema = $1
					AND table_name = ANY($2)
					AND column_name = 'epochId'
				ORDER BY table_name
			`, [schema, ['hanami_user_feed_epoch', 'hanami_user_feed_state']]);
			expect(userEpochColumns).toEqual([
				{ table_name: 'hanami_user_feed_epoch', is_nullable: 'NO' },
				{ table_name: 'hanami_user_feed_state', is_nullable: 'NO' },
			]);

			await expectConstraintHasDefinition('hanami_user_feed_batch', 'FK_hanami_user_feed_batch_base_common', ['"baseCommonGenerationId"']);
			await expectConstraintHasDefinition('hanami_user_feed_batch', 'FK_hanami_user_feed_batch_user', ['REFERENCES "user"']);
			await expectConstraintHasDefinition('hanami_user_feed_batch', 'CHK_hanami_user_feed_batch_trigger', ['\'initial\'', '\'refresh\'']);
			await expectConstraintHasDefinition('hanami_user_feed_batch', 'CHK_hanami_user_feed_batch_lease', ['\'generating\'', '"leaseOwner" IS NOT NULL', '"leaseExpiresAt" IS NOT NULL', '"leaseOwner" IS NULL', '"leaseExpiresAt" IS NULL']);
			await expectConstraintHasDefinition('hanami_user_feed_entry', 'CHK_hanami_user_feed_entry_position', ['"position" >= 0 AND "position" < 210']);
			await expectConstraintHasDefinition('hanami_user_feed_entry', 'CHK_hanami_user_feed_entry_origin', ["'commonCandidate'", "'personalCandidate'"]);
			await expectConstraintHasDefinition('hanami_user_feed_entry', 'FK_hanami_user_feed_entry_batch', ['REFERENCES "hanami_user_feed_batch"']);

			await expectConstraintHasDefinition('hanami_user_feed_refresh', 'CHK_hanami_user_feed_refresh_digest', ['octet_length("refreshTokenDigest") = 32']);
			await expectConstraintHasDefinition('hanami_user_feed_refresh', 'CHK_hanami_user_feed_refresh_result', ['pending', 'obsolete', 'ready', 'failed', '"resultMode" IS NULL', '"resultMode" IS NOT NULL', '"resultHeadSequence" > 0']);
			await expectConstraintHasDefinition('hanami_user_feed_state', 'CHK_hanami_user_feed_state_sequences', ['"latestSequence" = 0', '"earliestRetainedSequence" = 0', '"earliestRetainedSequence" > 0', '"latestSequence" >= "earliestRetainedSequence"']);
			await expectConstraintHasDefinition('hanami_user_feed_state', 'CHK_hanami_user_feed_state_common_head', ['"commonEpochId" IS NULL', '"commonHeadGenerationId" IS NULL', '"commonHeadSequence" IS NULL', '"commonHeadSequence" > 0']);

			await expectConstraintHasDefinition('hanami_user_recommendation_batch', 'FK_hanami_user_recommendation_batch_user', ['REFERENCES "user"']);
			await expectConstraintHasDefinition('hanami_user_recommendation_batch', 'UQ_hanami_user_recommendation_batch_user_epoch_id', ['UNIQUE']);

			await expectConstraintHasDefinition('hanami_recommendation_event', 'CHK_hanami_rec_event_feed_all_or_none', ['feedKind']);
			await expectConstraintHasDefinition('hanami_recommendation_event', 'CHK_hanami_rec_event_feed_occurred', ['"feedEntryId" IS NULL OR "occurredAt" IS NOT NULL']);
			await expectConstraintHasDefinition('hanami_recommendation_event', 'FK_hanami_rec_event_user', ['FOREIGN KEY', 'REFERENCES "user"', 'ON DELETE CASCADE']);
			await expectConstraintHasDefinition('hanami_recommendation_event', 'FK_hanami_rec_event_note', ['FOREIGN KEY', 'REFERENCES note', 'ON DELETE CASCADE']);

			await query(`INSERT INTO "hanami_common_generation" ("id", "ordinal", "status", "startedAt", "algorithmVersion", "generationFence")
				VALUES
					('g-main', 1, 'ready', NOW(), 'v-main', 0),
					('g-next', 2, 'ready', NOW(), 'v-next', 0),
					('g-retired', 3, 'ready', NOW(), 'v-retired', 0),
					('g-claim', 4, 'generating', NOW(), 'v-claim', 1)
			`);

			await query(`INSERT INTO "hanami_trend_snapshot" ("id", "ordinal", "status", "generatedAt", "itemCount", "commonGenerationId")
				VALUES ('trend-bounds', 1, 'ready', NOW(), 30, 'g-main')`);
			await expect(query(`INSERT INTO "hanami_trend_snapshot" ("id", "ordinal", "status", "generatedAt", "itemCount", "commonGenerationId")
				VALUES ('trend-too-many', 2, 'ready', NOW(), 31, 'g-next')`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot" SET "itemCount" = 31 WHERE "id" = 'trend-bounds'`)).rejects.toThrow();

			await query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term")
				VALUES ('2026-08-01', 'trend-entry-max', 'trend-bounds', 29, 'term-max')`);
			await expect(query(`INSERT INTO "hanami_trend_snapshot_entry" ("generatedMonth", "id", "snapshotId", "rank", "term")
				VALUES ('2026-08-01', 'trend-entry-over', 'trend-bounds', 30, 'term-over')`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot_entry" SET "rank" = 30 WHERE "id" = 'trend-entry-max'`)).rejects.toThrow();

			await query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId")
				VALUES ('2026-08-01', 'trend-bounds', 29, 4, 'n-main')`);
			await expect(query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId")
				VALUES ('2026-08-01', 'trend-bounds', 30, 0, 'n-alt')`)).rejects.toThrow();
			await expect(query(`INSERT INTO "hanami_trend_snapshot_representative_note" ("generatedMonth", "snapshotId", "rank", "position", "noteId")
				VALUES ('2026-08-01', 'trend-bounds', 28, 5, 'n-alt')`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot_representative_note" SET "rank" = 30
				WHERE "snapshotId" = 'trend-bounds' AND "rank" = 29 AND "position" = 4`)).rejects.toThrow();
			await expect(query(`UPDATE "hanami_trend_snapshot_representative_note" SET "position" = 5
				WHERE "snapshotId" = 'trend-bounds' AND "rank" = 29 AND "position" = 4`)).rejects.toThrow();

			await query(`INSERT INTO "hanami_common_feed_state" ("singletonId", "generatingGenerationId", "generationLeaseOwner", "generationLeaseExpiresAt", "generationFence", "updatedAt")
				VALUES ('singleton', 'g-claim', 'worker-1', NOW() + INTERVAL '5 minutes', 1, NOW())`);

			await expect(
				query('UPDATE "hanami_common_feed_state" SET "latestReadyGenerationId" = \'g-main\' WHERE "singletonId" = \'singleton\''),
			).rejects.toThrow();
			await expect(
				query('UPDATE "hanami_common_feed_state" SET "latestSequence" = 1 WHERE "singletonId" = \'singleton\''),
			).rejects.toThrow();
			await expect(
				query('UPDATE "hanami_common_feed_state" SET "earliestRetainedSequence" = 1 WHERE "singletonId" = \'singleton\''),
			).rejects.toThrow();

			const preSeedState = await query<{
				epoch_id: string | null;
				latest_ready_generation_id: string | null;
				latest_sequence: string;
				earliest_retained_sequence: string;
				generating_generation_id: string | null;
			}>(`SELECT
				"epochId" AS epoch_id,
				"latestReadyGenerationId" AS latest_ready_generation_id,
				"latestSequence"::text AS latest_sequence,
				"earliestRetainedSequence"::text AS earliest_retained_sequence,
				"generatingGenerationId" AS generating_generation_id
				FROM "hanami_common_feed_state" WHERE "singletonId" = 'singleton'`);
			expect(preSeedState).toEqual([{
				epoch_id: null,
				latest_ready_generation_id: null,
				latest_sequence: '0',
				earliest_retained_sequence: '0',
				generating_generation_id: 'g-claim',
			}]);

			await query(`UPDATE "hanami_common_feed_state"
				SET "epochId" = 'epoch-main', "latestReadyGenerationId" = 'g-main', "latestSequence" = 2, "earliestRetainedSequence" = 1,
					"generatingGenerationId" = NULL, "generationLeaseOwner" = NULL, "generationLeaseExpiresAt" = NULL
				WHERE "singletonId" = 'singleton'`);

			await query(`INSERT INTO "hanami_common_feed_entry" ("generatedMonth", "id", "epochId", "sequence", "generationId", "position", "noteId", "source", "sources", "generatedAt")
				VALUES
					('2026-08-01', 'f-aug', 'epoch-main', '1', 'g-main', 0, 'n-main', 'unit', '[]'::jsonb, NOW()),
					('2026-09-01', 'f-sep', 'epoch-main', '2', 'g-main', 1, 'n-alt', 'unit', '[]'::jsonb, NOW())
			`);

			await query(`INSERT INTO "hanami_common_candidate" ("generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId")
				VALUES
					('2026-08-01', 'g-main', 0, 'unit', 0, 'n-main'),
					('2026-09-01', 'g-main', 0, 'unit', 1, 'n-alt')
			`);

			await query(`INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
				VALUES
					('epoch-main', 'u-main', NOW(), NULL),
					('epoch-cascade', 'u-cascade', NOW(), NULL),
					('epoch-older', 'u-main', NOW() - INTERVAL '14 days', NOW()),
					('epoch-alt', 'u-alt', NOW(), NULL),
					('epoch-retired', 'u-retired', NOW() - INTERVAL '14 days', NULL),
					('epoch-retired-final', 'u-retired', NOW() - INTERVAL '14 days', NOW())
			`);

			await query(`INSERT INTO "hanami_user_feed_batch" ("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId")
				VALUES
					('batch-main', 'u-main', 'epoch-main', 'initial', 'pending', 0, NOW(), NOW(), 'g-main'),
					('batch-older', 'u-main', 'epoch-older', 'refresh', 'obsolete', 0, NOW(), NOW(), 'g-main'),
					('batch-alt', 'u-alt', 'epoch-alt', 'initial', 'pending', 0, NOW(), NOW(), 'g-main'),
					('batch-retired', 'u-retired', 'epoch-retired', 'initial', 'ready', 0, NOW(), NOW(), 'g-main')
			`);

			await query(`INSERT INTO "hanami_user_feed_state" ("userId", "epochId", "mode", "initialGenerationState", "latestReadyBatchId", "generatingBatchId", "latestSequence", "earliestRetainedSequence", "commonHeadGenerationId", "commonEpochId", "commonHeadSequence", "updatedAt")
				VALUES
					('u-main', 'epoch-main', 'personalized', 'notEvaluated', 'batch-main', NULL, 0, 0, 'g-main', 'epoch-main', 2, NOW()),
					('u-alt', 'epoch-alt', 'personalized', 'notEvaluated', 'batch-alt', NULL, 0, 0, NULL, NULL, NULL, NOW()),
					('u-cascade', 'epoch-cascade', 'personalized', 'notEvaluated', NULL, NULL, 0, 0, NULL, NULL, NULL, NOW()),
					('u-retired', 'epoch-retired', 'personalized', 'notEvaluated', 'batch-retired', NULL, 0, 0, NULL, NULL, NULL, NOW())
			`);

			await query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
				VALUES
					('entry-main', 'u-main', 'epoch-main', '1', 'batch-main', 0, 'n-main', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())
			`);

			await query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
				VALUES ('entry-compat', 'u-main', 'epoch-main', '2', 'batch-main', 1, 'n-alt', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`);

			await expect(
				query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
					VALUES ('entry-cross-user', 'u-main', 'epoch-main', '3', 'batch-alt', 2, 'n-alt', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`),
			).rejects.toThrow();

			await expect(
				query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
					VALUES ('entry-cross-epoch', 'u-main', 'epoch-main', '4', 'batch-older', 3, 'n-alt', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`),
			).rejects.toThrow();

			await expect(
				query(`INSERT INTO "hanami_user_feed_batch" ("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId")
					VALUES ('batch-main-two', 'u-main', 'epoch-older', 'refresh', 'generating', 0, NOW(), NOW(), 'g-main')`),
			).rejects.toThrow();

			await query(`INSERT INTO "hanami_user_feed_batch" ("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId", "itemCount")
				VALUES ('batch-210', 'u-main', 'epoch-main', 'initial', 'ready', 0, NOW(), NOW(), 'g-main', 210)`);
			await expect(
				query(`INSERT INTO "hanami_user_feed_batch" ("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId", "itemCount")
					VALUES ('batch-211', 'u-main', 'epoch-main', 'initial', 'ready', 0, NOW(), NOW(), 'g-main', 211)`),
			).rejects.toThrow();

			await query(`INSERT INTO "hanami_user_feed_batch" ("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId")
				VALUES ('batch-old-ready', 'u-main', 'epoch-older', 'refresh', 'ready', 0, NOW(), NOW(), 'g-main')`);

				await query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
					VALUES ('entry-209', 'u-main', 'epoch-main', '5', 'batch-main', 209, 'n-bigint', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`);

			await expect(
				query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
					VALUES ('entry-211', 'u-main', 'epoch-main', '6', 'batch-main', 210, 'n-alt', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`),
			).rejects.toThrow();

			await query(`INSERT INTO "hanami_user_feed_refresh" ("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt")
				VALUES ('u-main', 'epoch-main', $1::bytea, 'batch-main', 'pending', NOW(), NOW() + INTERVAL '7 days')`,
				[Buffer.alloc(32)]);

			await expect(
				query(`INSERT INTO "hanami_user_feed_refresh" ("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt")
					VALUES ('u-main', 'epoch-main', $1::bytea, 'batch-main', 'pending', NOW(), NOW() + INTERVAL '7 days')`,
				[Buffer.alloc(31)]),
			).rejects.toThrow();

			await expect(
				query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
					VALUES ('entry-bad-origin', 'u-main', 'epoch-main', '7', 'batch-main', 15, 'n-main', 'unit', '[]'::jsonb, 'bad-kind', '{}'::jsonb, NOW())`),
			).rejects.toThrow();

			await query(`INSERT INTO "hanami_user_recommendation_batch" ("id", "userId", "epochId", "ordinal", "trigger", "status", "attempts", "createdAt", "availableAt", "itemCount")
				VALUES ('rec-batch-210', 'u-main', 'epoch-main', 2, 'initial', 'ready', 0, NOW(), NOW(), 210)`);
			await expect(
				query(`INSERT INTO "hanami_user_recommendation_batch" ("id", "userId", "epochId", "ordinal", "trigger", "status", "attempts", "createdAt", "availableAt", "itemCount")
					VALUES ('rec-batch-211', 'u-main', 'epoch-main', 3, 'initial', 'ready', 0, NOW(), NOW(), 211)`),
			).rejects.toThrow();

			await query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "createdAt")
				VALUES ('evt-baseline', 'u-main', 'n-main', 'seed', NOW())`);

			await expect(
				query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "createdAt", "feedKind", "feedEpochId")
					VALUES ('evt-one-side', 'u-main', 'n-main', 'seed', NOW(), 'common', 'epoch-main')`),
			).rejects.toThrow();

			await expect(
				query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "createdAt", "feedKind", "feedEpochId", "feedEntryId")
					VALUES ('evt-missing-time', 'u-main', 'n-main', 'seed', NOW(), 'common', 'epoch-main', 'entry-main')`),
			).rejects.toThrow();

			await query(`INSERT INTO "hanami_recommendation_event" ("id", "userId", "noteId", "eventType", "createdAt", "feedKind", "feedEpochId", "feedEntryId", "occurredAt")
				VALUES ('evt-valid', 'u-main', 'n-main', 'seed', NOW(), 'common', 'epoch-main', 'entry-main', NOW())`);

			await query(`SET enable_seqscan = off`);
			try {
				const planRows = await query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF)
					SELECT "noteId"
					FROM "hanami_recommendation_event"
					WHERE "userId" = 'u-main' AND "eventType" = 'seed' AND "occurredAt" >= NOW() - INTERVAL '1 day'
					ORDER BY "occurredAt" DESC`);
				expect(planRows.map((row) => row['QUERY PLAN']).join('\n')).toContain('IDX_hanami_rec_event_provenance_fallback');
			} finally {
				await query(`RESET enable_seqscan`);
			}

			await query(`INSERT INTO "hanami_user_recommendation_batch" ("id", "userId", "epochId", "ordinal", "trigger", "status", "attempts", "createdAt", "availableAt")
				VALUES ('rec-batch', 'u-main', 'epoch-main', 1, 'initial', 'ready', 0, NOW(), NOW())`);

			await query(`INSERT INTO "hanami_user_recommendation_entry" ("id", "userId", "epochId", "sequence", "batchId", "rank", "recommendedUserId", "reason", "mutualCount", "shownAt")
				VALUES ('rec-entry', 'u-main', 'epoch-main', '9007199254740993', 'rec-batch', 0, 'u-alt', '{}'::jsonb, 0, NOW())`);

			const bigints = await query<{ value: string }>(
				`SELECT "sequence"::text AS value FROM "hanami_user_recommendation_entry" WHERE "id" = 'rec-entry'`,
			);
			expect(bigints[0]!.value).toBe('9007199254740993');

				await query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
					VALUES ('entry-to-partition', 'u-main', 'epoch-main', '8', 'batch-main', 20, 'n-retired', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`);

			const currentPartitionRows = await query<{ table_name: string }>(`
				SELECT tableoid::regclass::text AS table_name
				FROM "hanami_common_candidate"
				WHERE "noteId" = 'n-main'
			`);
			expect(currentPartitionRows.map((row) => row.table_name).some((name) => name.endsWith('hanami_common_candidate_202608'))).toBe(true);

			const nextPartitionRows = await query<{ table_name: string }>(`
				SELECT tableoid::regclass::text AS table_name
				FROM "hanami_common_candidate"
				WHERE "noteId" = 'n-alt'
			`);
			expect(nextPartitionRows.map((row) => row.table_name).some((name) => name.endsWith('hanami_common_candidate_202609'))).toBe(true);

			await expect(
				query(`DELETE FROM "hanami_common_generation" WHERE "id" = 'g-main'`),
			).rejects.toThrow();

			const cascadeStateCountBeforeDelete = await rowCount('hanami_user_feed_entry', '"userId" = \'u-cascade\'');
			expect(cascadeStateCountBeforeDelete).toBe(0);

			await query(`INSERT INTO "hanami_user_feed_batch" ("id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId")
				VALUES ('batch-cascade', 'u-cascade', 'epoch-cascade', 'initial', 'ready', 0, NOW(), NOW(), 'g-main')`);
			await query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
				VALUES ('entry-cascade', 'u-cascade', 'epoch-cascade', '9', 'batch-cascade', 4, 'n-cascade', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`);
			await query(`INSERT INTO "hanami_user_feed_refresh" ("userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt")
				VALUES ('u-cascade', 'epoch-cascade', $1::bytea, 'batch-cascade', 'pending', NOW(), NOW() + INTERVAL '7 days')`,
				[Buffer.alloc(32)]);

			await query(`DELETE FROM "user" WHERE "id" = 'u-cascade'`);

			expect(await rowCount('hanami_user_feed_state', '"userId" = \'u-cascade\'')).toBe(0);
			expect(await rowCount('hanami_user_feed_epoch', '"userId" = \'u-cascade\'')).toBe(0);
			expect(await rowCount('hanami_user_feed_batch', '"userId" = \'u-cascade\'')).toBe(0);
			expect(await rowCount('hanami_user_feed_entry', '"userId" = \'u-cascade\'')).toBe(0);
			expect(await rowCount('hanami_user_feed_refresh', '"userId" = \'u-cascade\'')).toBe(0);

			await query(`INSERT INTO "hanami_user_feed_entry" ("id", "userId", "epochId", "sequence", "batchId", "position", "noteId", "source", "sources", "origin", "reasonMetadata", "generatedAt")
				VALUES ('entry-retired', 'u-retired', 'epoch-retired', '10', 'batch-retired', 6, 'n-retired', 'unit', '[]'::jsonb, 'personalCandidate', '{}'::jsonb, NOW())`);

			await query(`UPDATE "hanami_user_feed_state" SET "epochId" = 'epoch-retired-final', "latestReadyBatchId" = NULL, "generatingBatchId" = NULL WHERE "userId" = 'u-retired'`);
			await query(`DELETE FROM "hanami_user_feed_epoch" WHERE "epochId" = 'epoch-retired'`);

			expect(await rowCount('hanami_user_feed_epoch', '"epochId" = \'epoch-retired\'')).toBe(0);
			expect(await rowCount('hanami_user_feed_batch', '"epochId" = \'epoch-retired\'')).toBe(0);
			expect(await rowCount('hanami_user_feed_entry', '"epochId" = \'epoch-retired\'')).toBe(0);

			await migration.down({ query } as QueryRunner);

			const expectedDroppedTables = expectedTables;
			for (const table of expectedDroppedTables) {
				await expectTableMissingAfterDown(table);
			}

			const remainingEventColumns = new Set((
				await query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'hanami_recommendation_event'`,
					[schema],
				)
			).map((row) => row.column_name));
			const provenanceIndexRows = await query<{ exists: boolean }>(`
				SELECT EXISTS (
					SELECT 1 FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
					WHERE n.nspname = $1 AND i.relname = 'IDX_hanami_rec_event_provenance_fallback'
				) AS "exists"
			`, [schema]);
			expect(provenanceIndexRows).toEqual([{ exists: false }]);

			expect(remainingEventColumns.has('feedKind')).toBe(false);
			expect(remainingEventColumns.has('feedEpochId')).toBe(false);
			expect(remainingEventColumns.has('feedEntryId')).toBe(false);
			expect(remainingEventColumns.has('occurredAt')).toBe(false);
			expect(remainingEventColumns.has('id')).toBe(true);
			expect(remainingEventColumns.has('userId')).toBe(true);
			expect(remainingEventColumns.has('noteId')).toBe(true);
			expect(remainingEventColumns.has('eventType')).toBe(true);
			expect(remainingEventColumns.has('createdAt')).toBe(true);

			const finalEventCount = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM "hanami_recommendation_event"');
			expect(Number(finalEventCount[0]!.count)).toBeGreaterThan(0);
		} catch (error) {
			if (isDbConnectionError(error)) {
				console.warn(
					'PostgreSQL is not reachable. Start a local test database with:\n'
					+	'docker run --rm --name wp1-tests-postgresql -e POSTGRES_DB=wp1-tests -e POSTGRES_USER=wp1-tests -e POSTGRES_PASSWORD=wp1-tests -p 5432:5432 postgres:16\n'
						+ 'export HANAMI_SCHEMA_TEST_DATABASE_URL=postgres://wp1-tests:wp1-tests@127.0.0.1:5432/wp1-tests\n'
				);
			}
			throw error;
		} finally {
			await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {
				// Ignore cleanup failures to avoid masking test failures.
			});
			await client.end().catch(() => {
				// Ignore cleanup failures to avoid masking test failures.
			});
		}
	});
});
