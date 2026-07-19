/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isConcurrentIndexMigrationEnabled } from './js/migration-config.js';

export class HanamiEmbeddingUpdatedAtIndex1783209600001 {
	name = 'HanamiEmbeddingUpdatedAtIndex1783209600001'
	transaction = isConcurrentIndexMigrationEnabled() ? false : undefined;

	async up(queryRunner) {
		if (isConcurrentIndexMigrationEnabled()) {
			const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'IDX_hanami_embedding_model_updatedAt'`);
			if (existing[0]?.indisvalid !== true) {
				await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hanami_embedding_model_updatedAt"`);
				await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_hanami_embedding_model_updatedAt" ON "hanami_note_embedding" ("model", "updatedAt")`);
			}
		} else {
			await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_hanami_embedding_model_updatedAt" ON "hanami_note_embedding" ("model", "updatedAt")`);
		}
	}

	async down(queryRunner) {
		const concurrently = isConcurrentIndexMigrationEnabled() ? 'CONCURRENTLY' : '';
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_hanami_embedding_model_updatedAt"`);
	}
}
