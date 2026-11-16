/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// エンティティの定義と DB の食い違い（check-migrations が出す pending DDL）のうち、DB 側を直す分。
// 名前・既定値・コメントだけの変更で、データは変えない。
//  - meta の既定 URL: エンティティはこのフォークの URL だが、DB の既定値は本家のままだった（新規サーバーの初期値にだけ影響）。
//  - 列コメント 4 つ: エンティティにあるが DB に付いていなかった。
//  - はなみ TL のチャート表: date の一意制約の名前が TypeORM の期待と違い、対になる一意インデックスも無かった。
export class HanamiSchemaDriftFix1794784102484 {
	name = 'HanamiSchemaDriftFix1794784102484';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "repositoryUrl" SET DEFAULT 'https://github.com/nanasina8/misskey'`);
		await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT 'https://github.com/nanasina8/misskey/issues/new'`);

		await queryRunner.query(`COMMENT ON COLUMN "meta"."hanamiRecommendationAxisConfig" IS 'はなみTLおすすめ軸のサーバー設定（軸ごとの available と default）'`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."exploreMediaFilter" IS 'みつける(featured)のメディア表示フィルタ: all | hideSensitive | hideMedia(画像/動画)'`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."hanamiRecommendationEnabled" IS 'はなみTLにおすすめノートを注入するか（ユーザー設定）'`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."hanamiRecommendationAxes" IS 'はなみTLおすすめ軸のユーザー別の量（off/low/normal/high。旧booleanはtrue=normal/false=offとして扱う）'`);

		// 一意制約は消さずに名前だけ TypeORM が期待するものへ変え、同じ列の一意インデックスを足す（本家のチャート表と同じ形）。
		// 表は 1 時間／1 日に 1 行なので小さい。
		await queryRunner.query(`ALTER TABLE "__chart__hanami_timeline" RENAME CONSTRAINT "__chart__hanami_timeline_date_key" TO "UQ_1cb3ba64f259b7d82a53de077c6"`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1cb3ba64f259b7d82a53de077c" ON "__chart__hanami_timeline" ("date")`);
		await queryRunner.query(`ALTER TABLE "__chart_day__hanami_timeline" RENAME CONSTRAINT "__chart_day__hanami_timeline_date_key" TO "UQ_784dba6ce2340ffcc5bd6e9e18b"`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_784dba6ce2340ffcc5bd6e9e18" ON "__chart_day__hanami_timeline" ("date")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_784dba6ce2340ffcc5bd6e9e18"`);
		await queryRunner.query(`ALTER TABLE "__chart_day__hanami_timeline" RENAME CONSTRAINT "UQ_784dba6ce2340ffcc5bd6e9e18b" TO "__chart_day__hanami_timeline_date_key"`);
		await queryRunner.query(`DROP INDEX "IDX_1cb3ba64f259b7d82a53de077c"`);
		await queryRunner.query(`ALTER TABLE "__chart__hanami_timeline" RENAME CONSTRAINT "UQ_1cb3ba64f259b7d82a53de077c6" TO "__chart__hanami_timeline_date_key"`);

		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."hanamiRecommendationAxes" IS NULL`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."hanamiRecommendationEnabled" IS NULL`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."exploreMediaFilter" IS NULL`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."hanamiRecommendationAxisConfig" IS NULL`);

		await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "feedbackUrl" SET DEFAULT 'https://github.com/misskey-dev/misskey/issues/new'`);
		await queryRunner.query(`ALTER TABLE "meta" ALTER COLUMN "repositoryUrl" SET DEFAULT 'https://github.com/misskey-dev/misskey'`);
	}
}
