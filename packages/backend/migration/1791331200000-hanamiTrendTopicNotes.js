/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiTrendTopicNotes1791331200000 {
	name = 'HanamiTrendTopicNotes1791331200000';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_representative_note" DROP CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_position"`);
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_representative_note" ADD CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_position" CHECK ("position" >= 0 AND "position" < 20)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DELETE FROM "hanami_trend_snapshot_representative_note" WHERE "position" >= 5`);
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_representative_note" DROP CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_position"`);
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_representative_note" ADD CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_position" CHECK ("position" >= 0 AND "position" < 5)`);
	}
}
