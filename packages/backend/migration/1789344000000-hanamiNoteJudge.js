/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Local Qwen note-judge results are intentionally a small, replaceable cache.
// promptVersion changes overwrite the per-note row; judgedAt supports the 14-day
// retention sweep without retaining note text.
export class HanamiNoteJudge1789344000000 {
	name = 'HanamiNoteJudge1789344000000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "hanami_note_judgement" (
			"noteId" character varying(32) NOT NULL,
			"model" character varying(128) NOT NULL,
			"promptVersion" integer NOT NULL,
			"ephemeralScore" real NOT NULL,
			"interest" real NOT NULL,
			"interestDist" real array NOT NULL,
			"contentType" smallint NOT NULL,
			"judgedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			CONSTRAINT "PK_hanami_note_judgement" PRIMARY KEY ("noteId"),
			CONSTRAINT "CHK_hanami_note_judgement_prompt_version" CHECK ("promptVersion" > 0),
			CONSTRAINT "CHK_hanami_note_judgement_interest" CHECK ("interest" >= 1 AND "interest" <= 5),
			CONSTRAINT "CHK_hanami_note_judgement_interest_dist" CHECK (array_length("interestDist", 1) = 5),
			CONSTRAINT "CHK_hanami_note_judgement_content_type" CHECK ("contentType" >= 0 AND "contentType" <= 9),
			CONSTRAINT "FK_hanami_note_judgement_note" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION
		)`);
		// Cleanup deletes rows older than 14 days, so keep its range scan indexed.
		await queryRunner.query(`CREATE INDEX "IDX_hanami_note_judgement_judgedAt" ON "hanami_note_judgement" ("judgedAt")`);

		// Stored as JSON because Meta's entity is deliberately not extended by this isolated unit.
		// The exported helper owns validation/defaulting before a future admin API reads it.
		await queryRunner.query(`ALTER TABLE "meta" ADD "hanamiNoteJudgeSettings" jsonb NOT NULL DEFAULT '{"schemaVersion":1,"promptVersion":1,"ephemeralThreshold":0,"interestThreshold":2.95,"reactionMax":3,"interestMax":10,"basis":{"ephemeralA":"その場限りの投稿（挨拶、短い相づち、相手や文脈がないと意味が通らない独り言、bot/定型の自動投稿、フォロー募集や質問募集などの呼びかけだけ）","ephemeralB":"単独で読める投稿（情報、意見、出来事の描写、作品の紹介、ジョークやネタとして成立しているもの。短くてもよい）","interest1":"挨拶・相づち・定型文・呼びかけ・内輪向けで、第三者が読む価値がない","interest2":"ありふれた近況や独り言で、第三者には特に意味がない","interest3":"普通。読めるが特に印象に残らない／本文が題名やタグだけで画像の中身は判断できない","interest4":"読んで得るものや面白さがはっきりある","interest5":"新しい情報・視点・気づきがあり、この人の他の投稿も読みたくなる"},"examples":[],"templatePatterns":["メシをよそえました","#FediQB","#MKTQB","Mewk","を引いたよ","登録してから","きょうのしろぷよ","きょうのほにゅ","ルリアに話しかけ","#好きな曲10曲","緊急地震速報","震度速報","#3good","^0+$","にゃんぷっぷーとあそぼう","質問募集","ラブレター募集","悪口診断","#愛される理由","生活リズムスイッチ"]}'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "hanamiNoteJudgeSettings"`);
		await queryRunner.query(`DROP TABLE "hanami_note_judgement"`);
	}
}
