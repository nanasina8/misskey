/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { hanamiReturningRows } from '@/core/hanami/HanamiReturningRows.js';
import { IdService } from '@/core/IdService.js';
import { HanamiInvalidPersonalSeedError } from '@/core/hanami/HanamiUserFeedContracts.js';
import {
	HANAMI_PERSONAL_FEED_COMPUTATION,
	HANAMI_USER_FEED_AXES,
	type HanamiFeedHeadSnapshot,
	type HanamiPersonalFeedComputationPort,
	type HanamiPersonalFeedComputationResult,
	type HanamiPersonalFeedItem,
	type HanamiUserFeedGenerationLifecyclePort,
	type HanamiUserFeedGenerationReconcileResult,
	type HanamiUserFeedGenerationRunResult,
} from './HanamiUserFeedContracts.js';
import { HanamiCommonHeadQueries } from './HanamiCommonHeadQueries.js';
import { encodeHanamiPersonalFeedEntryLocator } from './HanamiFeedCodec.js';
import type { DataSource, QueryRunner } from 'typeorm';

const MAX_ITEMS = 210;
const MAX_SEGMENTS = 7;
const MAX_SEGMENT_ITEMS = 30;
const MAX_RECONCILE_LIMIT = 1_000;
const AXES = new Set<string>(HANAMI_USER_FEED_AXES);

type Budget = {
	controller: AbortController;
	monotonicDeadline: number;
	databaseDeadlineAt?: string;
	timeoutError: Error;
	dispose: () => void;
};

type WorkerLease = Budget & {
	startHeartbeat: (claim: Claim) => void;
	stopHeartbeat: () => void;
};

type Claim = {
	batchId: string;
	userId: string;
	epochId: string;
	trigger: 'initial' | 'refresh';
	attempt: number;
	leaseOwner: string;
	baseCommonGenerationId: string;
	latestReadyBatchId: string | null;
	generatedAt: string;
};

type ClaimResult = { kind: 'claimed'; claim: Claim } | HanamiUserFeedGenerationRunResult;

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

type BatchRow = {
	id: string;
	user_id: string;
	epoch_id: string;
	trigger: 'initial' | 'refresh';
	status: 'pending' | 'generating' | 'ready' | 'failed' | 'obsolete';
	attempts: number;
	lease_owner: string | null;
	lease_is_live: boolean;
	available_is_due: boolean;
	item_count: number;
	base_common_generation_id: string;
};

type FailureResolution =
	| { kind: 'failed'; terminal: boolean }
	| { kind: 'stale' }
	| { kind: 'published'; itemCount: number; feedEpochId: string; headSequence: string };

type ReconcileCandidate = {
	id: string;
	user_id: string;
	epoch_id: string;
};

class HanamiUserFeedLeaseLostError extends Error {
	constructor() {
		super('Hanami user feed generation lease is no longer current');
	}
}

@Injectable()
export class HanamiUserFeedGenerationService implements HanamiUserFeedGenerationLifecyclePort {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.config)
		private config: Config,

		private idService: IdService,

		@Inject(HANAMI_PERSONAL_FEED_COMPUTATION)
		private computation: HanamiPersonalFeedComputationPort,

		private commonHeadQueries: HanamiCommonHeadQueries = new HanamiCommonHeadQueries(),
	) {}

	@bindThis
	public async runUserFeedGeneration(batchId: string): Promise<HanamiUserFeedGenerationRunResult> {
		if (typeof batchId !== 'string' || batchId.trim().length === 0) throw new TypeError('batchId must be nonempty');
		if (this.config.hanamiGenerationLeaseMs <= this.config.hanamiGenerationWorkerTimeoutMs) {
			throw new Error('Hanami generation lease must exceed the hard worker timeout');
		}

		const workerLease = this.startWorkerLease(batchId);
		let claim: Claim | undefined;
		try {
			const claimed = await this.claimBatch(batchId, workerLease);
			this.assertBudget(workerLease);
			if (claimed.kind !== 'claimed') return claimed;
			claim = claimed.claim;
			workerLease.startHeartbeat(claim);

			await this.confirmBaseCommonGenerationReady(claim, workerLease);
			this.assertBudget(workerLease);

			const computation = await this.runWithBudget(workerLease, () => this.computation.computePersonalFeed({
				userId: claim!.userId,
				epochId: claim!.epochId,
				baseCommonGenerationId: claim!.baseCommonGenerationId,
				latestReadyBatchId: claim!.latestReadyBatchId,
				generatedAt: claim!.generatedAt,
				databaseDeadlineAt: this.databaseDeadlineAt(workerLease),
				signal: workerLease.controller.signal,
			}));
			this.validateComputation(computation);
			if (computation.items.length === 0) throw new Error('Hanami personal generation produced an empty result');
			this.assertBudget(workerLease);

			const publication = await this.publishBatch(claim, computation, workerLease);
			if (publication.kind === 'stale') {
				return { kind: 'stale', batchId, attempt: claim.attempt };
			}
			return {
				kind: 'published',
				batchId,
				attempt: claim.attempt,
				itemCount: computation.items.length,
				feedEpochId: claim.epochId,
				headSequence: publication.headSequence,
			};
		} catch (primaryError) {
			workerLease.stopHeartbeat();
			if (claim == null) throw primaryError;
			if (primaryError === workerLease.timeoutError
				|| (workerLease.controller.signal.aborted && workerLease.controller.signal.reason === workerLease.timeoutError)) {
				throw workerLease.timeoutError;
			}
			if (primaryError instanceof HanamiInvalidPersonalSeedError) {
				const recoveryBudget = this.forkRemainingBudget(workerLease);
				if (recoveryBudget == null) throw primaryError;
				try {
					const recovery = await this.recoverInvalidPersonalSeed(claim, recoveryBudget);
					if (recovery.kind === 'stale') return { kind: 'stale', batchId, attempt: claim.attempt };
					return recovery;
				} finally {
					recoveryBudget.dispose();
				}
			}

			const failureBudget = this.forkRemainingBudget(workerLease);
			if (failureBudget == null) throw primaryError;
			try {
				const resolution = await this.resolveFailure(claim, failureBudget);
				if (resolution.kind === 'stale') return { kind: 'stale', batchId, attempt: claim.attempt };
				if (resolution.kind === 'published') {
					return {
						kind: 'published',
						batchId,
						attempt: claim.attempt,
						itemCount: resolution.itemCount,
						feedEpochId: resolution.feedEpochId,
						headSequence: resolution.headSequence,
					};
				}
				return { kind: 'failed', batchId, attempt: claim.attempt, terminal: resolution.terminal };
			} finally {
				failureBudget.dispose();
			}
		} finally {
			workerLease.dispose();
		}
	}

	@bindThis
	public async reconcileUserFeedGeneration(limit: number): Promise<HanamiUserFeedGenerationReconcileResult> {
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RECONCILE_LIMIT) {
			throw new TypeError(`limit must be an integer in 1..${MAX_RECONCILE_LIMIT}`);
		}

		const candidateRows = await this.db.query(`
			SELECT b."id" AS id, b."userId" AS user_id, b."epochId" AS epoch_id
			FROM "hanami_user_feed_batch" b
			LEFT JOIN "user" u ON u."id" = b."userId"
			LEFT JOIN "hanami_user_feed_state" s ON s."userId" = b."userId"
			LEFT JOIN "hanami_user_feed_epoch" e ON e."userId" = b."userId" AND e."epochId" = b."epochId"
			LEFT JOIN "hanami_common_generation" g ON g."id" = b."baseCommonGenerationId"
			WHERE b."status" IN ('pending', 'generating')
				AND (
					u."id" IS NULL OR u."isHibernated" = TRUE
					OR s."userId" IS NULL OR s."epochId" <> b."epochId" OR s."generatingBatchId" IS DISTINCT FROM b."id"
					OR e."epochId" IS NULL OR e."retiredAt" IS NOT NULL
					OR g."id" IS NULL OR g."status" <> 'ready'
					OR (b."attempts" >= $1 AND (
						b."status" = 'pending' OR b."leaseExpiresAt" <= clock_timestamp()
					))
					OR (b."status" = 'pending' AND b."availableAt" <= clock_timestamp())
					OR (b."status" = 'generating' AND b."leaseExpiresAt" <= clock_timestamp())
				)
			ORDER BY b."userId" ASC, b."id" ASC
			LIMIT $2
		`, [this.config.hanamiGenerationMaxAttempts, limit + 1]) as ReconcileCandidate[];
		const candidates = candidateRows.slice(0, limit);

		const batchIdsToEnqueue: string[] = [];
		let failedBatchCount = 0;
		let obsoleteBatchCount = 0;
		for (const candidate of candidates) {
			const outcome = await this.reconcileBatch(candidate);
			if (outcome === 'enqueue') batchIdsToEnqueue.push(candidate.id);
			if (outcome === 'failed') failedBatchCount++;
			if (outcome === 'obsolete') obsoleteBatchCount++;
		}

		const expiredProbeRows = await this.db.query(`
			SELECT COUNT(*)::text AS count
			FROM (
				SELECT 1 FROM "hanami_user_feed_refresh" r
				WHERE r."expiresAt" <= clock_timestamp()
				LIMIT $1
			) expired
		`, [limit + 1]) as Array<{ count: string }>;
		const deletedRefreshRows = hanamiReturningRows(await this.db.query(`
			WITH expired AS (
				SELECT r."userId", r."epochId", r."refreshTokenDigest"
				FROM "hanami_user_feed_refresh" r
				WHERE r."expiresAt" <= clock_timestamp()
				ORDER BY r."expiresAt" ASC, r."userId" ASC, r."epochId" ASC, r."refreshTokenDigest" ASC
				LIMIT $1
			)
			DELETE FROM "hanami_user_feed_refresh" r
			USING expired x
			WHERE r."userId" = x."userId" AND r."epochId" = x."epochId"
				AND r."refreshTokenDigest" = x."refreshTokenDigest"
			RETURNING r."userId" AS user_id
		`, [limit]) as Array<{ user_id: string }>);

		return {
			batchIdsToEnqueue,
			failedBatchCount,
			obsoleteBatchCount,
			deletedRefreshCount: deletedRefreshRows.length,
			hasMore: candidateRows.length > limit || Number(expiredProbeRows.at(0)?.count ?? '0') > limit,
		};
	}

	private async claimBatch(batchId: string, budget: Budget): Promise<ClaimResult> {
		return await this.withDeadlineTransaction(budget, async (queryRunner) => {
			const leaseOwner = randomUUID();
			const rows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
				WITH locked_state AS (
					SELECT s."userId", s."epochId", s."generatingBatchId", s."latestReadyBatchId"
					FROM "hanami_user_feed_state" s
					WHERE s."userId" = (SELECT b."userId" FROM "hanami_user_feed_batch" b WHERE b."id" = $1)
					FOR UPDATE
				)
				UPDATE "hanami_user_feed_batch" b
				SET "status" = 'generating',
					"attempts" = b."attempts" + 1,
					"leaseOwner" = $2,
					"leaseExpiresAt" = clock_timestamp() + ($3::text || ' milliseconds')::interval,
					"startedAt" = clock_timestamp(),
					"finishedAt" = NULL
				WHERE b."id" = $1
					AND b."attempts" < $4
					AND b."availableAt" <= clock_timestamp()
					AND (
						(b."status" = 'pending' AND b."leaseOwner" IS NULL AND b."leaseExpiresAt" IS NULL)
						OR (b."status" = 'generating' AND b."leaseOwner" IS NOT NULL
							AND b."leaseExpiresAt" IS NOT NULL AND b."leaseExpiresAt" <= clock_timestamp())
					)
					AND EXISTS (
						SELECT 1 FROM "user" u WHERE u."id" = b."userId" AND u."isHibernated" = FALSE
					)
					AND EXISTS (
						SELECT 1 FROM locked_state s
						WHERE s."userId" = b."userId" AND s."epochId" = b."epochId" AND s."generatingBatchId" = b."id"
					)
					AND EXISTS (
						SELECT 1 FROM "hanami_user_feed_epoch" e
						WHERE e."userId" = b."userId" AND e."epochId" = b."epochId" AND e."retiredAt" IS NULL
					)
					AND EXISTS (
						SELECT 1 FROM "hanami_common_generation" g
						WHERE g."id" = b."baseCommonGenerationId" AND g."status" = 'ready'
					)
				RETURNING b."id" AS id, b."userId" AS user_id, b."epochId" AS epoch_id,
					b."trigger" AS trigger, b."attempts" AS attempts,
					b."baseCommonGenerationId" AS base_common_generation_id,
					(SELECT s."latestReadyBatchId" FROM locked_state s) AS latest_ready_batch_id,
					to_char(b."startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generated_at
			`, [batchId, leaseOwner, String(this.config.hanamiGenerationLeaseMs), this.config.hanamiGenerationMaxAttempts]) as Array<{
				id: string;
				user_id: string;
				epoch_id: string;
				trigger: 'initial' | 'refresh';
				attempts: number;
				base_common_generation_id: string;
				latest_ready_batch_id: string | null;
				generated_at: string;
			}>);
			const row = rows.at(0);
			if (row != null) {
				return {
					kind: 'claimed',
					claim: {
						batchId: row.id,
						userId: row.user_id,
						epochId: row.epoch_id,
						trigger: row.trigger,
						attempt: row.attempts,
						leaseOwner,
					baseCommonGenerationId: row.base_common_generation_id,
					latestReadyBatchId: row.latest_ready_batch_id,
						generatedAt: this.toIsoString(row.generated_at, 'batch startedAt'),
					},
				};
			}

			const statusRows = await this.deadlineQuery(queryRunner, budget, `
				SELECT b."status" AS status, b."attempts" AS attempts, b."itemCount" AS item_count,
					b."availableAt" > clock_timestamp() AS available_in_future,
					COALESCE(b."leaseExpiresAt" > clock_timestamp(), FALSE) AS lease_is_live,
					EXISTS (
						SELECT 1 FROM "user" u
						JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
						JOIN "hanami_user_feed_epoch" e ON e."userId" = b."userId" AND e."epochId" = b."epochId"
						JOIN "hanami_common_generation" g ON g."id" = b."baseCommonGenerationId"
						WHERE u."id" = b."userId" AND u."isHibernated" = FALSE
							AND s."epochId" = b."epochId" AND s."generatingBatchId" = b."id"
							AND e."retiredAt" IS NULL AND g."status" = 'ready'
					) AS lifecycle_is_current
				FROM "hanami_user_feed_batch" b
				WHERE b."id" = $1
			`, [batchId]) as Array<{
				status: BatchRow['status'];
				attempts: number;
				item_count: number;
				available_in_future: boolean;
				lease_is_live: boolean;
				lifecycle_is_current: boolean;
			}>;
			const status = statusRows.at(0);
			if (status == null) return { kind: 'terminal', batchId, status: 'missing' };
			if (status.status === 'ready') return { kind: 'alreadyReady', batchId, itemCount: status.item_count };
			if (status.status === 'failed') return { kind: 'terminal', batchId, status: 'failed' };
			if (status.status === 'obsolete' || !status.lifecycle_is_current) return { kind: 'obsolete', batchId };
			if (status.status === 'generating' && status.lease_is_live) return { kind: 'leased', batchId, attempt: status.attempts };
			return { kind: 'pending', batchId };
		});
	}

	private startWorkerLease(batchId: string): WorkerLease {
		const controller = new AbortController();
		const timeoutError = new Error(`Hanami user feed generation ${batchId} exceeded its worker timeout`);
		const monotonicDeadline = performance.now() + this.config.hanamiGenerationWorkerTimeoutMs;
		const timeoutTimer = setTimeout(() => {
			if (!controller.signal.aborted) controller.abort(timeoutError);
		}, this.config.hanamiGenerationWorkerTimeoutMs);
		let stopped = false;
		let heartbeatTimer: NodeJS.Timeout | undefined;
		let heartbeatClaim: Claim | undefined;

		const abort = (error: unknown): void => {
			if (!controller.signal.aborted) controller.abort(error);
		};
		const cadenceMs = Math.max(1, Math.min(
			this.config.hanamiGenerationLeaseMs / 3,
			this.config.hanamiGenerationWorkerTimeoutMs / 2,
		));
		const schedule = (): void => {
			const activeClaim = heartbeatClaim;
			if (stopped || controller.signal.aborted || activeClaim == null) return;
			heartbeatTimer = setTimeout(() => {
				heartbeatTimer = undefined;
				void this.heartbeat(activeClaim, workerLease).then((extended) => {
					if (!extended) abort(new HanamiUserFeedLeaseLostError());
				}, abort).finally(schedule);
			}, cadenceMs);
		};

		const workerLease: WorkerLease = {
			controller,
			monotonicDeadline,
			timeoutError,
			startHeartbeat: (activeClaim) => {
				heartbeatClaim = activeClaim;
				schedule();
			},
			stopHeartbeat: () => {
				stopped = true;
				if (heartbeatTimer != null) clearTimeout(heartbeatTimer);
				heartbeatTimer = undefined;
			},
			dispose: () => {
				workerLease.stopHeartbeat();
				clearTimeout(timeoutTimer);
			},
		};
		return workerLease;
	}

	private async heartbeat(claim: Claim, budget: Budget): Promise<boolean> {
		return await this.withDeadlineTransaction(budget, async (queryRunner) => {
			const rows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
				UPDATE "hanami_user_feed_batch" b
				SET "leaseExpiresAt" = clock_timestamp() + ($4::text || ' milliseconds')::interval
				WHERE b."id" = $1 AND b."status" = 'generating'
					AND b."leaseOwner" = $2 AND b."attempts" = $3
					AND b."leaseExpiresAt" > clock_timestamp()
					AND clock_timestamp() < $5::timestamptz
					AND EXISTS (
						SELECT 1 FROM "user" u
						JOIN "hanami_user_feed_state" s ON s."userId" = u."id"
						JOIN "hanami_user_feed_epoch" e ON e."userId" = b."userId" AND e."epochId" = b."epochId"
						WHERE u."id" = b."userId" AND u."isHibernated" = FALSE
							AND s."epochId" = b."epochId" AND s."generatingBatchId" = b."id"
							AND e."retiredAt" IS NULL
					)
				RETURNING b."attempts" AS attempts
			`, [claim.batchId, claim.leaseOwner, claim.attempt, String(this.config.hanamiGenerationLeaseMs), this.databaseDeadlineAt(budget)]) as Array<{ attempts: number }>);
			return rows.length === 1;
		});
	}

	private async confirmBaseCommonGenerationReady(claim: Claim, budget: Budget): Promise<void> {
		await this.withDeadlineTransaction(budget, async (queryRunner) => {
			const rows = await this.deadlineQuery(queryRunner, budget, `
				SELECT g."status" AS status
				FROM "hanami_common_generation" g
				WHERE g."id" = $1
			`, [claim.baseCommonGenerationId]) as Array<{ status: string }>;
			if (rows.at(0)?.status !== 'ready') {
				throw new Error(`Hanami base common generation ${claim.baseCommonGenerationId} is not ready`);
			}
		});
	}

	private async publishBatch(
		claim: Claim,
		computation: HanamiPersonalFeedComputationResult,
		budget: Budget,
	): Promise<{ kind: 'published'; headSequence: string } | { kind: 'stale' }> {
		const entryIds = computation.items.map(() => this.idService.gen());
		const checksum = createHash('sha256').update(this.canonicalJson({
			version: 1,
			batchId: claim.batchId,
			attempt: claim.attempt,
			baseCommonGenerationId: claim.baseCommonGenerationId,
			computation,
		}), 'utf8').digest('hex');

		try {
			return await this.withDeadlineTransaction(budget, async (queryRunner) => {
				const users = await this.deadlineQuery(queryRunner, budget, `
					SELECT u."id" AS id, u."isHibernated" AS is_hibernated
					FROM "user" u WHERE u."id" = $1 FOR UPDATE OF u
				`, [claim.userId]) as Array<{ id: string; is_hibernated: boolean }>;
				const user = users.at(0);
				if (user == null || user.is_hibernated) throw new HanamiUserFeedLeaseLostError();

				const state = await this.lockState(queryRunner, budget, claim.userId);
				if (state == null) throw new HanamiUserFeedLeaseLostError();
				const epochs = await this.deadlineQuery(queryRunner, budget, `
					SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
					FROM "hanami_user_feed_epoch" e
					WHERE e."userId" = $1 AND e."epochId" = $2
					FOR UPDATE OF e
				`, [claim.userId, claim.epochId]) as Array<{ epoch_id: string; retired_at: Date | string | null }>;
				const epoch = epochs.at(0);
				if (epoch == null || epoch.retired_at != null) throw new HanamiUserFeedLeaseLostError();

				const batch = await this.lockBatch(queryRunner, budget, claim.batchId);
				if (!this.isExactLiveClaim(state, batch, claim)) throw new HanamiUserFeedLeaseLostError();
				await this.deleteUnservedOldHeadTail(queryRunner, budget, claim, state);
				const commonRows = await this.deadlineQuery(queryRunner, budget, `
					SELECT g."id" AS id FROM "hanami_common_generation" g
					WHERE g."id" = $1 AND g."status" = 'ready'
				`, [claim.baseCommonGenerationId]) as Array<{ id: string }>;
				if (commonRows.length !== 1) throw new HanamiUserFeedLeaseLostError();
				this.assertBudget(budget);

				await this.deadlineQuery(queryRunner, budget, `
					INSERT INTO "hanami_user_feed_entry" (
						"id", "userId", "epochId", "sequence", "batchId", "position", "noteId",
						"source", "sources", "origin", "reasonMetadata", "generatedAt"
					)
					SELECT input.entry_id, $1, $2,
						$3::bigint + $4::bigint - (input.ordinality::bigint - 1),
						$5, (input.ordinality::integer - 1), input.note_id, input.source,
						$9::jsonb -> (input.ordinality::integer - 1), input.origin,
						$11::jsonb -> (input.ordinality::integer - 1), $12::timestamptz
					FROM unnest($6::varchar[], $7::varchar[], $8::text[], $10::text[])
						WITH ORDINALITY AS input(entry_id, note_id, source, origin, ordinality)
				`, [
					claim.userId,
					claim.epochId,
					state.latest_sequence,
					String(computation.items.length),
					claim.batchId,
					entryIds,
					computation.items.map((item) => item.noteId),
					computation.items.map((item) => item.source),
					JSON.stringify(computation.items.map((item) => item.sources)),
					computation.items.map((item) => item.origin),
					JSON.stringify(computation.items.map((item) => item.reasonMetadata)),
					claim.generatedAt,
				]);

				const readyRows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
					UPDATE "hanami_user_feed_batch"
					SET "status" = 'ready', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
						"finishedAt" = clock_timestamp(), "itemCount" = $4, "checksum" = $5
					WHERE "id" = $1 AND "status" = 'generating' AND "leaseOwner" = $2 AND "attempts" = $3
						AND "leaseExpiresAt" > clock_timestamp() AND clock_timestamp() < $6::timestamptz
					RETURNING "id" AS id
				`, [claim.batchId, claim.leaseOwner, claim.attempt, computation.items.length, checksum, this.databaseDeadlineAt(budget)]) as Array<{ id: string }>);
				if (readyRows.length !== 1) throw new HanamiUserFeedLeaseLostError();

				const stateRows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
					UPDATE "hanami_user_feed_state" s
					SET "mode" = 'personalized', "latestReadyBatchId" = $3,
						"generatingBatchId" = NULL,
						"latestSequence" = s."latestSequence" + $4::bigint,
						"earliestRetainedSequence" = CASE WHEN s."latestSequence" = 0 THEN 1 ELSE s."earliestRetainedSequence" END,
						"initialGenerationState" = CASE WHEN s."initialGenerationState" = 'requested' THEN 'ready' ELSE s."initialGenerationState" END,
						"updatedAt" = clock_timestamp()
					WHERE s."userId" = $1 AND s."epochId" = $2 AND s."generatingBatchId" = $3
						AND s."latestSequence" = $5::bigint AND s."earliestRetainedSequence" = $6::bigint
						AND clock_timestamp() < $7::timestamptz
						AND EXISTS (SELECT 1 FROM "user" u WHERE u."id" = $1 AND u."isHibernated" = FALSE)
						AND EXISTS (SELECT 1 FROM "hanami_user_feed_batch" b WHERE b."id" = $3 AND b."status" = 'ready' AND b."attempts" = $8)
					RETURNING s."latestSequence"::text AS latest_sequence
				`, [
					claim.userId,
					claim.epochId,
					claim.batchId,
					String(computation.items.length),
					state.latest_sequence,
					state.earliest_retained_sequence,
					this.databaseDeadlineAt(budget),
					claim.attempt,
				]) as Array<{ latest_sequence: string }>);
				const publishedState = stateRows.at(0);
				if (publishedState == null) throw new HanamiUserFeedLeaseLostError();

				await this.deadlineQuery(queryRunner, budget, `
					UPDATE "hanami_user_feed_refresh"
					SET "status" = 'ready', "resultMode" = 'personalized',
						"resultFeedEpochId" = $2, "resultHeadBatchId" = $3,
						"resultHeadSequence" = $4::bigint
					WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
				`, [claim.userId, claim.epochId, claim.batchId, publishedState.latest_sequence]);
				return { kind: 'published', headSequence: publishedState.latest_sequence } as const;
			});
		} catch (error) {
			if (error instanceof HanamiUserFeedLeaseLostError) return { kind: 'stale' };
			throw error;
		}
	}

	private async deleteUnservedOldHeadTail(queryRunner: QueryRunner, budget: Budget, claim: Claim, state: StateRow): Promise<void> {
		if (claim.trigger !== 'refresh' || state.latest_ready_batch_id == null || state.latest_ready_batch_id === claim.batchId) return;

		const oldHeadBatchId = state.latest_ready_batch_id;
		const entries = await this.deadlineQuery(queryRunner, budget, `
			SELECT "sequence"::text AS sequence
			FROM "hanami_user_feed_entry"
			WHERE "userId" = $1 AND "epochId" = $2 AND "batchId" = $3
			ORDER BY "sequence" DESC
		`, [claim.userId, claim.epochId, oldHeadBatchId]) as Array<{ sequence: string }>;
		if (entries.length === 0) return;

		const sequenceByLocator = new Map(entries.map(({ sequence }) => [
			encodeHanamiPersonalFeedEntryLocator({ userId: claim.userId, epochId: claim.epochId, sequence }),
			sequence,
		]));
		const served = await this.deadlineQuery(queryRunner, budget, `
			SELECT ev."feedEntryId" AS feed_entry_id
			FROM "hanami_recommendation_event" ev
			WHERE ev."userId" = $1 AND ev."eventType" = 'served' AND ev."feedEntryId" = ANY($2::varchar[])
		`, [claim.userId, [...sequenceByLocator.keys()]]) as Array<{ feed_entry_id: string }>;
		const servedSequences = served.flatMap(({ feed_entry_id }) => {
			const sequence = sequenceByLocator.get(feed_entry_id);
			return sequence == null ? [] : [BigInt(sequence)];
		});
		if (servedSequences.length === 0) {
			await this.deadlineQuery(queryRunner, budget, `
				DELETE FROM "hanami_user_feed_entry"
				WHERE "userId" = $1 AND "epochId" = $2 AND "batchId" = $3
			`, [claim.userId, claim.epochId, oldHeadBatchId]);
			return;
		}

		const minServed = servedSequences.reduce((minimum, sequence) => sequence < minimum ? sequence : minimum);
		await this.deadlineQuery(queryRunner, budget, `
			DELETE FROM "hanami_user_feed_entry"
			WHERE "userId" = $1 AND "epochId" = $2 AND "batchId" = $3 AND "sequence" < $4::bigint
		`, [claim.userId, claim.epochId, oldHeadBatchId, minServed.toString()]);
	}

	private async resolveFailure(claim: Claim, budget: Budget): Promise<FailureResolution> {
		try {
			return await this.withDeadlineTransaction(budget, async (queryRunner) => {
				const users = await this.deadlineQuery(queryRunner, budget, `
					SELECT u."id" AS id, u."isHibernated" AS is_hibernated
					FROM "user" u WHERE u."id" = $1 FOR UPDATE OF u
				`, [claim.userId]) as Array<{ id: string; is_hibernated: boolean }>;
				const user = users.at(0);
				if (user == null || user.is_hibernated) return { kind: 'stale' } as const;

				const state = await this.lockState(queryRunner, budget, claim.userId);
				if (state == null) return { kind: 'stale' } as const;
				const epochs = await this.deadlineQuery(queryRunner, budget, `
					SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
					FROM "hanami_user_feed_epoch" e WHERE e."userId" = $1 AND e."epochId" = $2 FOR UPDATE OF e
				`, [claim.userId, claim.epochId]) as Array<{ epoch_id: string; retired_at: Date | string | null }>;
				if (epochs.at(0)?.retired_at != null || epochs.length !== 1) return { kind: 'stale' } as const;

				const batch = await this.lockBatch(queryRunner, budget, claim.batchId);
				if (batch?.status === 'ready' && batch.attempts === claim.attempt
					&& state.latest_ready_batch_id === claim.batchId && state.epoch_id === claim.epochId) {
					return { kind: 'published', itemCount: batch.item_count, feedEpochId: claim.epochId, headSequence: state.latest_sequence } as const;
				}
				if (!this.isExactLiveClaim(state, batch, claim)) return { kind: 'stale' } as const;

				if (claim.attempt < this.config.hanamiGenerationMaxAttempts) {
					const backoffMs = Math.min(30_000, 1_000 * (2 ** Math.max(0, claim.attempt - 1)));
					const rows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
						UPDATE "hanami_user_feed_batch"
						SET "status" = 'pending', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
							"availableAt" = clock_timestamp() + ($4::text || ' milliseconds')::interval
						WHERE "id" = $1 AND "status" = 'generating' AND "leaseOwner" = $2 AND "attempts" = $3
							AND "leaseExpiresAt" > clock_timestamp() AND clock_timestamp() < $5::timestamptz
						RETURNING "id" AS id
					`, [claim.batchId, claim.leaseOwner, claim.attempt, String(backoffMs), this.databaseDeadlineAt(budget)]) as Array<{ id: string }>);
					if (rows.length !== 1) return { kind: 'stale' } as const;
					return { kind: 'failed', terminal: false } as const;
				}

				const fallback = await this.requireFallbackHead(queryRunner, budget, state);
				const failedRows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
					UPDATE "hanami_user_feed_batch"
					SET "status" = 'failed', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "finishedAt" = clock_timestamp()
					WHERE "id" = $1 AND "status" = 'generating' AND "leaseOwner" = $2 AND "attempts" = $3
						AND "leaseExpiresAt" > clock_timestamp() AND clock_timestamp() < $4::timestamptz
					RETURNING "id" AS id
				`, [claim.batchId, claim.leaseOwner, claim.attempt, this.databaseDeadlineAt(budget)]) as Array<{ id: string }>);
				if (failedRows.length !== 1) return { kind: 'stale' } as const;

				const stateRows = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
					UPDATE "hanami_user_feed_state"
					SET "generatingBatchId" = NULL,
						"initialGenerationState" = CASE
							WHEN "initialGenerationState" = 'requested' THEN 'failed'
							ELSE "initialGenerationState"
						END,
						"updatedAt" = clock_timestamp()
					WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" = $3
					RETURNING "userId" AS user_id
				`, [claim.userId, claim.epochId, claim.batchId]) as Array<{ user_id: string }>);
				if (stateRows.length !== 1) throw new HanamiUserFeedLeaseLostError();
				await this.failPendingMappings(queryRunner, budget, claim.batchId, claim.userId, claim.epochId, fallback);
				return { kind: 'failed', terminal: true } as const;
			});
		} catch (error) {
			if (error instanceof HanamiUserFeedLeaseLostError) return { kind: 'stale' };
			throw error;
		}
	}

	/**
	 * An invalid seed is distinct from a generation failure: its active epoch can
	 * never satisfy the constraint window. Every row that can invalidate this
	 * claim is locked before any mutation, so a delayed worker is fenced by the
	 * old epoch, state pointer, and old batch lease CAS.
	 */
	private async recoverInvalidPersonalSeed(
		claim: Claim,
		budget: Budget,
	): Promise<Extract<HanamiUserFeedGenerationRunResult, { kind: 'replaced' }> | { kind: 'stale' }> {
		return await this.withDeadlineTransaction(budget, async (queryRunner) => {
			// Lock order is intentionally fixed: user, state, epoch, batch, refreshes.
			const users = await this.deadlineQuery(queryRunner, budget, `
				SELECT u."id" AS id, u."isHibernated" AS is_hibernated
				FROM "user" u WHERE u."id" = $1 FOR UPDATE OF u
			`, [claim.userId]) as Array<{ id: string; is_hibernated: boolean }>;
			const user = users.at(0);
			if (user == null || user.is_hibernated) return { kind: 'stale' } as const;

			const state = await this.lockState(queryRunner, budget, claim.userId);
			if (state == null) return { kind: 'stale' } as const;
			const epochs = await this.deadlineQuery(queryRunner, budget, `
				SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
				FROM "hanami_user_feed_epoch" e
				WHERE e."userId" = $1 AND e."epochId" = $2
				FOR UPDATE OF e
			`, [claim.userId, claim.epochId]) as Array<{ epoch_id: string; retired_at: Date | string | null }>;
			const epoch = epochs.at(0);
			if (epoch == null || epoch.retired_at != null) return { kind: 'stale' } as const;

			const batch = await this.lockBatch(queryRunner, budget, claim.batchId);
			await this.deadlineQuery(queryRunner, budget, `
				SELECT r."refreshTokenDigest"
				FROM "hanami_user_feed_refresh" r
				WHERE r."userId" = $1 AND r."epochId" = $2
					AND r."requestedBatchId" = $3 AND r."status" = 'pending'
				ORDER BY r."refreshTokenDigest" ASC
				FOR UPDATE OF r
			`, [claim.userId, claim.epochId, claim.batchId]);
			if (!this.isExactLiveClaim(state, batch, claim)) return { kind: 'stale' } as const;

			const replacementBatchId = this.idService.gen();
			const replacementEpochId = this.idService.gen();
			const obsolete = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
				UPDATE "hanami_user_feed_batch"
				SET "status" = 'obsolete', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
					"finishedAt" = clock_timestamp()
				WHERE "id" = $1 AND "status" = 'generating' AND "leaseOwner" = $2
					AND "attempts" = $3 AND "leaseExpiresAt" > clock_timestamp()
					AND clock_timestamp() < $4::timestamptz
				RETURNING "id" AS id
			`, [claim.batchId, claim.leaseOwner, claim.attempt, this.databaseDeadlineAt(budget)]) as Array<{ id: string }>);
			if (obsolete.length !== 1) return { kind: 'stale' } as const;

			const retired = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
				UPDATE "hanami_user_feed_epoch"
				SET "retiredAt" = clock_timestamp()
				WHERE "userId" = $1 AND "epochId" = $2 AND "retiredAt" IS NULL
				RETURNING "epochId" AS epoch_id
			`, [claim.userId, claim.epochId]) as Array<{ epoch_id: string }>);
			if (retired.length !== 1) throw new HanamiUserFeedLeaseLostError();

			await this.deadlineQuery(queryRunner, budget, `
				INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
				VALUES ($1, $2, clock_timestamp(), NULL)
			`, [replacementEpochId, claim.userId]);
			const commonHead = await this.commonHeadQueries.lockLatestReadyCommonHead(queryRunner);
			if (commonHead == null) throw new Error('Hanami common feed is not ready for invalid-seed recovery');

			await this.deadlineQuery(queryRunner, budget, `
				INSERT INTO "hanami_user_feed_batch" (
					"id", "userId", "epochId", "trigger", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId"
				)
				VALUES ($1, $2, $3, 'initial', 'pending', 0, clock_timestamp(), clock_timestamp(), $4)
			`, [replacementBatchId, claim.userId, replacementEpochId, commonHead.generationId]);
			const updatedState = hanamiReturningRows(await this.deadlineQuery(queryRunner, budget, `
				UPDATE "hanami_user_feed_state"
				SET "epochId" = $2, "mode" = 'common', "initialGenerationState" = 'requested',
					"initialGenerationAttemptedAt" = clock_timestamp(), "latestReadyBatchId" = NULL,
					"generatingBatchId" = $3, "latestSequence" = 0, "earliestRetainedSequence" = 0,
					"commonEpochId" = $4, "commonHeadGenerationId" = $5,
					"commonHeadSequence" = $6::bigint, "updatedAt" = clock_timestamp()
				WHERE "userId" = $1 AND "epochId" = $7 AND "generatingBatchId" = $8
				RETURNING "userId" AS user_id
			`, [claim.userId, replacementEpochId, replacementBatchId, commonHead.epochId,
				commonHead.generationId, commonHead.headSequence, claim.epochId, claim.batchId]) as Array<{ user_id: string }>);
			if (updatedState.length !== 1) throw new HanamiUserFeedLeaseLostError();
			await this.deadlineQuery(queryRunner, budget, `
				UPDATE "hanami_user_feed_refresh"
				SET "epochId" = $4, "requestedBatchId" = $5
				WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
			`, [claim.userId, claim.epochId, claim.batchId, replacementEpochId, replacementBatchId]);

			return { kind: 'replaced', batchId: claim.batchId, attempt: claim.attempt, replacementBatchId } as const;
		}).catch((error: unknown) => {
			if (error instanceof HanamiUserFeedLeaseLostError) return { kind: 'stale' } as const;
			throw error;
		});
	}

	private async reconcileBatch(candidate: ReconcileCandidate): Promise<'enqueue' | 'failed' | 'obsolete' | null> {
		return await this.withTransaction(async (queryRunner) => {
			const users = await queryRunner.query(`
				SELECT u."id" AS id, u."isHibernated" AS is_hibernated
				FROM "user" u WHERE u."id" = $1 FOR UPDATE OF u
			`, [candidate.user_id]) as Array<{ id: string; is_hibernated: boolean }>;
			const user = users.at(0);
			if (user == null) return null;

			const states = await queryRunner.query(`
				SELECT s."userId" AS user_id, s."epochId" AS epoch_id, s."mode" AS mode,
					s."initialGenerationState" AS initial_state,
					s."latestReadyBatchId" AS latest_ready_batch_id,
					s."generatingBatchId" AS generating_batch_id,
					s."latestSequence"::text AS latest_sequence,
					s."earliestRetainedSequence"::text AS earliest_retained_sequence,
					s."commonEpochId" AS common_epoch_id, s."commonHeadGenerationId" AS common_generation_id,
					s."commonHeadSequence"::text AS common_sequence
				FROM "hanami_user_feed_state" s WHERE s."userId" = $1 FOR UPDATE OF s
			`, [candidate.user_id]) as StateRow[];
			const state = states.at(0) ?? null;
			const epochs = await queryRunner.query(`
				SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
				FROM "hanami_user_feed_epoch" e
				WHERE e."userId" = $1 AND e."epochId" = $2 FOR UPDATE OF e
			`, [candidate.user_id, candidate.epoch_id]) as Array<{ epoch_id: string; retired_at: Date | string | null }>;
			const epoch = epochs.at(0) ?? null;
			const batches = await queryRunner.query(`
				SELECT b."id" AS id, b."userId" AS user_id, b."epochId" AS epoch_id,
					b."trigger" AS trigger, b."status" AS status, b."attempts" AS attempts,
					b."leaseOwner" AS lease_owner,
					COALESCE(b."leaseExpiresAt" > clock_timestamp(), FALSE) AS lease_is_live,
					b."availableAt" <= clock_timestamp() AS available_is_due,
					b."itemCount" AS item_count, b."baseCommonGenerationId" AS base_common_generation_id
				FROM "hanami_user_feed_batch" b WHERE b."id" = $1 FOR UPDATE OF b
			`, [candidate.id]) as BatchRow[];
			const batch = batches.at(0);
			if (batch == null || (batch.status !== 'pending' && batch.status !== 'generating')) return null;

			const common = await queryRunner.query(`
				SELECT g."status" AS status FROM "hanami_common_generation" g WHERE g."id" = $1
			`, [batch.base_common_generation_id]) as Array<{ status: string }>;
			const lifecycleValid = !user.is_hibernated && state != null && state.epoch_id === batch.epoch_id
				&& state.generating_batch_id === batch.id && epoch != null && epoch.retired_at == null && common.at(0)?.status === 'ready';
			if (!lifecycleValid) {
				await queryRunner.query(`
					UPDATE "hanami_user_feed_batch"
					SET "status" = 'obsolete', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "finishedAt" = clock_timestamp()
					WHERE "id" = $1 AND "status" IN ('pending', 'generating')
				`, [batch.id]);
				await queryRunner.query(`
					UPDATE "hanami_user_feed_state" SET "generatingBatchId" = NULL, "updatedAt" = clock_timestamp()
					WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" = $3
				`, [batch.user_id, batch.epoch_id, batch.id]);
				await queryRunner.query(`
					UPDATE "hanami_user_feed_refresh"
					SET "status" = 'obsolete', "resultMode" = NULL, "resultFeedEpochId" = NULL,
						"resultHeadBatchId" = NULL, "resultHeadSequence" = NULL
					WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
				`, [batch.user_id, batch.epoch_id, batch.id]);
				return 'obsolete';
			}

			if (batch.attempts >= this.config.hanamiGenerationMaxAttempts
				&& (batch.status === 'pending' || !batch.lease_is_live)) {
				const fallback = await this.requireFallbackHeadUnbounded(queryRunner, state);
				await queryRunner.query(`
					UPDATE "hanami_user_feed_batch"
					SET "status" = 'failed', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "finishedAt" = clock_timestamp()
					WHERE "id" = $1 AND "status" IN ('pending', 'generating')
				`, [batch.id]);
				await queryRunner.query(`
					UPDATE "hanami_user_feed_state"
					SET "generatingBatchId" = NULL,
						"initialGenerationState" = CASE
							WHEN "initialGenerationState" = 'requested' THEN 'failed'
							ELSE "initialGenerationState"
						END,
						"updatedAt" = clock_timestamp()
					WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" = $3
				`, [batch.user_id, batch.epoch_id, batch.id]);
				await this.failPendingMappingsUnbounded(queryRunner, batch.id, batch.user_id, batch.epoch_id, fallback);
				return 'failed';
			}

			if (batch.status === 'pending' && batch.available_is_due) return 'enqueue';
			if (batch.status === 'generating' && !batch.lease_is_live) return 'enqueue';
			return null;
		});
	}

	private async lockState(queryRunner: QueryRunner, budget: Budget, userId: string): Promise<StateRow | null> {
		const rows = await this.deadlineQuery(queryRunner, budget, `
			SELECT s."userId" AS user_id, s."epochId" AS epoch_id, s."mode" AS mode,
				s."initialGenerationState" AS initial_state,
				s."latestReadyBatchId" AS latest_ready_batch_id,
				s."generatingBatchId" AS generating_batch_id,
				s."latestSequence"::text AS latest_sequence,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence,
				s."commonEpochId" AS common_epoch_id, s."commonHeadGenerationId" AS common_generation_id,
				s."commonHeadSequence"::text AS common_sequence
			FROM "hanami_user_feed_state" s WHERE s."userId" = $1 FOR UPDATE OF s
		`, [userId]) as StateRow[];
		return rows.at(0) ?? null;
	}

	private async lockBatch(queryRunner: QueryRunner, budget: Budget, batchId: string): Promise<BatchRow | null> {
		const rows = await this.deadlineQuery(queryRunner, budget, `
			SELECT b."id" AS id, b."userId" AS user_id, b."epochId" AS epoch_id,
				b."trigger" AS trigger, b."status" AS status, b."attempts" AS attempts,
				b."leaseOwner" AS lease_owner,
				COALESCE(b."leaseExpiresAt" > clock_timestamp(), FALSE) AS lease_is_live,
				b."availableAt" <= clock_timestamp() AS available_is_due,
				b."itemCount" AS item_count, b."baseCommonGenerationId" AS base_common_generation_id
			FROM "hanami_user_feed_batch" b WHERE b."id" = $1 FOR UPDATE OF b
		`, [batchId]) as BatchRow[];
		return rows.at(0) ?? null;
	}

	private isExactLiveClaim(state: StateRow, batch: BatchRow | null, claim: Claim): batch is BatchRow {
		return batch != null && state.epoch_id === claim.epochId && state.generating_batch_id === claim.batchId
			&& batch.user_id === claim.userId && batch.epoch_id === claim.epochId
			&& batch.status === 'generating' && batch.lease_owner === claim.leaseOwner
			&& batch.attempts === claim.attempt && batch.lease_is_live
			&& batch.base_common_generation_id === claim.baseCommonGenerationId;
	}

	private async requireFallbackHead(queryRunner: QueryRunner, budget: Budget, state: StateRow): Promise<HanamiFeedHeadSnapshot> {
		if (state.latest_ready_batch_id != null && state.latest_sequence !== '0') {
			const rows = await this.deadlineQuery(queryRunner, budget, `
				SELECT b."id" AS id FROM "hanami_user_feed_batch" b
				WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
			`, [state.latest_ready_batch_id, state.user_id, state.epoch_id]) as Array<{ id: string }>;
			if (rows.length === 1) return this.personalHead(state);
		}
		if (state.common_epoch_id != null && state.common_generation_id != null && state.common_sequence != null) {
			const rows = await this.deadlineQuery(queryRunner, budget, `
				SELECT g."id" AS id FROM "hanami_common_generation" g WHERE g."id" = $1 AND g."status" = 'ready'
			`, [state.common_generation_id]) as Array<{ id: string }>;
			if (rows.length === 1) return this.commonHead(state);
		}
		throw new Error(`Hanami user ${state.user_id} has no immutable failure fallback`);
	}

	private async requireFallbackHeadUnbounded(queryRunner: QueryRunner, state: StateRow): Promise<HanamiFeedHeadSnapshot> {
		if (state.latest_ready_batch_id != null && state.latest_sequence !== '0') {
			const rows = await queryRunner.query(`
				SELECT b."id" AS id FROM "hanami_user_feed_batch" b
				WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
			`, [state.latest_ready_batch_id, state.user_id, state.epoch_id]) as Array<{ id: string }>;
			if (rows.length === 1) return this.personalHead(state);
		}
		if (state.common_epoch_id != null && state.common_generation_id != null && state.common_sequence != null) {
			const rows = await queryRunner.query(`
				SELECT g."id" AS id FROM "hanami_common_generation" g WHERE g."id" = $1 AND g."status" = 'ready'
			`, [state.common_generation_id]) as Array<{ id: string }>;
			if (rows.length === 1) return this.commonHead(state);
		}
		throw new Error(`Hanami user ${state.user_id} has no immutable failure fallback`);
	}

	private personalHead(state: StateRow): HanamiFeedHeadSnapshot {
		return { mode: 'personalized', kind: 'personal', feedEpochId: state.epoch_id,
			headBatchId: state.latest_ready_batch_id!, headSequence: state.latest_sequence };
	}

	private commonHead(state: StateRow): HanamiFeedHeadSnapshot {
		return { mode: 'common', kind: 'common', feedEpochId: state.common_epoch_id!,
			headBatchId: state.common_generation_id!, headSequence: state.common_sequence! };
	}

	private async failPendingMappings(
		queryRunner: QueryRunner,
		budget: Budget,
		batchId: string,
		userId: string,
		epochId: string,
		fallback: HanamiFeedHeadSnapshot,
	): Promise<void> {
		await this.deadlineQuery(queryRunner, budget, `
			UPDATE "hanami_user_feed_refresh"
			SET "status" = 'failed', "resultMode" = $4, "resultFeedEpochId" = $5,
				"resultHeadBatchId" = $6, "resultHeadSequence" = $7::bigint
			WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
		`, [userId, epochId, batchId, fallback.mode, fallback.feedEpochId, fallback.headBatchId, fallback.headSequence]);
	}

	private async failPendingMappingsUnbounded(
		queryRunner: QueryRunner,
		batchId: string,
		userId: string,
		epochId: string,
		fallback: HanamiFeedHeadSnapshot,
	): Promise<void> {
		await queryRunner.query(`
			UPDATE "hanami_user_feed_refresh"
			SET "status" = 'failed', "resultMode" = $4, "resultFeedEpochId" = $5,
				"resultHeadBatchId" = $6, "resultHeadSequence" = $7::bigint
			WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
		`, [userId, epochId, batchId, fallback.mode, fallback.feedEpochId, fallback.headBatchId, fallback.headSequence]);
	}

	private validateComputation(result: HanamiPersonalFeedComputationResult): void {
		if (result == null || (result.confidence !== 'high' && result.confidence !== 'low' && result.confidence !== 'none')) {
			throw new Error('Hanami personal computation has invalid confidence');
		}
		if (!Array.isArray(result.items) || result.items.length > MAX_ITEMS) throw new Error(`Hanami personal computation exceeds ${MAX_ITEMS} items`);
		if (!Array.isArray(result.segmentLengths) || result.segmentLengths.length > MAX_SEGMENTS) throw new Error('Hanami personal computation has invalid segments');
		let segmentTotal = 0;
		for (const length of result.segmentLengths) {
			if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_SEGMENT_ITEMS) throw new Error('Hanami personal segment length must be in 1..30');
			segmentTotal += length;
		}
		if (segmentTotal !== result.items.length) throw new Error('Hanami personal segment lengths do not match item count');
		if (result.items.length > 0 && result.segmentLengths.length === 0) throw new Error('Hanami personal computation is missing segments');

		const noteIds = new Set<string>();
		for (const item of result.items) {
			this.validateItem(item);
			if (noteIds.has(item.noteId)) throw new Error(`Hanami personal computation contains duplicate Note ${item.noteId}`);
			noteIds.add(item.noteId);
		}
	}

	private validateItem(item: HanamiPersonalFeedItem): void {
		if (item == null || typeof item.noteId !== 'string' || item.noteId.length === 0) throw new Error('Hanami personal item has invalid noteId');
		if (!AXES.has(item.source)) throw new Error(`Hanami personal item has invalid source ${String(item.source)}`);
		if (!Array.isArray(item.sources) || item.sources.length === 0) throw new Error('Hanami personal item sources must be nonempty');
		const sources = new Set<string>();
		for (const source of item.sources) {
			if (!AXES.has(source) || sources.has(source)) throw new Error(`Hanami personal item has invalid or duplicate source ${String(source)}`);
			sources.add(source);
		}
		if (!sources.has(item.source)) throw new Error('Hanami personal primary source is not in sources');
		if (item.origin !== 'commonCandidate' && item.origin !== 'personalCandidate') throw new Error('Hanami personal item has invalid origin');
		const reason = item.reasonMetadata;
		if (reason == null || (reason.version !== 1 && reason.version !== 2)) throw new Error('Hanami personal item has invalid reason metadata');
		if (reason.term != null && typeof reason.term !== 'string') throw new Error('Hanami personal item has invalid reason term');
		if (reason.clusterId != null && (!Number.isSafeInteger(reason.clusterId) || reason.clusterId < 0)) throw new Error('Hanami personal item has invalid clusterId');
		if (reason.bucket != null && reason.bucket !== 'cluster' && reason.bucket !== 'recent') throw new Error('Hanami personal item has invalid reason bucket');
		if (reason.fallbackOverflow != null && reason.fallbackOverflow !== true) throw new Error('Hanami personal item has invalid fallbackOverflow');
		if (reason.version === 2 && reason.qualityShadow != null) {
			const shadow = reason.qualityShadow;
			if (!['directFollow', 'known', 'unknown'].includes(shadow.relationshipClass)
				|| (shadow.standaloneValue !== null && typeof shadow.standaloneValue !== 'boolean')
				|| (shadow.socialOnly !== null && typeof shadow.socialOnly !== 'boolean')) throw new Error('Hanami personal item has invalid quality shadow');
		}
	}

	private remainingBudgetMs(budget: Budget): number {
		return Math.max(0, Math.floor(budget.monotonicDeadline - performance.now()));
	}

	private assertBudget(budget: Budget): void {
		if (!budget.controller.signal.aborted && this.remainingBudgetMs(budget) <= 0) budget.controller.abort(budget.timeoutError);
		if (budget.controller.signal.aborted) throw budget.controller.signal.reason;
	}

	private forkRemainingBudget(source: Budget): Budget | null {
		const remainingMs = this.remainingBudgetMs(source);
		if (remainingMs <= 0) return null;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(source.timeoutError), remainingMs);
		return { controller, monotonicDeadline: source.monotonicDeadline, databaseDeadlineAt: source.databaseDeadlineAt,
			timeoutError: source.timeoutError, dispose: () => clearTimeout(timer) };
	}

	private databaseDeadlineAt(budget: Budget): string {
		if (budget.databaseDeadlineAt == null) throw new Error('Hanami user generation database deadline is not established');
		return budget.databaseDeadlineAt;
	}

	private async waitForBudget<T>(promise: Promise<T>, budget: Budget): Promise<T> {
		const signal = budget.controller.signal;
		const remainingMs = this.remainingBudgetMs(budget);
		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (operation: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				operation();
			};
			const onAbort = (): void => finish(() => reject(signal.reason));
			const timer = setTimeout(() => {
				if (!signal.aborted) budget.controller.abort(budget.timeoutError);
			}, Math.max(1, remainingMs));
			signal.addEventListener('abort', onAbort, { once: true });
			void promise.then((value) => {
				try {
					this.assertBudget(budget);
					finish(() => resolve(value));
				} catch (error) {
					finish(() => reject(error));
				}
			}, (error) => {
				try {
					this.assertBudget(budget);
					finish(() => reject(error));
				} catch (budgetError) {
					finish(() => reject(budgetError));
				}
			});
			if (!signal.aborted && remainingMs <= 0) budget.controller.abort(budget.timeoutError);
			if (signal.aborted) onAbort();
		});
	}

	private async runWithBudget<T>(budget: Budget, operation: () => Promise<T>): Promise<T> {
		this.assertBudget(budget);
		return await this.waitForBudget(operation(), budget);
	}

	private async establishDatabaseDeadline(queryRunner: QueryRunner, budget: Budget): Promise<void> {
		if (budget.databaseDeadlineAt != null) return;
		const remainingMs = this.remainingBudgetMs(budget);
		this.assertBudget(budget);
		const rows = await this.runWithBudget(budget, async () => await queryRunner.query(`
			SELECT to_char((clock_timestamp() + ($1::text || ' milliseconds')::interval) AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_at
		`, [String(Math.max(1, remainingMs - 1))]) as Array<{ deadline_at: string }>);
		const deadlineAt = rows.at(0)?.deadline_at;
		if (typeof deadlineAt !== 'string' || Number.isNaN(Date.parse(deadlineAt))) throw new Error('Invalid Hanami database deadline');
		budget.databaseDeadlineAt = deadlineAt;
	}

	private async configureDeadline(queryRunner: QueryRunner, budget: Budget): Promise<void> {
		const rows = await this.runWithBudget(budget, async () => await queryRunner.query(`
			WITH budget AS (
				SELECT FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)::bigint - 1 AS remaining_ms
			)
			SELECT set_config('statement_timeout', budget.remaining_ms::text || 'ms', TRUE),
				set_config('lock_timeout', budget.remaining_ms::text || 'ms', TRUE)
			FROM budget WHERE budget.remaining_ms > 0
		`, [this.databaseDeadlineAt(budget)]) as unknown[]);
		if (rows.length !== 1) {
			if (!budget.controller.signal.aborted) budget.controller.abort(budget.timeoutError);
			throw budget.timeoutError;
		}
	}

	private async deadlineQuery<T extends unknown[] = unknown[]>(queryRunner: QueryRunner, budget: Budget, sql: string, values: unknown[] = []): Promise<T> {
		await this.configureDeadline(queryRunner, budget);
		return await this.runWithBudget(budget, async () => await queryRunner.query(sql, values) as T);
	}

	private async withDeadlineTransaction<T>(budget: Budget, callback: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
		const queryRunner = this.db.createQueryRunner();
		let connected = false;
		let transactionStarted = false;
		let hasPrimaryError = false;
		let primaryError: unknown;
		let result: T | undefined;
		let connectPromise: Promise<void> | undefined;
		let connectSettled = false;
		let startPromise: Promise<void> | undefined;
		let startSettled = false;
		let commitPromise: Promise<void> | undefined;
		let commitSettled = false;
		let releasePromise: Promise<void> | undefined;
		let releaseSettled = false;

		try {
			this.assertBudget(budget);
			connectPromise = Promise.resolve(queryRunner.connect());
			void connectPromise.then(() => { connectSettled = true; }, () => { connectSettled = true; });
			await this.waitForBudget(connectPromise, budget);
			connected = true;

			this.assertBudget(budget);
			startPromise = Promise.resolve(queryRunner.startTransaction());
			void startPromise.then(() => { startSettled = true; }, () => { startSettled = true; });
			await this.waitForBudget(startPromise, budget);
			transactionStarted = true;

			await this.establishDatabaseDeadline(queryRunner, budget);
			await this.configureDeadline(queryRunner, budget);
			result = await this.runWithBudget(budget, () => callback(queryRunner));
			await this.configureDeadline(queryRunner, budget);

			this.assertBudget(budget);
			commitPromise = Promise.resolve(queryRunner.commitTransaction());
			void commitPromise.then(() => { commitSettled = true; }, () => { commitSettled = true; });
			await this.waitForBudget(commitPromise, budget);
			transactionStarted = false;

			this.assertBudget(budget);
			releasePromise = Promise.resolve(queryRunner.release());
			void releasePromise.then(() => { releaseSettled = true; }, () => { releaseSettled = true; });
			await this.waitForBudget(releasePromise, budget);
			connected = false;
		} catch (error) {
			hasPrimaryError = true;
			primaryError = error;
		}

		if (hasPrimaryError) {
			if (connectPromise != null && !connectSettled && !connected) {
				this.scheduleLateQueryRunnerCleanup(queryRunner, connectPromise, false, primaryError);
			} else if (startPromise != null && !startSettled && connected && !transactionStarted) {
				this.scheduleLateQueryRunnerCleanup(queryRunner, startPromise, true, primaryError);
			} else if (commitPromise != null && !commitSettled && transactionStarted) {
				this.scheduleLateQueryRunnerCleanup(queryRunner, commitPromise, false, primaryError, true);
			} else if (releasePromise != null && !releaseSettled) {
				void releasePromise.catch((lateReleaseError) => this.attachCleanupError(primaryError, lateReleaseError));
			} else {
				await this.runBoundedQueryRunnerCleanup(
					queryRunner,
					transactionStarted || queryRunner.isTransactionActive,
					budget,
					primaryError,
				);
			}
			throw primaryError;
		}

		if (connected) throw new Error('Hanami user generation deadline transaction did not release its query runner');
		return result as T;
	}

	private scheduleLateQueryRunnerCleanup(
		queryRunner: QueryRunner,
		pending: Promise<void>,
		rollbackAfterSuccess: boolean,
		primaryError: unknown,
		commitPhase = false,
	): void {
		void pending.then(async () => {
			await this.cleanupQueryRunner(queryRunner, rollbackAfterSuccess, primaryError);
		}, async (lateDriverError) => {
			this.attachCleanupError(primaryError, lateDriverError);
			await this.cleanupQueryRunner(queryRunner, commitPhase || queryRunner.isTransactionActive, primaryError);
		}).catch((lateCleanupError) => this.attachCleanupError(primaryError, lateCleanupError));
	}

	private async runBoundedQueryRunnerCleanup(
		queryRunner: QueryRunner,
		rollback: boolean,
		budget: Budget,
		primaryError: unknown,
	): Promise<void> {
		const cleanup = this.cleanupQueryRunner(queryRunner, rollback, primaryError);
		if (budget.controller.signal.aborted || this.remainingBudgetMs(budget) <= 0) {
			void cleanup;
			return;
		}
		try {
			await this.waitForBudget(cleanup, budget);
		} catch (cleanupError) {
			this.attachCleanupError(primaryError, cleanupError);
		}
	}

	private async cleanupQueryRunner(queryRunner: QueryRunner, rollback: boolean, primaryError: unknown): Promise<void> {
		if (rollback) {
			try {
				await queryRunner.rollbackTransaction();
			} catch (rollbackError) {
				this.attachCleanupError(primaryError, rollbackError);
			}
		}
		try {
			await queryRunner.release();
		} catch (releaseError) {
			this.attachCleanupError(primaryError, releaseError);
		}
	}

	private attachCleanupError(primaryError: unknown, cleanupError: unknown): void {
		try {
			if (primaryError instanceof Error) {
				const target = primaryError as Error & { cleanupErrors?: unknown[] };
				target.cleanupErrors = [...(target.cleanupErrors ?? []), cleanupError];
			}
		} catch {
			// Cleanup diagnostics must never replace the primary failure.
		}
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

	private toIsoString(value: Date | string, name: string): string {
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
		return typeof value === 'string' ? value : date.toISOString();
	}

	private canonicalJson(value: unknown): string {
		const encode = (item: unknown, ancestors: Set<object>): string => {
			if (item === null) return 'null';
			if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
			if (typeof item === 'number') {
				if (!Number.isFinite(item)) throw new Error('Cannot checksum a non-finite number');
				return JSON.stringify(item);
			}
			if (typeof item !== 'object') throw new Error('Cannot checksum a non-JSON value');
			if (ancestors.has(item)) throw new Error('Cannot checksum cyclic JSON');
			ancestors.add(item);
			const encoded = Array.isArray(item)
				? `[${item.map((entry) => encode(entry, ancestors)).join(',')}]`
				: `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], ancestors)}`).join(',')}}`;
			ancestors.delete(item);
			return encoded;
		};
		return encode(value, new Set<object>());
	}
}
