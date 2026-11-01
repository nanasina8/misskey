/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AiModerationExternal1793526525173 {
	name = 'AiModerationExternal1793526525173';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationExternalIncludeRemote" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan" ADD "useExternal" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan" ADD "externalLastError" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" ADD "externalStatus" character varying(16)`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" ADD "externalFlagged" boolean`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" ADD "externalCategories" character varying(128) array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" ADD "externalScores" jsonb`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" ADD "externalModel" character varying(128)`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_scan_item_externalStatus" ON "ai_moderation_scan_item" ("scanId", "externalStatus") `);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_ai_moderation_scan_item_externalStatus"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" DROP COLUMN "externalModel"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" DROP COLUMN "externalScores"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" DROP COLUMN "externalCategories"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" DROP COLUMN "externalFlagged"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" DROP COLUMN "externalStatus"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan" DROP COLUMN "externalLastError"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan" DROP COLUMN "useExternal"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationExternalIncludeRemote"`);
	}
}
