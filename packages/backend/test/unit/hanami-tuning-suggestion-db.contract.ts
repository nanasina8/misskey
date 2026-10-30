/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import SuggestionEndpoint, { meta } from '@/server/api/endpoints/i/hanami-tuning-suggestion.js';
import { HanamiTuning1793027014718 } from '../../migration/1793027014718-hanamiTuning.js';

const databaseUrl = process.env.HANAMI_TUNING_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;

describe('Hanami tuning API PostgreSQL contracts', () => {
	test('suggestions require credentials and read:account with a light request limit', () => {
		expect(meta).toMatchObject({ requireCredential: true, kind: 'read:account', limit: { duration: 60000, max: 10 } });
	});
	dbTest('migration up/down preserves legacy values; endpoint deduplicates scoped 14-day events without exposing other viewers', async () => {
		const client = new Client({ connectionString: databaseUrl });
		const schema = `hanami_tuning_${randomBytes(6).toString('hex')}`;
		const query = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
		try {
			await client.connect();
			expect((await query('SELECT current_database() AS db'))[0].db).toBe('test-misskey');
			await query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
			await query(`CREATE TABLE user_profile ("userId" text, "hanamiRecommendationAxes" jsonb);
				CREATE TABLE hanami_user_feed_refresh ("userId" text);
				CREATE TABLE hanami_recommendation_event ("userId" text, "noteId" text, source text, "eventType" text, "feedKind" text, "occurredAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now());
				INSERT INTO user_profile VALUES ('me', '{"globalPopular":"high"}');
				INSERT INTO hanami_user_feed_refresh VALUES ('me')`);
			const migration = new HanamiTuning1793027014718();
			await migration.up({ query });
			expect(await query('SELECT "hanamiTuning", "hanamiRecommendationAxes" FROM user_profile')).toEqual([{ hanamiTuning: {}, hanamiRecommendationAxes: { globalPopular: 'high' } }]);
			expect(await query('SELECT reason FROM hanami_user_feed_refresh')).toEqual([{ reason: 'normal' }]);
			await query(`INSERT INTO hanami_recommendation_event SELECT 'me', 'n' || i, 'globalPopular', 'seen', 'personal', now() FROM generate_series(1,200) i;
				INSERT INTO hanami_recommendation_event SELECT 'me', 'n' || i, 'globalPopular', 'served', 'personal', now() FROM generate_series(1,200) i;
				INSERT INTO hanami_recommendation_event SELECT 'me', 'n' || i, 'globalPopular', e, NULL, now() FROM generate_series(1,10) i CROSS JOIN unnest(ARRAY['reaction','reply','renote']) e;
				INSERT INTO hanami_recommendation_event VALUES ('me','common-only','globalPopular','served','common',now()), ('me','common-only','globalPopular','reaction',NULL,now()),
					('me','n150','trending','reaction',NULL,now());
				INSERT INTO hanami_recommendation_event VALUES ('me','n1','globalPopular','seen','personal',now()), ('me','old','globalPopular','seen','personal',now()-interval '15 days'), ('me','common','globalPopular','seen','common',now()), ('me','normal','normal','seen','personal',now());
				INSERT INTO hanami_recommendation_event SELECT 'someone-else', 'n' || i, 'globalPopular', 'seen', 'personal', now() FROM generate_series(1,100) i;
				INSERT INTO hanami_recommendation_event SELECT 'someone-else', 'n' || i, 'globalPopular', 'served', 'personal', now() FROM generate_series(1,100) i;
				INSERT INTO hanami_recommendation_event SELECT 'someone-else', 'n' || i, 'globalPopular', 'reaction', NULL, now() FROM generate_series(1,20) i`);
			// Null occurredAt must fall back for both personal and server counts.
			await query(`UPDATE hanami_recommendation_event SET "occurredAt" = NULL WHERE "noteId" = 'n1';
				INSERT INTO hanami_recommendation_event VALUES
					('me','old-null','globalPopular','seen','personal',NULL,now()-interval '15 days'),
					('me','future-null','globalPopular','served','personal',NULL,now()+interval '1 day'),
					('me','future-null','globalPopular','reaction',NULL,NULL,now()+interval '1 day'),
					('someone-else','old-null','globalPopular','served','personal',NULL,now()-interval '15 days'),
					('someone-else','old-null','globalPopular','reaction',NULL,NULL,now()-interval '15 days')`);
			// A manually enabled default-off axis remains eligible for aggregation.
			const endpoint = new SuggestionEndpoint({ query } as never, { hanamiRecommendationAxisConfig: { globalPopular: { default: false } } } as never, { userProfileCache: { fetch: async (userId: string) => { expect(userId).toBe('me'); return { hanamiRecommendationAxes: { globalPopular: 'normal' } }; } } } as never);
			const result = await endpoint.exec({}, { id: 'me' } as never, null);
			expect(result).toMatchObject({ eligible: true, totalSeen: 200, totalReactions: 10 });
			expect(result.axes[0]).toMatchObject({ axis: 'globalPopular', seen: 200, reactions: 10, current: 1 });
			expect(result.axes[0].rate).toBeCloseTo((10 + 30 * (30 / 300)) / 230);
			expect(JSON.stringify(result)).not.toMatch(/someone-else|userId|noteId|serverRate|serverSeen/);
			await migration.down({ query });
			expect(await query('SELECT "hanamiRecommendationAxes" FROM user_profile')).toEqual([{ hanamiRecommendationAxes: { globalPopular: 'high' } }]);
			expect(await query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('hanamiTuning','reason')`, [schema])).toEqual([]);
		} finally {
			await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
			await client.end();
		}
	});
});
