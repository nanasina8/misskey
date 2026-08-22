/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';

const loadMigration = (name: string): string => {
	return readFileSync(new URL(`../../migration/${name}`, import.meta.url), 'utf8');
};

const contains = (sql: string, needle: string): void => {
	expect(sql).toContain(needle);
};

describe('Hanami migration contracts', () => {
	const phase1 = loadMigration('1787097600000-hanamiPersistedTimelinePhase1.js');
	const forYouDataLayer = loadMigration('1782950400000-hanamiForYouDataLayer.js');
	const tasteCluster = loadMigration('1783036800000-hanamiTasteCluster.js');
	const tasteModelColumn = loadMigration('1783123200000-hanamiTasteModelColumn.js');
	const recommendation = loadMigration('1780300000000-hanamiRecommendation.js');
	const recommendationReasonPerUser = loadMigration('1782086400000-hanamiRecommendationReasonPerUser.js');
	const fofInteractionIndexes = loadMigration('1781136000000-hanamiFofInteractionIndexes.js');
	const embeddingIndex = loadMigration('1783209600001-hanamiEmbeddingUpdatedAtIndex.js');
	const forYouInteractionDaily = loadMigration('1783209600000-hanamiForYouInteractionDaily.js');
	const autoInjectDefaultOn = loadMigration('1781136200000-hanamiAutoInjectDefaultOn.js');
	const recommendationEventModel = readFileSync(new URL('../../src/models/HanamiRecommendationEvent.ts', import.meta.url), 'utf8');

	test('phase 1 migration defines partitioned timeline/state tables with required invariants', () => {
		contains(phase1, 'CREATE TABLE "hanami_common_generation"');
		contains(phase1, 'CONSTRAINT "PK_hanami_common_generation" PRIMARY KEY ("id")');
		contains(phase1, 'CONSTRAINT "UQ_hanami_common_generation_ordinal" UNIQUE ("ordinal")');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_generation_status" CHECK ("status" IN (\'pending\', \'generating\', \'ready\', \'failed\', \'obsolete\'))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_generation_ordinal" CHECK ("ordinal" > 0)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_generation_fence" CHECK ("generationFence" >= 0)');

		contains(phase1, 'CREATE TABLE "hanami_common_candidate"');
		contains(phase1, 'PARTITION BY RANGE ("generatedMonth")');
		contains(phase1, 'CREATE TABLE "hanami_common_candidate_202608" PARTITION OF "hanami_common_candidate"');
		contains(phase1, 'CREATE INDEX "IDX_hanami_common_candidate_generation" ON "hanami_common_candidate" ("generationId", "generationFence", "axis", "rank")');
		contains(phase1, 'CREATE INDEX "IDX_hanami_common_candidate_note" ON "hanami_common_candidate" ("noteId")');
		contains(phase1, 'CONSTRAINT "UQ_hanami_common_candidate_note" UNIQUE ("generatedMonth", "generationId", "generationFence", "axis", "noteId")');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_candidate_month" CHECK (EXTRACT(DAY FROM "generatedMonth") = 1)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_candidate_rank" CHECK ("rank" >= 0)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_candidate_fence" CHECK ("generationFence" >= 0)');

		contains(phase1, 'CREATE TABLE "hanami_common_feed_entry"');
		contains(phase1, 'PARTITION BY RANGE ("generatedMonth")');
		contains(phase1, 'CONSTRAINT "PK_hanami_common_feed_entry" PRIMARY KEY ("generatedMonth", "id")');
		contains(phase1, 'CONSTRAINT "UQ_hanami_common_feed_entry_sequence" UNIQUE ("generatedMonth", "epochId", "sequence")');
		contains(phase1, 'CONSTRAINT "UQ_hanami_common_feed_entry_position" UNIQUE ("generatedMonth", "generationId", "position")');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_feed_entry_position" CHECK ("position" >= 0 AND "position" < 210)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_feed_entry_month" CHECK (EXTRACT(DAY FROM "generatedMonth") = 1)');
		contains(phase1, 'CONSTRAINT "FK_hanami_common_feed_entry_generation" FOREIGN KEY ("generationId") REFERENCES "hanami_common_generation"("id") ON DELETE CASCADE ON UPDATE NO ACTION');

		contains(phase1, 'CREATE TABLE "hanami_common_feed_state" ("singletonId" character varying(32) NOT NULL, "epochId" character varying(32), "latestSequence" bigint NOT NULL');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_feed_state_singleton" CHECK ("singletonId" = \'singleton\')');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_feed_state_sequences" CHECK ("latestSequence" >= 0 AND "earliestRetainedSequence" >= 0)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_feed_state_epoch_seeded" CHECK ("epochId" IS NOT NULL OR ("latestReadyGenerationId" IS NULL AND "latestSequence" = 0 AND "earliestRetainedSequence" = 0))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_common_feed_state_lifecycle" CHECK ((("epochId" IS NULL AND "latestReadyGenerationId" IS NULL AND "latestSequence" = 0 AND "earliestRetainedSequence" = 0) OR ("epochId" IS NOT NULL AND "latestReadyGenerationId" IS NOT NULL AND "earliestRetainedSequence" > 0 AND "latestSequence" >= "earliestRetainedSequence"))');
		contains(phase1, 'CONSTRAINT "FK_hanami_common_feed_state_ready_generation" FOREIGN KEY ("latestReadyGenerationId") REFERENCES "hanami_common_generation"("id") ON DELETE RESTRICT ON UPDATE NO ACTION');
		contains(phase1, 'CONSTRAINT "CHK_hanami_trend_snapshot_item_count" CHECK ("itemCount" >= 0 AND "itemCount" <= 30)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_trend_snapshot_entry_rank" CHECK ("rank" >= 0 AND "rank" < 30)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_rank" CHECK ("rank" >= 0 AND "rank" < 30)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_trend_snapshot_rep_note_position" CHECK ("position" >= 0 AND "position" < 5)');
		contains(phase1, 'DELETE FROM "hanami_recommendation_event" e WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = e."userId") OR NOT EXISTS (SELECT 1 FROM "note" n WHERE n."id" = e."noteId")');
		expect(phase1).not.toContain('hanami_recommendation_event has orphan');
		contains(phase1, 'CONSTRAINT "FK_hanami_rec_event_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION');
		contains(phase1, 'CONSTRAINT "FK_hanami_rec_event_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION');
		contains(phase1, 'CREATE INDEX "IDX_hanami_rec_event_provenance_fallback" ON "hanami_recommendation_event" ("userId", "eventType", "occurredAt" DESC, "noteId")');
		contains(phase1, 'DROP INDEX "IDX_hanami_rec_event_provenance_fallback"');
		expect(phase1.indexOf('DROP INDEX "IDX_hanami_rec_event_provenance_fallback"')).toBeLessThan(phase1.indexOf('DROP COLUMN "occurredAt"'));
		contains(recommendationEventModel, "@Index('IDX_hanami_rec_event_provenance_fallback', { synchronize: false })");

		contains(phase1, 'CREATE TABLE "hanami_user_feed_epoch" ("epochId" character varying(32) NOT NULL');
		contains(phase1, 'CREATE TABLE "hanami_user_feed_batch"');
		contains(phase1, 'CONSTRAINT "UQ_hanami_user_feed_batch_user_epoch_id" UNIQUE ("userId", "epochId", "id")');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_batch_trigger" CHECK ("trigger" IN (\'initial\', \'refresh\'))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_batch_status" CHECK ("status" IN (\'pending\', \'generating\', \'ready\', \'failed\', \'obsolete\'))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_batch_lease" CHECK (("status" = \'generating\' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR ("status" <> \'generating\' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL))');
		contains(phase1, 'CREATE UNIQUE INDEX "IDX_hanami_user_feed_batch_active_user" ON "hanami_user_feed_batch" ("userId") WHERE "status" IN (\'pending\', \'generating\')');

		contains(phase1, 'CREATE TABLE "hanami_user_feed_state" ("userId" character varying(32) NOT NULL, "epochId" character varying(32) NOT NULL');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_state_mode" CHECK ("mode" IN (\'personalized\', \'common\'))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_state_initial" CHECK ("initialGenerationState" IN (\'notEvaluated\', \'requested\', \'ready\', \'failed\', \'skippedUnavailable\'))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_state_sequences" CHECK (("latestSequence" = 0 AND "earliestRetainedSequence" = 0) OR ("earliestRetainedSequence" > 0 AND "latestSequence" >= "earliestRetainedSequence"))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_state_common_head" CHECK (("commonEpochId" IS NULL AND "commonHeadGenerationId" IS NULL AND "commonHeadSequence" IS NULL) OR ("commonEpochId" IS NOT NULL AND "commonHeadGenerationId" IS NOT NULL AND "commonHeadSequence" > 0))');
		contains(phase1, 'CONSTRAINT "FK_hanami_user_feed_state_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION');

		contains(phase1, 'CREATE TABLE "hanami_user_feed_entry"');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_entry_sequence" CHECK ("sequence" > 0)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_entry_position" CHECK ("position" >= 0 AND "position" < 210)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_entry_origin" CHECK ("origin" IN (\'commonCandidate\', \'personalCandidate\'))');
		contains(phase1, 'CREATE INDEX "IDX_hanami_user_feed_entry_note" ON "hanami_user_feed_entry" ("noteId")');

		contains(phase1, 'CREATE TABLE "hanami_user_feed_refresh"');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_refresh_digest" CHECK (octet_length("refreshTokenDigest") = 32)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_refresh_status" CHECK ("status" IN (\'pending\', \'ready\', \'failed\', \'obsolete\'))');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_feed_refresh_result" CHECK (("status" IN (\'pending\', \'obsolete\') AND "resultMode" IS NULL AND "resultFeedEpochId" IS NULL AND "resultHeadBatchId" IS NULL AND "resultHeadSequence" IS NULL) OR ("status" IN (\'ready\', \'failed\') AND "resultMode" IS NOT NULL AND "resultFeedEpochId" IS NOT NULL AND "resultHeadBatchId" IS NOT NULL AND "resultHeadSequence" > 0))');
		contains(phase1, 'CREATE INDEX "IDX_hanami_user_feed_refresh_expires" ON "hanami_user_feed_refresh" ("expiresAt")');

		contains(phase1, 'CREATE TABLE "hanami_user_recommendation_entry"');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_recommendation_entry_sequence" CHECK ("sequence" > 0)');
		contains(phase1, 'CONSTRAINT "CHK_hanami_user_recommendation_entry_rank" CHECK ("rank" >= 0)');
		contains(phase1, 'CREATE INDEX "IDX_hanami_user_recommendation_entry_page" ON "hanami_user_recommendation_entry" ("userId", "epochId", "sequence" DESC)');
	});

	test('hanami recommendation/profile migrations encode the intended settings transition', () => {
		contains(recommendation, 'ALTER TABLE "user_profile" ADD "hanamiRecommendationEnabled" boolean NOT NULL DEFAULT true');
		contains(recommendation, 'ALTER TABLE "user_profile" ADD "hanamiRecommendationStrength" character varying(32) NOT NULL DEFAULT \'high\'');
		contains(recommendation, 'ALTER TABLE "user_profile" ADD "hanamiRecommendationAutoInjectEnabled" boolean NOT NULL DEFAULT false');
		contains(recommendation, 'ALTER TABLE "user_profile" ADD "hanamiRecommendationAutoInjectStrength" character varying(32) NOT NULL DEFAULT \'low\'');
		contains(recommendation, 'ALTER TABLE "meta" ADD "hanamiShowRecommendationReason" boolean NOT NULL DEFAULT false');

		contains(recommendationReasonPerUser, 'ALTER TABLE "user_profile" ADD "hanamiShowRecommendationReason" boolean NOT NULL DEFAULT false');
		contains(recommendationReasonPerUser, 'UPDATE "user_profile" SET "hanamiShowRecommendationReason" = COALESCE((SELECT "hanamiShowRecommendationReason" FROM "meta" LIMIT 1), false)');
		contains(recommendationReasonPerUser, 'ALTER TABLE "meta" DROP COLUMN "hanamiShowRecommendationReason"');
		contains(autoInjectDefaultOn, 'ALTER TABLE "user_profile" ALTER COLUMN "hanamiRecommendationAutoInjectEnabled" SET DEFAULT true');
		contains(autoInjectDefaultOn, 'UPDATE "user_profile" SET "hanamiRecommendationAutoInjectEnabled" = true WHERE "hanamiRecommendationAxes" = \'{}\'::jsonb');
	});

	test('for-you layer migrations create required tables and foreign-key semantics', () => {
		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_model_run"');
		contains(forYouDataLayer, 'CONSTRAINT "PK_hanami_foryou_model_run" PRIMARY KEY ("id")');
		contains(forYouDataLayer, 'CREATE INDEX "IDX_hanami_foryou_model_run_kind_status" ON "hanami_foryou_model_run" ("kind", "status", "startedAt")');

		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_user_factor"');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_author_factor"');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_author_rec"');
		contains(forYouDataLayer, 'CREATE INDEX "IDX_hanami_foryou_author_rec_user_rank" ON "hanami_foryou_author_rec" ("runId", "userId", "rank")');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_neighbor_user"');
		contains(forYouDataLayer, 'CREATE INDEX "IDX_hanami_foryou_neighbor_user_user_rank" ON "hanami_foryou_neighbor_user" ("runId", "userId", "rank")');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_relation"');
		contains(forYouDataLayer, 'CREATE INDEX "IDX_hanami_foryou_relation_user_rel" ON "hanami_foryou_relation" ("userId", "relScore")');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_note_embedding"');
		contains(forYouDataLayer, 'CONSTRAINT "PK_hanami_note_embedding" PRIMARY KEY ("noteId", "model")');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_recommendation_event"');
		contains(forYouDataLayer, 'CREATE INDEX "IDX_hanami_rec_event_user_note_type" ON "hanami_recommendation_event" ("userId", "noteId", "eventType")');
		contains(forYouDataLayer, 'ALTER TABLE "hanami_note_embedding" ADD CONSTRAINT "FK_hanami_note_embedding_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION');
		contains(forYouDataLayer, 'ALTER TABLE "hanami_foryou_author_rec" ADD CONSTRAINT "FK_hanami_foryou_author_rec_run" FOREIGN KEY ("runId") REFERENCES "hanami_foryou_model_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION');

		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_user_centroid"');
		contains(forYouDataLayer, 'CREATE TABLE "hanami_foryou_user_aux"');

		contains(tasteCluster, 'CREATE TABLE "hanami_foryou_taste_evidence"');
		contains(tasteCluster, 'CONSTRAINT "FK_hanami_foryou_taste_evidence_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE');
		contains(tasteCluster, 'CREATE TABLE "hanami_foryou_taste_state"');

		contains(tasteModelColumn, 'ALTER TABLE "hanami_foryou_taste_evidence" ADD "model" character varying(64) NOT NULL DEFAULT \'intfloat/multilingual-e5-base\'');
		contains(tasteModelColumn, 'ALTER TABLE "hanami_foryou_user_taste_cluster" ADD "model" character varying(64) NOT NULL DEFAULT \'intfloat/multilingual-e5-base\'');
	});

	test('secondary hanami operations migrations keep expected index and validation shapes', () => {
		contains(forYouInteractionDaily, 'CREATE TABLE "hanami_foryou_interaction_daily"');
		contains(forYouInteractionDaily, 'CONSTRAINT "CHK_hanami_foryou_interaction_daily_signal" CHECK ("signal" IN (\'reaction\', \'reply\', \'renote\'))');
		contains(forYouInteractionDaily, 'CONSTRAINT "CHK_hanami_foryou_interaction_daily_count" CHECK ("count" > 0)');

		contains(fofInteractionIndexes, 'CREATE INDEX IF NOT EXISTS "IDX_hanami_note_replyUserId" ON "note" ("replyUserId") WHERE "replyUserId" IS NOT NULL');
		contains(fofInteractionIndexes, 'CREATE INDEX IF NOT EXISTS "IDX_hanami_note_renoteUserId" ON "note" ("renoteUserId") WHERE "renoteUserId" IS NOT NULL');
		contains(fofInteractionIndexes, 'CREATE INDEX IF NOT EXISTS "IDX_hanami_note_reaction_userId_id" ON "note_reaction" ("userId", "id")');

		contains(embeddingIndex, 'CREATE INDEX');
		contains(embeddingIndex, 'IDX_hanami_embedding_model_updatedAt');
	});
});
