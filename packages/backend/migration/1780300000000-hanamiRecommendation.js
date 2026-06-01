/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiRecommendation1780300000000 {
	name = 'HanamiRecommendation1780300000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiRecommendationEnabled" boolean NOT NULL DEFAULT true`);
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiRecommendationStrength" character varying(32) NOT NULL DEFAULT 'high'`);
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiRecommendationAutoInjectEnabled" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiRecommendationAutoInjectStrength" character varying(32) NOT NULL DEFAULT 'low'`);
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiRecommendationAxes" jsonb NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "hanamiShowRecommendationReason" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "hanamiRecommendationAxisConfig" jsonb NOT NULL DEFAULT '{}'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "hanamiRecommendationAxisConfig"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "hanamiShowRecommendationReason"`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiRecommendationAxes"`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiRecommendationAutoInjectStrength"`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiRecommendationAutoInjectEnabled"`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiRecommendationStrength"`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiRecommendationEnabled"`);
	}
}
