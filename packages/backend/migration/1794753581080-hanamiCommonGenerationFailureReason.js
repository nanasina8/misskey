/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HanamiCommonGenerationFailureReason1794753581080 {
	name = 'HanamiCommonGenerationFailureReason1794753581080';

	async up(queryRunner) {
		// 共通の TL 生成が失敗した理由を残し、管理 API（admin/hanami/metrics/errors）で DB やログを見ずに確かめられるようにする。
		await queryRunner.query(`ALTER TABLE "hanami_common_generation" ADD "failureReason" character varying(512)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "hanami_common_generation" DROP COLUMN "failureReason"`);
	}
}
