/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import { hanamiReturningRows } from '@/core/hanami/HanamiReturningRows.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { HanamiCommonHeadQueries } from './HanamiCommonHeadQueries.js';
import type { MiUser } from '@/models/User.js';
import type { EntityManager } from 'typeorm';

type UserFeedStateRow = {
	user_id: MiUser['id'];
	epoch_id: string;
};

@Injectable()
export class HanamiFeedLifecycleService {
	constructor(
		private idService: IdService,
		private roleService: RoleService,
		private commonHeadQueries: HanamiCommonHeadQueries = new HanamiCommonHeadQueries(),
	) {}

	@bindThis
	public async hibernateUsers(
		manager: EntityManager,
		userIds: readonly MiUser['id'][],
		transitionedAt: Date,
	): Promise<void> {
		const orderedUserIds = [...new Set<MiUser['id']>(userIds)].sort();
		if (orderedUserIds.length === 0) return;

		const states = await manager.query<UserFeedStateRow[]>(`
			SELECT s."userId" AS user_id, s."epochId" AS epoch_id
			FROM "hanami_user_feed_state" s
			WHERE s."userId" = ANY($1::varchar[])
			ORDER BY s."userId" ASC
			FOR UPDATE OF s
		`, [orderedUserIds]);
		if (states.length === 0) return;
		const stateUserIds = states.map((state) => state.user_id);

		await this.lockActiveEpochs(manager, states);
		await this.obsoleteCurrentWork(manager, stateUserIds, transitionedAt);
		const commonHead = await this.commonHeadQueries.lockLatestReadyCommonHead(manager);

		const updated = hanamiReturningRows(await manager.query<Array<{ user_id: MiUser['id'] }>>(`
			UPDATE "hanami_user_feed_state" s
			SET "mode" = 'common',
				"generatingBatchId" = NULL,
				"commonEpochId" = $2,
				"commonHeadGenerationId" = $3,
				"commonHeadSequence" = $4::bigint,
				"updatedAt" = $5
			WHERE s."userId" = ANY($1::varchar[])
			RETURNING s."userId" AS user_id
		`, [
			stateUserIds,
			commonHead?.epochId ?? null,
			commonHead?.generationId ?? null,
			commonHead?.headSequence ?? null,
			transitionedAt,
		]));
		if (updated.length !== states.length) {
			throw new Error(`Hanami hibernation updated ${updated.length} of ${states.length} locked feed states`);
		}
	}

	@bindThis
	public async reviveUser(
		manager: EntityManager,
		userId: MiUser['id'],
		transitionedAt: Date,
	): Promise<void> {
		const states = await manager.query<UserFeedStateRow[]>(`
			SELECT s."userId" AS user_id, s."epochId" AS epoch_id
			FROM "hanami_user_feed_state" s
			WHERE s."userId" = $1
			ORDER BY s."userId" ASC
			FOR UPDATE OF s
		`, [userId]);
		const state = states.at(0);
		if (state == null) return;

		await this.lockActiveEpochs(manager, [state]);
		await this.obsoleteCurrentWork(manager, [userId], transitionedAt);
		const initialGenerationState = await this.getInitialGenerationState(manager, userId);
		const commonHead = await this.commonHeadQueries.lockLatestReadyCommonHead(manager);

		const retired = hanamiReturningRows(await manager.query<Array<{ epoch_id: string }>>(`
			UPDATE "hanami_user_feed_epoch"
			SET "retiredAt" = $3
			WHERE "userId" = $1 AND "epochId" = $2 AND "retiredAt" IS NULL
			RETURNING "epochId" AS epoch_id
		`, [userId, state.epoch_id, transitionedAt]));
		if (retired.length !== 1) throw new Error('Hanami user feed state does not reference its active epoch');

		const newEpochId = this.idService.gen();
		await manager.query(`
			INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
			VALUES ($1, $2, $3, NULL)
		`, [newEpochId, userId, transitionedAt]);

		const updated = state == null ? [] : hanamiReturningRows(await manager.query<Array<{ user_id: MiUser['id'] }>>(`
			UPDATE "hanami_user_feed_state"
			SET "epochId" = $2,
				"mode" = 'common',
				"initialGenerationState" = $3,
				"initialGenerationAttemptedAt" = NULL,
				"latestReadyBatchId" = NULL,
				"generatingBatchId" = NULL,
				"latestSequence" = '0'::bigint,
				"earliestRetainedSequence" = '0'::bigint,
				"commonEpochId" = $4,
				"commonHeadGenerationId" = $5,
				"commonHeadSequence" = $6::bigint,
				"updatedAt" = $7
			WHERE "userId" = $1 AND "epochId" = $8
			RETURNING "userId" AS user_id
		`, [
			userId,
			newEpochId,
			initialGenerationState,
			commonHead?.epochId ?? null,
			commonHead?.generationId ?? null,
			commonHead?.headSequence ?? null,
			transitionedAt,
			state.epoch_id,
		]));
		if (updated.length !== 1) throw new Error('Hanami user feed state changed during revival');
	}

	private async lockActiveEpochs(manager: EntityManager, states: readonly UserFeedStateRow[]): Promise<void> {
		const epochs = await manager.query<UserFeedStateRow[]>(`
			SELECT e."userId" AS user_id, e."epochId" AS epoch_id
			FROM "hanami_user_feed_epoch" e
			JOIN "hanami_user_feed_state" s
				ON s."userId" = e."userId" AND s."epochId" = e."epochId"
			WHERE s."userId" = ANY($1::varchar[]) AND e."retiredAt" IS NULL
			ORDER BY e."userId" ASC, e."epochId" ASC
			FOR UPDATE OF e
		`, [states.map((state) => state.user_id)]);
		if (epochs.length !== states.length) {
			throw new Error(`Hanami feed state references ${states.length} current epochs, but ${epochs.length} active epochs were found`);
		}
		for (let index = 0; index < states.length; index++) {
			const state = states[index]!;
			const epoch = epochs[index]!;
			if (state.user_id !== epoch.user_id || state.epoch_id !== epoch.epoch_id) {
				throw new Error(`Hanami feed state for user ${state.user_id} does not reference its active epoch ${state.epoch_id}`);
			}
		}
	}

	private async obsoleteCurrentWork(
		manager: EntityManager,
		userIds: readonly MiUser['id'][],
		transitionedAt: Date,
	): Promise<void> {
		const batches = await manager.query<Array<{ id: string }>>(`
			SELECT b."id" AS id
			FROM "hanami_user_feed_batch" b
			JOIN "hanami_user_feed_state" s
				ON s."userId" = b."userId" AND s."epochId" = b."epochId"
			WHERE s."userId" = ANY($1::varchar[])
				AND b."status" IN ('pending', 'generating')
			ORDER BY b."userId" ASC, b."id" ASC
			FOR UPDATE OF b
		`, [userIds]);
		if (batches.length > 0) {
			const updated = hanamiReturningRows(await manager.query<Array<{ id: string }>>(`
				UPDATE "hanami_user_feed_batch" b
				SET "status" = 'obsolete',
					"leaseOwner" = NULL,
					"leaseExpiresAt" = NULL,
					"finishedAt" = $2
				FROM "hanami_user_feed_state" s
				WHERE s."userId" = b."userId" AND s."epochId" = b."epochId"
					AND s."userId" = ANY($1::varchar[])
					AND b."status" IN ('pending', 'generating')
				RETURNING b."id" AS id
			`, [userIds, transitionedAt]));
			if (updated.length !== batches.length) {
				throw new Error(`Hanami lifecycle obsoleted ${updated.length} of ${batches.length} locked active feed batches`);
			}
		}

		const refreshes = await manager.query<Array<{ user_id: MiUser['id'] }>>(`
			SELECT r."userId" AS user_id
			FROM "hanami_user_feed_refresh" r
			JOIN "hanami_user_feed_state" s
				ON s."userId" = r."userId" AND s."epochId" = r."epochId"
			WHERE s."userId" = ANY($1::varchar[]) AND r."status" = 'pending'
			ORDER BY r."userId" ASC, r."epochId" ASC, r."refreshTokenDigest" ASC
			FOR UPDATE OF r
		`, [userIds]);
		if (refreshes.length > 0) {
			const updated = hanamiReturningRows(await manager.query<Array<{ user_id: MiUser['id'] }>>(`
				UPDATE "hanami_user_feed_refresh" r
				SET "status" = 'obsolete',
					"resultMode" = NULL,
					"resultFeedEpochId" = NULL,
					"resultHeadBatchId" = NULL,
					"resultHeadSequence" = NULL
				FROM "hanami_user_feed_state" s
				WHERE s."userId" = r."userId" AND s."epochId" = r."epochId"
					AND s."userId" = ANY($1::varchar[])
					AND r."status" = 'pending'
				RETURNING r."userId" AS user_id
			`, [userIds]));
			if (updated.length !== refreshes.length) {
				throw new Error(`Hanami lifecycle obsoleted ${updated.length} of ${refreshes.length} locked pending refreshes`);
			}
		}

	}

	private async getInitialGenerationState(
		manager: EntityManager,
		userId: MiUser['id'],
	): Promise<'notEvaluated' | 'skippedUnavailable'> {
		const policies = await this.roleService.getUserPolicies(userId, manager);
		if (policies.hanamiTlAvailable !== true) return 'skippedUnavailable';

		const profiles = await manager.query<Array<{ enabled: boolean }>>(`
			SELECT p."hanamiRecommendationEnabled" AS enabled
			FROM "user_profile" p
			WHERE p."userId" = $1
		`, [userId]);
		const profile = profiles.at(0);
		if (profile == null) throw new Error(`Hanami revival profile is missing for user ${userId}`);
		return profile.enabled === true ? 'notEvaluated' : 'skippedUnavailable';
	}
}
