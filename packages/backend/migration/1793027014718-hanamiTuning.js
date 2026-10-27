/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiTuning1793027014718 {
	name = 'HanamiTuning1793027014718';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_refresh" ADD "reason" varchar(16) NOT NULL DEFAULT 'normal'`);
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "hanamiTuning" jsonb NOT NULL DEFAULT '{}'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_user_feed_refresh" DROP COLUMN "reason"`);
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "hanamiTuning"`);
	}
}
