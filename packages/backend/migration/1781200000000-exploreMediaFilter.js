/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ExploreMediaFilter1781200000000 {
	name = 'ExploreMediaFilter1781200000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "exploreMediaFilter" character varying(32) NOT NULL DEFAULT 'all'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "exploreMediaFilter"`);
	}
}
