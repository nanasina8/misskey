/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import { HanamiPersistedFeedReadService } from '@/core/hanami/HanamiPersistedFeedReadService.js';
import type { DataSource } from 'typeorm';

type DbRow = Record<string, unknown>;

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;
const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;

// 待たされたかどうかを、この時間で打ち切って確かめる。
const LOCK_TIMEOUT = '300ms';

/**
 * 本物の読み出しサービスに渡す DataSource。利用者の行を取った直後に止められるようにしてある。
 * lockTimeout を渡すと、その接続ではロック待ちが打ち切られる（待たされたら 55P03 で失敗する）。
 */
function makeDataSource(schema: string, options: { lockTimeout?: string; pauseAfterUserLock?: Promise<void>; onUserLocked?: () => void } = {}) {
	const initialize = async (client: Client): Promise<void> => {
		await client.connect();
		await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
		if (options.lockTimeout != null) await client.query(`SET lock_timeout = '${options.lockTimeout}'`);
	};
	return {
		createQueryRunner: () => {
			let client: Client | undefined;
			const runner = {
				isTransactionActive: false,
				connect: async (): Promise<void> => {
					client = new Client({ connectionString: databaseUrl });
					await initialize(client);
				},
				startTransaction: async (): Promise<void> => {
					await client!.query('BEGIN');
					runner.isTransactionActive = true;
				},
				commitTransaction: async (): Promise<void> => {
					await client!.query('COMMIT');
					runner.isTransactionActive = false;
				},
				rollbackTransaction: async (): Promise<void> => {
					await client!.query('ROLLBACK');
					runner.isTransactionActive = false;
				},
				release: async (): Promise<void> => {
					await client?.end();
				},
				query: async <T extends DbRow = DbRow>(sql: string, values: unknown[] = []): Promise<T[]> => {
					const rows = (await client!.query<T>(sql, values)).rows;
					if (sql.includes('FROM "user" u')) {
						options.onUserLocked?.();
						if (options.pauseAfterUserLock != null) await options.pauseAfterUserLock;
					}
					return rows;
				},
			};
			return runner;
		},
	} as unknown as DataSource;
}

const scanInput = {
	requesterUserId: 'reader',
	head: {
		mode: 'personalized' as const,
		kind: 'personal' as const,
		feedEpochId: 'epoch-1',
		headBatchId: 'batch-1',
		headSequence: '1',
	},
	beforeSequence: null,
	scanLimit: 10,
};

describe('Hanami user-row lock PostgreSQL contracts', () => {
	dbTest('はなみの読み出しが利用者の行を取っている間も、その利用者を参照する投稿の INSERT は待たされず、はなみ同士と休眠の切り替えは待つ', async () => {
		const schema = `hanami_user_lock_${randomBytes(6).toString('hex')}`;
		const admin = new Client({ connectionString: databaseUrl });
		const other = new Client({ connectionString: databaseUrl });
		const query = async (client: Client, sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
		let release!: () => void;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		let locked!: () => void;
		const userLocked = new Promise<void>((resolve) => { locked = resolve; });
		let holder: Promise<unknown> | undefined;
		try {
			await admin.connect();
			expect((await query(admin, 'SELECT current_database() AS db'))[0].db).toBe('test-misskey');
			// 読み出しに要る最小の表だけを用意する。投稿の表は利用者を外部キーで参照する。
			await query(admin, `CREATE SCHEMA ${quoteIdent(schema)}; SET search_path TO ${quoteIdent(schema)}`);
			await query(admin, `
				CREATE TABLE "user" ("id" varchar(32) PRIMARY KEY, "isHibernated" boolean NOT NULL DEFAULT false, "lastActiveDate" timestamptz);
				CREATE TABLE "note" ("id" varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL REFERENCES "user"("id") ON DELETE CASCADE);
				CREATE TABLE "hanami_user_feed_state" (
					"userId" varchar(32) PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
					"epochId" varchar(32), "mode" varchar(16) NOT NULL DEFAULT 'personalized', "earliestRetainedSequence" bigint
				);
				INSERT INTO "user" ("id") VALUES ('reader');
			`);

			await other.connect();
			await query(other, `SET search_path TO ${quoteIdent(schema)}`);
			await query(other, `SET lock_timeout = '${LOCK_TIMEOUT}'`);

			const holderService = new HanamiPersistedFeedReadService(makeDataSource(schema, { pauseAfterUserLock: paused, onUserLocked: locked }));
			holder = holderService.scanReadyEntries(scanInput);
			await userLocked;

			// 本人の投稿（外部キーの確認は FOR KEY SHARE）は待たされない。
			await query(other, `INSERT INTO "note" ("id", "userId") VALUES ('note-1', 'reader')`);
			expect(await query(other, `SELECT "id" FROM "note" WHERE "userId" = 'reader'`)).toEqual([{ id: 'note-1' }]);

			// 同じ読み出しどうしは今までどおり待つ。
			const contender = new HanamiPersistedFeedReadService(makeDataSource(schema, { lockTimeout: LOCK_TIMEOUT }));
			await expect(contender.scanReadyEntries(scanInput)).rejects.toMatchObject({ code: '55P03' });

			// 休眠の切り替え（行の UPDATE）と、休眠の一括処理の FOR UPDATE も待つ。
			await expect(query(other, `UPDATE "user" SET "isHibernated" = true WHERE "id" = 'reader'`)).rejects.toMatchObject({ code: '55P03' });
			await expect(query(other, `UPDATE "user" SET "lastActiveDate" = now() WHERE "id" = 'reader'`)).rejects.toMatchObject({ code: '55P03' });
			await expect(query(other, `SELECT "id" FROM "user" WHERE "id" = 'reader' FOR UPDATE`)).rejects.toMatchObject({ code: '55P03' });
			// アカウント削除も待つ。
			await expect(query(other, `DELETE FROM "user" WHERE "id" = 'reader'`)).rejects.toMatchObject({ code: '55P03' });

			release();
			await expect(holder).resolves.toEqual({ kind: 'cursorExpired' });
			holder = undefined;

			// 読み出しが終われば、休眠の切り替えは通る。
			await query(other, `UPDATE "user" SET "isHibernated" = true WHERE "id" = 'reader'`);
		} finally {
			release?.();
			await holder?.catch(() => undefined);
			await other.end().catch(() => undefined);
			await query(admin, `DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => undefined);
			await admin.end().catch(() => undefined);
		}
	});
});
