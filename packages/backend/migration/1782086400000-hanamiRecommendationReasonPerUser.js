/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiRecommendationReasonPerUser1782086400000 {
	name = 'HanamiRecommendationReasonPerUser1782086400000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiShowRecommendationReason" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."hanamiShowRecommendationReason" IS 'はなみTLおすすめに理由ラベルを表示するか（ユーザー設定）'`);
		// 現在のサーバー設定を既存ユーザーの初期値として引き継ぐ。
		await queryRunner.query(`UPDATE "user_profile" SET "hanamiShowRecommendationReason" = COALESCE((SELECT "hanamiShowRecommendationReason" FROM "meta" LIMIT 1), false)`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "hanamiShowRecommendationReason"`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "hanamiShowRecommendationReason" boolean NOT NULL DEFAULT false`);
		// 個人設定は一つのサーバー設定へ完全には戻せないため、誰か一人でもONならONとして戻す。
		await queryRunner.query(`UPDATE "meta" SET "hanamiShowRecommendationReason" = COALESCE((SELECT bool_or("hanamiShowRecommendationReason") FROM "user_profile"), false)`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiShowRecommendationReason"`);
	}
}
