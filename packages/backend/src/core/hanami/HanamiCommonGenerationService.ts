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
import {
	HANAMI_COMMON_AXES,
	HANAMI_COMMON_COMPUTATION,
	type HanamiCommonAxis,
	type HanamiCommonComputationPort,
	type HanamiCommonGenerationDispatch,
	type HanamiCommonGenerationLifecyclePort,
	type HanamiCommonGenerationReadContext,
	type HanamiCommonGenerationReadPort,
	type HanamiCommonGenerationRequestResult,
	type HanamiCommonGenerationRunResult,
	type HanamiCommonSourceBundle,
	type HanamiCommonTrigger,
	type HanamiPersistedCommonCandidate,
	type HanamiReadyCommonHead,
} from './HanamiCommonGenerationContracts.js';
import { HanamiTimelinePartitionService } from './HanamiTimelinePartitionService.js';
import { HanamiForYouSafetyService } from './HanamiForYouSafetyService.js';
import type { DataSource, QueryRunner } from 'typeorm';

const COMMON_STATE_ID = 'singleton';
const COMMON_GENERATION_ADVISORY_LOCK = 'hanami.timeline.common-generation';
const MAX_COMMON_ITEMS = 210;
const MAX_SEGMENTS = 7;
const MAX_SEGMENT_ITEMS = 30;
const MAX_TREND_TERMS = 30;
const MAX_TREND_REPRESENTATIVES = 5;
const CANDIDATE_LIMITS: Readonly<Record<HanamiCommonAxis, number>> = {
	globalPopular: 200,
	trending: 200,
	exploration: 500,
};
const AXIS_ORDER = new Map<HanamiCommonAxis, number>(HANAMI_COMMON_AXES.map((axis, index) => [axis, index]));

type CommonStateRow = {
	epoch_id: string | null;
	latest_sequence: string;
	earliest_retained_sequence: string;
	latest_ready_generation_id: string | null;
	generating_generation_id: string | null;
	generation_lease_owner: string | null;
	generation_lease_expires_at: Date | string | null;
	generation_fence: string;
	lease_is_live: boolean;
};

type CommonGenerationRow = {
	status: 'pending' | 'generating' | 'ready' | 'failed' | 'obsolete';
	ordinal: string;
	started_at: string;
	generation_fence: string;
};

type ClaimResult = HanamiCommonGenerationRunResult | {
	kind: 'claimed';
	generationId: string;
	generationFence: string;
	leaseOwner: string;
	startedAt: string;
	epochId: string | null;
};

type GenerationBudget = {
	controller: AbortController;
	monotonicDeadline: number;
	databaseDeadlineAt?: string;
	timeoutError: Error;
	dispose: () => void;
};

type WorkerLease = GenerationBudget & {
	startHeartbeat: (claim: Extract<ClaimResult, { kind: 'claimed' }>) => void;
	stopHeartbeat: () => void;
};

type CandidateInsertRow = {
	axis: HanamiCommonAxis;
	rank: string;
	noteId: string;
	baseScore: number;
	metadata: Readonly<Record<string, unknown>>;
};

type PreparedPublication = {
	checksum: string;
	epochId: string;
	feedEntryIds: string[];
	trendEntryIds: string[];
};

type PublishResult = {
	kind: 'published';
} | {
	kind: 'obsolete';
};

type FailureResolution = {
	kind: 'failed' | 'stale';
} | {
	kind: 'ready';
	generationFence: string;
	itemCount: number;
};

class HanamiCommonLeaseLostError extends Error {
	constructor() {
		super('Hanami common generation lease is no longer current');
	}
}

@Injectable()
export class HanamiCommonGenerationService implements HanamiCommonGenerationLifecyclePort, HanamiCommonGenerationReadPort {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.config)
		private config: Config,

		private idService: IdService,
		private partitionService: HanamiTimelinePartitionService,
		private safetyService: HanamiForYouSafetyService,

		@Inject(HANAMI_COMMON_COMPUTATION)
		private computation: HanamiCommonComputationPort,
	) {}

	@bindThis
	public async requestCommonGeneration(trigger: HanamiCommonTrigger): Promise<HanamiCommonGenerationRequestResult> {
		return await this.withTransaction(async (queryRunner) => {
			await queryRunner.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('${COMMON_GENERATION_ADVISORY_LOCK}', 0))`);
			await queryRunner.query(`
				INSERT INTO "hanami_common_feed_state" (
					"singletonId", "epochId", "latestSequence", "earliestRetainedSequence",
					"latestReadyGenerationId", "generatingGenerationId", "generationLeaseOwner",
					"generationLeaseExpiresAt", "generationFence", "updatedAt"
				)
				VALUES ($1, NULL, '0'::bigint, '0'::bigint, NULL, NULL, NULL, NULL, '0'::bigint, clock_timestamp())
				ON CONFLICT ("singletonId") DO NOTHING
			`, [COMMON_STATE_ID]);

			const state = await this.lockCommonState(queryRunner);
			if (state == null) throw new Error('Hanami common feed state bootstrap did not create the singleton');

			if (state.generating_generation_id != null) {
				return { kind: 'noop', reason: 'active' };
			}

			if (trigger === 'seed' && state.latest_ready_generation_id != null) {
				return { kind: 'noop', reason: 'alreadySeeded' };
			}

			if (trigger === 'scheduled') {
				const dueRows = await queryRunner.query(`
					SELECT COALESCE((
						SELECT floor(EXTRACT(EPOCH FROM g."startedAt") * 1000 / $1::numeric)
							< floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 / $1::numeric)
						FROM "hanami_common_generation" g
						ORDER BY g."ordinal" DESC
						LIMIT 1
					), TRUE) AS due
				`, [String(this.config.hanamiCommonGenerationIntervalMs)]) as Array<{ due: boolean }>;
				if (dueRows[0]?.due !== true) return { kind: 'noop', reason: 'notDue' };
			}

			const ordinalRows = await queryRunner.query(`
				SELECT (COALESCE(MAX(g."ordinal"), '0'::bigint) + '1'::bigint)::text AS ordinal
				FROM "hanami_common_generation" g
			`) as Array<{ ordinal: string }>;
			const ordinal = ordinalRows.at(0)?.ordinal;
			if (ordinal == null) throw new Error('Failed to allocate a Hanami common generation ordinal');

			const generationId = this.idService.gen();
			const snapshotId = this.idService.gen();
			await queryRunner.query(`
				WITH inserted_generation AS (
					INSERT INTO "hanami_common_generation" (
						"id", "ordinal", "status", "startedAt", "finishedAt", "algorithmVersion",
						"checksum", "sourceAsOf", "generationFence"
					)
					VALUES ($1, $2::bigint, 'pending', clock_timestamp(), NULL, $3, NULL, '{}'::jsonb, $4::bigint)
					RETURNING "startedAt"
				)
				INSERT INTO "hanami_trend_snapshot" (
					"id", "ordinal", "status", "generatedAt", "itemCount", "commonGenerationId"
				)
				SELECT $5, $2::bigint, 'pending', inserted_generation."startedAt", 0, $1
				FROM inserted_generation
			`, [generationId, ordinal, this.computation.algorithmVersion, state.generation_fence, snapshotId]);

			const pointerRows = hanamiReturningRows(await queryRunner.query(`
				UPDATE "hanami_common_feed_state"
				SET "generatingGenerationId" = $2,
					"generationLeaseOwner" = NULL,
					"generationLeaseExpiresAt" = NULL,
					"updatedAt" = clock_timestamp()
				WHERE "singletonId" = $1
					AND "generatingGenerationId" IS NULL
				RETURNING "generationFence"::text AS generation_fence
			`, [COMMON_STATE_ID, generationId]) as Array<{ generation_fence: string }>);
			if (pointerRows.length !== 1) throw new Error('Failed to install the Hanami common generation pointer');

			return { kind: 'dispatch', generationId };
		});
	}

	@bindThis
	public async findDispatchableCommonGeneration(): Promise<HanamiCommonGenerationDispatch | null> {
		const rows = await this.db.query(`
			SELECT s."generatingGenerationId" AS generation_id,
				CASE WHEN g."status" = 'pending' THEN 'pending' ELSE 'leaseExpired' END AS reason
			FROM "hanami_common_feed_state" s
			JOIN "hanami_common_generation" g ON g."id" = s."generatingGenerationId"
			WHERE s."singletonId" = $1
				AND (
					(g."status" = 'pending'
						AND s."generationLeaseOwner" IS NULL
						AND s."generationLeaseExpiresAt" IS NULL)
					OR
					(g."status" = 'generating'
						AND s."generationLeaseOwner" IS NOT NULL
						AND s."generationLeaseExpiresAt" IS NOT NULL
						AND s."generationLeaseExpiresAt" <= clock_timestamp())
				)
			LIMIT 1
		`, [COMMON_STATE_ID]) as Array<{ generation_id: string; reason: 'pending' | 'leaseExpired' }>;

		const row = rows.at(0);
		return row == null ? null : { generationId: row.generation_id, reason: row.reason };
	}

	@bindThis
	public async runCommonGeneration(generationId: string): Promise<HanamiCommonGenerationRunResult> {
		const workerLease = this.startWorkerLease(generationId);
		let claim: Extract<ClaimResult, { kind: 'claimed' }> | undefined;
		try {
			const claimResult = await this.claimGeneration(generationId, workerLease);
			this.assertOperationBudget(workerLease);
			if (claimResult.kind !== 'claimed') return claimResult;
			claim = claimResult;
			const activeClaim = claimResult;
			workerLease.startHeartbeat(activeClaim);

			const generatedMonth = this.utcMonthStart(activeClaim.startedAt);
			await this.runWithOperationBudget(workerLease, () => this.partitionService.ensureMonthAvailable(generatedMonth, {
				signal: workerLease.controller.signal,
				databaseDeadlineAt: this.databaseDeadlineAt(workerLease),
			}));
			this.assertOperationBudget(workerLease);

			const source = await this.runWithOperationBudget(workerLease, () => this.computation.buildSourceBundle({
				generationId,
				generationFence: activeClaim.generationFence,
				generatedAt: activeClaim.startedAt,
				signal: workerLease.controller.signal,
			}));
			this.assertOperationBudget(workerLease);
			const candidateRows = this.validateSourceBundle(source);
			await this.runWithOperationBudget(workerLease, () => this.validateSnapshotRepresentativeEligibility(source));
			this.assertOperationBudget(workerLease);

			const recentCommonNoteIds = await this.runWithOperationBudget(workerLease, () => this.loadRecentCommonNoteIds(activeClaim.startedAt));
			this.assertOperationBudget(workerLease);
			const materialization = this.computation.materializeFeed({ source, recentCommonNoteIds });
			this.assertOperationBudget(workerLease);
			this.validateMaterialization(source, materialization);

			await this.stageCandidates(activeClaim, generatedMonth, source, candidateRows, workerLease);
			this.assertOperationBudget(workerLease);

			const prepared = this.preparePublication(activeClaim, source, materialization);
			const publication = await this.publishGeneration(activeClaim, generatedMonth, source, materialization, candidateRows, prepared, workerLease);
			if (publication.kind === 'obsolete') return { kind: 'stale', generationId };

			return {
				kind: 'published',
				generationId,
				generationFence: activeClaim.generationFence,
				itemCount: materialization.items.length,
			};
		} catch (primaryError) {
			workerLease.stopHeartbeat();
			if (claim == null) throw primaryError;
			if (primaryError === workerLease.timeoutError
				|| (workerLease.controller.signal.aborted && workerLease.controller.signal.reason === workerLease.timeoutError)) {
				throw workerLease.timeoutError;
			}
			const failureBudget = this.forkRemainingBudget(workerLease);
			if (failureBudget == null) throw primaryError;
			let resolution: FailureResolution;
			try {
				resolution = await this.resolveFailure(claim, failureBudget);
			} catch (failureError) {
				this.attachCleanupError(primaryError, failureError);
				throw primaryError;
			} finally {
				failureBudget.dispose();
			}

			if (resolution.kind === 'ready') {
				return {
					kind: 'published',
					generationId,
					generationFence: resolution.generationFence,
					itemCount: resolution.itemCount,
				};
			}
			if (resolution.kind === 'stale') return { kind: 'stale', generationId };

			throw primaryError;
		} finally {
			workerLease.dispose();
		}
	}

	@bindThis
	public async getLatestReadyCommonHead(): Promise<HanamiReadyCommonHead | null> {
		const rows = await this.db.query(`
			SELECT s."epochId" AS epoch_id,
				s."latestReadyGenerationId" AS generation_id,
				g."ordinal"::text AS generation_ordinal,
				g."generationFence"::text AS generation_fence,
				s."latestSequence"::text AS latest_sequence,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence
			FROM "hanami_common_feed_state" s
			JOIN "hanami_common_generation" g
				ON g."id" = s."latestReadyGenerationId" AND g."status" = 'ready'
			WHERE s."singletonId" = $1 AND s."epochId" IS NOT NULL
			LIMIT 1
		`, [COMMON_STATE_ID]) as Array<{
			epoch_id: string;
			generation_id: string;
			generation_ordinal: string;
			generation_fence: string;
			latest_sequence: string;
			earliest_retained_sequence: string;
		}>;
		const row = rows.at(0);
		if (row == null) return null;

		return {
			epochId: row.epoch_id,
			generationId: row.generation_id,
			generationOrdinal: row.generation_ordinal,
			generationFence: row.generation_fence,
			latestSequence: row.latest_sequence,
			earliestRetainedSequence: row.earliest_retained_sequence,
		};
	}

	@bindThis
	public async loadReadyCommonCandidates(
		generationId: string,
		context?: HanamiCommonGenerationReadContext,
	): Promise<readonly HanamiPersistedCommonCandidate[]> {
		context?.signal.throwIfAborted();
		const query = context?.queryRunner ?? this.db;
		const rows = await query.query(`
			SELECT c."axis" AS axis,
				c."rank"::text AS rank,
				c."noteId" AS note_id,
				c."baseScore" AS base_score,
				c."metadata" AS metadata
			FROM "hanami_common_generation" g
			JOIN "hanami_common_candidate" c
				ON c."generatedMonth" = date_trunc('month', g."startedAt")::date
				AND c."generationId" = g."id"
				AND c."generationFence" = g."generationFence"
			WHERE g."id" = $1 AND g."status" = 'ready'
			ORDER BY CASE c."axis"
				WHEN 'globalPopular' THEN 0
				WHEN 'trending' THEN 1
				WHEN 'exploration' THEN 2
				ELSE 3
			END, c."rank" ASC
		`, [generationId]) as Array<{
			axis: HanamiCommonAxis;
			rank: string;
			note_id: string;
			base_score: number;
			metadata: Readonly<Record<string, unknown>>;
		}>;
		context?.signal.throwIfAborted();

		return rows.map((row) => ({
			axis: row.axis,
			rank: row.rank,
			noteId: row.note_id,
			baseScore: row.base_score,
			metadata: row.metadata,
		}));
	}

	private async claimGeneration(generationId: string, workerLease: WorkerLease): Promise<ClaimResult> {
		return await this.withDeadlineTransaction(workerLease, async (queryRunner) => {
			const state = await this.lockCommonState(queryRunner, workerLease);
			const generationRows = await this.deadlineQuery<CommonGenerationRow[]>(queryRunner, workerLease, `
				SELECT g."status" AS status,
					g."ordinal"::text AS ordinal,
					to_char(g."startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
					g."generationFence"::text AS generation_fence
				FROM "hanami_common_generation" g
				WHERE g."id" = $1
				FOR UPDATE
			`, [generationId]);
			const generation = generationRows.at(0);
			if (generation == null) return { kind: 'notClaimed', generationId, reason: 'notCurrent' };
			if (generation.status === 'ready') return { kind: 'alreadyReady', generationId };
			if (generation.status === 'failed' || generation.status === 'obsolete') {
				return { kind: 'notClaimed', generationId, reason: 'terminal' };
			}
			if (state == null || state.generating_generation_id !== generationId) {
				return { kind: 'notClaimed', generationId, reason: 'notCurrent' };
			}
			if (state.lease_is_live) return { kind: 'notClaimed', generationId, reason: 'leased' };

			const pendingClaim = generation.status === 'pending'
				&& state.generation_lease_owner == null
				&& state.generation_lease_expires_at == null;
			const expiredReclaim = generation.status === 'generating'
				&& state.generation_lease_owner != null
				&& state.generation_lease_expires_at != null;
			if (!pendingClaim && !expiredReclaim) {
				return { kind: 'notClaimed', generationId, reason: 'notCurrent' };
			}

			const leaseOwner = randomUUID();
			const stateRows = hanamiReturningRows(await this.deadlineQuery<Array<{ generation_fence: string; epoch_id: string | null }>>(queryRunner, workerLease, `
				UPDATE "hanami_common_feed_state"
				SET "generationFence" = "generationFence" + '1'::bigint,
					"generationLeaseOwner" = $3,
					"generationLeaseExpiresAt" = clock_timestamp() + ($4::text || ' milliseconds')::interval,
					"updatedAt" = clock_timestamp()
				WHERE "singletonId" = $1
					AND "generatingGenerationId" = $2
					AND "generationFence" = $5::bigint
					AND (
						($6 = 'pending' AND "generationLeaseOwner" IS NULL AND "generationLeaseExpiresAt" IS NULL)
						OR
						($6 = 'expired' AND "generationLeaseOwner" IS NOT NULL
							AND "generationLeaseExpiresAt" IS NOT NULL
							AND "generationLeaseExpiresAt" <= clock_timestamp())
					)
				RETURNING "generationFence"::text AS generation_fence, "epochId" AS epoch_id
			`, [
				COMMON_STATE_ID,
				generationId,
				leaseOwner,
				String(this.config.hanamiGenerationLeaseMs),
				state.generation_fence,
				pendingClaim ? 'pending' : 'expired',
			]));
			const claimedState = stateRows.at(0);
			if (claimedState == null) return { kind: 'notClaimed', generationId, reason: 'leased' };

			const claimedGenerationRows = hanamiReturningRows(await this.deadlineQuery<Array<{
				started_at: string;
				generation_fence: string;
			}>>(queryRunner, workerLease, `
				UPDATE "hanami_common_generation"
				SET "status" = 'generating',
					"generationFence" = $2::bigint,
					"algorithmVersion" = $3
				WHERE "id" = $1 AND "status" = $4
				RETURNING to_char("startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
					"generationFence"::text AS generation_fence
			`, [generationId, claimedState.generation_fence, this.computation.algorithmVersion, generation.status]));
			const claimedGeneration = claimedGenerationRows.at(0);
			if (claimedGeneration == null) throw new Error('Failed to move the claimed Hanami common generation to generating');

			return {
				kind: 'claimed',
				generationId,
				generationFence: claimedGeneration.generation_fence,
				leaseOwner,
				startedAt: this.toIsoString(claimedGeneration.started_at, 'generation startedAt'),
				epochId: claimedState.epoch_id,
			};
		});
	}

	private startWorkerLease(generationId: string): WorkerLease {
		const controller = new AbortController();
		const timeoutError = new Error(`Hanami common generation ${generationId} exceeded its worker timeout`);
		const monotonicDeadline = performance.now() + this.config.hanamiGenerationWorkerTimeoutMs;
		let stopped = false;
		let heartbeatTimer: NodeJS.Timeout | undefined;

		const abort = (error: unknown): void => {
			if (!controller.signal.aborted) controller.abort(error);
		};
		const timeoutTimer = setTimeout(() => abort(timeoutError), this.config.hanamiGenerationWorkerTimeoutMs);
		const cadenceMs = Math.max(1, Math.min(
			this.config.hanamiGenerationLeaseMs / 3,
			this.config.hanamiGenerationWorkerTimeoutMs / 2,
		));

		let heartbeatClaim: Extract<ClaimResult, { kind: 'claimed' }> | undefined;
		const scheduleHeartbeat = (): void => {
			const claim = heartbeatClaim;
			if (stopped || controller.signal.aborted || claim == null) return;
			heartbeatTimer = setTimeout(() => {
				heartbeatTimer = undefined;
				void this.heartbeatGeneration(claim, workerLease).then((extended) => {
					if (!extended) abort(new HanamiCommonLeaseLostError());
				}, abort).finally(scheduleHeartbeat);
			}, cadenceMs);
		};
		const startHeartbeat = (claim: Extract<ClaimResult, { kind: 'claimed' }>): void => {
			heartbeatClaim = claim;
			scheduleHeartbeat();
		};

		const stopHeartbeat = (): void => {
			stopped = true;
			if (heartbeatTimer != null) clearTimeout(heartbeatTimer);
			heartbeatTimer = undefined;
		};

		const workerLease: WorkerLease = {
			controller,
			monotonicDeadline,
			timeoutError,
			startHeartbeat,
			stopHeartbeat,
			dispose: () => {
				stopHeartbeat();
				clearTimeout(timeoutTimer);
			},
		};
		return workerLease;
	}

	private async heartbeatGeneration(claim: Extract<ClaimResult, { kind: 'claimed' }>, budget: GenerationBudget): Promise<boolean> {
		const rows = await this.runWithOperationBudget(budget, async () => hanamiReturningRows(await this.db.query(`
			UPDATE "hanami_common_feed_state" s
			SET "generationLeaseExpiresAt" = clock_timestamp() + ($5::text || ' milliseconds')::interval,
				"updatedAt" = clock_timestamp()
			WHERE s."singletonId" = $1
				AND s."generatingGenerationId" = $2
				AND s."generationLeaseOwner" = $3
				AND s."generationFence" = $4::bigint
				AND s."generationLeaseExpiresAt" > clock_timestamp()
				AND clock_timestamp() < $6::timestamptz
				AND EXISTS (
					SELECT 1
					FROM "hanami_common_generation" g
					WHERE g."id" = $2
						AND g."status" = 'generating'
						AND g."generationFence" = $4::bigint
				)
			RETURNING s."generationFence"::text AS generation_fence
		`, [
			COMMON_STATE_ID,
			claim.generationId,
			claim.leaseOwner,
			claim.generationFence,
			String(this.config.hanamiGenerationLeaseMs),
			this.databaseDeadlineAt(budget),
		]) as Array<{ generation_fence: string }>));
		return rows.length === 1;
	}

	private async loadRecentCommonNoteIds(startedAt: string): Promise<ReadonlySet<string>> {
		const currentMonth = this.utcMonthStart(startedAt);
		const previousMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 1, 1));
		const rows = await this.db.query(`
			SELECT DISTINCT e."noteId" AS note_id
			FROM "hanami_common_feed_entry" e
			JOIN "hanami_common_generation" g ON g."id" = e."generationId" AND g."status" = 'ready'
			WHERE e."generatedMonth" = ANY($1::date[])
				AND e."generatedAt" >= $2::timestamptz - INTERVAL '30 minutes'
				AND e."generatedAt" < $2::timestamptz
		`, [[this.dateLiteral(previousMonth), this.dateLiteral(currentMonth)], startedAt]) as Array<{ note_id: string }>;
		return new Set(rows.map((row) => row.note_id));
	}

	private validateSourceBundle(source: HanamiCommonSourceBundle): CandidateInsertRow[] {
		if (source == null || typeof source !== 'object' || source.version !== 1) {
			throw new Error('Hanami common source bundle must have version 1');
		}
		this.assertIsoTimestamp(source.capturedAt, 'source capturedAt');
		if (source.sourceAsOf == null || source.sourceAsOf.version !== 1) {
			throw new Error('Hanami common sourceAsOf must have version 1');
		}
		for (const key of ['capturedAt', 'featuredAt', 'trendAt', 'axisConfigAt'] as const) {
			this.assertIsoTimestamp(source.sourceAsOf[key], `sourceAsOf.${key}`);
		}

		if (!Array.isArray(source.enabledAxes)) throw new Error('Hanami common enabledAxes must be an array');
		const enabledAxes = new Set<HanamiCommonAxis>();
		for (const axis of source.enabledAxes) {
			if (!this.isCommonAxis(axis) || enabledAxes.has(axis)) throw new Error(`Invalid or duplicate Hanami common enabled axis: ${String(axis)}`);
			enabledAxes.add(axis);
		}

		const rows: CandidateInsertRow[] = [];
		for (const axis of HANAMI_COMMON_AXES) {
			const candidates = source.candidates?.[axis];
			if (!Array.isArray(candidates)) throw new Error(`Hanami common ${axis} candidates must be an array`);
			if (!enabledAxes.has(axis) && candidates.length !== 0) throw new Error(`Disabled Hanami common axis ${axis} must be empty`);
			if (candidates.length > CANDIDATE_LIMITS[axis]) throw new Error(`Hanami common ${axis} candidate limit exceeded`);

			const noteIds = new Set<string>();
			for (const [rank, candidate] of candidates.entries()) {
				this.assertNonEmptyString(candidate.noteId, `${axis} candidate noteId`);
				this.assertNonEmptyString(candidate.authorId, `${axis} candidate authorId`);
				if (!Number.isFinite(candidate.baseScore)) throw new Error(`Hanami common ${axis} candidate baseScore must be finite`);
				if (noteIds.has(candidate.noteId)) throw new Error(`Hanami common ${axis} candidates contain duplicate Note ${candidate.noteId}`);
				noteIds.add(candidate.noteId);
				this.assertJsonRecord(candidate.metadata, `${axis} candidate metadata`);
				if (axis === 'trending' && typeof candidate.metadata.term !== 'string') {
					throw new Error('Hanami common trending candidate metadata.term must be a string');
				}
				rows.push({
					axis,
					rank: String(rank),
					noteId: candidate.noteId,
					baseScore: candidate.baseScore,
					metadata: candidate.metadata,
				});
			}
		}

		if (source.trendSnapshot == null || !Array.isArray(source.trendSnapshot.terms)) {
			throw new Error('Hanami common trend snapshot terms must be an array');
		}
		if (source.trendSnapshot.terms.length > MAX_TREND_TERMS) {
			throw new Error(`Hanami common trend snapshot term limit of ${MAX_TREND_TERMS} exceeded`);
		}
		const terms = new Set<string>();
		for (const trend of source.trendSnapshot.terms) {
			this.assertNonEmptyString(trend.term, 'trend term');
			if (trend.term.length > 256) throw new Error('Hanami common trend term exceeds 256 characters');
			if (terms.has(trend.term)) throw new Error(`Hanami common trend snapshot contains duplicate term ${trend.term}`);
			terms.add(trend.term);
			if (!Number.isFinite(trend.score)) throw new Error('Hanami common trend score must be finite');
			if (!Number.isSafeInteger(trend.distinctAuthors) || trend.distinctAuthors < 0 || trend.distinctAuthors > 2_147_483_647) {
				throw new Error('Hanami common trend distinctAuthors must fit a non-negative PostgreSQL integer');
			}
			if (!Array.isArray(trend.representativeNoteIds)) throw new Error('Hanami common trend representativeNoteIds must be an array');
			if (trend.representativeNoteIds.length > MAX_TREND_REPRESENTATIVES) {
				throw new Error(`Hanami common trend ${trend.term} representative Note limit of ${MAX_TREND_REPRESENTATIVES} exceeded`);
			}
			const representativeIds = new Set<string>();
			for (const noteId of trend.representativeNoteIds) {
				this.assertNonEmptyString(noteId, 'trend representative noteId');
				if (representativeIds.has(noteId)) throw new Error(`Hanami common trend ${trend.term} contains duplicate representative Note ${noteId}`);
				representativeIds.add(noteId);
			}
		}

		return rows;
	}

	private async validateSnapshotRepresentativeEligibility(source: HanamiCommonSourceBundle): Promise<void> {
		const noteIds = [...new Set(source.trendSnapshot.terms.flatMap((term) => term.representativeNoteIds))];
		if (noteIds.length === 0) return;

		const eligibleAuthors = await this.safetyService.filterCommonEligibleNotes(noteIds);
		for (const noteId of noteIds) {
			const authorId = eligibleAuthors.get(noteId);
			if (typeof authorId !== 'string' || authorId.trim().length === 0) {
				throw new Error(`Hanami common trend representative Note ${noteId} is missing or not common-eligible`);
			}
		}
	}

	private validateMaterialization(source: HanamiCommonSourceBundle, materialization: ReturnType<HanamiCommonComputationPort['materializeFeed']>): void {
		if (materialization == null || !Array.isArray(materialization.items)) throw new Error('Hanami common materialized items must be an array');
		if (materialization.items.length === 0 || materialization.items.length > MAX_COMMON_ITEMS) {
			throw new Error(`Hanami common materialization must contain 1..${MAX_COMMON_ITEMS} items`);
		}
		if (!Array.isArray(materialization.segmentLengths)
			|| materialization.segmentLengths.length === 0
			|| materialization.segmentLengths.length > MAX_SEGMENTS) {
			throw new Error(`Hanami common materialization must contain 1..${MAX_SEGMENTS} segment lengths`);
		}
		let segmentTotal = 0;
		for (const length of materialization.segmentLengths) {
			if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_SEGMENT_ITEMS) {
				throw new Error(`Hanami common segment length must be in 1..${MAX_SEGMENT_ITEMS}`);
			}
			segmentTotal += length;
		}
		if (segmentTotal !== materialization.items.length) throw new Error('Hanami common segment lengths do not match the materialized item count');

		const enabledAxes = new Set(source.enabledAxes);
		const candidateByAxis = new Map<HanamiCommonAxis, Map<string, string>>();
		for (const axis of HANAMI_COMMON_AXES) {
			candidateByAxis.set(axis, new Map(source.candidates[axis].map((candidate) => [candidate.noteId, candidate.authorId])));
		}
		const noteIds = new Set<string>();
		for (const item of materialization.items) {
			this.assertNonEmptyString(item.noteId, 'materialized noteId');
			this.assertNonEmptyString(item.authorId, 'materialized authorId');
			if (noteIds.has(item.noteId)) throw new Error(`Hanami common materialization contains duplicate Note ${item.noteId}`);
			noteIds.add(item.noteId);
			if (!this.isCommonAxis(item.source) || !enabledAxes.has(item.source)) throw new Error(`Invalid Hanami common materialized source ${String(item.source)}`);
			if (!Array.isArray(item.sources) || item.sources.length === 0) throw new Error('Hanami common materialized sources must be a non-empty array');
			const sources = new Set<HanamiCommonAxis>();
			for (const axis of item.sources) {
				if (!this.isCommonAxis(axis) || !enabledAxes.has(axis) || sources.has(axis)) {
					throw new Error(`Invalid or duplicate Hanami common materialized source ${String(axis)}`);
				}
				sources.add(axis);
				if (candidateByAxis.get(axis)?.get(item.noteId) !== item.authorId) {
					throw new Error(`Hanami common materialized Note ${item.noteId} is not present in source axis ${axis}`);
				}
			}
			if (!sources.has(item.source)) throw new Error('Hanami common primary source must be included in sources');
		}
	}

	private async stageCandidates(
		claim: Extract<ClaimResult, { kind: 'claimed' }>,
		generatedMonth: Date,
		source: HanamiCommonSourceBundle,
		candidateRows: CandidateInsertRow[],
		workerLease: WorkerLease,
	): Promise<void> {
		await this.withDeadlineTransaction(workerLease, async (queryRunner) => {
			const state = await this.lockCommonState(queryRunner, workerLease);
			const generationRows = await this.deadlineQuery<CommonGenerationRow[]>(queryRunner, workerLease, `
				SELECT g."status" AS status,
					g."ordinal"::text AS ordinal,
					to_char(g."startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
					g."generationFence"::text AS generation_fence
				FROM "hanami_common_generation" g
				WHERE g."id" = $1
				FOR UPDATE
			`, [claim.generationId]);
			const generation = generationRows[0];
			if (!this.isExactLiveClaim(state, generation, claim)) throw new HanamiCommonLeaseLostError();
			this.assertOperationBudget(workerLease);

			await this.deadlineQuery(queryRunner, workerLease, `
				DELETE FROM "hanami_common_candidate"
				WHERE "generatedMonth" = $1::date
					AND "generationId" = $2
					AND "generationFence" = $3::bigint
			`, [this.dateLiteral(generatedMonth), claim.generationId, claim.generationFence]);

			if (candidateRows.length > 0) {
				await this.deadlineQuery(queryRunner, workerLease, `
					INSERT INTO "hanami_common_candidate" (
						"generatedMonth", "generationId", "generationFence", "axis", "rank", "noteId", "baseScore", "metadata"
					)
					SELECT $1::date, $2, $3::bigint, input.axis, input.rank, input.note_id, input.base_score,
						$8::jsonb -> (input.ordinality::integer - 1)
					FROM unnest($4::text[], $5::bigint[], $6::varchar[], $7::double precision[])
						WITH ORDINALITY AS input(axis, rank, note_id, base_score, ordinality)
				`, [
					this.dateLiteral(generatedMonth),
					claim.generationId,
					claim.generationFence,
					candidateRows.map((row) => row.axis),
					candidateRows.map((row) => row.rank),
					candidateRows.map((row) => row.noteId),
					candidateRows.map((row) => row.baseScore),
					JSON.stringify(candidateRows.map((row) => row.metadata)),
				]);
			}

			const generationUpdateRows = hanamiReturningRows(await this.deadlineQuery<Array<{ generation_fence: string }>>(queryRunner, workerLease, `
				UPDATE "hanami_common_generation"
				SET "sourceAsOf" = $3::jsonb
				WHERE "id" = $1 AND "status" = 'generating' AND "generationFence" = $2::bigint
				RETURNING "generationFence"::text AS generation_fence
			`, [claim.generationId, claim.generationFence, JSON.stringify(source.sourceAsOf)]));
			if (generationUpdateRows.length !== 1) throw new HanamiCommonLeaseLostError();
			this.assertOperationBudget(workerLease);

			const extensionRows = hanamiReturningRows(await this.deadlineQuery<Array<{ generation_fence: string }>>(queryRunner, workerLease, `
				UPDATE "hanami_common_feed_state" s
				SET "generationLeaseExpiresAt" = clock_timestamp() + ($5::text || ' milliseconds')::interval,
					"updatedAt" = clock_timestamp()
				WHERE s."singletonId" = $1
					AND s."generatingGenerationId" = $2
					AND s."generationLeaseOwner" = $3
					AND s."generationFence" = $4::bigint
					AND s."generationLeaseExpiresAt" > clock_timestamp()
					AND clock_timestamp() < $6::timestamptz
					AND EXISTS (
						SELECT 1 FROM "hanami_common_generation" g
						WHERE g."id" = $2 AND g."status" = 'generating' AND g."generationFence" = $4::bigint
					)
				RETURNING s."generationFence"::text AS generation_fence
			`, [
				COMMON_STATE_ID,
				claim.generationId,
				claim.leaseOwner,
				claim.generationFence,
				String(this.config.hanamiGenerationLeaseMs),
				this.databaseDeadlineAt(workerLease),
			]));
			if (extensionRows.length !== 1) throw new HanamiCommonLeaseLostError();
		});
	}

	private preparePublication(
		claim: Extract<ClaimResult, { kind: 'claimed' }>,
		source: HanamiCommonSourceBundle,
		materialization: ReturnType<HanamiCommonComputationPort['materializeFeed']>,
	): PreparedPublication {
		const checksum = createHash('sha256').update(this.canonicalJson({
			version: 1,
			generationId: claim.generationId,
			generationFence: claim.generationFence,
			source,
			materialization,
		}), 'utf8').digest('hex');
		return {
			checksum,
			epochId: claim.epochId ?? this.idService.gen(),
			feedEntryIds: Array.from({ length: materialization.items.length }, () => this.idService.gen()),
			trendEntryIds: source.trendSnapshot.terms.map(() => this.idService.gen()),
		};
	}

	private async publishGeneration(
		claim: Extract<ClaimResult, { kind: 'claimed' }>,
		generatedMonth: Date,
		source: HanamiCommonSourceBundle,
		materialization: ReturnType<HanamiCommonComputationPort['materializeFeed']>,
		candidateRows: CandidateInsertRow[],
		prepared: PreparedPublication,
		workerLease: WorkerLease,
	): Promise<PublishResult> {
		return await this.withDeadlineTransaction(workerLease, async (queryRunner) => {
			const publicationQuery = async <T extends unknown[] = unknown[]>(sql: string, values: unknown[] = []): Promise<T> => {
				return await this.deadlineQuery<T>(queryRunner, workerLease, sql, values);
			};

			const state = await this.lockCommonState(queryRunner, workerLease);
			this.assertOperationBudget(workerLease);
			const generationRows = await publicationQuery<CommonGenerationRow[]>(`
				SELECT g."status" AS status,
					g."ordinal"::text AS ordinal,
					to_char(g."startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
					g."generationFence"::text AS generation_fence
				FROM "hanami_common_generation" g
				WHERE g."id" = $1
				FOR UPDATE
			`, [claim.generationId]);
			const generation = generationRows[0];
			const snapshotRows = await publicationQuery<Array<{ status: 'pending' | 'ready' | 'failed' | 'obsolete' }>>(`
				SELECT t."status" AS status
				FROM "hanami_trend_snapshot" t
				WHERE t."commonGenerationId" = $1
				FOR UPDATE
			`, [claim.generationId]);
			const snapshot = snapshotRows.at(0);
			if (!this.isExactLiveClaim(state, generation, claim) || snapshot?.status !== 'pending') throw new HanamiCommonLeaseLostError();
			this.assertOperationBudget(workerLease);

			const publicationGuardRows = await publicationQuery<Array<{ shape_is_valid: boolean; lost_ordinal: boolean }>>(`
				SELECT (
					(s."epochId" IS NULL
						AND s."latestReadyGenerationId" IS NULL
						AND s."latestSequence" = '0'::bigint
						AND s."earliestRetainedSequence" = '0'::bigint)
					OR
					(s."epochId" IS NOT NULL
						AND s."latestReadyGenerationId" IS NOT NULL
						AND s."earliestRetainedSequence" > '0'::bigint
						AND s."latestSequence" >= s."earliestRetainedSequence"
						AND EXISTS (
							SELECT 1 FROM "hanami_common_generation" ready_generation
							WHERE ready_generation."id" = s."latestReadyGenerationId"
								AND ready_generation."status" = 'ready'
						))
				) AS shape_is_valid,
				EXISTS (
					SELECT 1 FROM "hanami_common_generation" ready_generation
					WHERE ready_generation."id" = s."latestReadyGenerationId"
						AND ready_generation."status" = 'ready'
						AND ready_generation."ordinal" >= $2::bigint
				) AS lost_ordinal
				FROM "hanami_common_feed_state" s
				WHERE s."singletonId" = $1
			`, [COMMON_STATE_ID, generation.ordinal]);
			const publicationGuard = publicationGuardRows.at(0);
			if (publicationGuard?.shape_is_valid !== true) throw new Error('Hanami common feed state has an invalid publication shape');

			if (publicationGuard.lost_ordinal) {
				this.assertOperationBudget(workerLease);
				const obsoleteGenerationRows = hanamiReturningRows(await publicationQuery<Array<{ generation_fence: string }>>(`
					UPDATE "hanami_common_generation"
					SET "status" = 'obsolete', "finishedAt" = clock_timestamp()
					WHERE "id" = $1 AND "status" = 'generating' AND "generationFence" = $2::bigint
					RETURNING "generationFence"::text AS generation_fence
				`, [claim.generationId, claim.generationFence]));
				const obsoleteSnapshotRows = hanamiReturningRows(await publicationQuery<Array<{ ordinal: string }>>(`
					UPDATE "hanami_trend_snapshot"
					SET "status" = 'obsolete'
					WHERE "commonGenerationId" = $1 AND "status" = 'pending'
					RETURNING "ordinal"::text AS ordinal
				`, [claim.generationId]));
				if (obsoleteGenerationRows.length !== 1 || obsoleteSnapshotRows.length !== 1) throw new HanamiCommonLeaseLostError();

				await this.configureOperationDeadline(queryRunner, workerLease);
				const clearRows = await this.clearClaim(queryRunner, claim, workerLease);
				this.assertOperationBudget(workerLease);
				if (clearRows !== 1) throw new HanamiCommonLeaseLostError();
				return { kind: 'obsolete' };
			}

			const expectedCounts = HANAMI_COMMON_AXES.map((axis) => candidateRows.filter((row) => row.axis === axis).length);
			const countRows = await publicationQuery<Array<{ counts_match: boolean }>>(`
				SELECT (
					COUNT(*) = $4::bigint
					AND COUNT(*) FILTER (WHERE c."axis" = 'globalPopular') = $5::bigint
					AND COUNT(*) FILTER (WHERE c."axis" = 'trending') = $6::bigint
					AND COUNT(*) FILTER (WHERE c."axis" = 'exploration') = $7::bigint
					AND COUNT(*) FILTER (WHERE c."axis" NOT IN ('globalPopular', 'trending', 'exploration')) = '0'::bigint
				) AS counts_match
				FROM "hanami_common_candidate" c
				WHERE c."generatedMonth" = $1::date
					AND c."generationId" = $2
					AND c."generationFence" = $3::bigint
			`, [
				this.dateLiteral(generatedMonth),
				claim.generationId,
				claim.generationFence,
				String(candidateRows.length),
				String(expectedCounts[0]),
				String(expectedCounts[1]),
				String(expectedCounts[2]),
			]);
			if (countRows[0]?.counts_match !== true) throw new Error('Hanami common candidate counts changed before publication');

			const epochId = state.epoch_id ?? prepared.epochId;
			await publicationQuery(`
				INSERT INTO "hanami_common_feed_entry" (
					"generatedMonth", "id", "epochId", "sequence", "generationId", "position",
					"noteId", "source", "sources", "generatedAt"
				)
				SELECT $1::date,
					input.entry_id,
					$2,
					$3::bigint + $4::bigint - (input.ordinality::bigint - '1'::bigint),
					$5,
					(input.ordinality::integer - 1),
					input.note_id,
					input.source,
					$9::jsonb -> (input.ordinality::integer - 1),
					$10::timestamptz
				FROM unnest($6::varchar[], $7::varchar[], $8::text[])
					WITH ORDINALITY AS input(entry_id, note_id, source, ordinality)
			`, [
				this.dateLiteral(generatedMonth),
				epochId,
				state.latest_sequence,
				String(materialization.items.length),
				claim.generationId,
				prepared.feedEntryIds,
				materialization.items.map((item) => item.noteId),
				materialization.items.map((item) => item.source),
				JSON.stringify(materialization.items.map((item) => item.sources)),
				claim.startedAt,
			]);

			const trendTerms = source.trendSnapshot.terms;
			if (trendTerms.length > 0) {
				await publicationQuery(`
					INSERT INTO "hanami_trend_snapshot_entry" (
						"generatedMonth", "id", "snapshotId", "rank", "term", "score", "distinctAuthors"
					)
					SELECT $1::date, input.entry_id, t."id", (input.ordinality::bigint - '1'::bigint),
						input.term, input.score, input.distinct_authors
					FROM "hanami_trend_snapshot" t,
						unnest($3::varchar[], $4::text[], $5::double precision[], $6::integer[])
							WITH ORDINALITY AS input(entry_id, term, score, distinct_authors, ordinality)
					WHERE t."commonGenerationId" = $2 AND t."status" = 'pending'
				`, [
					this.dateLiteral(generatedMonth),
					claim.generationId,
					prepared.trendEntryIds,
					trendTerms.map((term) => term.term),
					trendTerms.map((term) => term.score),
					trendTerms.map((term) => term.distinctAuthors),
				]);

				const representatives = trendTerms.flatMap((term, rank) => term.representativeNoteIds
					.map((noteId, position) => ({ rank: String(rank), position, noteId })));
				if (representatives.length > 0) {
					await publicationQuery(`
						INSERT INTO "hanami_trend_snapshot_representative_note" (
							"generatedMonth", "snapshotId", "rank", "position", "noteId"
						)
						SELECT $1::date, t."id", input.rank, input.position, input.note_id
						FROM "hanami_trend_snapshot" t,
							unnest($3::bigint[], $4::integer[], $5::varchar[]) AS input(rank, position, note_id)
						WHERE t."commonGenerationId" = $2 AND t."status" = 'pending'
					`, [
						this.dateLiteral(generatedMonth),
						claim.generationId,
						representatives.map((row) => row.rank),
						representatives.map((row) => row.position),
						representatives.map((row) => row.noteId),
					]);
				}
			}

			const snapshotReadyRows = hanamiReturningRows(await publicationQuery<Array<{ ordinal: string }>>(`
				UPDATE "hanami_trend_snapshot"
				SET "status" = 'ready', "itemCount" = $2
				WHERE "commonGenerationId" = $1 AND "status" = 'pending'
				RETURNING "ordinal"::text AS ordinal
			`, [claim.generationId, trendTerms.length]));
			if (snapshotReadyRows.length !== 1) throw new HanamiCommonLeaseLostError();

			const generationReadyRows = hanamiReturningRows(await publicationQuery<Array<{ generation_fence: string }>>(`
				UPDATE "hanami_common_generation"
				SET "status" = 'ready', "checksum" = $3, "finishedAt" = clock_timestamp()
				WHERE "id" = $1 AND "status" = 'generating' AND "generationFence" = $2::bigint
				RETURNING "generationFence"::text AS generation_fence
			`, [claim.generationId, claim.generationFence, prepared.checksum]));
			if (generationReadyRows.length !== 1) throw new HanamiCommonLeaseLostError();

			const stateReadyRows = hanamiReturningRows(await publicationQuery<Array<{ latest_sequence: string; earliest_retained_sequence: string }>>(`
				UPDATE "hanami_common_feed_state" s
				SET "epochId" = COALESCE(s."epochId", $5),
					"latestReadyGenerationId" = $2,
					"latestSequence" = CASE
						WHEN s."epochId" IS NULL THEN $6::bigint
						ELSE s."latestSequence" + $6::bigint
					END,
					"earliestRetainedSequence" = CASE
						WHEN s."epochId" IS NULL THEN '1'::bigint
						ELSE s."earliestRetainedSequence"
					END,
					"generatingGenerationId" = NULL,
					"generationLeaseOwner" = NULL,
					"generationLeaseExpiresAt" = NULL,
					"updatedAt" = clock_timestamp()
				WHERE s."singletonId" = $1
					AND s."generatingGenerationId" = $2
					AND s."generationLeaseOwner" = $3
					AND s."generationFence" = $4::bigint
					AND s."generationLeaseExpiresAt" > clock_timestamp()
					AND clock_timestamp() < $11::timestamptz
					AND s."epochId" IS NOT DISTINCT FROM $7
					AND s."latestReadyGenerationId" IS NOT DISTINCT FROM $8
					AND s."latestSequence" = $9::bigint
					AND s."earliestRetainedSequence" = $10::bigint
					AND EXISTS (
						SELECT 1 FROM "hanami_common_generation" g
						WHERE g."id" = $2 AND g."status" = 'ready' AND g."generationFence" = $4::bigint
					)
					AND EXISTS (
						SELECT 1 FROM "hanami_trend_snapshot" t
						WHERE t."commonGenerationId" = $2 AND t."status" = 'ready'
					)
				RETURNING s."latestSequence"::text AS latest_sequence,
					s."earliestRetainedSequence"::text AS earliest_retained_sequence
			`, [
				COMMON_STATE_ID,
				claim.generationId,
				claim.leaseOwner,
				claim.generationFence,
				prepared.epochId,
				String(materialization.items.length),
				state.epoch_id,
				state.latest_ready_generation_id,
				state.latest_sequence,
				state.earliest_retained_sequence,
				this.databaseDeadlineAt(workerLease),
			]));
			if (stateReadyRows.length !== 1) throw new HanamiCommonLeaseLostError();

			return { kind: 'published' };
		});
	}

	private async resolveFailure(claim: Extract<ClaimResult, { kind: 'claimed' }>, budget: GenerationBudget): Promise<FailureResolution> {
		try {
			return await this.withDeadlineTransaction(budget, async (queryRunner) => {
				const state = await this.lockCommonState(queryRunner, budget);
				const generationRows = await this.deadlineQuery<CommonGenerationRow[]>(queryRunner, budget, `
					SELECT g."status" AS status,
						g."ordinal"::text AS ordinal,
						to_char(g."startedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
						g."generationFence"::text AS generation_fence
					FROM "hanami_common_generation" g
					WHERE g."id" = $1
					FOR UPDATE
				`, [claim.generationId]);
				const generation = generationRows.at(0);
				const snapshotRows = await this.deadlineQuery<Array<{ status: 'pending' | 'ready' | 'failed' | 'obsolete' }>>(queryRunner, budget, `
					SELECT t."status" AS status
					FROM "hanami_trend_snapshot" t
					WHERE t."commonGenerationId" = $1
					FOR UPDATE
				`, [claim.generationId]);
				const snapshot = snapshotRows.at(0);

				if (generation?.status === 'ready' && snapshot?.status === 'ready' && generation.generation_fence === claim.generationFence) {
					const countRows = await this.deadlineQuery<Array<{ item_count: number }>>(queryRunner, budget, `
						SELECT COALESCE(MAX(e."position") + 1, 0) AS item_count
						FROM "hanami_common_feed_entry" e
						WHERE e."generatedMonth" = date_trunc('month', $2::timestamptz)::date
							AND e."generationId" = $1
					`, [claim.generationId, this.toIsoString(generation.started_at, 'generation startedAt')]);
					return {
						kind: 'ready',
						generationFence: generation.generation_fence,
						itemCount: countRows[0]?.item_count ?? 0,
					};
				}

				if (!this.isExactLiveClaim(state, generation, claim) || snapshot?.status !== 'pending') return { kind: 'stale' };

				const failedGenerationRows = hanamiReturningRows(await this.deadlineQuery<Array<{ generation_fence: string }>>(queryRunner, budget, `
					UPDATE "hanami_common_generation"
					SET "status" = 'failed', "finishedAt" = clock_timestamp()
					WHERE "id" = $1 AND "status" = 'generating' AND "generationFence" = $2::bigint
					RETURNING "generationFence"::text AS generation_fence
				`, [claim.generationId, claim.generationFence]));
				const failedSnapshotRows = hanamiReturningRows(await this.deadlineQuery<Array<{ ordinal: string }>>(queryRunner, budget, `
					UPDATE "hanami_trend_snapshot"
					SET "status" = 'failed'
					WHERE "commonGenerationId" = $1 AND "status" = 'pending'
					RETURNING "ordinal"::text AS ordinal
				`, [claim.generationId]));
				if (failedGenerationRows.length !== 1 || failedSnapshotRows.length !== 1) throw new HanamiCommonLeaseLostError();

				const clearRows = await this.clearClaim(queryRunner, claim, budget);
				if (clearRows !== 1) throw new HanamiCommonLeaseLostError();
				return { kind: 'failed' };
			});
		} catch (error) {
			if (error instanceof HanamiCommonLeaseLostError) return { kind: 'stale' };
			throw error;
		}
	}

	private async clearClaim(queryRunner: QueryRunner, claim: Extract<ClaimResult, { kind: 'claimed' }>, budget: GenerationBudget): Promise<number> {
		const rows = hanamiReturningRows(await this.deadlineQuery<Array<{ generation_fence: string }>>(queryRunner, budget, `
			UPDATE "hanami_common_feed_state"
			SET "generatingGenerationId" = NULL,
				"generationLeaseOwner" = NULL,
				"generationLeaseExpiresAt" = NULL,
				"updatedAt" = clock_timestamp()
			WHERE "singletonId" = $1
				AND "generatingGenerationId" = $2
				AND "generationLeaseOwner" = $3
				AND "generationFence" = $4::bigint
				AND "generationLeaseExpiresAt" > clock_timestamp()
			RETURNING "generationFence"::text AS generation_fence
		`, [COMMON_STATE_ID, claim.generationId, claim.leaseOwner, claim.generationFence]));
		return rows.length;
	}

	private async lockCommonState(queryRunner: QueryRunner, budget?: GenerationBudget): Promise<CommonStateRow | null> {
		const sql = `
			SELECT s."epochId" AS epoch_id,
				s."latestSequence"::text AS latest_sequence,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence,
				s."latestReadyGenerationId" AS latest_ready_generation_id,
				s."generatingGenerationId" AS generating_generation_id,
				s."generationLeaseOwner" AS generation_lease_owner,
				s."generationLeaseExpiresAt" AS generation_lease_expires_at,
				s."generationFence"::text AS generation_fence,
				COALESCE(s."generationLeaseExpiresAt" > clock_timestamp(), FALSE) AS lease_is_live
			FROM "hanami_common_feed_state" s
			WHERE s."singletonId" = $1
			FOR UPDATE
		`;
		const rows = budget == null
			? await queryRunner.query(sql, [COMMON_STATE_ID]) as CommonStateRow[]
			: await this.deadlineQuery<CommonStateRow[]>(queryRunner, budget, sql, [COMMON_STATE_ID]);
		return rows.at(0) ?? null;
	}

	private isExactLiveClaim(
		state: CommonStateRow | null,
		generation: CommonGenerationRow | undefined,
		claim: Extract<ClaimResult, { kind: 'claimed' }>,
	): state is CommonStateRow {
		return state != null
			&& generation != null
			&& state.generating_generation_id === claim.generationId
			&& state.generation_lease_owner === claim.leaseOwner
			&& state.generation_fence === claim.generationFence
			&& state.lease_is_live
			&& generation.status === 'generating'
			&& generation.generation_fence === claim.generationFence;
	}

	private remainingBudgetMs(budget: GenerationBudget): number {
		return Math.max(0, Math.floor(budget.monotonicDeadline - performance.now()));
	}

	private assertOperationBudget(budget: GenerationBudget): void {
		if (!budget.controller.signal.aborted && this.remainingBudgetMs(budget) <= 0) {
			budget.controller.abort(budget.timeoutError);
		}
		if (budget.controller.signal.aborted) throw budget.controller.signal.reason;
	}

	private forkRemainingBudget(source: GenerationBudget): GenerationBudget | null {
		const remainingMs = this.remainingBudgetMs(source);
		if (remainingMs <= 0) return null;

		const controller = new AbortController();
		const timeoutTimer = setTimeout(() => controller.abort(source.timeoutError), remainingMs);
		return {
			controller,
			monotonicDeadline: source.monotonicDeadline,
			databaseDeadlineAt: source.databaseDeadlineAt,
			timeoutError: source.timeoutError,
			dispose: () => clearTimeout(timeoutTimer),
		};
	}

	private databaseDeadlineAt(budget: GenerationBudget): string {
		if (budget.databaseDeadlineAt == null) throw new Error('Hanami common generation database deadline is not established');
		return budget.databaseDeadlineAt;
	}

	private async waitForOperationBudget<T>(promise: Promise<T>, budget: GenerationBudget): Promise<T> {
		const signal = budget.controller.signal;
		const remainingMs = this.remainingBudgetMs(budget);
		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (operation: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				signal.removeEventListener('abort', onAbort);
				operation();
			};
			const onAbort = (): void => finish(() => reject(signal.reason));
			const timeoutTimer = setTimeout(() => {
				if (!signal.aborted) budget.controller.abort(budget.timeoutError);
			}, Math.max(1, remainingMs));
			signal.addEventListener('abort', onAbort, { once: true });
			void promise.then((value) => {
				try {
					this.assertOperationBudget(budget);
					finish(() => resolve(value));
				} catch (error) {
					finish(() => reject(error));
				}
			}, (error) => {
				try {
					this.assertOperationBudget(budget);
					finish(() => reject(error));
				} catch (budgetError) {
					finish(() => reject(budgetError));
				}
			});

			if (!signal.aborted && remainingMs <= 0) budget.controller.abort(budget.timeoutError);
			if (signal.aborted) onAbort();
		});
	}

	private async runWithOperationBudget<T>(budget: GenerationBudget, operation: () => Promise<T>): Promise<T> {
		this.assertOperationBudget(budget);
		return await this.waitForOperationBudget(operation(), budget);
	}

	private async establishDatabaseDeadline(queryRunner: QueryRunner, budget: GenerationBudget): Promise<void> {
		if (budget.databaseDeadlineAt != null) return;
		const remainingMs = this.remainingBudgetMs(budget);
		if (remainingMs <= 0) {
			this.assertOperationBudget(budget);
			return;
		}

		const rows = await this.runWithOperationBudget(budget, async () => await queryRunner.query(`
			SELECT to_char(
				(pg_catalog.clock_timestamp() + ($1::text || ' milliseconds')::interval) AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
			) AS deadline_at
		`, [String(Math.max(1, remainingMs - 1))]) as Array<{ deadline_at: string }>);
		const deadlineAt = rows[0]?.deadline_at;
		this.assertIsoTimestamp(deadlineAt, 'database deadline');
		budget.databaseDeadlineAt = deadlineAt;
	}

	private async configureOperationDeadline(queryRunner: QueryRunner, budget: GenerationBudget): Promise<void> {
		const rows = await this.runWithOperationBudget(budget, async () => await queryRunner.query(`
			WITH budget AS (
				SELECT FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)::bigint - 1 AS remaining_ms
			)
			SELECT set_config('statement_timeout', budget.remaining_ms::text || 'ms', TRUE),
				set_config('lock_timeout', budget.remaining_ms::text || 'ms', TRUE)
			FROM budget
			WHERE budget.remaining_ms > 0
		`, [this.databaseDeadlineAt(budget)]) as unknown[]);
		if (rows.length !== 1) {
			if (!budget.controller.signal.aborted) budget.controller.abort(budget.timeoutError);
			throw budget.timeoutError;
		}
		this.assertOperationBudget(budget);
	}

	private async deadlineQuery<T extends unknown[] = unknown[]>(queryRunner: QueryRunner, budget: GenerationBudget, sql: string, values: unknown[] = []): Promise<T> {
		await this.configureOperationDeadline(queryRunner, budget);
		return await this.runWithOperationBudget(budget, async () => await queryRunner.query(sql, values) as T);
	}

	private utcMonthStart(timestamp: string): Date {
		const date = new Date(timestamp);
		if (Number.isNaN(date.getTime())) throw new Error('Hanami generation startedAt is invalid');
		return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
	}

	private dateLiteral(date: Date): string {
		return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
	}

	private toIsoString(value: Date | string, name: string): string {
		if (typeof value === 'string') {
			if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be a valid timestamp`);
			return value;
		}
		const date = value;
		if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
		return date.toISOString();
	}

	private assertIsoTimestamp(value: unknown, name: string): asserts value is string {
		if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
			throw new Error(`${name} must be a valid timestamp string`);
		}
	}

	private assertNonEmptyString(value: unknown, name: string): asserts value is string {
		if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
	}

	private isCommonAxis(value: unknown): value is HanamiCommonAxis {
		return typeof value === 'string' && AXIS_ORDER.has(value as HanamiCommonAxis);
	}

	private assertJsonRecord(value: unknown, name: string): asserts value is Readonly<Record<string, unknown>> {
		if (typeof value !== 'object' || value == null || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
		this.assertJsonValue(value, name, new Set<object>());
	}

	private assertJsonValue(value: unknown, name: string, ancestors: Set<object>): void {
		if (value == null || typeof value === 'string' || typeof value === 'boolean') return;
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
			return;
		}
		if (typeof value !== 'object') throw new Error(`${name} contains a non-JSON value`);
		if (ancestors.has(value)) throw new Error(`${name} contains a cycle`);
		ancestors.add(value);
		if (Array.isArray(value)) {
			for (const item of value) this.assertJsonValue(item, name, ancestors);
		} else {
			for (const item of Object.values(value)) this.assertJsonValue(item, name, ancestors);
		}
		ancestors.delete(value);
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
			let encoded: string;
			if (Array.isArray(item)) {
				encoded = `[${item.map((entry) => encode(entry, ancestors)).join(',')}]`;
			} else {
				encoded = `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], ancestors)}`).join(',')}}`;
			}
			ancestors.delete(item);
			return encoded;
		};
		return encode(value, new Set<object>());
	}

	private async withDeadlineTransaction<T>(budget: GenerationBudget, callback: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
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
			this.assertOperationBudget(budget);
			connectPromise = Promise.resolve(queryRunner.connect());
			void connectPromise.then(() => { connectSettled = true; }, () => { connectSettled = true; });
			await this.waitForOperationBudget(connectPromise, budget);
			connected = true;

			this.assertOperationBudget(budget);
			startPromise = Promise.resolve(queryRunner.startTransaction());
			void startPromise.then(() => { startSettled = true; }, () => { startSettled = true; });
			await this.waitForOperationBudget(startPromise, budget);
			transactionStarted = true;

			await this.establishDatabaseDeadline(queryRunner, budget);
			await this.configureOperationDeadline(queryRunner, budget);
			result = await this.runWithOperationBudget(budget, () => callback(queryRunner));
			await this.configureOperationDeadline(queryRunner, budget);

			this.assertOperationBudget(budget);
			commitPromise = Promise.resolve(queryRunner.commitTransaction());
			void commitPromise.then(() => { commitSettled = true; }, () => { commitSettled = true; });
			await this.waitForOperationBudget(commitPromise, budget);
			transactionStarted = false;

			this.assertOperationBudget(budget);
			releasePromise = Promise.resolve(queryRunner.release());
			void releasePromise.then(() => { releaseSettled = true; }, () => { releaseSettled = true; });
			await this.waitForOperationBudget(releasePromise, budget);
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

		if (connected) throw new Error('Hanami common deadline transaction did not release its query runner');
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
		budget: GenerationBudget,
		primaryError: unknown,
	): Promise<void> {
		const cleanup = this.cleanupQueryRunner(queryRunner, rollback, primaryError);
		if (budget.controller.signal.aborted || this.remainingBudgetMs(budget) <= 0) {
			// The driver may still settle later, but no Bull worker slot waits for it and no business callback resumes.
			void cleanup;
			return;
		}

		try {
			await this.waitForOperationBudget(cleanup, budget);
		} catch (cleanupBudgetError) {
			if (cleanupBudgetError !== primaryError) this.attachCleanupError(primaryError, cleanupBudgetError);
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

	private async withTransaction<T>(
		callback: (queryRunner: QueryRunner) => Promise<T>,
		beforeCommit?: (queryRunner: QueryRunner) => Promise<void>,
	): Promise<T> {
		const queryRunner = this.db.createQueryRunner();
		let connected = false;
		let transactionStarted = false;
		let hasPrimaryError = false;
		let primaryError: unknown;
		let completed = false;
		let result: T | undefined;

		try {
			await queryRunner.connect();
			connected = true;
			await queryRunner.startTransaction();
			transactionStarted = true;
			result = await callback(queryRunner);
			if (beforeCommit != null) await beforeCommit(queryRunner);
			await queryRunner.commitTransaction();
			transactionStarted = false;
			completed = true;
		} catch (error) {
			hasPrimaryError = true;
			primaryError = error;
		}

		if (hasPrimaryError && (transactionStarted || queryRunner.isTransactionActive)) {
			try {
				await queryRunner.rollbackTransaction();
			} catch (rollbackError) {
				this.attachCleanupError(primaryError, rollbackError);
			}
		}

		if (connected || hasPrimaryError) {
			try {
				await queryRunner.release();
			} catch (releaseError) {
				if (!hasPrimaryError) throw releaseError;
				this.attachCleanupError(primaryError, releaseError);
			}
		}

		if (hasPrimaryError) throw primaryError;
		if (!completed) throw new Error('Hanami common transaction did not complete');
		return result as T;
	}

	private attachCleanupError(primaryError: unknown, cleanupError: unknown): void {
		try {
			if (primaryError instanceof Error) {
				const errorWithCleanup = primaryError as Error & { cleanupErrors?: unknown[] };
				errorWithCleanup.cleanupErrors = [...(errorWithCleanup.cleanupErrors ?? []), cleanupError];
			}
		} catch {
			// Cleanup diagnostics must never replace the primary failure.
		}
	}
}
