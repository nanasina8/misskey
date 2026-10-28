/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiTrendTitle1793197452559 {
	name = 'HanamiTrendTitle1793197452559';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "hanami_trend_snapshot_entry" ADD COLUMN "title" character varying(64) NULL');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "hanami_trend_snapshot_entry" DROP COLUMN "title"');
	}
}
