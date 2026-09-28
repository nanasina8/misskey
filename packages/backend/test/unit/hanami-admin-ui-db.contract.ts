/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, test } from '@jest/globals';
import JudgeAggregateEndpoint from '@/server/api/endpoints/admin/hanami/judge-aggregate.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiMetricsRuleExcluded1790467200000 } from '../../migration/1790467200000-hanamiMetricsRuleExcluded.js';

// Use a disposable PostgreSQL instance, never the local misskey database.
const databaseUrl = process.env.HANAMI_ADMIN_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;

describe('Hanami admin aggregate and migration PostgreSQL contracts', () => {
	dbTest('separates rule judgements, deduplicates twenty generations, and reverses capture/backfill/rollup', async () => {
		const schema = `hanami_admin_${randomBytes(6).toString('hex')}`;
		const client = new Client({ connectionString: databaseUrl });
		const query = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
		try {
			await client.connect();
			expect((await query('SELECT current_database() AS name'))[0].name).not.toBe('misskey');
			await query(`CREATE SCHEMA "${schema}"`);
			await query(`SET search_path TO "${schema}"`);
			await query(`CREATE TABLE meta ("hanamiNoteJudgeSettings" jsonb);
				CREATE TABLE "user" (id text PRIMARY KEY, host text);
				CREATE TABLE note (id text PRIMARY KEY, text text, "userId" text, "fileIds" text[]);
				CREATE TABLE user_profile ("userId" text, "hanamiRecommendationAxes" jsonb);
				CREATE TABLE hanami_user_feed_entry ("userId" text, "epochId" text, sequence bigint, "noteId" text, "reasonMetadata" jsonb);
				CREATE TABLE hanami_recommendation_event (id text, "userId" text, "noteId" text, "eventType" text, source text, "feedKind" text, "feedEpochId" text, "feedEntryId" text, "occurredAt" timestamptz, "createdAt" timestamptz);
				CREATE TABLE hanami_note_judgement ("noteId" text, "promptVersion" integer, model text, "contentType" integer, "ephemeralScore" float8, interest float8, "judgedAt" timestamptz);
				CREATE TABLE hanami_metrics_judgement (LIKE hanami_note_judgement);
				CREATE TABLE hanami_metrics_event (LIKE hanami_recommendation_event, dimensions jsonb, judgement jsonb, PRIMARY KEY(id));
				CREATE TABLE hanami_common_generation (id text, "generationFence" bigint);
				CREATE TABLE hanami_common_candidate ("noteId" text, "generationId" text, "generationFence" bigint, "generatedMonth" date, axis text, rank bigint, "baseScore" float8);
				CREATE TABLE hanami_common_feed_state ("latestReadyGenerationId" text);
				CREATE TABLE hanami_metrics_daily (day date, scope text, dimension text, key text, users integer, served integer, seen integer, reaction integer, reply integer, renote integer);
				CREATE FUNCTION hanami_metrics_locator(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
				INSERT INTO "user" VALUES ('u1', NULL);
				INSERT INTO note VALUES ('llm', 'LLM note', 'u1', '{}'), ('rule', 'Rule note', 'u1', '{}'), ('other', 'Other source', 'u1', '{}');
				INSERT INTO hanami_note_judgement VALUES ('llm', 1, 'llm', 0, 0, 5, now()), ('rule', 1, 'rule:bot', 0, 1, 1, now());
				INSERT INTO hanami_metrics_judgement SELECT * FROM hanami_note_judgement;
				INSERT INTO hanami_metrics_judgement VALUES ('llm', 2, 'rule:reply', 0, 1, 1, now());
				INSERT INTO hanami_common_generation SELECT 'g' || n, 1 FROM generate_series(1,20) n;
				INSERT INTO hanami_common_feed_state VALUES ('g20');
				INSERT INTO hanami_common_candidate SELECT 'llm', 'g' || n, 1, current_date, 'exploration', 0, n FROM generate_series(1,20) n;
				INSERT INTO hanami_common_candidate VALUES ('llm', 'g20', 0, current_date, 'exploration', 0, 999);
				INSERT INTO hanami_recommendation_event VALUES
					('e1','u1','llm','served','exploration',NULL,NULL,NULL,now()-interval '1 hour',now()-interval '1 hour'),
					('e2','u1','llm','served','exploration',NULL,NULL,NULL,now(),now()),
					('e3','u1','other','served','trending',NULL,NULL,NULL,now(),now());`);
			await query('INSERT INTO meta VALUES ($1)', [createDefaultHanamiNoteJudgeSettings()]);
			const aggregate = await new JudgeAggregateEndpoint({ query } as never).exec({}, { id: 'admin' } as never, null);
			expect(aggregate).toMatchObject({ judged: 1, ruleExcluded: 1, ephemeral: 0, interestFiltered: 0, typeBreakdown: [{ contentType: 0, count: 1 }] });
			expect(aggregate.topServed).toEqual([{ noteId: 'llm', text: 'LLM note', reactionScore: 20, interest: 5, ephemeralScore: 0 }]);
			// Two contentType=0 cohorts share the same user; the newer rule judgement on llm must not rewrite its older snapshot.
			await query(`INSERT INTO hanami_metrics_event (id,"userId","noteId","eventType","createdAt",dimensions,judgement)
				VALUES ('old-rule','u1','rule','served',now()-interval '1 day','{"contentType":"0"}','{"promptVersion":1}'),
				('old-llm','u1','llm','served',now()-interval '1 day','{"contentType":"0"}','{"promptVersion":1}'),
				('reaction','u1','rule','reaction',now(),'{}','{}');
				INSERT INTO hanami_metrics_daily VALUES ((now()-interval '1 day') AT TIME ZONE 'Asia/Tokyo','engagement','contentType','0',1,2,0,1,0,0);`);
			const migration = new HanamiMetricsRuleExcluded1790467200000();
			await migration.up({ query });
			expect(await query('SELECT id, dimensions->>\'contentType\' AS type FROM hanami_metrics_event WHERE id LIKE \'old-%\' ORDER BY id')).toEqual([{ id: 'old-llm', type: '0' }, { id: 'old-rule', type: 'ruleExcluded' }]);
			expect(await query('SELECT key, users, served, reaction FROM hanami_metrics_daily ORDER BY key')).toEqual([{ key: '0', users: 1, served: 1, reaction: 0 }, { key: 'ruleExcluded', users: 1, served: 1, reaction: 1 }]);
			await query(`CREATE FUNCTION capture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM hanami_metrics_capture_event(NEW); RETURN NEW; END $$;
				CREATE TRIGGER capture AFTER INSERT ON hanami_recommendation_event FOR EACH ROW EXECUTE FUNCTION capture_trigger();
				INSERT INTO hanami_recommendation_event VALUES ('new-rule','u1','rule','served','exploration',NULL,NULL,NULL,now(),now());`);
			expect((await query('SELECT dimensions->>\'contentType\' AS type FROM hanami_metrics_event WHERE id=\'new-rule\''))[0].type).toBe('ruleExcluded');
			await migration.down({ query });
			expect((await query('SELECT COUNT(*)::int AS count FROM hanami_metrics_event WHERE dimensions->>\'contentType\'=\'ruleExcluded\''))[0].count).toBe(0);
			expect(await query('SELECT key, users, served, reaction FROM hanami_metrics_daily')).toEqual([{ key: '0', users: 1, served: 2, reaction: 1 }]);
			await query('INSERT INTO hanami_recommendation_event VALUES (\'down-rule\',\'u1\',\'rule\',\'served\',\'exploration\',NULL,NULL,NULL,now(),now())');
			expect((await query('SELECT dimensions->>\'contentType\' AS type FROM hanami_metrics_event WHERE id=\'down-rule\''))[0].type).toBe('0');
		} finally {
			await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
			await client.end();
		}
	});
});
