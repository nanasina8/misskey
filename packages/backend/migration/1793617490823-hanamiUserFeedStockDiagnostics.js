/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiUserFeedStockDiagnostics1793617490823 {
	name = 'HanamiUserFeedStockDiagnostics1793617490823';

	async up(queryRunner) {
		// ストックの「きっかけ」「繰り上げ」「捨てた理由」を batch に残し、診断 API が DB を見ずに経路を追えるようにする。
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD "reason" character varying(16)`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD "promotedAt" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD "discardReason" character varying(16)`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD CONSTRAINT "CHK_hanami_user_feed_batch_reason" CHECK ("reason" IS NULL OR "reason" IN ('open', 'prewarm', 'refresh', 'tuning', 'session', 'afterServe', 'afterPromote', 'afterGenerate', 'upkeep'))`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD CONSTRAINT "CHK_hanami_user_feed_batch_discard_reason" CHECK ("discardReason" IS NULL OR "discardReason" IN ('stale', 'tuning', 'publish', 'hibernate', 'revive', 'upkeep', 'prewarm'))`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_hanami_user_feed_batch_created" ON "hanami_user_feed_batch" ("createdAt")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hanami_user_feed_batch_created"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP CONSTRAINT "CHK_hanami_user_feed_batch_discard_reason"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP CONSTRAINT "CHK_hanami_user_feed_batch_reason"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP COLUMN "discardReason"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP COLUMN "promotedAt"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP COLUMN "reason"`);
	}
}
