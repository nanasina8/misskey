/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DataSource, QueryRunner } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import {
	HANAMI_COMMON_GENERATION_READ,
	type HanamiCommonGenerationReadPort,
	type HanamiPersistedCommonCandidate,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import {
	type HanamiPersonalFeedCandidate,
	type HanamiPersonalFeedComputationInput,
	type HanamiPersonalFeedComputationPort,
	type HanamiPersonalFeedComputationResult,
	type HanamiPersonalFeedItem,
	HanamiInvalidPersonalSeedError,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { hanamiInterleave, type HanamiAxis, type ForYouCandidate } from '@/core/hanami/HanamiForYouInterleave.js';
import {
	HanamiForYouService,
	type HanamiPersonalFeedGenerationContext,
} from '@/core/hanami/HanamiForYouService.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { createHanamiExactTextFingerprint, createHanamiStrictBotTemplateFingerprint } from '@/core/hanami/HanamiForYouTextNormalization.js';
import { createHanamiQualityShadow, type HanamiRelationshipClass } from '@/core/hanami/HanamiForYouQualityContracts.js';

const MAX_SEGMENTS = 7;
const SEGMENT_SIZE = 30;
const MAX_COMMON_CANDIDATES = 900;
const COMMON_CANDIDATE_LIMITS = Object.freeze({ globalPopular: 200, trending: 200, exploration: 500 });
const GENERATION_LOCK_TIMEOUT_MS = 5000;

const CONFIGURE_DEADLINE_SQL = `
	WITH budget AS (
		SELECT floor(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)::bigint AS remaining_ms
	)
	SELECT
		set_config('statement_timeout', GREATEST(1, remaining_ms)::text, true) AS statement_timeout,
		set_config('lock_timeout', GREATEST(1, LEAST($2::bigint, remaining_ms))::text, true) AS lock_timeout
	FROM budget
	WHERE remaining_ms > 0
`;

type PendingRunnerOperation = {
	readonly kind: 'connect' | 'start' | 'query' | 'commit' | 'rollback' | 'release';
	completion: Promise<void>;
	settled: boolean;
};

type GenerationRunnerScope = {
	readonly queryRunner: QueryRunner;
	readonly signal: AbortSignal;
	readonly originalQuery: QueryRunner['query'];
	pending: PendingRunnerOperation | null;
	transactionStarted: boolean;
	released: boolean;
};

export const HANAMI_PERSONAL_FEED_ALGORITHM_VERSION = 'hanami-personal-v1';

/** Pure old-head check: a new item cannot repair an existing upper excess. */
export function hanamiHasUnhealablePersonalSeedHead(seed: readonly ForYouCandidate[], unknownSufficient: boolean): boolean {
	for (const size of [10, 30, 210] as const) {
		// Without W - 1 old entries no new-inclusive full W window exists yet.
		if (seed.length < size - 1) continue;
		const head = seed.slice(0, size - 1);
		const authorLimit = size === 10 ? 1 : size === 30 ? 2 : 6;
		const exceeds = (values: readonly string[], limit: number): boolean => {
			const counts = new Map<string, number>();
			for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
			return [...counts.values()].some(count => count > limit);
		};
		if (exceeds(head.flatMap(item => item.userId == null ? [] : [item.userId]), authorLimit)) return true;
		if (size !== 30) continue;
		if (exceeds(head.flatMap(item => item.exactTextFingerprint == null ? [] : [item.exactTextFingerprint]), 1)) return true;
		if (exceeds(head.flatMap(item => item.isBot === true && item.userId != null && item.strictBotTemplateFingerprint != null
			? [`${item.userId}\u0000${item.strictBotTemplateFingerprint}`] : []), 1)) return true;
		const direct = head.filter(item => item.relationshipClass === 'directFollow').length;
		const knownIncludingDirect = head.filter(item => item.relationshipClass === 'directFollow' || item.relationshipClass === 'known').length;
		if (direct > 6 || knownIncludingDirect > 12) return true;
		if (unknownSufficient && head.filter(item => item.relationshipClass === 'unknown').length < 14) return true;
	}
	return false;
}

@Injectable()
export class HanamiPersonalFeedComputationService implements HanamiPersonalFeedComputationPort {
	public readonly algorithmVersion = HANAMI_PERSONAL_FEED_ALGORITHM_VERSION;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(HANAMI_COMMON_GENERATION_READ)
		private commonGenerationRead: HanamiCommonGenerationReadPort,

		private hanamiForYouService: HanamiForYouService,
		private hanamiForYouSafetyService: HanamiForYouSafetyService,
		private hanamiForYouProvenanceService: HanamiForYouProvenanceService,
	) {
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (!signal.aborted) return;
		if (signal.reason !== undefined) throw signal.reason;
		const error = new Error('The operation was aborted');
		error.name = 'AbortError';
		throw error;
	}

	private async waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		this.throwIfAborted(signal);
		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (operation: () => void): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', onAbort);
				operation();
			};
			const onAbort = (): void => finish(() => reject(signal.reason));
			signal.addEventListener('abort', onAbort, { once: true });
			void promise.then(
				value => signal.aborted ? onAbort() : finish(() => resolve(value)),
				error => signal.aborted ? onAbort() : finish(() => reject(error)),
			);
			if (signal.aborted) onAbort();
		});
	}

	private async boundary<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		this.throwIfAborted(signal);
		const promise = Promise.resolve().then(operation);
		const result = await this.waitForAbort(promise, signal);
		this.throwIfAborted(signal);
		return result;
	}

	private async runRunnerOperation<T>(scope: GenerationRunnerScope, kind: PendingRunnerOperation['kind'], operation: () => Promise<T>): Promise<T> {
		this.throwIfAborted(scope.signal);
		if (scope.pending != null && !scope.pending.settled) throw new Error('Concurrent Hanami personal-generation QueryRunner use is not allowed');

		const driverPromise = Promise.resolve().then(operation);
		const pending: PendingRunnerOperation = {
			kind,
			settled: false,
			completion: Promise.resolve(),
		};
		pending.completion = driverPromise.then(
			() => { pending.settled = true; },
			() => { pending.settled = true; },
		);
		scope.pending = pending;
		try {
			const result = await this.waitForAbort(driverPromise, scope.signal);
			this.throwIfAborted(scope.signal);
			return result;
		} finally {
			if (pending.settled && scope.pending === pending) scope.pending = null;
		}
	}

	private attachCleanupError(primaryError: unknown, cleanupError: unknown): void {
		try {
			if (primaryError instanceof Error) {
				const annotated = primaryError as Error & { cleanupErrors?: unknown[] };
				annotated.cleanupErrors = [...(annotated.cleanupErrors ?? []), cleanupError];
			}
		} catch {
			// Cleanup diagnostics must not replace the generation failure.
		}
	}

	private async cleanupRunnerUnbounded(scope: GenerationRunnerScope, rollback: boolean, primaryError: unknown): Promise<void> {
		if (scope.released || scope.queryRunner.isReleased) {
			scope.released = true;
			return;
		}
		if (rollback && scope.queryRunner.isTransactionActive) {
			try {
				await scope.queryRunner.rollbackTransaction();
				scope.transactionStarted = false;
			} catch (error) {
				this.attachCleanupError(primaryError, error);
			}
		}
		if (!scope.queryRunner.isReleased) {
			try {
				await scope.queryRunner.release();
				scope.released = true;
			} catch (error) {
				this.attachCleanupError(primaryError, error);
			}
		}
	}

	private scheduleLateCleanup(scope: GenerationRunnerScope, rollback: boolean, primaryError: unknown): void {
		const pending = scope.pending;
		if (pending == null) {
			void this.cleanupRunnerUnbounded(scope, rollback, primaryError);
			return;
		}
		void pending.completion
			.then(async () => await this.cleanupRunnerUnbounded(scope, rollback, primaryError))
			.catch(error => this.attachCleanupError(primaryError, error));
	}

	private async cleanupRunnerBounded(scope: GenerationRunnerScope, rollback: boolean, primaryError: unknown): Promise<void> {
		if (rollback && scope.queryRunner.isTransactionActive) {
			try {
				await this.runRunnerOperation(scope, 'rollback', async () => await scope.queryRunner.rollbackTransaction());
				scope.transactionStarted = false;
			} catch (error) {
				if (scope.pending != null && !scope.pending.settled) {
					this.scheduleLateCleanup(scope, rollback, primaryError);
					return;
				}
				this.attachCleanupError(primaryError, error);
			}
		}
		if (!scope.released && !scope.queryRunner.isReleased) {
			try {
				await this.runRunnerOperation(scope, 'release', async () => await scope.queryRunner.release());
				scope.released = true;
			} catch (error) {
				if (scope.pending != null && !scope.pending.settled) this.scheduleLateCleanup(scope, rollback, primaryError);
				else this.attachCleanupError(primaryError, error);
			}
		}
	}

	private async refreshDatabaseDeadline(query: QueryRunner['query'], input: HanamiPersonalFeedComputationInput): Promise<void> {
		const rows = await query(CONFIGURE_DEADLINE_SQL, [input.databaseDeadlineAt, String(GENERATION_LOCK_TIMEOUT_MS)]) as unknown[];
		if (rows.length !== 1) throw new Error('Hanami personal-generation database deadline expired');
	}

	private async configureTransaction(query: QueryRunner['query'], input: HanamiPersonalFeedComputationInput): Promise<void> {
		await query('SET TRANSACTION READ ONLY');
		this.throwIfAborted(input.signal);
		await this.refreshDatabaseDeadline(query, input);
	}

	private async finalDeadlineGuard(scope: GenerationRunnerScope, input: HanamiPersonalFeedComputationInput): Promise<void> {
		const rows = await scope.queryRunner.query(
			'SELECT clock_timestamp() < $1::timestamptz AS before_deadline',
			[input.databaseDeadlineAt],
		) as Array<{ before_deadline: boolean }>;
		if (rows.length !== 1 || rows[0]?.before_deadline !== true) throw new Error('Hanami personal-generation database deadline expired');
	}

	private async withGenerationRunner<T>(input: HanamiPersonalFeedComputationInput, operation: (context: HanamiPersonalFeedGenerationContext) => Promise<T>): Promise<T> {
		const queryRunner = this.db.createQueryRunner();
		const originalQuery = queryRunner.query.bind(queryRunner);
		const scope: GenerationRunnerScope = {
			queryRunner,
			signal: input.signal,
			originalQuery,
			pending: null,
			transactionStarted: false,
			released: false,
		};
		try {
			await this.runRunnerOperation(scope, 'connect', async () => await queryRunner.connect());
			await this.runRunnerOperation(scope, 'start', async () => await queryRunner.startTransaction('REPEATABLE READ'));
			scope.transactionStarted = true;
			await this.runRunnerOperation(scope, 'query', async () => await this.configureTransaction(originalQuery, input));
			queryRunner.query = ((...args: unknown[]) => this.runRunnerOperation(
				scope,
				'query',
				async () => {
					await this.refreshDatabaseDeadline(originalQuery, input);
					this.throwIfAborted(input.signal);
					return await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
				},
			)) as QueryRunner['query'];
			const context: HanamiPersonalFeedGenerationContext = { ...input, queryRunner };
			const result = await operation(context);
			this.throwIfAborted(input.signal);
			await this.finalDeadlineGuard(scope, input);
			queryRunner.query = originalQuery;
			await this.runRunnerOperation(scope, 'commit', async () => await queryRunner.commitTransaction());
			scope.transactionStarted = false;
			this.throwIfAborted(input.signal);
			await this.runRunnerOperation(scope, 'release', async () => await queryRunner.release());
			scope.released = true;
			this.throwIfAborted(input.signal);
			return result;
		} catch (error) {
			queryRunner.query = originalQuery;
			const primaryError = input.signal.aborted ? input.signal.reason : error;
			if ((scope.pending != null && !scope.pending.settled) || input.signal.aborted) {
				this.scheduleLateCleanup(scope, true, primaryError);
			} else {
				await this.cleanupRunnerBounded(scope, true, primaryError);
			}
			throw primaryError;
		}
	}

	private validateInput(input: HanamiPersonalFeedComputationInput): void {
		if (input.userId.trim().length === 0) throw new TypeError('userId must not be empty');
		if (input.epochId.trim().length === 0) throw new TypeError('epochId must not be empty');
		if (input.baseCommonGenerationId.trim().length === 0) throw new TypeError('baseCommonGenerationId must not be empty');
		if (!Number.isFinite(Date.parse(input.generatedAt))) throw new TypeError('generatedAt must be a valid ISO timestamp');
		if (!Number.isFinite(Date.parse(input.databaseDeadlineAt))) throw new TypeError('databaseDeadlineAt must be a valid ISO timestamp');
	}

	/**
	 * One bounded candidate lookup enriches transient constraints. Fingerprints
	 * are derived only in memory from Note text; persisted entries retain Note IDs
	 * only, so no fingerprint/text is written to reasonMetadata.
	 */
	private async enrichAndExcludeEpochCandidates(context: HanamiPersonalFeedGenerationContext, candidates: readonly HanamiPersonalFeedCandidate[]): Promise<{ candidates: readonly HanamiPersonalFeedCandidate[]; seed: readonly ForYouCandidate[] }> {
		const ids = [...new Set(candidates.map(c => c.noteId))];
		if (ids.length === 0) return { candidates, seed: [] };
		const existingRows = await context.queryRunner.query(`
			SELECT e."noteId" AS note_id FROM "hanami_user_feed_entry" e
			JOIN "hanami_user_feed_batch" b ON b."id" = e."batchId" AND b."status" = 'ready'
			WHERE e."userId" = $1 AND e."epochId" = $2 AND e."noteId" = ANY($3::varchar[])
		`, [context.userId, context.epochId, ids]) as Array<{ note_id: string }>;
		const seenRows = await context.queryRunner.query(`
			SELECT DISTINCT e."noteId" AS note_id FROM "hanami_recommendation_event" e
			WHERE e."userId" = $1 AND e."noteId" = ANY($2::varchar[]) AND e."eventType" = 'seen'
				AND e."occurredAt" >= $3::timestamptz - INTERVAL '7 days' AND e."occurredAt" <= $3::timestamptz
		`, [context.userId, ids, context.generatedAt]) as Array<{ note_id: string }>;
		const excluded = new Set([...existingRows, ...seenRows].map(row => row.note_id));
		const eligible = candidates.filter(candidate => !excluded.has(candidate.noteId));
		const detailRows = await context.queryRunner.query(`
			SELECT n.id AS note_id, n."userId" AS author_id, COALESCE(n.text, '') AS text, u."isBot" AS is_bot,
				CASE WHEN EXISTS (SELECT 1 FROM following f WHERE f."followerId" = $1 AND f."followeeId" = n."userId") THEN 'directFollow'
					WHEN EXISTS (SELECT 1 FROM following f WHERE (f."followerId" = $1 AND f."followeeId" = n."userId") OR (f."followerId" = n."userId" AND f."followeeId" = $1)) THEN 'known'
					ELSE 'unknown' END AS relationship_class
			FROM note n JOIN "user" u ON u.id = n."userId" WHERE n.id = ANY($2::varchar[])
		`, [context.userId, eligible.map(c => c.noteId)]) as Array<{ note_id: string; author_id: string; text: string; is_bot: boolean; relationship_class: HanamiRelationshipClass }>;
		const detail = new Map(detailRows.map(row => [row.note_id, row]));
		const enriched = eligible.flatMap(candidate => {
			const row = detail.get(candidate.noteId);
			// Safety already established eligibility. A concurrently removed detail row
			// is not a reason to invent a DB retry; retain legacy-compatible fields.
			if (row == null) return [candidate];
			const text = row.text;
			return [{ ...candidate, authorId: row.author_id, relationshipClass: row.relationship_class,
				exactTextFingerprint: createHanamiExactTextFingerprint(text),
				...(row.is_bot ? { isBot: true, strictBotTemplateFingerprint: createHanamiStrictBotTemplateFingerprint(row.author_id, text) } : {}),
				qualityShadow: createHanamiQualityShadow({ relationshipClass: row.relationship_class, standaloneValue: null, socialOnly: null }),
			}];
		});
		const seedRows = await context.queryRunner.query(`
			SELECT e."noteId" AS note_id, n."userId" AS author_id, COALESCE(n.text, '') AS text, u."isBot" AS is_bot,
				CASE WHEN EXISTS (SELECT 1 FROM following f WHERE f."followerId" = $1 AND f."followeeId" = n."userId") THEN 'directFollow'
					WHEN EXISTS (SELECT 1 FROM following f WHERE (f."followerId" = $1 AND f."followeeId" = n."userId") OR (f."followerId" = n."userId" AND f."followeeId" = $1)) THEN 'known'
					ELSE 'unknown' END AS relationship_class
			FROM "hanami_user_feed_entry" e JOIN "hanami_user_feed_batch" b ON b.id = e."batchId" AND b.status = 'ready'
			JOIN note n ON n.id = e."noteId" JOIN "user" u ON u.id = n."userId"
			WHERE e."userId" = $1 AND e."epochId" = $2 ORDER BY e."sequence" DESC LIMIT 210
		`, [context.userId, context.epochId]) as Array<{ note_id: string; author_id: string; text: string; is_bot: boolean; relationship_class: HanamiRelationshipClass }>;
		return { candidates: enriched, seed: seedRows.map(row => ({ noteId: row.note_id, userId: row.author_id, score: 0,
			relationshipClass: row.relationship_class,
			exactTextFingerprint: createHanamiExactTextFingerprint(row.text), isBot: row.is_bot,
			...(row.is_bot ? { strictBotTemplateFingerprint: createHanamiStrictBotTemplateFingerprint(row.author_id, row.text) } : {}),
		})) };
	}

	private commonCandidate(row: HanamiPersistedCommonCandidate, authorId: string): HanamiPersonalFeedCandidate {
		const term = row.axis === 'trending' && typeof row.metadata.term === 'string' && row.metadata.term.length > 0
			? row.metadata.term
			: undefined;
		return {
			noteId: row.noteId,
			authorId,
			axis: row.axis,
			origin: 'commonCandidate',
			score: row.baseScore,
			...(term !== undefined ? { term } : {}),
		};
	}

	/**
	 * Final persisted-path exploration pool: this deliberately runs after safety
	 * and the epoch/seen hard exclusions. One deterministic round takes the
	 * author-diverse rounds preserve ranked candidate volume while keeping every
	 * author at or below 5% of the pool. With fewer,
	 * no mathematically valid exploration pool exists and only that axis is
	 * omitted (other eligible axes are untouched).
	 */
	private finalExplorationDiversity(candidates: readonly HanamiPersonalFeedCandidate[]): readonly HanamiPersonalFeedCandidate[] {
		const exploration = candidates.filter(candidate => candidate.axis === 'exploration');
		const authors = new Map<string, HanamiPersonalFeedCandidate[]>();
		for (const candidate of exploration) {
			const list = authors.get(candidate.authorId) ?? [];
			list.push(candidate);
			authors.set(candidate.authorId, list);
		}
		// With fewer than twenty authors, even one candidate is >5%; omit this axis
		// rather than claim a mathematically impossible diversity guarantee.
		if (authors.size < 20) return candidates.filter(candidate => candidate.axis !== 'exploration');
		// A complete round has one candidate per author. Retaining only complete
		// rounds means the least-prolific eligible author sets the safe volume,
		// while the bounded 500 candidate source remains recoverable when all
		// authors have depth.
		const lists = [...authors.values()];
		const rounds = Math.min(
			Math.max(1, Math.floor(COMMON_CANDIDATE_LIMITS.exploration / authors.size)),
			...lists.map(list => list.length),
		);
		const selected: HanamiPersonalFeedCandidate[] = [];
		for (let round = 0; round < rounds; round++) {
			for (const list of lists) selected.push(list[round]!);
		}
		return candidates.filter(candidate => candidate.axis !== 'exploration').concat(selected);
	}

	private validateCommonCandidates(candidates: readonly HanamiPersistedCommonCandidate[]): void {
		if (candidates.length > MAX_COMMON_CANDIDATES) throw new Error(`Hanami common candidate read exceeded ${MAX_COMMON_CANDIDATES} rows`);
		const count = { globalPopular: 0, trending: 0, exploration: 0 };
		for (const candidate of candidates) {
			count[candidate.axis]++;
			if (count[candidate.axis] > COMMON_CANDIDATE_LIMITS[candidate.axis]) {
				throw new Error(`Hanami common ${candidate.axis} candidate read exceeded ${COMMON_CANDIDATE_LIMITS[candidate.axis]} rows`);
			}
		}
	}

	private immutableItem(item: HanamiPersonalFeedItem): HanamiPersonalFeedItem {
		return Object.freeze({
			...item,
			sources: Object.freeze([...item.sources]),
			reasonMetadata: Object.freeze({ ...item.reasonMetadata }),
		});
	}

	@bindThis
	public async computePersonalFeed(input: HanamiPersonalFeedComputationInput): Promise<HanamiPersonalFeedComputationResult> {
		this.validateInput(input);
		this.throwIfAborted(input.signal);

		return await this.withGenerationRunner(input, async context => {
			const persistedCommon = await this.boundary(context.signal, async () => (
				await this.commonGenerationRead.loadReadyCommonCandidates(input.baseCommonGenerationId, {
					queryRunner: context.queryRunner,
					signal: context.signal,
					databaseDeadlineAt: context.databaseDeadlineAt,
				})
			));
			this.validateCommonCandidates(persistedCommon);
			return await this.computeWithRunner(context, persistedCommon);
		});
	}

	private async computeWithRunner(
		context: HanamiPersonalFeedGenerationContext,
		persistedCommon: readonly HanamiPersistedCommonCandidate[],
	): Promise<HanamiPersonalFeedComputationResult> {
		const { signal } = context;
		const commonAuthorByNoteId = await this.boundary(signal, async () => (
			await this.hanamiForYouSafetyService.filterCommonEligibleNotes(
				persistedCommon.map(candidate => candidate.noteId),
				signal,
				context.queryRunner,
			)
		));
		const commonCandidates = persistedCommon.flatMap(row => {
			const authorId = commonAuthorByNoteId.get(row.noteId);
			return authorId == null || !Number.isFinite(row.baseScore) ? [] : [this.commonCandidate(row, authorId)];
		});

		const preparation = await this.boundary(signal, async () => (
			await this.hanamiForYouService.gatherPersonalFeedCandidates(context, commonCandidates)
		));
		const safeCandidates = await this.boundary(signal, async () => (
			await this.hanamiForYouSafetyService.filterPersonalEligibleCandidates({
				userId: context.userId,
				candidates: preparation.candidates,
				signal,
				queryRunner: context.queryRunner,
			})
		));
		const rankedCandidates = await this.boundary(signal, async () => (
			await this.hanamiForYouService.rankPersonalFeedCandidates(context, preparation, safeCandidates)
		));
		const constrained = await this.boundary(signal, async () => await this.enrichAndExcludeEpochCandidates(context, rankedCandidates));

		const finalCandidates = this.finalExplorationDiversity(constrained.candidates);
		// This is a refresh-wide eligibility fact, not a segment-local one. Reusing
		// it for every interleave prevents later segments from silently dropping the
		// 30-item unknown floor merely because earlier segments consumed candidates.
		const unknownEligibleCount = new Set(finalCandidates
			.filter(candidate => candidate.relationshipClass === 'unknown')
			.map(candidate => candidate.noteId)).size;
		const unknownSufficient = unknownEligibleCount >= 15;
		if (hanamiHasUnhealablePersonalSeedHead(constrained.seed, unknownSufficient)) {
			throw new HanamiInvalidPersonalSeedError();
		}
		const byAxis = new Map<HanamiAxis, HanamiPersonalFeedCandidate[]>();
		for (const candidate of finalCandidates) {
			const list = byAxis.get(candidate.axis) ?? [];
			list.push(candidate);
			byAxis.set(candidate.axis, list);
		}

		const selectedNoteIds = new Set<string>();
		const selectedHistory: ForYouCandidate[] = [];
		const items: HanamiPersonalFeedItem[] = [];
		const segmentLengths: number[] = [];
		for (let segmentIndex = 0; segmentIndex < MAX_SEGMENTS; segmentIndex++) {
			this.throwIfAborted(signal);
			const segmentStart = items.length;
			const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>();
			const sourceCandidateByKey = new Map<string, HanamiPersonalFeedCandidate>();
			for (const [axis, candidates] of byAxis) {
				const available = candidates.filter(candidate => !selectedNoteIds.has(candidate.noteId));
				axisCandidates.set(axis, available.map(candidate => ({
					...candidate,
					noteId: candidate.noteId,
					userId: candidate.authorId,
					score: candidate.score,
					...(candidate.term !== undefined ? { term: candidate.term } : {}),
					...(candidate.clusterId !== undefined ? { clusterId: candidate.clusterId } : {}),
					...(candidate.relationshipClass !== undefined ? { relationshipClass: candidate.relationshipClass } : {}),
					...(candidate.exactTextFingerprint !== undefined ? { exactTextFingerprint: candidate.exactTextFingerprint } : {}),
					...(candidate.isBot !== undefined ? { isBot: candidate.isBot } : {}),
					...(candidate.strictBotTemplateFingerprint !== undefined ? { strictBotTemplateFingerprint: candidate.strictBotTemplateFingerprint } : {}),
				})));
				for (const candidate of available) sourceCandidateByKey.set(`${axis}\t${candidate.noteId}`, candidate);
			}

			const interleaved = hanamiInterleave({
				confidence: preparation.confidence,
				limit: SEGMENT_SIZE,
				axisCandidates,
				axisLevels: preparation.axisLevels,
				personalConstraints: true,
				selectedVisible: selectedHistory,
				followingSeedVisible: constrained.seed,
				unknownSufficient,
			}).slice(0, SEGMENT_SIZE);
			if (interleaved.length === 0) break;

			for (const selected of interleaved) {
				const sourceCandidate = sourceCandidateByKey.get(`${selected.source}\t${selected.noteId}`);
				if (sourceCandidate == null || selectedNoteIds.has(selected.noteId)) continue;
				const transient: ForYouCandidate = {
					noteId: sourceCandidate.noteId, userId: sourceCandidate.authorId, score: sourceCandidate.score,
					...(sourceCandidate.relationshipClass !== undefined ? { relationshipClass: sourceCandidate.relationshipClass } : {}),
					...(sourceCandidate.exactTextFingerprint !== undefined ? { exactTextFingerprint: sourceCandidate.exactTextFingerprint } : {}),
					...(sourceCandidate.isBot !== undefined ? { isBot: sourceCandidate.isBot } : {}),
					...(sourceCandidate.strictBotTemplateFingerprint !== undefined ? { strictBotTemplateFingerprint: sourceCandidate.strictBotTemplateFingerprint } : {}),
				};
				selectedNoteIds.add(selected.noteId);
				selectedHistory.push(transient);
				items.push(this.immutableItem({
					noteId: selected.noteId,
					source: selected.source,
					sources: selected.sources,
					origin: sourceCandidate.origin,
					reasonMetadata: this.hanamiForYouProvenanceService.buildReasonMetadata(
						sourceCandidate,
						selected.fallbackOverflow === true,
					),
				}));
			}
			const segmentLength = items.length - segmentStart;
			if (segmentLength === 0) break;
			segmentLengths.push(segmentLength);
		}

		this.throwIfAborted(signal);
		return Object.freeze({
			confidence: preparation.confidence,
			items: Object.freeze(items),
			segmentLengths: Object.freeze(segmentLengths),
		});
	}
}
