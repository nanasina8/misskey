import { DataSource } from 'typeorm';
import { loadConfig } from './built/config.js';
import { entities } from './built/postgres.js';
import { isConcurrentIndexMigrationEnabled } from "./migration/js/migration-config.js";

// migrationはDB接続情報しか使わない。cursor署名鍵のような実行時専用の秘密を要求すると、
// 鍵未設定のデプロイでスキーマ適用そのものができなくなる。
const config = loadConfig({ requireRuntimeSecrets: false });

export default new DataSource({
	type: 'postgres',
	host: config.db.host,
	port: config.db.port,
	username: config.db.user,
	password: config.db.pass,
	database: config.db.db,
	extra: config.db.extra,
	entities: entities,
	migrations: ['migration/*.js'],
	migrationsTransactionMode: isConcurrentIndexMigrationEnabled() ? 'each' : 'all',
});
