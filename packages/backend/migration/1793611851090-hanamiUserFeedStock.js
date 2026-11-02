/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiUserFeedStock1793611851090 {
	name = 'HanamiUserFeedStock1793611851090';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP CONSTRAINT "CHK_hanami_user_feed_batch_trigger"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD CONSTRAINT "CHK_hanami_user_feed_batch_trigger" CHECK ("trigger" IN ('initial', 'refresh', 'prefetch'))`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" ADD "stockBatchId" character varying(32)`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" ADD "stockSequence" bigint`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" ADD CONSTRAINT "CHK_hanami_user_feed_state_stock" CHECK (("stockBatchId" IS NULL AND "stockSequence" IS NULL) OR ("stockBatchId" IS NOT NULL AND "stockSequence" > "latestSequence"))`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" ADD CONSTRAINT "FK_hanami_user_feed_state_stock_batch" FOREIGN KEY ("userId", "epochId", "stockBatchId") REFERENCES "hanami_user_feed_batch"("userId", "epochId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		// ストックの entry は先頭より上の行なので、先に捨ててから batch を obsolete にする。
		await queryRunner.query(`DELETE FROM "hanami_user_feed_entry" e
			USING "hanami_user_feed_state" s
			WHERE s."userId" = e."userId" AND s."epochId" = e."epochId" AND s."stockBatchId" = e."batchId"`);
		await queryRunner.query(`UPDATE "hanami_user_feed_batch" b
			SET "status" = 'obsolete'
			FROM "hanami_user_feed_state" s
			WHERE s."userId" = b."userId" AND s."epochId" = b."epochId" AND s."stockBatchId" = b."id"`);
		await queryRunner.query(`UPDATE "hanami_user_feed_state" SET "stockBatchId" = NULL, "stockSequence" = NULL`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" DROP CONSTRAINT "FK_hanami_user_feed_state_stock_batch"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" DROP CONSTRAINT "CHK_hanami_user_feed_state_stock"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" DROP COLUMN "stockSequence"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_state" DROP COLUMN "stockBatchId"`);
		await queryRunner.query(`UPDATE "hanami_user_feed_batch" SET "trigger" = 'refresh' WHERE "trigger" = 'prefetch'`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" DROP CONSTRAINT "CHK_hanami_user_feed_batch_trigger"`);
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_batch" ADD CONSTRAINT "CHK_hanami_user_feed_batch_trigger" CHECK ("trigger" IN ('initial', 'refresh'))`);
	}
}
