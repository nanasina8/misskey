/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { recordHanamiFeedEvent, type HanamiFeedDiscardReason, type HanamiFeedEventKind, type HanamiFeedStockReason, HANAMI_FEED_SEEN_KEY_PREFIX, HANAMI_FEED_PREWARM_KEY_PREFIX, HANAMI_FEED_PREWARM_TTL_SECONDS } from './HanamiFeedStockEvents.js';
import { jstDay } from './HanamiMetricsContracts.js';
import type { Redis } from 'ioredis';
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
// 更新で表に出してよいストックの古さ（これより新しいストックだけを即座に表へ出す）。
const STOCK_MAX_AGE_MINUTES = 180;
// ストックを作り直すべき古さ（この経過時間を超えたストックを裏で作り直す）。
const STOCK_REFRESH_AFTER_MINUTES = 60;
// ストックを作り直す対象になる、最後に使ってからの日数。
const STOCK_ACTIVE_DAYS = 7;

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
	stock_batch_id: string | null;
	stock_sequence: string | null;
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
	trigger: 'initial' | 'refresh' | 'prefetch';
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
	backgroundBatchId: string | null;
	// 初めての生成（trigger='initial' の batch をその場で作った／合流した）だけ true にして待つ。
	waitForGeneration: boolean;
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
		@Optional() @Inject(DI.redis) private metricsRedis?: Redis,
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

	/** 応答の返却後に次のストックを裏で作り始める（別トランザクション）。失敗は応答に影響させない。 */
	@bindThis
	public async ensureStock(userId: string, reason: HanamiFeedStockReason = 'afterGenerate'): Promise<void> {
		try {
			const batchId = await this.withTransaction(async (queryRunner) => {
				const context = await this.lockContext(queryRunner, userId);
				if (context.user.is_hibernated) return null;
				const availability = await this.evaluateAvailability(queryRunner, userId);
				if (availability.kind !== 'available') return null;
				return await this.startPrefetchIfEligible(queryRunner, context, reason);
			});
			if (batchId != null) {
				await this.queueService.enqueueHanamiUserFeedGeneration(batchId);
			}
		} catch (error) {
			this.logger.warn('Failed to ensure Hanami stock', { userId, e: error });
		}
	}

	/** 最近使った personalized ユーザーのストックを作り直す。enqueue は呼び出し側の責務。 */
	@bindThis
	public async maintainStock(limit: number): Promise<{ batchIdsToEnqueue: string[] }> {
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive safe integer');
		const candidates = await this.db.query(`
			SELECT s."userId" AS user_id, s."epochId" AS epoch_id, s."stockBatchId" AS stock_batch_id
			FROM "hanami_user_feed_state" s
			JOIN "user" u ON u."id" = s."userId"
			WHERE s."mode" = 'personalized'
				AND s."latestReadyBatchId" IS NOT NULL
				AND s."generatingBatchId" IS NULL
				AND u."isHibernated" = FALSE
				AND EXISTS (
					SELECT 1 FROM "hanami_metrics_timeline" t
					WHERE t."userId" = s."userId" AND t."kind" = 'hanami'
						AND t."day" >= ((clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date - ${STOCK_ACTIVE_DAYS})
				)
				AND NOT EXISTS (
					SELECT 1 FROM "hanami_user_feed_batch" b
					WHERE b."userId" = s."userId" AND b."createdAt" > clock_timestamp() - INTERVAL '${STOCK_REFRESH_AFTER_MINUTES} minutes'
				)
				AND (
					s."stockBatchId" IS NULL
					OR EXISTS (
						SELECT 1 FROM "hanami_user_feed_batch" sb
						WHERE sb."id" = s."stockBatchId" AND sb."userId" = s."userId"
							AND sb."finishedAt" <= clock_timestamp() - INTERVAL '${STOCK_REFRESH_AFTER_MINUTES} minutes'
					)
				)
			ORDER BY s."userId" ASC
			LIMIT $1
		`, [limit]) as Array<{ user_id: string; epoch_id: string; stock_batch_id: string | null }>;

		const batchIdsToEnqueue: string[] = [];
		for (const candidate of candidates) {
			try {
				const batchId = await this.withTransaction(async (queryRunner) => {
					const context = await this.lockContext(queryRunner, candidate.user_id);
					if (context.user.is_hibernated) return null;
					if (context.activeBatch != null) return null;
					if (context.state == null || context.state.mode !== 'personalized') return null;
					const availability = await this.evaluateAvailability(queryRunner, candidate.user_id);
					if (availability.kind !== 'available') return null;
					let state = context.state;
					if (state.stock_batch_id != null) {
						if (await this.isStockFresherThan(queryRunner, state, STOCK_REFRESH_AFTER_MINUTES)) return null;
						await this.discardStock(queryRunner, candidate.user_id, state.epoch_id, state.stock_batch_id, 'upkeep');
						state = { ...state, stock_batch_id: null, stock_sequence: null };
						context.state = state;
					}
					return await this.startPrefetchIfEligible(queryRunner, context, 'upkeep');
				});
				if (batchId != null) {
					batchIdsToEnqueue.push(batchId);
					this.recordEvent('upkeep', candidate.user_id, 'prefetch', batchId);
				}
			} catch (error) {
				this.logger.warn('Failed to maintain Hanami stock for a user', { userId: candidate.user_id, e: error });
			}
		}
		return { batchIdsToEnqueue };
	}

	@bindThis
	public async evaluateCursorless(userId: string): Promise<HanamiUserFeedRequestResult> {
		const startedAt = performance.now();
		// 判定はこのリクエストの packPage（SET する側）より前に行う。Redis が無ければ「30 分以内」とみなす。
		const inSession = await this.isInSession(userId);
		let decision: PendingDecision;
		const openState: { outcome: 'head' | 'stock' | 'pending' | 'initial' } = { outcome: 'head' };
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
						backgroundBatchId: null,
						waitForGeneration: false,
					};
				}

				if (context.state == null || context.state.initial_state === 'notEvaluated') {
					const commonHead = await this.requireLockedCommonHead(queryRunner);
					const started = await this.startInitialGeneration(queryRunner, context, commonHead, 'open');
					openState.outcome = 'initial';
					return {
						result: this.pendingResult(this.commonHead(commonHead), started.batchId),
						batchId: started.batchId,
						refreshDigest: null,
						backgroundBatchId: null,
						waitForGeneration: true,
					};
				}

				const state = context.state;
				const head = await this.requireStateHead(queryRunner, state);
				// しばらくぶり（30 分以上見ていない）の personalized は、更新と同じようにストックを出す。
				if (state.mode === 'personalized' && !inSession) {
					const sessionDecision = await this.evaluateSessionStock(queryRunner, context, state, head);
					openState.outcome = sessionDecision.result.kind === 'serve' && sessionDecision.result.generationPending ? 'pending' : 'stock';
					return sessionDecision;
				}

				if (context.activeBatch != null && context.activeBatch.id === state.generating_batch_id) {
					// ストック用の生成中は待たせない（I4）。普通に開いただけで並びを変えず、今の先頭を出す。
					if (context.activeBatch.trigger === 'prefetch') {
						return {
							result: { kind: 'serve', head, generationPending: false, requestedBatchId: null },
							batchId: null,
							refreshDigest: null,
							backgroundBatchId: null,
							waitForGeneration: false,
						};
					}
					// 生成中の refresh への合流は待たせない（初回の initial だけ待つ）。
					if (context.activeBatch.trigger !== 'initial') {
						openState.outcome = 'pending';
						return {
							result: this.pendingResult(head, context.activeBatch.id),
							batchId: context.activeBatch.id,
							refreshDigest: null,
							backgroundBatchId: null,
							waitForGeneration: false,
						};
					}
					openState.outcome = 'initial';
					return {
						result: this.pendingResult(head, context.activeBatch.id),
						batchId: context.activeBatch.id,
						refreshDigest: null,
						backgroundBatchId: null,
						waitForGeneration: true,
					};
				}

				// ストックは先頭より上に置き、更新で表に出す。普通に開いただけでは並びを変えない。
				const backgroundBatchId = await this.startPrefetchIfEligible(queryRunner, context, 'afterServe');
				return {
					result: { kind: 'serve', head, generationPending: false, requestedBatchId: null },
					batchId: null,
					refreshDigest: null,
					backgroundBatchId,
					waitForGeneration: false,
				};
			});
		} catch (error) {
			if (error instanceof HanamiCommonNotReadyError) return { kind: 'commonNotReady' };
			throw error;
		}

		const result = await this.dispatchAndWait(userId, decision);
		// その場で作って待った結果、personalized の先頭が返ったら次のストックを裏で仕込む。
		if (decision.waitForGeneration && result.kind === 'serve' && !result.generationPending && result.head.mode === 'personalized') {
			await this.ensureStock(userId, 'afterGenerate');
		}
		const outcome = result.kind !== 'serve'
			? 'unavailable'
			: openState.outcome === 'initial'
				? (result.generationPending ? 'initialPending' : 'initialWait')
				: openState.outcome;
		this.recordEvent('open', userId, outcome, undefined, Math.max(0, Math.round(performance.now() - startedAt)));
		return result;
	}

	@bindThis
	public async requestRefresh(userId: string, refreshToken: string, reason?: 'tuning'): Promise<HanamiUserFeedRequestResult> {
		const startedAt = performance.now();
		const kind: HanamiFeedEventKind = reason === 'tuning' ? 'tuning' : 'refresh';
		// A missing counter means unavailable, not zero. Initialize only when this
		// instrumentation actually observes requests; retain through the query horizon.
		const metricsKey = `hanami:metrics:429:${jstDay()}`;
		try { await this.metricsRedis?.set(metricsKey, '0', 'EX', 105 * 86400, 'NX'); } catch { /* serving remains independent */ }
		let refreshDigest: Buffer;
		try {
			refreshDigest = computeHanamiRefreshTokenDigest(refreshToken);
		} catch {
			return { kind: 'invalidRefreshToken' };
		}

		let decision: PendingDecision;
		let refreshOutcome: 'stock' | 'pending' | 'repeat' = 'pending';
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
						backgroundBatchId: null,
						waitForGeneration: false,
					};
				}

				await this.deleteExpiredMatchingRefresh(queryRunner, userId, refreshDigest);
				const existing = await this.lockRefreshMappings(queryRunner, userId, refreshDigest);
				if (existing.some((row) => row.epoch_id !== context.state?.epoch_id)) {
					return { result: { kind: 'refreshTokenExpired' }, batchId: null, refreshDigest: null, backgroundBatchId: null, waitForGeneration: false };
				}
				const currentMapping = existing.find((row) => row.epoch_id === context.state?.epoch_id);
				if (currentMapping != null) {
					if (currentMapping.status === 'obsolete') {
						return { result: { kind: 'refreshTokenExpired' }, batchId: null, refreshDigest: null, backgroundBatchId: null, waitForGeneration: false };
					}
					if (currentMapping.status === 'ready' || currentMapping.status === 'failed') {
						// 同じ token のやり直し。ストックのヒットとは数えない。
						refreshOutcome = 'repeat';
						return { result: this.terminalMappingResult(currentMapping), batchId: null, refreshDigest: null, backgroundBatchId: null, waitForGeneration: false };
					}
					const requestedBatches = await queryRunner.query(`
						SELECT b."status" AS status
						FROM "hanami_user_feed_batch" b
						WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3
					`, [currentMapping.requested_batch_id, userId, currentMapping.epoch_id]) as Array<{ status: BatchRow['status'] }>;
					if (requestedBatches.at(0)?.status === 'obsolete') {
						return { result: { kind: 'refreshTokenExpired' }, batchId: null, refreshDigest: null, backgroundBatchId: null, waitForGeneration: false };
					}

					const fallback = await this.requireStateHead(queryRunner, context.state!);
					return {
						result: this.pendingResult(fallback, currentMapping.requested_batch_id),
						batchId: currentMapping.requested_batch_id,
						refreshDigest,
						backgroundBatchId: null,
						waitForGeneration: false,
					};
				}

				if (await this.isRefreshRateLimited(queryRunner, userId, reason)) {
					return { result: { kind: 'refreshRateLimited' }, batchId: null, refreshDigest: null, backgroundBatchId: null, waitForGeneration: false };
				}

				let state = context.state;
				let backgroundBatchId: string | null = null;
				// ストックを表に出すのは更新のときだけ。新しくて形が合えば待たずに先頭へ繰り上げる。
				if (reason !== 'tuning' && state != null && state.mode === 'personalized' && context.activeBatch == null
					&& state.stock_batch_id != null) {
					if (await this.isFreshServedStock(queryRunner, state)) {
						refreshOutcome = 'stock';
						const stockBatchId = state.stock_batch_id;
						const newLatestSequence = await this.promoteStockToHead(queryRunner, state, stockBatchId);
						await queryRunner.query(`
							INSERT INTO "hanami_user_feed_refresh" (
								"userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status",
								"resultMode", "resultFeedEpochId", "resultHeadBatchId", "resultHeadSequence", "createdAt", "expiresAt"
							)
							VALUES ($1, $2, $3, $4, 'ready', 'personalized', $2, $4, $5::bigint, clock_timestamp(),
								clock_timestamp() + INTERVAL '${REFRESH_TTL_MINUTES} minutes')
						`, [userId, state.epoch_id, refreshDigest, stockBatchId, newLatestSequence]);
						// 繰り上げたストックの次を裏で作り始める。表の並びはここでは変えない。
						context.state = { ...state, latest_ready_batch_id: stockBatchId, latest_sequence: newLatestSequence, stock_batch_id: null, stock_sequence: null };
						backgroundBatchId = await this.startPrefetchIfEligible(queryRunner, context, 'afterPromote');
						return {
							result: {
								kind: 'serve',
								head: { mode: 'personalized', kind: 'personal', feedEpochId: state.epoch_id, headBatchId: stockBatchId, headSequence: newLatestSequence },
								generationPending: false,
								requestedBatchId: stockBatchId,
							},
							batchId: null,
							refreshDigest: null,
							backgroundBatchId,
							waitForGeneration: false,
						};
					}
					// 古い・形が合わないストックは捨てて、今までどおり refresh の batch を作る。
					await this.discardStock(queryRunner, userId, state.epoch_id, state.stock_batch_id, 'stale');
					state = { ...state, stock_batch_id: null, stock_sequence: null };
					context.state = state;
				}

				if (reason !== 'tuning' && state != null && state.mode === 'personalized' && state.latest_ready_batch_id != null && context.activeBatch == null
					&& await this.isUnservedReadyHead(queryRunner, state)) {
					refreshOutcome = 'stock';
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
						backgroundBatchId: null,
						waitForGeneration: false,
					};
				}

				// tuning は設定が古いのでストックを使わない。先に捨ててから作り直す。
				if (reason === 'tuning' && state != null && state.stock_batch_id != null) {
					await this.discardStock(queryRunner, userId, state.epoch_id, state.stock_batch_id, 'tuning');
					state = { ...state, stock_batch_id: null, stock_sequence: null };
					context.state = state;
				}

				// A tuning request must use a fresh settings snapshot. Fence an older
				// worker without retiring the epoch or touching ready feed entries.
				if (reason === 'tuning' && context.activeBatch != null && state != null) {
					await queryRunner.query(`UPDATE "hanami_user_feed_batch" SET status = 'obsolete', "leaseOwner" = NULL,
						"leaseExpiresAt" = NULL, "finishedAt" = clock_timestamp() WHERE id = $1`, [context.activeBatch.id]);
					await queryRunner.query(`UPDATE "hanami_user_feed_refresh" SET status = 'obsolete'
						WHERE "requestedBatchId" = $1 AND status = 'pending'`, [context.activeBatch.id]);
					await queryRunner.query(`UPDATE "hanami_user_feed_state" SET "generatingBatchId" = NULL
						WHERE "userId" = $1 AND "epochId" = $2`, [userId, state.epoch_id]);
					state = { ...state, generating_batch_id: null };
					context.activeBatch = null;
				}
				// 更新がストック用の生成中に来たら、そのまま refresh として先頭に出す（R4）。reason は残す。
				if (context.activeBatch != null && context.activeBatch.trigger === 'prefetch') {
					await queryRunner.query(`
						UPDATE "hanami_user_feed_batch"
						SET "trigger" = 'refresh'
						WHERE "id" = $1 AND "status" IN ('pending', 'generating') AND "trigger" = 'prefetch'
					`, [context.activeBatch.id]);
					context.activeBatch = { ...context.activeBatch, trigger: 'refresh' };
				}

				let batchId: string;
				if (state == null || state.initial_state === 'notEvaluated') {
					const commonHead = await this.requireLockedCommonHead(queryRunner);
					const started = await this.startInitialGeneration(queryRunner, context, commonHead, 'open');
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
					const created = await this.startRefreshGeneration(queryRunner, state, commonHead, reason === 'tuning' ? 'tuning' : 'refresh');
					state = created.state;
					batchId = created.batchId;
				}

				await queryRunner.query(`
					INSERT INTO "hanami_user_feed_refresh" (
						"userId", "epochId", "refreshTokenDigest", "requestedBatchId", "status", "createdAt", "expiresAt", "reason"
					)
					VALUES ($1, $2, $3, $4, 'pending', clock_timestamp(),
						clock_timestamp() + INTERVAL '${REFRESH_TTL_MINUTES} minutes', $5)
				`, [userId, state.epoch_id, refreshDigest, batchId, reason ?? 'normal']);

				const fallback = await this.requireStateHead(queryRunner, state);
				return {
					result: this.pendingResult(fallback, batchId),
					batchId,
					refreshDigest,
					backgroundBatchId,
					waitForGeneration: false,
				};
			});
		} catch (error) {
			if (error instanceof HanamiCommonNotReadyError) return { kind: 'commonNotReady' };
			throw error;
		}

		if (decision.result.kind === 'refreshRateLimited') {
			try { await this.metricsRedis?.incr(metricsKey); } catch { /* serving remains independent */ }
		}
		const result = await this.dispatchAndWait(userId, decision);
		// 記録は返す結果から決める（使えない人・回数制限・token 切れを pending やヒットに混ぜない）。
		const outcome = result.kind === 'serve'
			? (result.generationPending ? 'pending' : refreshOutcome === 'pending' ? 'head' : refreshOutcome)
			: result.kind === 'refreshRateLimited' ? 'rateLimited'
				: result.kind === 'refreshTokenExpired' ? 'expired'
					: 'unavailable';
		this.recordEvent(kind, userId, outcome, undefined, Math.max(0, Math.round(performance.now() - startedAt)));
		return result;
	}

	/** ほかの TL を見たときの先回り（30 分に 1 回まで）。呼び出し側は待たない。 */
	@bindThis
	public prewarm(userId: string): void {
		void this.runPrewarm(userId).catch((error) => {
			this.logger.warn('Failed to prewarm Hanami stock', { userId, e: error });
		});
	}

	private async runPrewarm(userId: string): Promise<void> {
		if (this.metricsRedis == null) return;
		// 30 分に 1 回まで。SET NX が取れなければ何もしない。
		const key = `${HANAMI_FEED_PREWARM_KEY_PREFIX}${userId}`;
		const acquired = await this.metricsRedis.set(key, '1', 'EX', HANAMI_FEED_PREWARM_TTL_SECONDS, 'NX');
		if (acquired == null) return;

		let batchId: string | null = null;
		let outcome: 'initial' | 'prefetch' | 'skip' = 'skip';
		try {
			batchId = await this.withTransaction(async (queryRunner) => {
				const context = await this.lockContext(queryRunner, userId);
				if (context.user.is_hibernated) return null;
				const availability = await this.evaluateAvailability(queryRunner, userId);
				if (availability.kind !== 'available') return null;

				// state が無い／notEvaluated → 初回の生成を先に作る（共通の先頭が無ければ何もしない）。
				if (context.state == null || context.state.initial_state === 'notEvaluated') {
					const commonHead = await this.commonHeadQueries.readLatestReadyCommonHead(queryRunner);
					if (commonHead == null) return null;
					const started = await this.startInitialGeneration(queryRunner, context, commonHead, 'prewarm');
					outcome = 'initial';
					return started.batchId;
				}

				const state = context.state;
				// personalized・active batch なし → ストックが無い／60 分より古ければ prefetch を作る。
				if (state.mode === 'personalized' && context.activeBatch == null) {
					if (state.stock_batch_id != null && await this.isStockFresherThan(queryRunner, state, STOCK_REFRESH_AFTER_MINUTES)) {
						return null;
					}
					if (state.stock_batch_id != null) {
						await this.discardStock(queryRunner, userId, state.epoch_id, state.stock_batch_id, 'prewarm');
						context.state = { ...state, stock_batch_id: null, stock_sequence: null };
					}
					const created = await this.startPrefetchIfEligible(queryRunner, context, 'prewarm');
					outcome = created == null ? 'skip' : 'prefetch';
					return created;
				}
				return null;
			});
		} catch (error) {
			this.logger.warn('Failed to prewarm Hanami stock', { userId, e: error });
			return;
		}
		this.recordEvent('prewarm', userId, outcome, batchId ?? undefined);
		if (batchId != null) {
			try {
				await this.queueService.enqueueHanamiUserFeedGeneration(batchId);
			} catch (error) {
				this.logQueueFailure(userId, batchId, error);
			}
		}
	}

	/** しばらくぶり（30 分以上見ていない）personalized の開き方。更新と同じくストックを出す。 */
	private async evaluateSessionStock(queryRunner: QueryRunner, context: LockedContext, state: StateRow, head: HanamiFeedHeadSnapshot): Promise<PendingDecision> {
		// 先頭を動かす生成（refresh）が進行中なら、新しく作らずそれを待つ形で返す（一人に active batch は 1 つだけ）。
		if (context.activeBatch != null && context.activeBatch.trigger !== 'prefetch') {
			return {
				result: this.pendingResult(head, context.activeBatch.id),
				batchId: context.activeBatch.id,
				refreshDigest: null,
				backgroundBatchId: null,
				waitForGeneration: false,
			};
		}
		// 使えるストックがあれば繰り上げて返す（refresh mapping は作らない）。
		if (context.activeBatch == null && state.stock_batch_id != null && await this.isFreshServedStock(queryRunner, state)) {
			const stockBatchId = state.stock_batch_id;
			const newLatestSequence = await this.promoteStockToHead(queryRunner, state, stockBatchId);
			context.state = { ...state, latest_ready_batch_id: stockBatchId, latest_sequence: newLatestSequence, stock_batch_id: null, stock_sequence: null };
			const backgroundBatchId = await this.startPrefetchIfEligible(queryRunner, context, 'afterPromote');
			return {
				result: {
					kind: 'serve',
					head: { mode: 'personalized', kind: 'personal', feedEpochId: state.epoch_id, headBatchId: stockBatchId, headSequence: newLatestSequence },
					generationPending: false,
					requestedBatchId: stockBatchId,
				},
				batchId: null,
				refreshDigest: null,
				backgroundBatchId,
				waitForGeneration: false,
			};
		}
		// 先に作ったばかりでまだ見ていない先頭（prewarm の初回など）は、作り直さずにそのまま出す。
		// 生成中の prefetch はそのままストックになる（startPrefetchIfEligible は active batch があれば作らない）。
		if (await this.isUnservedReadyHead(queryRunner, state)) {
			const backgroundBatchId = await this.startPrefetchIfEligible(queryRunner, context, 'afterServe');
			return {
				result: { kind: 'serve', head, generationPending: false, requestedBatchId: null },
				batchId: null,
				refreshDigest: null,
				backgroundBatchId,
				waitForGeneration: false,
			};
		}
		// 使えるストックが無く prefetch が生成中 → refresh に変えて待たずに pending。
		if (context.activeBatch != null && context.activeBatch.trigger === 'prefetch') {
			await queryRunner.query(`
				UPDATE "hanami_user_feed_batch"
				SET "trigger" = 'refresh'
				WHERE "id" = $1 AND "status" IN ('pending', 'generating') AND "trigger" = 'prefetch'
			`, [context.activeBatch.id]);
			context.activeBatch = { ...context.activeBatch, trigger: 'refresh' };
			return {
				result: this.pendingResult(head, context.activeBatch.id),
				batchId: context.activeBatch.id,
				refreshDigest: null,
				backgroundBatchId: null,
				waitForGeneration: false,
			};
		}
		// どちらも無い → refresh batch（reason session）。ストックが古ければ stale で捨ててから。
		if (state.stock_batch_id != null) {
			await this.discardStock(queryRunner, state.user_id, state.epoch_id, state.stock_batch_id, 'stale');
			context.state = { ...state, stock_batch_id: null, stock_sequence: null };
		}
		const commonHead = await this.requireLockedCommonHead(queryRunner);
		const created = await this.startRefreshGeneration(queryRunner, context.state ?? state, commonHead, 'session');
		return {
			result: this.pendingResult(head, created.batchId),
			batchId: created.batchId,
			refreshDigest: null,
			backgroundBatchId: null,
			waitForGeneration: false,
		};
	}

	/** ストックを先頭へ繰り上げ、batch に promotedAt を入れる。新しい latestSequence を返す。 */
	private async promoteStockToHead(queryRunner: QueryRunner, state: StateRow, stockBatchId: string): Promise<string> {
		const promoted = hanamiReturningRows(await queryRunner.query(`
			UPDATE "hanami_user_feed_state"
			SET "latestReadyBatchId" = "stockBatchId",
				"latestSequence" = "stockSequence",
				"stockBatchId" = NULL,
				"stockSequence" = NULL,
				"updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "stockBatchId" = $3 AND "generatingBatchId" IS NULL
			RETURNING "latestSequence"::text AS latest_sequence
		`, [state.user_id, state.epoch_id, stockBatchId]) as Array<{ latest_sequence: string }>);
		if (promoted.length !== 1) throw new Error('Failed to promote the Hanami stock batch to the head');
		await queryRunner.query(`
			UPDATE "hanami_user_feed_batch" SET "promotedAt" = clock_timestamp()
			WHERE "id" = $1 AND "userId" = $2 AND "status" = 'ready'
		`, [stockBatchId, state.user_id]);
		return promoted[0]!.latest_sequence;
	}

	/** 30 分以内に見たか（seen キーの有無）。Redis が無ければ「30 分以内」とみなす。 */
	private async isInSession(userId: string): Promise<boolean> {
		if (this.metricsRedis == null) return true;
		try {
			return await this.metricsRedis.exists(`${HANAMI_FEED_SEEN_KEY_PREFIX}${userId}`) === 1;
		} catch {
			return true;
		}
	}

	/** 出来事を記録する。失敗しても応答・生成には影響させない（関数側で握りつぶす）。 */
	private recordEvent(kind: HanamiFeedEventKind, userId: string, outcome: string, batchId?: string, durationMs?: number): void {
		if (this.metricsRedis == null) return;
		void recordHanamiFeedEvent(this.metricsRedis, {
			at: new Date().toISOString(),
			userId,
			kind,
			outcome,
			...(batchId != null ? { batchId } : {}),
			...(durationMs != null ? { durationMs } : {}),
		});
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
				s."stockBatchId" AS stock_batch_id,
				s."stockSequence"::text AS stock_sequence,
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
		reason: HanamiFeedStockReason,
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
		const inserted = await this.insertBatch(queryRunner, batchId, context.user.id, epochId, 'initial', commonHead.generationId, reason);
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
		reason: HanamiFeedStockReason,
	): Promise<{ batchId: string; state: StateRow }> {
		const batchId = this.idService.gen();
		const inserted = await this.insertBatch(queryRunner, batchId, state.user_id, state.epoch_id, 'refresh', commonHead.generationId, reason);
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
		trigger: 'initial' | 'refresh' | 'prefetch',
		baseCommonGenerationId: string,
		reason: HanamiFeedStockReason,
	): Promise<boolean> {
		const rows = await queryRunner.query(`
			INSERT INTO "hanami_user_feed_batch" (
				"id", "userId", "epochId", "trigger", "reason", "status", "attempts", "createdAt", "availableAt", "baseCommonGenerationId"
			)
			VALUES ($1, $2, $3, $4, $6, 'pending', 0, clock_timestamp(), clock_timestamp(), $5)
			ON CONFLICT ("userId") WHERE "status" IN ('pending', 'generating') DO NOTHING
			RETURNING "id" AS id
		`, [batchId, userId, epochId, trigger, baseCommonGenerationId, reason]) as Array<{ id: string }>;
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

	private async isRefreshRateLimited(queryRunner: QueryRunner, userId: string, reason?: 'tuning'): Promise<boolean> {
		const rows = await queryRunner.query(`
			SELECT COUNT(*)::text AS count
			FROM "hanami_user_feed_refresh" r
			WHERE r."userId" = $1
				AND r."createdAt" > clock_timestamp() - INTERVAL '1 minute' AND r."reason" = $2
		`, [userId, reason ?? 'normal']) as Array<{ count: string }>;
		return Number(rows.at(0)?.count ?? '0') >= (reason === 'tuning' ? 10 : REFRESH_RATE_LIMIT);
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

	/**
	 * ストックを捨てる。同じトランザクション内で state の stock 2 列を NULL にし、
	 * 先頭より上にある entry を消し、ready の batch を obsolete にして discardReason を残す。
	 */
	private async discardStock(queryRunner: QueryRunner, userId: string, epochId: string, stockBatchId: string, reason: HanamiFeedDiscardReason): Promise<void> {
		await queryRunner.query(`
			UPDATE "hanami_user_feed_state"
			SET "stockBatchId" = NULL, "stockSequence" = NULL, "updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "stockBatchId" = $3
		`, [userId, epochId, stockBatchId]);
		await queryRunner.query(`
			DELETE FROM "hanami_user_feed_entry"
			WHERE "userId" = $1 AND "epochId" = $2 AND "batchId" = $3
		`, [userId, epochId, stockBatchId]);
		await queryRunner.query(`
			UPDATE "hanami_user_feed_batch"
			SET "status" = 'obsolete', "discardReason" = $3
			WHERE "id" = $1 AND "userId" = $2 AND "status" = 'ready'
		`, [stockBatchId, userId, reason]);
		this.recordEvent('discard', userId, reason, stockBatchId);
	}

	/**
	 * 条件をすべて満たすときだけ trigger='prefetch' の batch を作って generatingBatchId に入れ、
	 * batchId を返す。満たさなければ null（例外にしない）。可用性は呼び出し側で確認済みを前提とする。
	 */
	private async startPrefetchIfEligible(queryRunner: QueryRunner, context: LockedContext, reason: HanamiFeedStockReason): Promise<string | null> {
		const state = context.state;
		if (context.user.is_hibernated) return null;
		if (state == null || state.mode !== 'personalized') return null;
		if (state.latest_ready_batch_id == null) return null;
		if (state.generating_batch_id != null) return null;
		if (context.activeBatch != null) return null;
		if (state.stock_batch_id != null) return null;

		// 普通に開くたびに通るので共通の先頭はロックしない（共通の生成の publish と取り合わない）。
		// base は FK で守られ、ready でなくなった場合は claim と reconcile が batch を止める。
		const commonHead = await this.commonHeadQueries.readLatestReadyCommonHead(queryRunner);
		if (commonHead == null) return null;

		const batchId = this.idService.gen();
		const inserted = await this.insertBatch(queryRunner, batchId, state.user_id, state.epoch_id, 'prefetch', commonHead.generationId, reason);
		if (!inserted) return null;
		const updated = hanamiReturningRows(await queryRunner.query(`
			UPDATE "hanami_user_feed_state"
			SET "generatingBatchId" = $3, "updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" IS NULL AND "stockBatchId" IS NULL
			RETURNING "userId" AS user_id
		`, [state.user_id, state.epoch_id, batchId]) as Array<{ user_id: string }>);
		if (updated.length !== 1) throw new Error('Failed to install the Hanami prefetch generation batch');
		return batchId;
	}

	/** 更新で表に出してよいストックか（ready・十分新しく・先頭に正しく連なる・空でない）。 */
	private async isFreshServedStock(queryRunner: QueryRunner, state: StateRow): Promise<boolean> {
		if (state.stock_batch_id == null || state.stock_sequence == null) return false;
		const rows = await queryRunner.query(`
			SELECT b."id" AS id
			FROM "hanami_user_feed_batch" b
			WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
				AND b."finishedAt" > clock_timestamp() - INTERVAL '${STOCK_MAX_AGE_MINUTES} minutes'
				AND b."itemCount" > 0
				AND $4::bigint = $5::bigint + b."itemCount"
		`, [state.stock_batch_id, state.user_id, state.epoch_id, state.stock_sequence, state.latest_sequence]) as Array<{ id: string }>;
		return rows.length === 1;
	}

	/** ストックの batch が指定分数より新しいか（作り直しの要否判定に使う）。 */
	private async isStockFresherThan(queryRunner: QueryRunner, state: StateRow, minutes: number): Promise<boolean> {
		if (state.stock_batch_id == null) return false;
		const rows = await queryRunner.query(`
			SELECT b."id" AS id
			FROM "hanami_user_feed_batch" b
			WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3
				AND b."finishedAt" > clock_timestamp() - ($4::text || ' minutes')::interval
		`, [state.stock_batch_id, state.user_id, state.epoch_id, String(minutes)]) as Array<{ id: string }>;
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
			backgroundBatchId: null,
			waitForGeneration: false,
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
			stock_batch_id: null,
			stock_sequence: null,
			latest_sequence: '0',
			earliest_retained_sequence: '0',
			common_epoch_id: commonHead?.epochId ?? null,
			common_generation_id: commonHead?.generationId ?? null,
			common_sequence: commonHead?.headSequence ?? null,
		};
	}

	private async dispatchAndWait(userId: string, decision: PendingDecision): Promise<HanamiUserFeedRequestResult> {
		// ストック用の生成は裏で進める。待たず、失敗しても応答には影響させない（I4）。
		if (decision.backgroundBatchId != null) {
			try {
				void Promise.resolve(this.queueService.enqueueHanamiUserFeedGeneration(decision.backgroundBatchId))
					.catch((error) => this.logQueueFailure(userId, decision.backgroundBatchId!, error));
			} catch (error) {
				this.logQueueFailure(userId, decision.backgroundBatchId!, error);
			}
		}
		if (decision.batchId == null || decision.result.kind !== 'serve' || !decision.result.generationPending) return decision.result;
		// 初めての生成（trigger='initial'）だけ待つ。refresh・tuning・session・生成中への合流は enqueue だけしてすぐ返す。
		if (!decision.waitForGeneration) {
			try {
				void Promise.resolve(this.queueService.enqueueHanamiUserFeedGeneration(decision.batchId))
					.catch((error) => this.logQueueFailure(userId, decision.batchId!, error));
			} catch (error) {
				this.logQueueFailure(userId, decision.batchId!, error);
			}
			return decision.result;
		}
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
