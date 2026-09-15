/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, test } from '@jest/globals';
import { HanamiNoteJudge1789344000000 } from '../../migration/1789344000000-hanamiNoteJudge.js';
import { HanamiReduceEphemeralPosts1789430400000 } from '../../migration/1789430400000-hanamiReduceEphemeralPosts.js';
import { HanamiNoteJudgeSettingsHistory1789516800000 } from '../../migration/1789516800000-hanamiNoteJudgeSettingsHistory.js';

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;

describe('Hanami judge migration DB-backed contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the Hanami judge migration DB contract suite.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('applies judge migrations, backfills immutable settings history, and reverses them', async () => {
		const schema = `hanami_judge_contract_${Date.now()}_${randomBytes(4).toString('hex')}`;
		const schemaName = `"${schema}"`;
		const client = new Client({ connectionString: databaseUrl });
		const query = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, values)).rows;
		const runner = { query };

		try {
			await client.connect();
			await query(`CREATE SCHEMA ${schemaName}`);
			await query(`SET search_path TO ${schemaName}, public`);
			await query('CREATE TABLE "note" ("id" character varying(32) PRIMARY KEY)');
			await query('CREATE TABLE "meta" ("id" character varying(32) PRIMARY KEY)');
			await query('CREATE TABLE "user_profile" ("id" character varying(32) PRIMARY KEY)');
			await query('INSERT INTO "note" ("id") VALUES ($1), ($2)', ['note-1', 'note-2']);
			await query('INSERT INTO "meta" ("id") VALUES ($1)', ['meta-1']);
			await query('INSERT INTO "user_profile" ("id") VALUES ($1)', ['user-1']);

			await new HanamiNoteJudge1789344000000().up(runner);
			await new HanamiReduceEphemeralPosts1789430400000().up(runner);
			await query(`UPDATE "meta" SET "hanamiNoteJudgeSettings" = jsonb_set("hanamiNoteJudgeSettings", '{promptVersion}', '7')`);
			await new HanamiNoteJudgeSettingsHistory1789516800000().up(runner);
			expect((await query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`${schema}.hanami_note_judgement`]))[0]!.exists).toBe(true);
			expect((await query<{ value: boolean }>('SELECT "hanamiReduceEphemeralPosts" AS value FROM "user_profile" WHERE "id" = $1', ['user-1']))[0]!.value).toBe(true);
			expect(await query<{ promptVersion: number; settings: { promptVersion: number } }>('SELECT "promptVersion", "settings" FROM "hanami_note_judge_settings"')).toEqual([
				{ promptVersion: 7, settings: expect.objectContaining({ promptVersion: 7 }) },
			]);
			await expect(query(`UPDATE "hanami_note_judge_settings" SET "settings" = '{}'::jsonb WHERE "promptVersion" = 7`)).rejects.toMatchObject({ code: 'P0001' });
			await expect(query(`INSERT INTO "hanami_note_judge_settings" ("promptVersion", "settings") VALUES (7, '{"promptVersion":7}'::jsonb)`)).rejects.toMatchObject({ code: '23505' });
			await expect(query(`INSERT INTO "hanami_note_judge_settings" ("promptVersion", "settings") VALUES (8, '{"promptVersion":7}'::jsonb)`)).rejects.toMatchObject({ code: '23514' });

			await query('INSERT INTO "hanami_note_judgement" VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', ['note-1', 'model', 1, 0.2, 3.5, [0.1, 0.2, 0.3, 0.2, 0.2], 2, new Date()]);
			await expect(query('INSERT INTO "hanami_note_judgement" VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', ['missing', 'model', 1, 0, 3, [0, 0, 0, 0, 0], 1, new Date()])).rejects.toMatchObject({ code: '23503' });
			await expect(query('INSERT INTO "hanami_note_judgement" VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', ['note-2', 'model', 1, 0, 6, [0, 0, 0, 0, 0], 1, new Date()])).rejects.toMatchObject({ code: '23514' });
			await expect(query('INSERT INTO "hanami_note_judgement" VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', ['note-1', 'model', 1, 0, 3, [0, 0, 0, 0, 0], 1, new Date()])).rejects.toMatchObject({ code: '23505' });

			await new HanamiReduceEphemeralPosts1789430400000().down(runner);
			await new HanamiNoteJudgeSettingsHistory1789516800000().down(runner);
			expect((await query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`${schema}.hanami_note_judge_settings`]))[0]!.exists).toBe(false);
			await new HanamiNoteJudge1789344000000().down(runner);
			expect((await query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [`${schema}.hanami_note_judgement`]))[0]!.exists).toBe(false);
			expect((await query('SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [schema, 'meta', 'hanamiNoteJudgeSettings'])).length).toBe(0);
		} finally {
			await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
			await client.end().catch(() => undefined);
		}
	});
});
