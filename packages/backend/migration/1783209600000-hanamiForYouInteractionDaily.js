/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Backfill is deliberately performed by HanamiForYouBatchService, not while holding a migration lock.
export class HanamiForYouInteractionDaily1783209600000 {
	name = 'HanamiForYouInteractionDaily1783209600000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "hanami_foryou_interaction_daily" (
			"day" date NOT NULL,
			"signal" character varying(16) NOT NULL,
			"actorUserId" character varying(32) NOT NULL,
			"targetUserId" character varying(32) NOT NULL,
			"count" integer NOT NULL,
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_interaction_daily" PRIMARY KEY ("day", "signal", "actorUserId", "targetUserId"),
			CONSTRAINT "CHK_hanami_foryou_interaction_daily_signal" CHECK ("signal" IN ('reaction', 'reply', 'renote')),
			CONSTRAINT "CHK_hanami_foryou_interaction_daily_count" CHECK ("count" > 0)
		)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "hanami_foryou_interaction_daily"`);
	}
}
