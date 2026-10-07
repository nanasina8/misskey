/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiTopicMembers1791331201000 {
	name = 'HanamiTopicMembers1791331201000';

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "hanami_trend_topic_note" (
			"topicId" varchar(32) NOT NULL, "noteId" varchar(32) NOT NULL, "addedAt" timestamptz NOT NULL, "noteCreatedAt" timestamptz NOT NULL,
			CONSTRAINT "PK_hanami_trend_topic_note" PRIMARY KEY ("topicId", "noteId"),
			CONSTRAINT "FK_hanami_trend_topic_note_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_trend_topic_note_added" ON "hanami_trend_topic_note" ("addedAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_trend_topic_note_note" ON "hanami_trend_topic_note" ("noteId")`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_trend_topic_note_recent" ON "hanami_trend_topic_note" ("topicId", "noteCreatedAt" DESC, "noteId" DESC)`);
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_entry" ADD "recentAuthors" integer NOT NULL DEFAULT 0`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_trend_snapshot_entry" DROP COLUMN "recentAuthors"`);
		await queryRunner.query(`DROP TABLE "hanami_trend_topic_note"`);
	}
}
