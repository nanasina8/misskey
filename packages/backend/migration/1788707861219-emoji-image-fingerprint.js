/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isConcurrentIndexMigrationEnabled } from './js/migration-config.js';

export class EmojiImageFingerprint1788707861219 {
	name = 'EmojiImageFingerprint1788707861219'
	transaction = isConcurrentIndexMigrationEnabled() ? false : undefined;

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "emoji" ADD COLUMN IF NOT EXISTS "imageFingerprint" character varying(80)`);
		// 「まだ試していない」と「試したが指紋を取れなかった」を区別する。これがないとバックフィルが
		// imageFingerprint IS NULL の行を起動のたびに拾い直し、デコードできない画像を毎回取得しにいく。
		await queryRunner.query(`ALTER TABLE "emoji" ADD COLUMN IF NOT EXISTS "imageFingerprintAttemptedAt" TIMESTAMP WITH TIME ZONE`);

		if (isConcurrentIndexMigrationEnabled()) {
			await this.createIndexConcurrentlyIfInvalid(queryRunner, 'IDX_EMOJI_IMAGE_FINGERPRINT_LOCAL', `("imageFingerprint") WHERE "host" IS NULL AND "imageFingerprint" IS NOT NULL`);
			await this.createIndexConcurrentlyIfInvalid(queryRunner, 'IDX_EMOJI_IMAGE_FINGERPRINT_PENDING', `("id") WHERE "imageFingerprint" IS NULL AND "imageFingerprintAttemptedAt" IS NULL`);
		} else {
			await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_EMOJI_IMAGE_FINGERPRINT_LOCAL" ON "emoji" ("imageFingerprint") WHERE "host" IS NULL AND "imageFingerprint" IS NOT NULL`);
			await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_EMOJI_IMAGE_FINGERPRINT_PENDING" ON "emoji" ("id") WHERE "imageFingerprint" IS NULL AND "imageFingerprintAttemptedAt" IS NULL`);
		}
	}

	async createIndexConcurrentlyIfInvalid(queryRunner, name, definition) {
		const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = '${name}'`);
		if (existing[0]?.indisvalid === true) return;
		await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
		await queryRunner.query(`CREATE INDEX CONCURRENTLY "${name}" ON "emoji" ${definition}`);
	}

	async down(queryRunner) {
		const concurrently = isConcurrentIndexMigrationEnabled() ? 'CONCURRENTLY' : '';
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_EMOJI_IMAGE_FINGERPRINT_PENDING"`);
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_EMOJI_IMAGE_FINGERPRINT_LOCAL"`);
		await queryRunner.query(`ALTER TABLE "emoji" DROP COLUMN IF EXISTS "imageFingerprintAttemptedAt"`);
		await queryRunner.query(`ALTER TABLE "emoji" DROP COLUMN IF EXISTS "imageFingerprint"`);
	}
}
