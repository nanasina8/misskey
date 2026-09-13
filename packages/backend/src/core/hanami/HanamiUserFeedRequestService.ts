/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { hanamiReturningRows } from '@/core/hanami/HanamiReturningRows.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { QueueService } from '@/core/QueueService.js';
import { RoleService } from '@/core/RoleService.js';
import { computeHanamiRefreshTokenDigest } from './HanamiFeedCodec.js';
import { HanamiCommonHeadQueries } from './HanamiCommonHeadQueries.js';
import type {
	HanamiCommonFeedHeadSnapshot,
	HanamiFeedHeadSnapshot,
	HanamiUserFeedAvailabilityResult,
	HanamiUserFeedRequestPort,
	HanamiUserFeedRequestResult,
} from './HanamiUserFeedContracts.js';
import type { DataSource, QueryRunner } from 'typeorm';

const REFRESH_TTL_MINUTES = 15;
const REFRESH_RATE_LIMIT = 3;
const SYNC_POLL_INTERVAL_MS = 20;
const UNSERVED_HEAD_REUSE_MINUTES = 20;

type UserRow = {
	id: string;
	is_hibernated: boolean;
};

type StateRow = {
	user_id: string;
	epoch_id: string;
	mode: 'personalized' | 'common';
	initial_state: 'notEvaluated' | 'requested' | 'ready' | 'failed' | 'skippedUnavailable';
	latest_ready_batch_id: string | null;
	generating_batch_id: string | null;
	latest_sequence: string;
	earliest_retained_sequence: string;
	common_epoch_id: string | null;
	common_generation_id: string | null;
	common_sequence: string | null;
};

type EpochRow = {
	epoch_id: string;
	retired_at: Date | string | null;
};

type BatchRow = {
	id: string;
	user_id: string;
	epoch_id: string;
	trigger: 'initial' | 'refresh';
	status: 'pending' | 'generating' | 'ready' | 'failed' | 'obsolete';
	attempts: number;
	item_count: number;
};

type RefreshRow = {
	epoch_id: string;
	requested_batch_id: string;
	status: 'pending' | 'ready' | 'failed' | 'obsolete';
	result_mode: 'personalized' | 'common' | null;
	result_feed_epoch_id: string | null;
	result_head_batch_id: string | null;
	result_head_sequence: string | null;
};

type LockedContext = {
	user: UserRow;
	state: StateRow | null;
	epoch: EpochRow | null;
	activeBatch: BatchRow | null;
};

type Availability = {
	kind: 'available';
} | {
	kind: 'roleDisabled';
} | {
	kind: 'recommendationDisabled';
};

type PendingDecision = {
	result: HanamiUserFeedRequestResult;
	batchId: string | null;
	refreshDigest: Buffer | null;
};

class HanamiCommonNotReadyError extends Error {}

@Injectable()
export class HanamiUserFeedRequestService implements HanamiUserFeedRequestPort {
	private logger: Logger;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.config)
		private config: Config,

		private idService: IdService,
		private roleService: RoleService,
		private queueService: QueueService,
		private loggerService: LoggerService,
		private commonHeadQueries: HanamiCommonHeadQueries,
	) {
		this.logger = this.loggerService.getLogger('hanami-user-feed-request');
	}

	@bindThis
	public async checkAvailability(userId: string): Promise<HanamiUserFeedAvailabilityResult> {
		return await this.withTransaction(async (queryRunner) => {
			const context = await this.lockContext(queryRunner, userId);
			const availability = await this.evaluateAvailability(queryRunner, userId);
			if (availability.kind === 'available' || availability.kind === 'roleDisabled') return availability;

			return {
				kind: 'recommendationDisabled',
				head: await this.recommendationDisabledHead(queryRunner, context.state, context.user.is_hibernated),
			};
		});
	}

	@bindThis
	public async evaluateCursorless(userId: string): Promise<HanamiUserFeedRequestResult> {
		let decision: PendingDecision;
		try {
			decision = await this.withTransaction(async (queryRunner) => {
				const context = await this.lockContext(queryRunner, userId);
				if (context.user.is_hibernated) return await this.hibernatedDecision(queryRunner, context);
				const availability = await this.evaluateAvailability(queryRunner, userId);
				if (availability.kind !== 'available') {
					const state = await this.recordInitialUnavailable(queryRunner, context);
					return {
						result: availability.kind === 'roleDisabled'
							? { kind: 'roleDisabled' }
							: { kind: 'recommendationDisabled', head: await this.recommendationDisabledHead(queryRunner, state, false) },
						batchId: null,
						refreshDigest: null,
					};
				}

				if (context.state == null || context.state.initial_state === 'notEvaluated') {
					const commonHead = await this.requireLockedCommonHead(queryRunner);
					const started = await this.startInitialGeneration(queryRunner, context, commonHead);
					return {
						result: this.pendingResult(this.commonHead(commonHead), started.batchId),
						batchId: started.batchId,
						refreshDigest: null,
					};
				}

				const state = context.state;
				const head = await this.requireStateHead(queryRunner, state);
				if (state.initial_state === 'requested' && context.activeBatch != null && context.activeBatch.id === state.generating_batch_id) {
					return {
						result: this.pendingResult(head, context.activeBatch.id),
						batchId: context.activeBatch.id,
						refreshDigest: null,
					};
				}

				return {
					result: { kind: 'serve', head, generationPending: false, requestedBatchId: null },
					batchId: null,
					refreshDigest: null,
				};
			});
		} catch (error) {
			if (error instanceof HanamiCommonNotReadyError) return { kind: 'commonNotReady' };
			throw error;
		}

		return await this.dispatchAndWait(userId, decision);
	}

	@bindThis
	public async requestRefresh(userId: string, refreshToken: string): Promise<HanamiUserFeedRequestResult> {
		let refreshDigest: Buffer;
		try {
			refreshDigest = computeHanamiRefreshTokenDigest(refreshToken);
		} catch {
			return { kind: 'invalidRefreshToken' };
		}

		let decision: PendingDecision;
		try {
			decision = await this.withTransaction(async (queryRunner) => {
				const context = await this.lockContext(queryRunner, userId);
				if (context.user.is_hibernated) return await this.hibernatedDecision(queryRunner, context);
				const availability = await this.evaluateAvailability(queryRunner, userId);
				if (availability.kind !== 'available') {
					const state = await this.recordInitialUnavailable(queryRunner, context);
					return {
						result: availability.kind === 'roleDisabled'
							? { kind: 'roleDisabled' }
							: { kind: 'recommendationDisabled', head: await this.recommendationDisabledHead(queryRunner, state, false) },
						batchId: null,
						refreshDigest: null,
					};
				}

				await this.deleteExpiredMatchingRefresh(queryRunner, userId, refreshDigest);
				const existing = await this.lockRefreshMappings(queryRunner, userId, refreshDigest);
				if (existing.some((row) => row.epoch_id !== context.state?.epoch_id)) {
					return { result: { kind: 'refreshTokenExpired' }, batchId: null, refreshDigest: null };
				}
				const currentMapping = existing.find((row) => row.epoch_id === context.state?.epoch_id);
				if (currentMapping != null) {
					if (currentMapping.status === 'obsolete') {
						return { result: { kind: 'refreshTokenExpired' }, batchId: null, refreshDigest: null };
					}
					if (currentMapping.status === 'ready' || currentMapping.status === 'failed') {
						return { result: this.terminalMappingResult(currentMapping), batchId: null, refreshDigest: null };
					}
					const requestedBatches = await queryRunner.query(`
						SELECT b."status" AS status
						FROM "hanami_user_feed_batch" b
						WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3
					`, [currentMapping.requested_batch_id, userId, currentMapping.epoch_id]) as Array<{ status: BatchRow['status'] }>;
					if (requestedBatches.at(0)?.status === 'obsolete') {
						return { result: { kind: 'refreshTokenExpired' }, batchId: null, refreshDigest: null };
					}

					const fallback = await this.requireStateHead(queryRunner, context.state!);
					return {
						result: this.pendingResult(fallback, currentMapping.requested_batch_id),
						batchId: currentMapping.requested_batch_id,
						refreshDigest,
					};
				}

				if (await this.isRefreshRateLimited(queryRunner, userId)) {
					return { result: { kind: 'refreshRateLimited' }, batchId: null, refreshDigest: null };
				}

				let state = context.state;
				if (state != null && state.mode === 'personalized' && state.latest_ready_batch_id != null && context.activeBatch == null
					&& await this.isUnservedReadyHead(queryRunner, state)) {
					const head = await this.requireStateHead(queryRunner, state);
					await queryRunner.query(`
						INSERT INTO "hanami_user_feed_refresh" (
							"userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status",
							"resultMode", "resultFeedEpochId", "resultHeadBatchId", "resultHeadSequence", "createdAt", "expiresAt"
						)
						VALUES ($1, $2, $3, $4, 'ready', 'personalized', $2, $4, $5::bigint, clock_timestamp(),
							clock_timestamp() + INTERVAL '${REFRESH_TTL_MINUTES} minutes')
					`, [userId, state.epoch_id, refreshDigest, state.latest_ready_batch_id, state.latest_sequence]);
					return {
						result: { kind: 'serve', head, generationPending: false, requestedBatchId: state.latest_ready_batch_id },
						batchId: null,
						refreshDigest: null,
					};
				}

				let batchId: string;
				if (state == null || state.initial_state === 'notEvaluated') {
					const commonHead = await this.requireLockedCommonHead(queryRunner);
					const started = await this.startInitialGeneration(queryRunner, context, commonHead);
					state = started.state;
					batchId = started.batchId;
				} else if (context.activeBatch != null) {
					if (context.activeBatch.epoch_id !== state.epoch_id) {
						throw new Error(`Hanami active batch ${context.activeBatch.id} belongs to a different epoch`);
					}
					if (state.generating_batch_id == null) {
						const installed = hanamiReturningRows(await queryRunner.query(`
							UPDATE "hanami_user_feed_state"
							SET "generatingBatchId" = $3, "updatedAt" = clock_timestamp()
							WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" IS NULL
							RETURNING "userId" AS user_id
						`, [userId, state.epoch_id, context.activeBatch.id]) as Array<{ user_id: string }>);
						if (installed.length !== 1) throw new Error('Failed to join the active Hanami user feed batch');
						state = { ...state, generating_batch_id: context.activeBatch.id };
					} else if (state.generating_batch_id !== context.activeBatch.id) {
						throw new Error('Hanami user feed state points to a different active batch');
					}
					batchId = context.activeBatch.id;
				} else {
					const commonHead = await this.requireLockedCommonHead(queryRunner);
					const created = await this.startRefreshGeneration(queryRunner, state, commonHead);
					state = created.state;
					batchId = created.batchId;
				}

				await queryRunner.query(`
					INSERT INTO "hanami_user_feed_refresh" (
						"userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt"
					)
					VALUES ($1, $2, $3, $4, 'pending', clock_timestamp(),
						clock_timestamp() + INTERVAL '${REFRESH_TTL_MINUTES} minutes')
				`, [userId, state.epoch_id, refreshDigest, batchId]);

				const fallback = await this.requireStateHead(queryRunner, state);
				return {
					result: this.pendingResult(fallback, batchId),
					batchId,
					refreshDigest,
				};
			});
		} catch (error) {
			if (error instanceof HanamiCommonNotReadyError) return { kind: 'commonNotReady' };
			throw error;
		}

		return await this.dispatchAndWait(userId, decision);
	}

	private async lockContext(queryRunner: QueryRunner, userId: string): Promise<LockedContext> {
		const users = await queryRunner.query(`
			SELECT u."id" AS id, u."isHibernated" AS is_hibernated
			FROM "user" u
			WHERE u."id" = $1
			FOR UPDATE OF u
		`, [userId]) as UserRow[];
		const user = users.at(0);
		if (user == null) throw new Error(`Hanami user ${userId} does not exist`);

		const states = await queryRunner.query(`
			SELECT s."userId" AS user_id, s."epochId" AS epoch_id, s."mode" AS mode,
				s."initialGenerationState" AS initial_state,
				s."latestReadyBatchId" AS latest_ready_batch_id,
				s."generatingBatchId" AS generating_batch_id,
				s."latestSequence"::text AS latest_sequence,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence,
				s."commonEpochId" AS common_epoch_id,
				s."commonHeadGenerationId" AS common_generation_id,
				s."commonHeadSequence"::text AS common_sequence
			FROM "hanami_user_feed_state" s
			WHERE s."userId" = $1
			FOR UPDATE OF s
		`, [userId]) as StateRow[];
		const state = states.at(0) ?? null;

		const epochs = state == null
			? await queryRunner.query(`
				SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
				FROM "hanami_user_feed_epoch" e
				WHERE e."userId" = $1 AND e."retiredAt" IS NULL
				ORDER BY e."epochId" ASC
				FOR UPDATE OF e
			`, [userId]) as EpochRow[]
			: await queryRunner.query(`
				SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
				FROM "hanami_user_feed_epoch" e
				WHERE e."userId" = $1 AND e."epochId" = $2
				FOR UPDATE OF e
			`, [userId, state.epoch_id]) as EpochRow[];
		if (epochs.length > 1) throw new Error(`Hanami user ${userId} has multiple active feed epochs`);
		const epoch = epochs.at(0) ?? null;
		if (state != null && (epoch == null || epoch.retired_at != null)) {
			throw new Error(`Hanami feed state for user ${userId} does not reference an active epoch`);
		}

		const activeBatches = await queryRunner.query(`
			SELECT b."id" AS id, b."userId" AS user_id, b."epochId" AS epoch_id,
				b."trigger" AS trigger, b."status" AS status, b."attempts" AS attempts,
				b."itemCount" AS item_count
			FROM "hanami_user_feed_batch" b
			WHERE b."userId" = $1 AND b."status" IN ('pending', 'generating')
			ORDER BY b."id" ASC
			FOR UPDATE OF b
		`, [userId]) as BatchRow[];
		if (activeBatches.length > 1) throw new Error(`Hanami user ${userId} has multiple active feed batches`);

		return { user, state, epoch, activeBatch: activeBatches.at(0) ?? null };
	}

	private async evaluateAvailability(queryRunner: QueryRunner, userId: string): Promise<Availability> {
		const policies = await this.roleService.getUserPolicies(userId, queryRunner.manager);
		if (policies.hanamiTlAvailable !== true) return { kind: 'roleDisabled' };

		const profiles = await queryRunner.query(`
			SELECT p."hanamiRecommendationEnabled" AS enabled
			FROM "user_profile" p
			WHERE p."userId" = $1
		`, [userId]) as Array<{ enabled: boolean }>;
		const profile = profiles.at(0);
		if (profile == null) throw new Error(`Hanami profile is missing for user ${userId}`);
		return profile.enabled === true
			? { kind: 'available' }
			: { kind: 'recommendationDisabled' };
	}

	private async recordInitialUnavailable(queryRunner: QueryRunner, context: LockedContext): Promise<StateRow | null> {
		if (context.state != null && context.state.initial_state !== 'notEvaluated') return context.state;

		const commonHead = await this.commonHeadQueries.lockLatestReadyCommonHead(queryRunner);
		const epochId = await this.ensureEpoch(queryRunner, context);
		if (context.state == null) {
			await queryRunner.query(`
				INSERT INTO "hanami_user_feed_state" (
					"userId", "epochId", "mode", "initialGenerationState", "initialGenerationAttemptedAt",
					"latestReadyBatchId", "generatingBatchId", "latestSequence", "earliestRetainedSequence",
					"commonEpochId", "commonHeadGenerationId", "commonHeadSequence", "updatedAt"
				)
				VALUES ($1, $2, 'common', 'skippedUnavailable', clock_timestamp(), NULL, NULL, 0, 0,
					$3, $4, $5::bigint, clock_timestamp())
			`, [context.user.id, epochId, commonHead?.epochId ?? null, commonHead?.generationId ?? null, commonHead?.headSequence ?? null]);
			return this.emptyState(context.user.id, epochId, 'skippedUnavailable', commonHead);
		}

		const rows = hanamiReturningRows(await queryRunner.query(`
			UPDATE "hanami_user_feed_state"
			SET "mode" = 'common',
				"initialGenerationState" = 'skippedUnavailable',
				"initialGenerationAttemptedAt" = clock_timestamp(),
				"commonEpochId" = $3,
				"commonHeadGenerationId" = $4,
				"commonHeadSequence" = $5::bigint,
				"updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "initialGenerationState" = 'notEvaluated'
			RETURNING "userId" AS user_id
		`, [context.user.id, epochId, commonHead?.epochId ?? null, commonHead?.generationId ?? null, commonHead?.headSequence ?? null]) as Array<{ user_id: string }>);
		if (rows.length !== 1) throw new Error('Failed to record unavailable Hanami initial evaluation');
		return {
			...context.state,
			mode: 'common',
			initial_state: 'skippedUnavailable',
			common_epoch_id: commonHead?.epochId ?? null,
			common_generation_id: commonHead?.generationId ?? null,
			common_sequence: commonHead?.headSequence ?? null,
		};
	}

	private async startInitialGeneration(
		queryRunner: QueryRunner,
		context: LockedContext,
		commonHead: HanamiCommonFeedHeadSnapshot,
	): Promise<{ batchId: string; state: StateRow }> {
		const epochId = await this.ensureEpoch(queryRunner, context);
		let state = context.state;
		if (state == null) {
			await queryRunner.query(`
				INSERT INTO "hanami_user_feed_state" (
					"userId", "epochId", "mode", "initialGenerationState", "initialGenerationAttemptedAt",
					"latestReadyBatchId", "generatingBatchId", "latestSequence", "earliestRetainedSequence",
					"commonEpochId", "commonHeadGenerationId", "commonHeadSequence", "updatedAt"
				)
				VALUES ($1, $2, 'common', 'notEvaluated', NULL, NULL, NULL, 0, 0, $3, $4, $5::bigint, clock_timestamp())
			`, [context.user.id, epochId, commonHead.epochId, commonHead.generationId, commonHead.headSequence]);
			state = this.emptyState(context.user.id, epochId, 'notEvaluated', commonHead);
		}

		if (context.activeBatch != null) {
			if (context.activeBatch.epoch_id !== epochId) throw new Error('Cannot join an active Hanami batch from an old epoch');
			await queryRunner.query(`
				UPDATE "hanami_user_feed_batch" SET "trigger" = 'initial'
				WHERE "id" = $1 AND "userId" = $2 AND "epochId" = $3 AND "status" IN ('pending', 'generating')
			`, [context.activeBatch.id, context.user.id, epochId]);
			const joined = hanamiReturningRows(await queryRunner.query(`
				UPDATE "hanami_user_feed_state"
				SET "mode" = 'common', "initialGenerationState" = 'requested',
					"initialGenerationAttemptedAt" = clock_timestamp(), "generatingBatchId" = $3,
					"commonEpochId" = $4, "commonHeadGenerationId" = $5,
					"commonHeadSequence" = $6::bigint, "updatedAt" = clock_timestamp()
				WHERE "userId" = $1 AND "epochId" = $2 AND "initialGenerationState" = 'notEvaluated'
					AND ("generatingBatchId" IS NULL OR "generatingBatchId" = $3)
				RETURNING "userId" AS user_id
			`, [context.user.id, epochId, context.activeBatch.id, commonHead.epochId, commonHead.generationId, commonHead.headSequence]) as Array<{ user_id: string }>);
			if (joined.length !== 1) throw new Error('Failed to join the active Hanami initial generation');
			return {
				batchId: context.activeBatch.id,
				state: { ...state, mode: 'common', initial_state: 'requested', generating_batch_id: context.activeBatch.id,
					common_epoch_id: commonHead.epochId, common_generation_id: commonHead.generationId, common_sequence: commonHead.headSequence },
			};
		}

		const batchId = this.idService.gen();
		const inserted = await this.insertBatch(queryRunner, batchId, context.user.id, epochId, 'initial', commonHead.generationId);
		const activeBatch = inserted ? batchId : await this.requireActiveBatchId(queryRunner, context.user.id, epochId);
		if (!inserted) {
			await queryRunner.query(`
				UPDATE "hanami_user_feed_batch" SET "trigger" = 'initial'
				WHERE "id" = $1 AND "userId" = $2 AND "epochId" = $3 AND "status" IN ('pending', 'generating')
			`, [activeBatch, context.user.id, epochId]);
		}
		const updated = hanamiReturningRows(await queryRunner.query(`
			UPDATE "hanami_user_feed_state"
			SET "mode" = 'common', "initialGenerationState" = 'requested',
				"initialGenerationAttemptedAt" = clock_timestamp(), "generatingBatchId" = $3,
				"commonEpochId" = $4, "commonHeadGenerationId" = $5,
				"commonHeadSequence" = $6::bigint, "updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "initialGenerationState" = 'notEvaluated'
				AND "generatingBatchId" IS NULL
			RETURNING "userId" AS user_id
		`, [context.user.id, epochId, activeBatch, commonHead.epochId, commonHead.generationId, commonHead.headSequence]) as Array<{ user_id: string }>);
		if (updated.length !== 1) throw new Error('Failed to install the Hanami initial generation batch');

		return {
			batchId: activeBatch,
			state: { ...state, mode: 'common', initial_state: 'requested', generating_batch_id: activeBatch,
				common_epoch_id: commonHead.epochId, common_generation_id: commonHead.generationId, common_sequence: commonHead.headSequence },
		};
	}

	private async startRefreshGeneration(
		queryRunner: QueryRunner,
		state: StateRow,
		commonHead: HanamiCommonFeedHeadSnapshot,
	): Promise<{ batchId: string; state: StateRow }> {
		const batchId = this.idService.gen();
		const inserted = await this.insertBatch(queryRunner, batchId, state.user_id, state.epoch_id, 'refresh', commonHead.generationId);
		const activeBatch = inserted ? batchId : await this.requireActiveBatchId(queryRunner, state.user_id, state.epoch_id);
		const updateCommonHead = state.mode === 'common';
		const updated = hanamiReturningRows(await queryRunner.query(`
			UPDATE "hanami_user_feed_state"
			SET "generatingBatchId" = $3,
				"initialGenerationState" = CASE
					WHEN "initialGenerationState" IN ('failed', 'skippedUnavailable') THEN 'requested'
					ELSE "initialGenerationState"
				END,
				"initialGenerationAttemptedAt" = CASE
					WHEN "initialGenerationState" IN ('failed', 'skippedUnavailable') THEN clock_timestamp()
					ELSE "initialGenerationAttemptedAt"
				END,
				"commonEpochId" = CASE WHEN $4::boolean THEN $5 ELSE "commonEpochId" END,
				"commonHeadGenerationId" = CASE WHEN $4::boolean THEN $6 ELSE "commonHeadGenerationId" END,
				"commonHeadSequence" = CASE WHEN $4::boolean THEN $7::bigint ELSE "commonHeadSequence" END,
				"updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" IS NULL
			RETURNING "userId" AS user_id
		`, [state.user_id, state.epoch_id, activeBatch, updateCommonHead, commonHead.epochId, commonHead.generationId, commonHead.headSequence]) as Array<{ user_id: string }>);
		if (updated.length !== 1) throw new Error('Failed to install the Hanami refresh generation batch');

		return {
			batchId: activeBatch,
			state: {
				...state,
				initial_state: state.initial_state === 'failed' || state.initial_state === 'skippedUnavailable' ? 'requested' : state.initial_state,
				generating_batch_id: activeBatch,
				common_epoch_id: updateCommonHead ? commonHead.epochId : state.common_epoch_id,
				common_generation_id: updateCommonHead ? commonHead.generationId : state.common_generation_id,
				common_sequence: updateCommonHead ? commonHead.headSequence : state.common_sequence,
			},
		};
	}

	private async insertBatch(
		queryRunner: QueryRunner,
		batchId: string,
		userId: string,
		epochId: string,
		trigger: 'initial' | 'refresh',
		baseCommonGenerationId: string,
	): Promise<boolean> {
		const rows = await queryRunner.query(`
			INSERT INTO "hanami_user_feed_batch" (
				"id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId"
			)
			VALUES ($1, $2, $3, $4, 'pending', 0, clock_timestamp(), clock_timestamp(), $5)
			ON CONFLICT ("userId") WHERE "status" IN ('pending', 'generating') DO NOTHING
			RETURNING "id" AS id
		`, [batchId, userId, epochId, trigger, baseCommonGenerationId]) as Array<{ id: string }>;
		return rows.length === 1;
	}

	private async requireActiveBatchId(queryRunner: QueryRunner, userId: string, epochId: string): Promise<string> {
		const rows = await queryRunner.query(`
			SELECT b."id" AS id, b."epochId" AS epoch_id
			FROM "hanami_user_feed_batch" b
			WHERE b."userId" = $1 AND b."status" IN ('pending', 'generating')
			ORDER BY b."id" ASC
			FOR UPDATE OF b
		`, [userId]) as Array<{ id: string; epoch_id: string }>;
		const row = rows.at(0);
		if (rows.length !== 1 || row == null) throw new Error('Hanami active-batch unique conflict did not expose one active batch');
		if (row.epoch_id !== epochId) throw new Error(`Hanami active batch ${row.id} belongs to an obsolete epoch`);
		return row.id;
	}

	private async ensureEpoch(queryRunner: QueryRunner, context: LockedContext): Promise<string> {
		if (context.epoch != null) return context.epoch.epoch_id;
		if (context.state != null) throw new Error('Hanami feed state is missing its epoch');
		const epochId = this.idService.gen();
		await queryRunner.query(`
			INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
			VALUES ($1, $2, clock_timestamp(), NULL)
		`, [epochId, context.user.id]);
		return epochId;
	}

	private async requireLockedCommonHead(queryRunner: QueryRunner): Promise<HanamiCommonFeedHeadSnapshot> {
		const head = await this.commonHeadQueries.lockLatestReadyCommonHead(queryRunner);
		if (head == null) throw new HanamiCommonNotReadyError('Hanami common feed is not ready');
		return head;
	}

	private async deleteExpiredMatchingRefresh(queryRunner: QueryRunner, userId: string, digest: Buffer): Promise<void> {
		await queryRunner.query(`
			DELETE FROM "hanami_user_feed_refresh"
			WHERE "userId" = $1 AND "refreshTokenDigest" = $2 AND "expiresAt" <= clock_timestamp()
		`, [userId, digest]);
	}

	private async lockRefreshMappings(queryRunner: QueryRunner, userId: string, digest: Buffer): Promise<RefreshRow[]> {
		return await queryRunner.query(`
			SELECT r."epochId" AS epoch_id, r."requestedBatchId" AS requested_batch_id,
				r."status" AS status, r."resultMode" AS result_mode,
				r."resultFeedEpochId" AS result_feed_epoch_id,
				r."resultHeadBatchId" AS result_head_batch_id,
				r."resultHeadSequence"::text AS result_head_sequence
			FROM "hanami_user_feed_refresh" r
			WHERE r."userId" = $1 AND r."refreshTokenDigest" = $2
			ORDER BY r."epochId" ASC
			FOR UPDATE OF r
		`, [userId, digest]) as RefreshRow[];
	}

	private async isRefreshRateLimited(queryRunner: QueryRunner, userId: string): Promise<boolean> {
		const rows = await queryRunner.query(`
			SELECT COUNT(*)::text AS count
			FROM "hanami_user_feed_refresh" r
			WHERE r."userId" = $1
				AND r."createdAt" > clock_timestamp() - INTERVAL '1 minute'
		`, [userId]) as Array<{ count: string }>;
		return Number(rows.at(0)?.count ?? '0') >= REFRESH_RATE_LIMIT;
	}

	private async isUnservedReadyHead(queryRunner: QueryRunner, state: StateRow): Promise<boolean> {
		const rows = await queryRunner.query(`
			SELECT b."id" AS id
			FROM "hanami_user_feed_batch" b
			WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
				AND b."finishedAt" > clock_timestamp() - INTERVAL '${UNSERVED_HEAD_REUSE_MINUTES} minutes'
				AND NOT EXISTS (
					SELECT 1 FROM "hanami_user_feed_entry" e
					JOIN "hanami_recommendation_event" ev
						ON ev."userId" = e."userId" AND ev."noteId" = e."noteId"
						AND ev."eventType" = 'served' AND ev."feedKind" = 'personal' AND ev."feedEpochId" = e."epochId"
					WHERE e."batchId" = b."id"
				)
		`, [state.latest_ready_batch_id, state.user_id, state.epoch_id]) as Array<{ id: string }>;
		return rows.length === 1;
	}

	private async requireStateHead(queryRunner: QueryRunner, state: StateRow): Promise<HanamiFeedHeadSnapshot> {
		const head = await this.headFromState(queryRunner, state);
		if (head == null) throw new HanamiCommonNotReadyError('Hanami feed state has no fallback head');
		return head;
	}

	private async recommendationDisabledHead(
		queryRunner: QueryRunner,
		state: StateRow | null,
		hibernated: boolean,
	): Promise<HanamiFeedHeadSnapshot | null> {
		const stateHead = state == null
			? null
			: hibernated
				? await this.frozenCommonHeadFromState(queryRunner, state)
				: await this.headFromState(queryRunner, state);
		if (stateHead != null) return stateHead;

		const latestCommon = await this.commonHeadQueries.lockLatestReadyCommonHead(queryRunner);
		return latestCommon == null ? null : this.commonHead(latestCommon);
	}

	private async hibernatedDecision(queryRunner: QueryRunner, context: LockedContext): Promise<PendingDecision> {
		let head: HanamiFeedHeadSnapshot | null;
		if (context.state == null) {
			const latestCommon = await this.commonHeadQueries.lockLatestReadyCommonHead(queryRunner);
			head = latestCommon == null ? null : this.commonHead(latestCommon);
		} else {
			head = await this.frozenCommonHeadFromState(queryRunner, context.state);
		}

		return {
			result: head == null
				? { kind: 'commonNotReady' }
				: { kind: 'serve', head, generationPending: false, requestedBatchId: null },
			batchId: null,
			refreshDigest: null,
		};
	}

	private async frozenCommonHeadFromState(queryRunner: QueryRunner, state: StateRow): Promise<HanamiFeedHeadSnapshot | null> {
		if (state.common_epoch_id == null || state.common_generation_id == null || state.common_sequence == null) return null;
		const generations = await queryRunner.query(`
			SELECT g."id" AS id
			FROM "hanami_common_generation" g
			WHERE g."id" = $1 AND g."status" = 'ready'
		`, [state.common_generation_id]) as Array<{ id: string }>;
		if (generations.length !== 1) throw new Error(`Hanami frozen common generation ${state.common_generation_id} is not ready`);
		return {
			mode: 'common',
			kind: 'common',
			feedEpochId: state.common_epoch_id,
			headBatchId: state.common_generation_id,
			headSequence: state.common_sequence,
		};
	}

	private async headFromState(queryRunner: QueryRunner, state: StateRow | null): Promise<HanamiFeedHeadSnapshot | null> {
		if (state == null) return null;
		if (state.mode === 'personalized') {
			if (state.latest_ready_batch_id == null || !/^[1-9]\d*$/.test(state.latest_sequence)) {
				throw new Error(`Hanami personalized state for user ${state.user_id} has no valid ready head`);
			}
			const batches = await queryRunner.query(`
				SELECT b."id" AS id
				FROM "hanami_user_feed_batch" b
				WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
			`, [state.latest_ready_batch_id, state.user_id, state.epoch_id]) as Array<{ id: string }>;
			if (batches.length !== 1) throw new Error(`Hanami personalized head batch ${state.latest_ready_batch_id} is not ready`);
			return {
				mode: 'personalized',
				kind: 'personal',
				feedEpochId: state.epoch_id,
				headBatchId: state.latest_ready_batch_id,
				headSequence: state.latest_sequence,
			};
		}

		if (state.common_epoch_id == null || state.common_generation_id == null || state.common_sequence == null) return null;
		const generations = await queryRunner.query(`
			SELECT g."id" AS id
			FROM "hanami_common_generation" g
			WHERE g."id" = $1 AND g."status" = 'ready'
		`, [state.common_generation_id]) as Array<{ id: string }>;
		if (generations.length !== 1) throw new Error(`Hanami frozen common generation ${state.common_generation_id} is not ready`);
		return {
			mode: 'common',
			kind: 'common',
			feedEpochId: state.common_epoch_id,
			headBatchId: state.common_generation_id,
			headSequence: state.common_sequence,
		};
	}

	private commonHead(head: HanamiCommonFeedHeadSnapshot): HanamiFeedHeadSnapshot {
		return {
			mode: 'common',
			kind: 'common',
			feedEpochId: head.epochId,
			headBatchId: head.generationId,
			headSequence: head.headSequence,
		};
	}

	private pendingResult(head: HanamiFeedHeadSnapshot, batchId: string): HanamiUserFeedRequestResult {
		return { kind: 'serve', head, generationPending: true, requestedBatchId: batchId };
	}

	private terminalMappingResult(mapping: RefreshRow): HanamiUserFeedRequestResult {
		if (mapping.result_mode == null || mapping.result_feed_epoch_id == null
			|| mapping.result_head_batch_id == null || mapping.result_head_sequence == null) {
			throw new Error(`Terminal Hanami refresh mapping for batch ${mapping.requested_batch_id} has no result head`);
		}
		return {
			kind: 'serve',
			head: {
				mode: mapping.result_mode,
				kind: mapping.result_mode === 'personalized' ? 'personal' : 'common',
				feedEpochId: mapping.result_feed_epoch_id,
				headBatchId: mapping.result_head_batch_id,
				headSequence: mapping.result_head_sequence,
			},
			generationPending: false,
			requestedBatchId: mapping.requested_batch_id,
		};
	}

	private emptyState(
		userId: string,
		epochId: string,
		initialState: StateRow['initial_state'],
		commonHead: HanamiCommonFeedHeadSnapshot | null,
	): StateRow {
		return {
			user_id: userId,
			epoch_id: epochId,
			mode: 'common',
			initial_state: initialState,
			latest_ready_batch_id: null,
			generating_batch_id: null,
			latest_sequence: '0',
			earliest_retained_sequence: '0',
			common_epoch_id: commonHead?.epochId ?? null,
			common_generation_id: commonHead?.generationId ?? null,
			common_sequence: commonHead?.headSequence ?? null,
		};
	}

	private async dispatchAndWait(userId: string, decision: PendingDecision): Promise<HanamiUserFeedRequestResult> {
		if (decision.batchId == null || decision.result.kind !== 'serve' || !decision.result.generationPending) return decision.result;
		const deadline = performance.now() + this.config.hanamiGenerationSyncWaitMs;
		let enqueueOperation: Promise<unknown>;
		try {
			enqueueOperation = Promise.resolve(this.queueService.enqueueHanamiUserFeedGeneration(decision.batchId));
		} catch (error) {
			enqueueOperation = Promise.reject(error);
		}
		const observedEnqueue = enqueueOperation.then(
			() => undefined,
			(error) => this.logQueueFailure(userId, decision.batchId!, error),
		);

		const enqueueWait = await this.withWaitDeadline(observedEnqueue, Math.max(0, deadline - performance.now()));
		if (enqueueWait === 'timeout') return decision.result;
		while (performance.now() < deadline) {
			const remainingMs = Math.max(0, deadline - performance.now());
			const polled = decision.refreshDigest == null
				? await this.withWaitDeadline(this.pollCursorlessResult(userId, decision.batchId), remainingMs)
				: await this.withWaitDeadline(this.pollRefreshResult(userId, decision.refreshDigest), remainingMs);
			if (polled === 'timeout') return decision.result;
			if (polled != null) return polled;

			const sleepMs = Math.min(SYNC_POLL_INTERVAL_MS, Math.max(0, deadline - performance.now()));
			if (sleepMs <= 0) break;
			await new Promise((resolve) => setTimeout(resolve, sleepMs));
		}
		return decision.result;
	}

	private logQueueFailure(userId: string, batchId: string, error: unknown): void {
		try {
			this.logger.warn('Failed to enqueue a durable Hanami user feed generation request', {
				userId,
				batchId,
				e: error,
			});
		} catch {
			// Queue observation must not create an unhandled rejection if logging itself fails.
		}
	}

	private async pollRefreshResult(userId: string, digest: Buffer): Promise<HanamiUserFeedRequestResult | null> {
		const rows = await this.db.query(`
			SELECT r."epochId" AS epoch_id, r."requestedBatchId" AS requested_batch_id,
				r."status" AS status, r."resultMode" AS result_mode,
				r."resultFeedEpochId" AS result_feed_epoch_id,
				r."resultHeadBatchId" AS result_head_batch_id,
				r."resultHeadSequence"::text AS result_head_sequence
			FROM "hanami_user_feed_refresh" r
			JOIN "hanami_user_feed_state" s ON s."userId" = r."userId"
			WHERE r."userId" = $1 AND r."refreshTokenDigest" = $2 AND r."epochId" = s."epochId"
		`, [userId, digest]) as RefreshRow[];
		const mapping = rows.at(0);
		if (mapping == null || mapping.status === 'obsolete') return { kind: 'refreshTokenExpired' };
		if (mapping.status === 'ready' || mapping.status === 'failed') return this.terminalMappingResult(mapping);
		return null;
	}

	private async pollCursorlessResult(userId: string, batchId: string): Promise<HanamiUserFeedRequestResult | null> {
		const rows = await this.db.query(`
			SELECT u."isHibernated" AS is_hibernated,
				s."epochId" AS epoch_id, s."mode" AS mode,
				s."latestReadyBatchId" AS latest_ready_batch_id,
				s."generatingBatchId" AS generating_batch_id,
				s."latestSequence"::text AS latest_sequence,
				s."commonEpochId" AS common_epoch_id,
				s."commonHeadGenerationId" AS common_generation_id,
				s."commonHeadSequence"::text AS common_sequence,
				b."status" AS batch_status
			FROM "user" u
			JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
			LEFT JOIN "hanami_user_feed_batch" b ON b."id" = $2 AND b."userId" = u."id"
			WHERE u."id" = $1
		`, [userId, batchId]) as Array<{
			is_hibernated: boolean;
			epoch_id: string;
			mode: 'personalized' | 'common';
			latest_ready_batch_id: string | null;
			generating_batch_id: string | null;
			latest_sequence: string;
			common_epoch_id: string | null;
			common_generation_id: string | null;
			common_sequence: string | null;
			batch_status: BatchRow['status'] | null;
		}>;
		const row = rows.at(0);
		if (row == null) return null;
		if (row.batch_status === 'pending' || row.batch_status === 'generating') return null;

		let head: HanamiFeedHeadSnapshot | null = null;
		if (!row.is_hibernated && row.mode === 'personalized' && row.latest_ready_batch_id != null && row.latest_sequence !== '0') {
			head = { mode: 'personalized', kind: 'personal', feedEpochId: row.epoch_id,
				headBatchId: row.latest_ready_batch_id, headSequence: row.latest_sequence };
		} else if (row.common_epoch_id != null && row.common_generation_id != null && row.common_sequence != null) {
			head = { mode: 'common', kind: 'common', feedEpochId: row.common_epoch_id,
				headBatchId: row.common_generation_id, headSequence: row.common_sequence };
		}
		if (head == null) return { kind: 'commonNotReady' };
		return { kind: 'serve', head, generationPending: false, requestedBatchId: batchId };
	}

	private async withWaitDeadline<T>(operation: Promise<T>, remainingMs: number): Promise<T | 'timeout'> {
		if (remainingMs <= 0) return 'timeout';
		return await new Promise<T | 'timeout'>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve('timeout');
			}, remainingMs);
			void operation.then((value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			}, (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	private async withTransaction<T>(callback: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
		const queryRunner = this.db.createQueryRunner();
		let connected = false;
		try {
			await queryRunner.connect();
			connected = true;
			await queryRunner.startTransaction();
			const result = await callback(queryRunner);
			await queryRunner.commitTransaction();
			return result;
		} catch (error) {
			if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction().catch(() => undefined);
			throw error;
		} finally {
			if (connected) await queryRunner.release();
		}
	}
}
