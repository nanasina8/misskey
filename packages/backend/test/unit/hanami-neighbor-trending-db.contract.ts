/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { HanamiForYouService } from '@/core/hanami/HanamiForYouService.js';

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;

type NeighborTrending = {
	neighborTrendingCandidates(userId: string, alsRunId: string | null): Promise<Array<{ noteId: string; userId: string; score: number; socialCount?: number }>>;
};

describe('近くで話題 PostgreSQL contracts', () => {
	dbTest('近い人の重みの合計で並べ、1 人 1 回・48 時間・公開範囲・本人の投稿の決まりを守る', async () => {
		const client = new Client({ connectionString: databaseUrl });
		const schema = `hanami_neighbor_${randomBytes(6).toString('hex')}`;
		const query = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
		try {
			await client.connect();
			expect((await query('SELECT current_database() AS db'))[0].db).toBe('test-misskey');
			await query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
			// 本番と同じ型・索引だけを持つ最小の表。id は文字列の大小で新旧が決まる（"m" が 48 時間の境目）。
			await query(`
				CREATE TABLE note (id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, visibility varchar(16) NOT NULL, "channelId" varchar(32));
				CREATE TABLE note_reaction (id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, "noteId" varchar(32) NOT NULL);
				CREATE UNIQUE INDEX ON note_reaction ("userId", "noteId");
				CREATE INDEX "IDX_hanami_note_reaction_userId_id" ON note_reaction ("userId", id);
				CREATE TABLE following (id varchar(32) PRIMARY KEY, "followerId" varchar(32) NOT NULL, "followeeId" varchar(32) NOT NULL);
				CREATE INDEX ON following ("followerId");
				CREATE TABLE hanami_foryou_relation ("userId" varchar(32), "otherUserId" varchar(32), "relScore" double precision, PRIMARY KEY ("userId", "otherUserId"));
				CREATE TABLE hanami_foryou_neighbor_user ("runId" varchar(32), "userId" varchar(32), "neighborUserId" varchar(32), rank int, score double precision);

				INSERT INTO following VALUES ('f1', 'me', 'followee'), ('f2', 'me', 'both');
				INSERT INTO hanami_foryou_relation VALUES ('me', 'close', 4), ('me', 'both', 2), ('someone', 'stranger', 9);
				INSERT INTO hanami_foryou_neighbor_user VALUES ('run', 'me', 'als', 1, 0.9), ('run', 'someone', 'stranger', 1, 0.9);

				INSERT INTO note VALUES
					('n-popular', 'author', 'public', NULL),
					('n-close', 'author', 'home', NULL),
					('n-follow', 'followee', 'public', NULL),
					('n-mine', 'me', 'public', NULL),
					('n-followers', 'author', 'followers', NULL),
					('n-channel', 'author', 'public', 'channel'),
					('n-old', 'author', 'public', NULL),
					('n-stranger', 'author', 'public', NULL);
				INSERT INTO note_reaction VALUES
					('r01', 'followee', 'n-popular'),
					('r02', 'als', 'n-popular'),
					('r03', 'both', 'n-popular'),
					('r04', 'close', 'n-close'),
					('r05', 'followee', 'n-follow'),
					('r06', 'followee', 'n-mine'),
					('r07', 'close', 'n-followers'),
					('r08', 'close', 'n-channel'),
					('a01', 'close', 'n-old'),
					('r09', 'stranger', 'n-stranger'),
					('r10', 'me', 'n-stranger');
			`);

			const service = new HanamiForYouService(
				{ query } as never, {} as never, {} as never, {} as never, {} as never, {} as never,
				{ gen: () => 'm' } as never,
				{} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
			) as unknown as NeighborTrending;

			// n-popular = followee 1 + als 1 + both max(1, 1.5) = 3.5 / 3 人、n-close = close 2 / 1 人、n-follow = 1 / 1 人。
			const result = await service.neighborTrendingCandidates('me', 'run');
			expect(result.map(row => [row.noteId, row.userId, row.socialCount])).toEqual([
				['n-popular', 'author', 3],
				['n-close', 'author', 1],
				['n-follow', 'followee', 1],
			]);
			expect(result.map(row => row.score)).toEqual([1, 2 / 3.5, 1 / 3.5]);

			// ALS の run が無くても、フォロー中と関係値だけで出る（als の反応は数えない）。
			const withoutAls = await service.neighborTrendingCandidates('me', null);
			expect(withoutAls.map(row => [row.noteId, row.socialCount])).toEqual([
				['n-popular', 2],
				['n-close', 1],
				['n-follow', 1],
			]);
			expect(withoutAls[0].score).toBe(1);

			// 近い人がいなければ空。
			await expect(service.neighborTrendingCandidates('nobody', 'run')).resolves.toEqual([]);
		} finally {
			await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
			await client.end();
		}
	});
});
