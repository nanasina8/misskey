/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// はなみTL For You v2.1 データ層（canonical spec §7.2/§7.3）。
// バッチ出力（ALS factor / 発見作者 / 近傍 / 関係値 / 埋め込み / centroid / aux）の派生テーブルと、
// provenance 用の event を作る。
// 列名は TypeORM/Misskey 慣習に合わせ camelCase（quoted）。テーブル名は snake_case。
// 384/128次元は pgvector を増やさず real[] で持つ（spec §7.3。重くなったら別途判断）。
export class HanamiForYouDataLayer1782950400000 {
	name = 'HanamiForYouDataLayer1782950400000'

	async up(queryRunner) {
		// ── model_run: バッチ世代。status='ready' の最新だけ serve が読む（§7.3）。直近2世代保持。
		await queryRunner.query(`CREATE TABLE "hanami_foryou_model_run" (
			"id" character varying(32) NOT NULL,
			"kind" character varying(32) NOT NULL,
			"params" jsonb NOT NULL DEFAULT '{}',
			"status" character varying(32) NOT NULL DEFAULT 'pending',
			"startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"finishedAt" TIMESTAMP WITH TIME ZONE,
			CONSTRAINT "PK_hanami_foryou_model_run" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_foryou_model_run_kind_status" ON "hanami_foryou_model_run" ("kind", "status", "startedAt")`);

			// ── user_factor: ALS user 側（evidence が薄い user は作らない）。
			await queryRunner.query(`CREATE TABLE "hanami_foryou_user_factor" (
				"runId" character varying(32) NOT NULL,
				"userId" character varying(32) NOT NULL,
				"factor" real array NOT NULL DEFAULT '{}',
				"evidenceCount" integer NOT NULL DEFAULT 0,
			CONSTRAINT "PK_hanami_foryou_user_factor" PRIMARY KEY ("runId", "userId")
		)`);

		// ── author_factor: ALS author 側。
		await queryRunner.query(`CREATE TABLE "hanami_foryou_author_factor" (
			"runId" character varying(32) NOT NULL,
			"authorId" character varying(32) NOT NULL,
			"factor" real array NOT NULL DEFAULT '{}',
			"reactionCount" integer NOT NULL DEFAULT 0,
			CONSTRAINT "PK_hanami_foryou_author_factor" PRIMARY KEY ("runId", "authorId")
		)`);

		// ── author_rec: reactionSimilar の発見作者 top-N（§4/§10）。
		await queryRunner.query(`CREATE TABLE "hanami_foryou_author_rec" (
				"runId" character varying(32) NOT NULL,
				"userId" character varying(32) NOT NULL,
				"authorId" character varying(32) NOT NULL,
				"score" double precision NOT NULL DEFAULT 0,
			"rank" integer NOT NULL DEFAULT 0,
			CONSTRAINT "PK_hanami_foryou_author_rec" PRIMARY KEY ("runId", "userId", "authorId")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_foryou_author_rec_user_rank" ON "hanami_foryou_author_rec" ("runId", "userId", "rank")`);

		// ── neighbor_user: neighborTrending 用の taste 近傍ユーザ（§4/§10）。
		await queryRunner.query(`CREATE TABLE "hanami_foryou_neighbor_user" (
				"runId" character varying(32) NOT NULL,
				"userId" character varying(32) NOT NULL,
				"neighborUserId" character varying(32) NOT NULL,
				"score" double precision NOT NULL DEFAULT 0,
			"rank" integer NOT NULL DEFAULT 0,
			CONSTRAINT "PK_hanami_foryou_neighbor_user" PRIMARY KEY ("runId", "userId", "neighborUserId")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_foryou_neighbor_user_user_rank" ON "hanami_foryou_neighbor_user" ("runId", "userId", "rank")`);

		// ── relation: 双方向関係値（catchup と全軸の近さレイヤ。§5/§7.3）。run に紐付かない per-user 現在状態。
		await queryRunner.query(`CREATE TABLE "hanami_foryou_relation" (
				"userId" character varying(32) NOT NULL,
				"otherUserId" character varying(32) NOT NULL,
				"relScore" double precision NOT NULL DEFAULT 0,
			"outScore" double precision NOT NULL DEFAULT 0,
			"inScore" double precision NOT NULL DEFAULT 0,
			"mutualScore" double precision NOT NULL DEFAULT 0,
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_relation" PRIMARY KEY ("userId", "otherUserId")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_foryou_relation_user_rel" ON "hanami_foryou_relation" ("userId", "relScore")`);

			// ── note_embedding: MiniLM 等のノート埋め込み（§7.4。note 削除で消す＝FK CASCADE。model 変更は別 model 行）。
		await queryRunner.query(`CREATE TABLE "hanami_note_embedding" (
			"noteId" character varying(32) NOT NULL,
			"model" character varying(64) NOT NULL,
			"dim" integer NOT NULL,
			"embedding" real array NOT NULL DEFAULT '{}',
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_note_embedding" PRIMARY KEY ("noteId", "model")
		)`);

			// ── user_centroid: MiniLM taste-centroid（反応先平均。§5/§7.4）。
		await queryRunner.query(`CREATE TABLE "hanami_foryou_user_centroid" (
				"userId" character varying(32) NOT NULL,
				"model" character varying(64) NOT NULL,
				"centroid" real array NOT NULL DEFAULT '{}',
			"evidenceCount" integer NOT NULL DEFAULT 0,
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_user_centroid" PRIMARY KEY ("userId", "model")
		)`);

		// ── user_aux: 活動リズム・メディア嗜好（最終 boost/filter。§5/§7.3）。
			await queryRunner.query(`CREATE TABLE "hanami_foryou_user_aux" (
				"userId" character varying(32) NOT NULL,
				"activeHourHist" jsonb NOT NULL DEFAULT '{}',
			"mediaReactionRate" double precision NOT NULL DEFAULT 0,
			"textReactionRate" double precision NOT NULL DEFAULT 0,
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_user_aux" PRIMARY KEY ("userId")
		)`);

		// ── recommendation_event: provenance/測定（§7.2）。served/seen=14d, 個人event=180d は batch cleanup。
		// review script (scripts/hanami-foryou-review.mjs) が "userId"/"eventType"/"source"/"createdAt" を読む。
		await queryRunner.query(`CREATE TABLE "hanami_recommendation_event" (
				"id" character varying(32) NOT NULL,
				"userId" character varying(32) NOT NULL,
				"noteId" character varying(32) NOT NULL,
				"eventType" character varying(32) NOT NULL,
				"source" character varying(64),
				"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
				CONSTRAINT "PK_hanami_recommendation_event" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_rec_event_user_note_type" ON "hanami_recommendation_event" ("userId", "noteId", "eventType")`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_rec_event_type_createdAt" ON "hanami_recommendation_event" ("eventType", "createdAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_rec_event_user_createdAt" ON "hanami_recommendation_event" ("userId", "createdAt")`);

			// ── FK: run に紐付く派生は model_run 削除（2世代超の世代落とし）で cascade 削除。
		await queryRunner.query(`ALTER TABLE "hanami_foryou_user_factor" ADD CONSTRAINT "FK_hanami_foryou_user_factor_run" FOREIGN KEY ("runId") REFERENCES "hanami_foryou_model_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_author_factor" ADD CONSTRAINT "FK_hanami_foryou_author_factor_run" FOREIGN KEY ("runId") REFERENCES "hanami_foryou_model_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_author_rec" ADD CONSTRAINT "FK_hanami_foryou_author_rec_run" FOREIGN KEY ("runId") REFERENCES "hanami_foryou_model_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_neighbor_user" ADD CONSTRAINT "FK_hanami_foryou_neighbor_user_run" FOREIGN KEY ("runId") REFERENCES "hanami_foryou_model_run"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		// ── FK: 埋め込みは note 削除で消す（§7.3）。
		await queryRunner.query(`ALTER TABLE "hanami_note_embedding" ADD CONSTRAINT "FK_hanami_note_embedding_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_note_embedding" DROP CONSTRAINT "FK_hanami_note_embedding_note"`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_neighbor_user" DROP CONSTRAINT "FK_hanami_foryou_neighbor_user_run"`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_author_rec" DROP CONSTRAINT "FK_hanami_foryou_author_rec_run"`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_author_factor" DROP CONSTRAINT "FK_hanami_foryou_author_factor_run"`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_user_factor" DROP CONSTRAINT "FK_hanami_foryou_user_factor_run"`);

			await queryRunner.query(`DROP TABLE "hanami_recommendation_event"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_user_aux"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_user_centroid"`);
		await queryRunner.query(`DROP TABLE "hanami_note_embedding"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_relation"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_neighbor_user"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_author_rec"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_author_factor"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_user_factor"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_model_run"`);
	}
}
