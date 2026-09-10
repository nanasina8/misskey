/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isConcurrentIndexMigrationEnabled } from './js/migration-config.js';

export class EmojiImageFingerprintErrorCode1789027200000 {
	name = 'EmojiImageFingerprintErrorCode1789027200000'
	transaction = isConcurrentIndexMigrationEnabled() ? false : undefined;

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "emoji" ADD COLUMN IF NOT EXISTS "imageFingerprintErrorCode" character varying(32)`);

		// 1788707861219 は当初 imageFingerprint だけを追加する内容で、後から
		// imageFingerprintAttemptedAt と PENDING インデックスを追記した。既に旧版を適用済みの
		// 環境ではそのmigrationが再実行されず、追記分だけが欠けた状態になる。ここで冪等に補う。
		await queryRunner.query(`ALTER TABLE "emoji" ADD COLUMN IF NOT EXISTS "imageFingerprintAttemptedAt" TIMESTAMP WITH TIME ZONE`);

		if (isConcurrentIndexMigrationEnabled()) {
			const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'IDX_EMOJI_IMAGE_FINGERPRINT_PENDING'`);
			if (existing[0]?.indisvalid !== true) {
				await queryRunner.query(`DROP INDEX IF EXISTS "IDX_EMOJI_IMAGE_FINGERPRINT_PENDING"`);
				await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_EMOJI_IMAGE_FINGERPRINT_PENDING" ON "emoji" ("id") WHERE "imageFingerprint" IS NULL AND "imageFingerprintAttemptedAt" IS NULL`);
			}
		} else {
			await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_EMOJI_IMAGE_FINGERPRINT_PENDING" ON "emoji" ("id") WHERE "imageFingerprint" IS NULL AND "imageFingerprintAttemptedAt" IS NULL`);
		}
	}

	async down(queryRunner) {
		// imageFingerprintAttemptedAt と PENDING インデックスの所有者は 1788707861219 なので、
		// ここでは戻さない（このmigrationはあくまで取りこぼしを補うだけ）。
		await queryRunner.query(`ALTER TABLE "emoji" DROP COLUMN IF EXISTS "imageFingerprintErrorCode"`);
	}
}
