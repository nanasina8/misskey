/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiTrendTopics1791244800000 {
	name = 'HanamiTrendTopics1791244800000';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_entry"
			ADD COLUMN "topicId" character varying(32) NULL,
			ADD COLUMN "relatedTerms" character varying(256)[] NOT NULL DEFAULT '{}',
			ADD COLUMN "startedAt" TIMESTAMP WITH TIME ZONE NULL,
			ADD COLUMN "daily" boolean NOT NULL DEFAULT false,
			ADD CONSTRAINT "CHK_hanami_trend_snapshot_entry_related_terms" CHECK (cardinality("relatedTerms") <= 5)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_trend_snapshot_entry_topic" ON "hanami_trend_snapshot_entry" ("topicId")`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_trend_snapshot_generated_at" ON "hanami_trend_snapshot" ("generatedAt")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_hanami_trend_snapshot_generated_at"`);
		await queryRunner.query(`DROP INDEX "IDX_hanami_trend_snapshot_entry_topic"`);
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_entry"
			DROP CONSTRAINT "CHK_hanami_trend_snapshot_entry_related_terms",
			DROP COLUMN "daily", DROP COLUMN "startedAt", DROP COLUMN "relatedTerms", DROP COLUMN "topicId"`);
	}
}
