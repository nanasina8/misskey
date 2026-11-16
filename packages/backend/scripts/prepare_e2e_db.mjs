/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// e2e テスト用の DB を空にして、全 migration を当て直す。
//
// このフォークのテーブル（はなみ TL・計測・AI 投稿チェックなど）は migration でしか作られない
// （パーティション・トリガー・関数を含むので TypeORM の synchronize では作れない）。
// synchronize で作った DB では、起動時に必要な hanami_metrics_collector が無くてテストサーバーが立ち上がらない。
// そのため e2e は「migration で作った DB」＋ MISSKEY_TEST_DB_MIGRATIONS=1（ファイルごとに TRUNCATE）で動かす。
//
// 単体テスト（pnpm test）は同じ DB を synchronize で作り直すので、e2e の前に毎回これを通す。空の DB なら数秒で終わる。

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { selectMigrations, validateMigrationIdentities } from '../migration/online/selection.mjs';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(backendDir, '../../.config', process.env.MISSKEY_CONFIG_YML ?? 'test.yml');

const config = yaml.load(await readFile(configPath, 'utf8'));
const db = config?.db;
if (db == null || typeof db.db !== 'string') {
	console.error(`[prepare-e2e-db] ${configPath} に db の設定がありません。`);
	process.exit(1);
}

// スキーマごと消すので、テスト用でない DB（本番・開発用のダンプなど）を指していたら止める。
if (!/test/i.test(db.db) && process.env.MISSKEY_E2E_DB_FORCE !== '1') {
	console.error(`[prepare-e2e-db] DB 名 "${db.db}" に "test" が含まれていないので中止しました（${configPath}）。`);
	console.error('[prepare-e2e-db] 本当にこの DB を空にしてよい場合だけ MISSKEY_E2E_DB_FORCE=1 を付けてください。');
	process.exit(1);
}

const connection = {
	host: db.host,
	port: db.port,
	user: db.user,
	password: db.pass,
	database: db.db,
};

const client = new pg.Client(connection);
await client.connect();
try {
	await client.query('DROP SCHEMA IF EXISTS public CASCADE');
	await client.query('CREATE SCHEMA public');
} finally {
	await client.end();
}

const migrations = await selectMigrations(resolve(backendDir, 'migration'), false);
await validateMigrationIdentities(migrations);

const dataSource = new DataSource({
	type: 'postgres',
	host: connection.host,
	port: connection.port,
	username: connection.user,
	password: connection.password,
	database: connection.database,
	extra: db.extra,
	migrations: migrations.map(migration => migration.file),
	migrationsTransactionMode: 'all',
});
await dataSource.initialize();
try {
	const executed = await dataSource.runMigrations();
	console.log(`[prepare-e2e-db] ${db.db} を空にして migration を ${executed.length} 本当てました。`);
} finally {
	await dataSource.destroy();
}
