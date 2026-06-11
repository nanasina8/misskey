/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// FoFシード相互作用シグナル（HanamiUserRecommendationService.getSeedInteractionSignals）用のインデックス。
// replyUserId/renoteUserId は Denormalized フィールドだが索引が無く、自分宛ての返信/RNの抽出が
// 直近14日の全ノートPK範囲スキャンになっていた。NULLが大半なので部分インデックスにする。
// note_reaction(userId, id) は「自分が付けたリアクションの時系列範囲」をインデックスだけで絞るための複合。
// 大規模インスタンスでロックが気になる場合は、先に手動で CREATE INDEX CONCURRENTLY を実行しておけば
// このマイグレーションは IF NOT EXISTS により素通りする。
export class HanamiFofInteractionIndexes1781136000000 {
	name = 'HanamiFofInteractionIndexes1781136000000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_hanami_note_replyUserId" ON "note" ("replyUserId") WHERE "replyUserId" IS NOT NULL`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_hanami_note_renoteUserId" ON "note" ("renoteUserId") WHERE "renoteUserId" IS NOT NULL`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_hanami_note_reaction_userId_id" ON "note_reaction" ("userId", "id")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hanami_note_reaction_userId_id"`);
		await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hanami_note_renoteUserId"`);
		await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hanami_note_replyUserId"`);
	}
}
