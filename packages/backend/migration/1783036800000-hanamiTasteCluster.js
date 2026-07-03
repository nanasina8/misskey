/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taste-clustered popular（hanami-taste-cluster-spec v0.2 §1）。
// evidence = クラスタ学習素材のベクトルを note_embedding の TTL から切り離して保持する（fp16 bytea）。
// user_taste_cluster = ユーザーごとの「好みの顔」K個（centroid・ラベル・userWeight）。
// taste_state = 平均中心化用 mean_vec の共有置き場（model 単位で1行）。
// アクセスは生SQL（バッチ/serve とも）なので TypeORM エンティティは作らない。
export class HanamiTasteCluster1783036800000 {
	name = 'HanamiTasteCluster1783036800000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "hanami_foryou_taste_evidence" (
			"userId" character varying(32) NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"vector" bytea NOT NULL,
			"src" character varying(1) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_taste_evidence" PRIMARY KEY ("userId", "noteId"),
			CONSTRAINT "FK_hanami_foryou_taste_evidence_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_taste_evidence_user_createdAt" ON "hanami_foryou_taste_evidence" ("userId", "createdAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_hanami_taste_evidence_createdAt" ON "hanami_foryou_taste_evidence" ("createdAt")`);

		await queryRunner.query(`CREATE TABLE "hanami_foryou_user_taste_cluster" (
			"userId" character varying(32) NOT NULL,
			"clusterId" integer NOT NULL,
			"centroid" real array NOT NULL DEFAULT '{}',
			"size" integer NOT NULL DEFAULT 0,
			"ownRate" real NOT NULL DEFAULT 0,
			"labelTerms" character varying(128) array NOT NULL DEFAULT '{}',
			"exampleNoteIds" character varying(32) array NOT NULL DEFAULT '{}',
			"userWeight" real NOT NULL DEFAULT 1,
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_user_taste_cluster" PRIMARY KEY ("userId", "clusterId"),
			CONSTRAINT "FK_hanami_foryou_user_taste_cluster_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
		)`);

		await queryRunner.query(`CREATE TABLE "hanami_foryou_taste_state" (
			"model" character varying(64) NOT NULL,
			"meanVec" real array NOT NULL DEFAULT '{}',
			"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_foryou_taste_state" PRIMARY KEY ("model")
		)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "hanami_foryou_taste_state"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_user_taste_cluster"`);
		await queryRunner.query(`DROP TABLE "hanami_foryou_taste_evidence"`);
	}
}
