/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { computeHanamiRefreshTokenDigest } from './HanamiFeedCodec.js';
import { HanamiUserRecommendationService } from './HanamiUserRecommendationService.js';

const MAX_BATCH_SIZE = 210;
const REFRESH_TTL_MINUTES = 15;
const REFRESH_RATE_LIMIT = 3;
const STALE_BATCH_MS = 5 * 60_000;
const CURSOR_PREFIX = 'hur1';
const PG_BIGINT_MAX = '9223372036854775807';

type CursorMode = 'widget' | 'history';

type RecommendationCursor = {
	userId: string;
	epochId: string;
	mode: CursorMode;
	batchId: string | null;
	ordinal: string;
	rank: string;
};

type RecommendationRequest = {
	limit: number;
	cursor: string | null;
	history: boolean;
	refresh: boolean;
	refreshToken: string | null;
};

type RecommendationRow = {
	recommendation_entry_id: string;
	batch_id: string;
	batch_generated_at: Date | string;
	batch_ordinal: string;
	rank: string;
	recommended_user_id: string;
	reason: unknown;
	mutual_count: number;
};

type RecommendationState = {
	epoch_id: string;
	latest_ready_batch_id: string | null;
	latest_ordinal: string;
	generating_batch_id: string | null;
	initial_state: 'notEvaluated' | 'requested' | 'ready' | 'failed' | 'skippedUnavailable';
};

type PreparedRequest = {
	kind: 'ready';
	epochId: string;
	batchToGenerate: string | null;
	requestedBatchId: string | null;
} | {
	kind: 'empty';
} | {
	kind: 'roleDisabled' | 'refreshTokenExpired' | 'refreshRateLimited';
};

export type HanamiUserRecommendationPageResult = {
	kind: 'ok';
	response: {
		items: Array<{
			recommendationEntryId: string;
			batchId: string;
			batchGeneratedAt: string;
			user: Awaited<ReturnType<UserEntityService['packMany']>>[number];
			reason: string;
			mutualCount: number;
		}>;
		nextCursor: string | null;
		hasMore: boolean;
	};
} | {
	kind: 'invalidCursor' | 'cursorExpired' | 'invalidRefreshToken' | 'refreshTokenExpired' | 'refreshRateLimited' | 'roleDisabled';
};

@Injectable()
export class HanamiUserRecommendationPageService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,
		@Inject(DI.config)
		private config: Config,
		private idService: IdService,
		private roleService: RoleService,
		private userEntityService: UserEntityService,
		private recommendationService: HanamiUserRecommendationService,
	) {}

	@bindThis
	public async serve(me: MiLocalUser, request: RecommendationRequest): Promise<HanamiUserRecommendationPageResult> {
		let cursor: RecommendationCursor | null = null;
		if (request.cursor != null) {
			try {
				cursor = this.decodeCursor(request.cursor);
			} catch (error) {
				return { kind: error instanceof CursorKeyExpiredError ? 'cursorExpired' : 'invalidCursor' };
			}
			if (cursor.userId !== me.id || cursor.mode !== (request.history ? 'history' : 'widget')) {
				return { kind: 'invalidCursor' };
			}
		}

		let refreshDigest: Buffer | null = null;
		if (request.refresh) {
			if (request.refreshToken == null) return { kind: 'invalidRefreshToken' };
			try {
				refreshDigest = computeHanamiRefreshTokenDigest(request.refreshToken);
			} catch {
				return { kind: 'invalidRefreshToken' };
			}
		}

		const prepared = await this.prepareRequest(me.id, request, refreshDigest);
		if (prepared.kind === 'empty') return this.emptyPage();
		if (prepared.kind !== 'ready') return { kind: prepared.kind };
		if (cursor != null && cursor.epochId !== prepared.epochId) return { kind: 'cursorExpired' };

		if (prepared.batchToGenerate != null) {
			try {
				await this.generateBatch(me.id, prepared.epochId, prepared.batchToGenerate);
			} catch (error) {
				await this.failBatch(me.id, prepared.epochId, prepared.batchToGenerate);
				throw error;
			}
		}

		return await this.readPage(me, prepared.epochId, request, cursor, prepared.requestedBatchId);
	}

	private async prepareRequest(userId: string, request: RecommendationRequest, refreshDigest: Buffer | null): Promise<PreparedRequest> {
		return await this.withTransaction(async (queryRunner) => {
			const users = await queryRunner.query(`
				SELECT u."id" AS id, u."isHibernated" AS is_hibernated
				FROM "user" u WHERE u."id" = $1 FOR UPDATE OF u
			`, [userId]) as Array<{ id: string; is_hibernated: boolean }>;
			const user = users.at(0);
			if (user == null || user.is_hibernated) return { kind: 'empty' };

			const epochs = await queryRunner.query(`
				SELECT e."epochId" AS epoch_id
				FROM "hanami_user_feed_epoch" e
				WHERE e."userId" = $1 AND e."retiredAt" IS NULL
				ORDER BY e."createdAt" DESC, e."epochId" DESC
				FOR UPDATE OF e
			`, [userId]) as Array<{ epoch_id: string }>;
			if (epochs.length > 1) throw new Error(`User ${userId} has multiple active Hanami feed epochs`);
			let epochId = epochs.at(0)?.epoch_id;
			if (epochId == null) {
				epochId = this.idService.gen();
				await queryRunner.query(`
					INSERT INTO "hanami_user_feed_epoch" ("epochId", "userId", "createdAt", "retiredAt")
					VALUES ($1, $2, clock_timestamp(), NULL)
				`, [epochId, userId]);
			}

			let state = await this.lockState(queryRunner, userId);
			if (state == null) {
				await queryRunner.query(`
					INSERT INTO "hanami_user_recommendation_state" (
						"userId", "epochId", "latestReadyBatchId", "latestOrdinal",
						"generatingBatchId", "initialGenerationState", "updatedAt"
					) VALUES ($1, $2, NULL, '0'::bigint, NULL, 'notEvaluated', clock_timestamp())
				`, [userId, epochId]);
				state = await this.lockState(queryRunner, userId);
			} else if (state.epoch_id !== epochId) {
				await this.obsoleteRecommendationWork(queryRunner, userId, state.epoch_id);
				await queryRunner.query(`
					UPDATE "hanami_user_recommendation_state"
					SET "epochId" = $2, "latestReadyBatchId" = NULL, "latestOrdinal" = '0'::bigint,
						"generatingBatchId" = NULL, "initialGenerationState" = 'notEvaluated', "updatedAt" = clock_timestamp()
					WHERE "userId" = $1
				`, [userId, epochId]);
				state = await this.lockState(queryRunner, userId);
			}
			if (state == null) throw new Error('Hanami user recommendation state bootstrap failed');

			const policies = await this.roleService.getUserPolicies(userId, queryRunner.manager);
			if (policies.hanamiTlAvailable !== true) {
				await this.markUnavailable(queryRunner, userId);
				return { kind: 'roleDisabled' };
			}
			const profiles = await queryRunner.query(`
				SELECT p."hanamiRecommendationEnabled" AS enabled FROM "user_profile" p WHERE p."userId" = $1
			`, [userId]) as Array<{ enabled: boolean }>;
			if (profiles.at(0)?.enabled !== true) {
				await this.markUnavailable(queryRunner, userId);
				return { kind: 'ready', epochId, batchToGenerate: null, requestedBatchId: null };
			}

			let staleBatchId: string | null = null;
			if (state.generating_batch_id != null) {
				const batches = await queryRunner.query(`
					SELECT b."status" AS status, b."createdAt" AS created_at
					FROM "hanami_user_recommendation_batch" b
					WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3
					FOR UPDATE OF b
				`, [state.generating_batch_id, userId, epochId]) as Array<{ status: string; created_at: Date | string }>;
				const batch = batches.at(0);
				if (batch?.status === 'pending' && Date.now() - new Date(batch.created_at).getTime() >= STALE_BATCH_MS) {
					staleBatchId = state.generating_batch_id;
				}
			}

			if (request.cursor != null) return { kind: 'ready', epochId, batchToGenerate: null, requestedBatchId: null };
			if (request.refresh) {
				if (refreshDigest == null) throw new Error('Validated refresh request lost its digest');
				const mappings = await queryRunner.query(`
					SELECT r."epochId" AS epoch_id, r."requestedBatchId" AS requested_batch_id,
						r."status" AS status, r."resultBatchId" AS result_batch_id, r."expiresAt" AS expires_at
					FROM "hanami_user_recommendation_refresh" r
					WHERE r."userId" = $1 AND r."refreshTokenDigest" = $2
					ORDER BY r."epochId" FOR UPDATE OF r
				`, [userId, refreshDigest]) as Array<{
					epoch_id: string;
					requested_batch_id: string;
					result_batch_id: string | null;
					status: string;
					expires_at: Date | string;
				}>;
				if (mappings.some(mapping => mapping.epoch_id !== epochId)) return { kind: 'refreshTokenExpired' };
				const current = mappings.at(0);
				if (current != null) {
					if (new Date(current.expires_at).getTime() <= Date.now() || current.status === 'obsolete') return { kind: 'refreshTokenExpired' };
					return {
						kind: 'ready',
						epochId,
						batchToGenerate: current.status === 'pending' && current.requested_batch_id === staleBatchId ? current.requested_batch_id : null,
						requestedBatchId: current.status === 'ready' ? current.result_batch_id : null,
					};
				}

				const rateRows = await queryRunner.query(`
					SELECT count(*)::int AS count
					FROM "hanami_user_recommendation_refresh"
					WHERE "userId" = $1 AND "createdAt" > clock_timestamp() - INTERVAL '1 minute'
				`, [userId]) as Array<{ count: number }>;
				if (Number(rateRows.at(0)?.count ?? 0) >= REFRESH_RATE_LIMIT) return { kind: 'refreshRateLimited' };

				let batchId = state.generating_batch_id;
				let batchToGenerate: string | null = staleBatchId;
				if (batchId == null) {
					batchId = this.idService.gen();
					await this.insertBatch(queryRunner, batchId, userId, epochId, 'refresh');
					await this.markGenerating(queryRunner, userId, batchId);
					batchToGenerate = batchId;
				}
				await queryRunner.query(`
					INSERT INTO "hanami_user_recommendation_refresh" (
						"userId", "epochId", "refreshTokenDigest", "requestedBatchId", "resultBatchId",
						"status", "createdAt", "expiresAt"
					) VALUES ($1, $2, $3, $4, NULL, 'pending', clock_timestamp(), clock_timestamp() + INTERVAL '${REFRESH_TTL_MINUTES} minutes')
				`, [userId, epochId, refreshDigest, batchId]);
				return { kind: 'ready', epochId, batchToGenerate, requestedBatchId: batchId };
			}

			if (state.initial_state === 'notEvaluated') {
				const batchId = this.idService.gen();
				await this.insertBatch(queryRunner, batchId, userId, epochId, 'initial');
				await this.markGenerating(queryRunner, userId, batchId);
				return { kind: 'ready', epochId, batchToGenerate: batchId, requestedBatchId: batchId };
			}
			if (state.initial_state === 'requested' && staleBatchId != null) {
				return { kind: 'ready', epochId, batchToGenerate: staleBatchId, requestedBatchId: staleBatchId };
			}
			return { kind: 'ready', epochId, batchToGenerate: null, requestedBatchId: null };
		});
	}

	private async generateBatch(userId: string, epochId: string, batchId: string): Promise<void> {
		const candidates = await this.recommendationService.getFollowCandidates(userId, MAX_BATCH_SIZE);
		const generatedAt = Date.now();
		const rows = candidates.map((candidate, rank) => ({
			id: this.idService.gen(generatedAt),
			rank: String(rank),
			recommendedUserId: candidate.userId,
			reason: { version: 1, type: candidate.reason },
			mutualCount: candidate.mutualCount,
		}));

		await this.withTransaction(async (queryRunner) => {
			const users = await queryRunner.query(`SELECT "isHibernated" AS is_hibernated FROM "user" WHERE "id" = $1 FOR UPDATE`, [userId]) as Array<{ is_hibernated: boolean }>;
			const state = await this.lockState(queryRunner, userId);
			const batches = await queryRunner.query(`
				SELECT b."status" AS status FROM "hanami_user_recommendation_batch" b
				WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 FOR UPDATE OF b
			`, [batchId, userId, epochId]) as Array<{ status: string }>;
			if (users.at(0)?.is_hibernated !== false || state?.epoch_id !== epochId
				|| state.generating_batch_id !== batchId || batches.at(0)?.status !== 'pending') {
				return;
			}

			const nextOrdinal = (BigInt(state.latest_ordinal) + 1n).toString();
			if (rows.length > 0) {
				await queryRunner.query(`
					INSERT INTO "hanami_user_recommendation_entry" (
						"id", "userId", "epochId", "sequence", "batchId", "rank",
						"recommendedUserId", "reason", "mutualCount", "shownAt"
					)
					SELECT input.id, $1, $2,
						(($4::bigint - '1'::bigint) * ${MAX_BATCH_SIZE}::bigint) + input.rank::bigint + '1'::bigint,
						$3, input.rank::bigint, input.recommended_user_id, input.reason, input.mutual_count, NULL
					FROM jsonb_to_recordset($5::jsonb) AS input(
						id varchar, rank text, recommended_user_id varchar, reason jsonb, mutual_count integer
					)
				`, [userId, epochId, batchId, nextOrdinal, JSON.stringify(rows.map(row => ({
					id: row.id,
					rank: row.rank,
					recommended_user_id: row.recommendedUserId,
					reason: row.reason,
					mutual_count: row.mutualCount,
				}))) ]);
			}

			const updated = await queryRunner.query(`
				UPDATE "hanami_user_recommendation_batch"
				SET "ordinal" = $4::bigint, "status" = 'ready', "finishedAt" = clock_timestamp(), "itemCount" = $5
				WHERE "id" = $1 AND "userId" = $2 AND "epochId" = $3 AND "status" = 'pending'
				RETURNING "id"
			`, [batchId, userId, epochId, nextOrdinal, rows.length]) as Array<{ id: string }>;
			if (updated.length !== 1) throw new Error('Hanami recommendation batch publication lost its claim');
			await queryRunner.query(`
				UPDATE "hanami_user_recommendation_state"
				SET "latestReadyBatchId" = $3, "latestOrdinal" = $4::bigint, "generatingBatchId" = NULL,
					"initialGenerationState" = 'ready', "updatedAt" = clock_timestamp()
				WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" = $3
			`, [userId, epochId, batchId, nextOrdinal]);
			await queryRunner.query(`
				UPDATE "hanami_user_recommendation_refresh"
				SET "status" = 'ready', "resultBatchId" = $3
				WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
			`, [userId, epochId, batchId]);
		});
	}

	private async readPage(
		me: MiLocalUser,
		epochId: string,
		request: RecommendationRequest,
		cursor: RecommendationCursor | null,
		requestedBatchId: string | null,
	): Promise<HanamiUserRecommendationPageResult> {
		const states = await this.db.query(`
			SELECT s."epochId" AS epoch_id, s."latestReadyBatchId" AS latest_ready_batch_id
			FROM "hanami_user_recommendation_state" s
			JOIN "user" u ON u."id" = s."userId" AND u."isHibernated" = FALSE
			JOIN "hanami_user_feed_epoch" epoch ON epoch."userId" = s."userId" AND epoch."epochId" = s."epochId" AND epoch."retiredAt" IS NULL
			WHERE s."userId" = $1 AND s."epochId" = $2
		`, [me.id, epochId]) as Array<{ epoch_id: string; latest_ready_batch_id: string | null }>;
		const state = states.at(0);
		if (state == null) return this.emptyPage();
		if (!request.history && cursor != null && cursor.batchId !== state.latest_ready_batch_id) return { kind: 'cursorExpired' };
		const widgetBatchId = requestedBatchId ?? state.latest_ready_batch_id;
		if (!request.history && widgetBatchId == null) return this.emptyPage();

		const values: unknown[] = [me.id, epochId, request.limit + 1];
		let boundarySql: string;
		if (request.history) {
			if (cursor == null) {
				boundarySql = '';
			} else {
				values.push(cursor.ordinal, cursor.rank);
				boundarySql = `AND (b."ordinal" < $4::bigint OR (b."ordinal" = $4::bigint AND e."rank" > $5::bigint))`;
			}
		} else {
			values.push(widgetBatchId, cursor?.rank ?? '-1');
			boundarySql = `AND b."id" = $4 AND e."rank" > $5::bigint`;
		}

		const rows = await this.db.query(`
			SELECT e."id" AS recommendation_entry_id, e."batchId" AS batch_id,
				COALESCE(b."finishedAt", b."createdAt") AS batch_generated_at,
				b."ordinal"::text AS batch_ordinal, e."rank"::text AS rank,
				e."recommendedUserId" AS recommended_user_id, e."reason" AS reason,
				e."mutualCount" AS mutual_count
			FROM "hanami_user_recommendation_entry" e
			JOIN "hanami_user_recommendation_batch" b
				ON b."id" = e."batchId" AND b."userId" = e."userId" AND b."epochId" = e."epochId" AND b."status" = 'ready'
			JOIN "user" candidate ON candidate."id" = e."recommendedUserId"
			WHERE e."userId" = $1 AND e."epochId" = $2
				AND candidate."isSuspended" = FALSE AND candidate."isDeleted" = FALSE
				AND candidate."isExplorable" = TRUE AND candidate."isBot" = FALSE
				AND NOT EXISTS (SELECT 1 FROM "following" f WHERE f."followerId" = $1 AND f."followeeId" = e."recommendedUserId")
				AND NOT EXISTS (SELECT 1 FROM "follow_request" f WHERE f."followerId" = $1 AND f."followeeId" = e."recommendedUserId")
				AND NOT EXISTS (SELECT 1 FROM "blocking" block WHERE (block."blockerId" = $1 AND block."blockeeId" = e."recommendedUserId") OR (block."blockerId" = e."recommendedUserId" AND block."blockeeId" = $1))
				AND NOT EXISTS (SELECT 1 FROM "muting" mute WHERE mute."muterId" = $1 AND mute."muteeId" = e."recommendedUserId")
				${boundarySql}
			ORDER BY b."ordinal" DESC, e."rank" ASC
			LIMIT $3
		`, values) as RecommendationRow[];
		const hasMore = rows.length > request.limit;
		const pageRows = rows.slice(0, request.limit);
		if (pageRows.length === 0) return this.emptyPage();

		const users = await this.userEntityService.packMany(pageRows.map(row => row.recommended_user_id), me, { schema: 'UserDetailed' });
		const usersById = new Map(users.map(user => [user.id, user]));
		const retained = pageRows.filter(row => usersById.has(row.recommended_user_id));
		if (retained.length > 0) {
			await this.db.query(`
				UPDATE "hanami_user_recommendation_entry"
				SET "shownAt" = COALESCE("shownAt", clock_timestamp())
				WHERE "userId" = $1 AND "epochId" = $2 AND "id" = ANY($3::varchar[])
			`, [me.id, epochId, retained.map(row => row.recommendation_entry_id)]);
			await this.recommendationService.recordShown(me.id, retained.map(row => row.recommended_user_id)).catch(() => undefined);
		}

		const last = retained.at(-1);
		const nextCursor = hasMore && last != null
			? this.encodeCursor({
				userId: me.id,
				epochId,
				mode: request.history ? 'history' : 'widget',
				batchId: request.history ? null : last.batch_id,
				ordinal: last.batch_ordinal,
				rank: last.rank,
			})
			: null;
		return {
			kind: 'ok',
			response: {
				items: retained.map(row => ({
					recommendationEntryId: row.recommendation_entry_id,
					batchId: row.batch_id,
					batchGeneratedAt: new Date(row.batch_generated_at).toISOString(),
					user: usersById.get(row.recommended_user_id)!,
					reason: this.reasonType(row.reason),
					mutualCount: Number(row.mutual_count),
				})),
				nextCursor,
				hasMore: nextCursor != null,
			},
		};
	}

	private emptyPage(): Extract<HanamiUserRecommendationPageResult, { kind: 'ok' }> {
		return { kind: 'ok', response: { items: [], nextCursor: null, hasMore: false } };
	}

	private reasonType(value: unknown): string {
		if (typeof value === 'object' && value != null && !Array.isArray(value) && typeof (value as Record<string, unknown>).type === 'string') {
			return (value as Record<string, string>).type;
		}
		return 'fof';
	}

	private async lockState(queryRunner: QueryRunner, userId: string): Promise<RecommendationState | null> {
		const rows = await queryRunner.query(`
			SELECT s."epochId" AS epoch_id, s."latestReadyBatchId" AS latest_ready_batch_id,
				s."latestOrdinal"::text AS latest_ordinal, s."generatingBatchId" AS generating_batch_id,
				s."initialGenerationState" AS initial_state
			FROM "hanami_user_recommendation_state" s WHERE s."userId" = $1 FOR UPDATE OF s
		`, [userId]) as RecommendationState[];
		return rows.at(0) ?? null;
	}

	private async insertBatch(queryRunner: QueryRunner, batchId: string, userId: string, epochId: string, trigger: 'initial' | 'refresh'): Promise<void> {
		await queryRunner.query(`
			INSERT INTO "hanami_user_recommendation_batch" (
				"id", "userId", "epochId", "ordinal", "trigger", "status", "attempts",
				"createdAt", "availableAt", "leaseOwner", "leaseExpiresAt", "startedAt",
				"finishedAt", "itemCount", "checksum"
			) VALUES ($1, $2, $3, NULL, $4, 'pending', 1, clock_timestamp(), clock_timestamp(), NULL, NULL, clock_timestamp(), NULL, 0, NULL)
		`, [batchId, userId, epochId, trigger]);
	}

	private async markGenerating(queryRunner: QueryRunner, userId: string, batchId: string): Promise<void> {
		await queryRunner.query(`
			UPDATE "hanami_user_recommendation_state"
			SET "generatingBatchId" = $2, "initialGenerationState" = 'requested', "updatedAt" = clock_timestamp()
			WHERE "userId" = $1
		`, [userId, batchId]);
	}

	private async markUnavailable(queryRunner: QueryRunner, userId: string): Promise<void> {
		await queryRunner.query(`
			UPDATE "hanami_user_recommendation_state"
			SET "initialGenerationState" = 'skippedUnavailable', "updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "latestReadyBatchId" IS NULL AND "generatingBatchId" IS NULL
		`, [userId]);
	}

	private async obsoleteRecommendationWork(queryRunner: QueryRunner, userId: string, epochId: string): Promise<void> {
		await queryRunner.query(`
			UPDATE "hanami_user_recommendation_batch"
			SET "status" = 'obsolete', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "finishedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "status" IN ('pending', 'generating')
		`, [userId, epochId]);
		await queryRunner.query(`
			UPDATE "hanami_user_recommendation_refresh" SET "status" = 'obsolete', "resultBatchId" = NULL
			WHERE "userId" = $1 AND "epochId" = $2 AND "status" = 'pending'
		`, [userId, epochId]);
	}

	private async failBatch(userId: string, epochId: string, batchId: string): Promise<void> {
		await this.db.query(`
			WITH failed AS (
				UPDATE "hanami_user_recommendation_batch"
				SET "status" = 'failed', "finishedAt" = clock_timestamp()
				WHERE "id" = $3 AND "userId" = $1 AND "epochId" = $2 AND "status" = 'pending'
				RETURNING "id"
			)
			UPDATE "hanami_user_recommendation_state"
			SET "generatingBatchId" = NULL,
				"initialGenerationState" = CASE WHEN "latestReadyBatchId" IS NULL THEN 'failed' ELSE "initialGenerationState" END,
				"updatedAt" = clock_timestamp()
			WHERE "userId" = $1 AND "epochId" = $2 AND "generatingBatchId" = $3 AND EXISTS (SELECT 1 FROM failed)
		`, [userId, epochId, batchId]);
		await this.db.query(`
			UPDATE "hanami_user_recommendation_refresh" SET "status" = 'failed', "resultBatchId" = NULL
			WHERE "userId" = $1 AND "epochId" = $2 AND "requestedBatchId" = $3 AND "status" = 'pending'
		`, [userId, epochId, batchId]);
	}

	private encodeCursor(cursor: RecommendationCursor): string {
		const keys = this.config.hanamiCursorSigningKeys;
		const key = keys[0]!;
		this.validateDecimal(cursor.ordinal, 'ordinal');
		this.validateDecimal(cursor.rank, 'rank');
		const payload = Buffer.from(JSON.stringify([
			'HUR', 1, key.id, cursor.userId, cursor.epochId, cursor.mode,
			cursor.batchId, cursor.ordinal, cursor.rank,
		]), 'utf8').toString('base64url');
		const signingInput = `${CURSOR_PREFIX}.${payload}`;
		const signature = createHmac('sha256', key.secret).update(signingInput, 'ascii').digest('base64url');
		return `${signingInput}.${signature}`;
	}

	private decodeCursor(cursor: string): RecommendationCursor {
		const parts = cursor.split('.');
		if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX || parts[1]!.includes('=') || parts[2]!.includes('=')) throw new Error('Invalid recommendation cursor');
		const payloadBuffer = Buffer.from(parts[1]!, 'base64url');
		if (payloadBuffer.toString('base64url') !== parts[1]) throw new Error('Non-canonical recommendation cursor');
		const value = JSON.parse(payloadBuffer.toString('utf8')) as unknown;
		if (!Array.isArray(value) || value.length !== 9 || value[0] !== 'HUR' || value[1] !== 1
			|| typeof value[2] !== 'string' || typeof value[3] !== 'string' || typeof value[4] !== 'string'
			|| (value[5] !== 'widget' && value[5] !== 'history')
			|| (value[6] !== null && typeof value[6] !== 'string') || typeof value[7] !== 'string' || typeof value[8] !== 'string') {
			throw new Error('Invalid recommendation cursor payload');
		}
		const key = this.config.hanamiCursorSigningKeys.find(candidate => candidate.id === value[2]);
		if (key == null) throw new CursorKeyExpiredError();
		const expected = createHmac('sha256', key.secret).update(`${CURSOR_PREFIX}.${parts[1]}`, 'ascii').digest();
		const signature = Buffer.from(parts[2]!, 'base64url');
		if (signature.toString('base64url') !== parts[2] || signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('Invalid recommendation cursor signature');
		this.validateDecimal(value[7], 'ordinal');
		this.validateDecimal(value[8], 'rank');
		if (value[3].length === 0 || value[4].length === 0 || (value[5] === 'widget' && (value[6] == null || value[6].length === 0)) || (value[5] === 'history' && value[6] !== null)) {
			throw new Error('Invalid recommendation cursor fields');
		}
		return { userId: value[3], epochId: value[4], mode: value[5], batchId: value[6], ordinal: value[7], rank: value[8] };
	}

	private validateDecimal(value: string, field: string): void {
		if (!/^(?:0|[1-9]\d*)$/.test(value) || value.length > PG_BIGINT_MAX.length || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
			throw new Error(`Invalid recommendation cursor ${field}`);
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
}

class CursorKeyExpiredError extends Error {}
