/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiReduceEphemeralPosts1789430400000 {
	name = 'HanamiReduceEphemeralPosts1789430400000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiReduceEphemeralPosts" boolean NOT NULL DEFAULT true`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."hanamiReduceEphemeralPosts" IS 'はなみTLで短期間の投稿を減らすか（ユーザー設定）'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiReduceEphemeralPosts"`);
	}
}
