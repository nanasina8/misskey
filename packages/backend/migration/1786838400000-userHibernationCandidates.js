/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isConcurrentIndexMigrationEnabled } from './js/migration-config.js';

export class UserHibernationCandidates1786838400000 {
	name = 'UserHibernationCandidates1786838400000'
	transaction = isConcurrentIndexMigrationEnabled() ? false : undefined;

	async up(queryRunner) {
		await queryRunner.query(`UPDATE "following" AS f SET "isFollowerHibernated" = u."isHibernated" FROM "user" AS u WHERE f."followerId" = u."id" AND f."followerHost" IS NULL AND f."isFollowerHibernated" IS DISTINCT FROM u."isHibernated"`);

		if (isConcurrentIndexMigrationEnabled()) {
			const existing = await queryRunner.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'IDX_user_hibernation_candidates'`);
			if (existing[0]?.indisvalid !== true) {
				await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_hibernation_candidates"`);
				await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_user_hibernation_candidates" ON "user" ("lastActiveDate") WHERE "host" IS NULL AND "isHibernated" = false AND "lastActiveDate" IS NOT NULL`);
			}
		} else {
			await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_hibernation_candidates" ON "user" ("lastActiveDate") WHERE "host" IS NULL AND "isHibernated" = false AND "lastActiveDate" IS NOT NULL`);
		}
	}

	async down(queryRunner) {
		const concurrently = isConcurrentIndexMigrationEnabled() ? 'CONCURRENTLY' : '';
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_user_hibernation_candidates"`);
	}
}
