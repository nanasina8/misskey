/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiShowRecommendationReasonDefaultOn1794831694349 {
	name = 'HanamiShowRecommendationReasonDefaultOn1794831694349';

	async up(queryRunner) {
		// はなみTL の「なぜ出たか」の表示（理由ラベル）を、初めからオンにする。
		// 種類ごとの「増やす・減らす」の入口は理由ラベルのメニューにしか無く、オフのままだと誰にも見えない。
		// これまでの初期値はオフで、ほぼ全員が初期値のままだったので、いまオフの人もオンにする（設定画面でいつでもオフに戻せる）。
		await queryRunner.query(`ALTER TABLE "user_profile" ALTER COLUMN "hanamiShowRecommendationReason" SET DEFAULT true`);
		await queryRunner.query(`UPDATE "user_profile" SET "hanamiShowRecommendationReason" = true WHERE "hanamiShowRecommendationReason" = false`);
	}

	async down(queryRunner) {
		// 初期値だけを戻す。up でオンにした人を、自分でオフにしていた人と見分けることはできないので、値は戻さない。
		await queryRunner.query(`ALTER TABLE "user_profile" ALTER COLUMN "hanamiShowRecommendationReason" SET DEFAULT false`);
	}
}
