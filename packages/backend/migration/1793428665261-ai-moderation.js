/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AiModeration1793428665261 {
	name = 'AiModeration1793428665261'

	/**
	 * @param {QueryRunner} queryRunner
	 */
	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "ai_moderation_queue" ("id" character varying(32) NOT NULL, "noteId" character varying(32) NOT NULL, "noteUserId" character varying(32) NOT NULL, "noteUserHost" character varying(128), "noteVisibility" character varying(64) NOT NULL, "noteText" character varying(1024) NOT NULL, "triggers" character varying(64) array NOT NULL DEFAULT '{}', "links" character varying(256) array NOT NULL DEFAULT '{}', "textFingerprint" character varying(64), "contactUserIds" character varying(32) array NOT NULL DEFAULT '{}', "contactKind" character varying(16), "localLabel" character varying(32), "localScores" jsonb, "localModel" character varying(128), "externalFlagged" boolean, "externalCategories" character varying(128) array NOT NULL DEFAULT '{}', "externalScores" jsonb, "externalModel" character varying(128), "flagged" boolean NOT NULL DEFAULT false, "resolved" boolean NOT NULL DEFAULT false, "assigneeId" character varying(32), "moderationNote" character varying(8192) NOT NULL DEFAULT '', "autoAction" character varying(16), "spamSignals" character varying(32) array NOT NULL DEFAULT '{}', "criteriaVersion" character varying(32), "judgedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_ai_moderation_queue_id" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_queue_noteUserId" ON "ai_moderation_queue" ("noteUserId")`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_queue_noteUserHost" ON "ai_moderation_queue" ("noteUserHost")`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_queue_textFingerprint" ON "ai_moderation_queue" ("textFingerprint")`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_queue_host_judgedAt" ON "ai_moderation_queue" ("noteUserHost", "judgedAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_queue_flagged" ON "ai_moderation_queue" ("flagged")`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_queue_resolved" ON "ai_moderation_queue" ("resolved")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_moderation_queue_noteId" ON "ai_moderation_queue" ("noteId")`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_queue" ADD CONSTRAINT "FK_ai_moderation_queue_assignee" FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

		await queryRunner.query(`CREATE TABLE "ai_moderation_hidden_target" ("id" character varying(32) NOT NULL, "targetType" character varying(16) NOT NULL, "userId" character varying(32), "host" character varying(128), "reason" character varying(16) NOT NULL, "createdById" character varying(32), "sourceQueueId" character varying(32), "moderationNote" character varying(8192) NOT NULL DEFAULT '', CONSTRAINT "PK_ai_moderation_hidden_target_id" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_moderation_hidden_target_userId" ON "ai_moderation_hidden_target" ("userId")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ai_moderation_hidden_target_host" ON "ai_moderation_hidden_target" ("host")`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_hidden_target" ADD CONSTRAINT "FK_ai_moderation_hidden_target_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_hidden_target" ADD CONSTRAINT "FK_ai_moderation_hidden_target_createdBy" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

		await queryRunner.query(`CREATE TABLE "ai_moderation_criteria" ("id" character varying(32) NOT NULL, "criteria" jsonb NOT NULL, "firstUsedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_ai_moderation_criteria_id" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE TABLE "ai_moderation_scan" ("id" character varying(32) NOT NULL, "status" character varying(16) NOT NULL, "mode" character varying(16) NOT NULL, "target" character varying(16) NOT NULL, "sinceNoteId" character varying(32), "untilNoteId" character varying(32) NOT NULL, "cursor" character varying(32), "maxJudged" integer NOT NULL, "scannedCount" integer NOT NULL DEFAULT '0', "judgedCount" integer NOT NULL DEFAULT '0', "flaggedCount" integer NOT NULL DEFAULT '0', "wouldHideCount" integer NOT NULL DEFAULT '0', "judgeSeconds" real NOT NULL DEFAULT '0', "startedById" character varying(32), "finishedAt" TIMESTAMP WITH TIME ZONE, "lastError" character varying(1024), "criteriaVersion" character varying(32) NOT NULL, CONSTRAINT "PK_ai_moderation_scan_id" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_scan_status" ON "ai_moderation_scan" ("status")`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan" ADD CONSTRAINT "FK_ai_moderation_scan_startedBy" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
		await queryRunner.query(`CREATE TABLE "ai_moderation_scan_item" ("id" character varying(32) NOT NULL, "scanId" character varying(32) NOT NULL, "noteId" character varying(32) NOT NULL, "noteUserId" character varying(32) NOT NULL, "noteUserHost" character varying(128), "noteVisibility" character varying(64) NOT NULL, "noteText" character varying(1024) NOT NULL, "triggers" character varying(64) array NOT NULL DEFAULT '{}', "links" character varying(256) array NOT NULL DEFAULT '{}', "textFingerprint" character varying(64), "localLabel" character varying(32), "localScores" jsonb, "flagged" boolean NOT NULL DEFAULT false, "spamSignals" character varying(32) array NOT NULL DEFAULT '{}', "wouldHide" boolean NOT NULL DEFAULT false, "criteriaVersion" character varying(32), CONSTRAINT "PK_ai_moderation_scan_item_id" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_scan_item_textFingerprint" ON "ai_moderation_scan_item" ("textFingerprint")`);
		await queryRunner.query(`CREATE INDEX "IDX_ai_moderation_scan_item_scan_flagged" ON "ai_moderation_scan_item" ("scanId", "flagged")`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" ADD CONSTRAINT "FK_ai_moderation_scan_item_scan" FOREIGN KEY ("scanId") REFERENCES "ai_moderation_scan"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationEnabled" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationNewAuthorDays" integer NOT NULL DEFAULT '7'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationDailyLimit" integer NOT NULL DEFAULT '500'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationLocalEnabled" boolean NOT NULL DEFAULT true`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationLocalThreshold" real NOT NULL DEFAULT '0.6'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationExternalEnabled" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationExternalApiUrl" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationExternalApiKey" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationExternalModel" character varying(128)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationExternalVisibilities" character varying(64) array NOT NULL DEFAULT '{public,home,followers}'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationAutoHideMode" character varying(16) NOT NULL DEFAULT 'on'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationAutoHideThreshold" real NOT NULL DEFAULT '0.9'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationAutoHideDailyLimit" integer NOT NULL DEFAULT '50'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "aiModerationAutoHideHosts" boolean NOT NULL DEFAULT false`);
	}

	/**
	 * @param {QueryRunner} queryRunner
	 */
	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationAutoHideHosts"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationAutoHideDailyLimit"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationAutoHideThreshold"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationAutoHideMode"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationExternalVisibilities"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationExternalModel"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationExternalApiKey"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationExternalApiUrl"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationExternalEnabled"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationLocalThreshold"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationLocalEnabled"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationDailyLimit"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationNewAuthorDays"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "aiModerationEnabled"`);

		await queryRunner.query(`ALTER TABLE "ai_moderation_scan_item" DROP CONSTRAINT "FK_ai_moderation_scan_item_scan"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_scan_item_scan_flagged"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_scan_item_textFingerprint"`);
		await queryRunner.query(`DROP TABLE "ai_moderation_scan_item"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_scan" DROP CONSTRAINT "FK_ai_moderation_scan_startedBy"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_scan_status"`);
		await queryRunner.query(`DROP TABLE "ai_moderation_scan"`);
		await queryRunner.query(`DROP TABLE "ai_moderation_criteria"`);

		await queryRunner.query(`ALTER TABLE "ai_moderation_hidden_target" DROP CONSTRAINT "FK_ai_moderation_hidden_target_createdBy"`);
		await queryRunner.query(`ALTER TABLE "ai_moderation_hidden_target" DROP CONSTRAINT "FK_ai_moderation_hidden_target_user"`);
		await queryRunner.query(`DROP INDEX "UQ_ai_moderation_hidden_target_host"`);
		await queryRunner.query(`DROP INDEX "UQ_ai_moderation_hidden_target_userId"`);
		await queryRunner.query(`DROP TABLE "ai_moderation_hidden_target"`);

		await queryRunner.query(`ALTER TABLE "ai_moderation_queue" DROP CONSTRAINT "FK_ai_moderation_queue_assignee"`);
		await queryRunner.query(`DROP INDEX "UQ_ai_moderation_queue_noteId"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_queue_resolved"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_queue_flagged"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_queue_host_judgedAt"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_queue_textFingerprint"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_queue_noteUserHost"`);
		await queryRunner.query(`DROP INDEX "IDX_ai_moderation_queue_noteUserId"`);
		await queryRunner.query(`DROP TABLE "ai_moderation_queue"`);
	}
}
