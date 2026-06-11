/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// ストリームのおすすめ自動挿入（auto-inject）を既定ONにする。
// ストリーム経路のおすすめは auto-inject のみ（推薦集合照合方式はデッドパスとして廃止済み）なので、
// OFF既定だと既定設定のユーザーはストリーム購読中におすすめを一切受け取れなかった。
//
// 既存行の扱い: 保存値の false だけでは「明示的にOFF」と「触っていない」を区別できないため、
// 「おすすめ設定を一度でも保存したか」を代理指標にする。設定ページの保存は毎回
// hanamiRecommendationAxes を書き込む（未保存ユーザーは初期値 '{}' のまま）ので、
// axes が空のユーザーだけ ON に引き上げ、保存歴のあるユーザーの false は明示OFFとして温存する。
// （他の項目だけ変えて保存した人の false も温存される＝ユーザー設定を尊重する側に倒す）
export class HanamiAutoInjectDefaultOn1781136200000 {
	name = 'HanamiAutoInjectDefaultOn1781136200000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ALTER COLUMN "hanamiRecommendationAutoInjectEnabled" SET DEFAULT true`);
		await queryRunner.query(`UPDATE "user_profile" SET "hanamiRecommendationAutoInjectEnabled" = true WHERE "hanamiRecommendationAxes" = '{}'::jsonb`);
	}

	async down(queryRunner) {
		// 個々のユーザーの旧設定値は復元できない（既定だけ戻す）。
		await queryRunner.query(`ALTER TABLE "user_profile" ALTER COLUMN "hanamiRecommendationAutoInjectEnabled" SET DEFAULT false`);
	}
}
