/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taste-clustered popular v0.4:
// - centroid / evidence に model 列を追加。埋め込みモデル載せ替え時に
//   旧空間の centroid × 新空間の埋め込みという無意味な cos 計算が「動いているように見える」事故を防ぐ。
//   既存行は現行モデルで埋める。serve/バッチは model 一致行のみ読む。
//   載せ替え手順: TASTE_EMBED_MODEL を変更 → 日次バッチが旧モデル行を purge →
//   scripts/hanami-foryou/taste_bootstrap_once.sh を再実行（30日窓の append だけでは軽量ユーザーが復活しない）。
// - evidence の保持は日付TTLからノート数窓（最新2,700件/人・活動時刻順）へ（テーブル変更不要、バッチ側）。
export class HanamiTasteModelColumn1783123200000 {
	name = 'HanamiTasteModelColumn1783123200000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_foryou_taste_evidence" ADD "model" character varying(64) NOT NULL DEFAULT 'intfloat/multilingual-e5-base'`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_user_taste_cluster" ADD "model" character varying(64) NOT NULL DEFAULT 'intfloat/multilingual-e5-base'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_foryou_user_taste_cluster" DROP COLUMN "model"`);
		await queryRunner.query(`ALTER TABLE "hanami_foryou_taste_evidence" DROP COLUMN "model"`);
	}
}
