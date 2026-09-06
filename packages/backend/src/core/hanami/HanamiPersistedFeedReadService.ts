/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import {
	HANAMI_USER_FEED_AXES,
	type HanamiPersistedCommonFeedEntry,
	type HanamiPersistedFeedCursorResumeInput,
	type HanamiPersistedFeedCursorResumeResult,
	type HanamiPersistedFeedReadPort,
	type HanamiPersistedFeedScanInput,
	type HanamiPersistedFeedScanResult,
	type HanamiPersistedPersonalFeedEntry,
} from './HanamiUserFeedContracts.js';
import type { DataSource, QueryRunner } from 'typeorm';

const PG_BIGINT_MAX = '9223372036854775807';
const AXES = new Set<string>(HANAMI_USER_FEED_AXES);

type PersonalEntryRow = {
	epoch_id: string;
	sequence: string;
	batch_id: string;
	note_id: string;
	source: string;
	sources: unknown;
	origin: 'commonCandidate' | 'personalCandidate';
	reason_metadata: unknown;
};

type CommonEntryRow = {
	epoch_id: string;
	sequence: string;
	batch_id: string;
	note_id: string;
	source: string;
	sources: unknown;
	generated_month: string;
	row_id: string;
};

@Injectable()
export class HanamiPersistedFeedReadService implements HanamiPersistedFeedReadPort {
	constructor(
		@Inject(DI.db)
		private db: DataSource,
	) {}

	@bindThis
	public async scanReadyEntries(input: HanamiPersistedFeedScanInput): Promise<HanamiPersistedFeedScanResult> {
		this.validateInput(input);
		return await this.withTransaction(async (queryRunner) => input.head.kind === 'personal'
			? await this.scanPersonal(queryRunner, input)
			: await this.scanCommon(queryRunner, input));
	}

	@bindThis
	public async resumeReadyEntries(input: HanamiPersistedFeedCursorResumeInput): Promise<HanamiPersistedFeedCursorResumeResult> {
		this.validateResumeInput(input);
		return await this.withTransaction(async (queryRunner) => input.cursor.kind === 'personal'
			? await this.resumePersonal(queryRunner, input)
			: await this.resumeCommon(queryRunner, input));
	}

	private async scanPersonal(queryRunner: QueryRunner, input: HanamiPersistedFeedScanInput): Promise<HanamiPersistedFeedScanResult> {
		if (input.head.mode !== 'personalized') throw new TypeError('A personal Hanami head must use personalized mode');
		const users = await queryRunner.query(`
			SELECT u."id" AS id, u."isHibernated" AS is_hibernated
			FROM "user" u
			WHERE u."id" = $1
			FOR UPDATE OF u
		`, [input.requesterUserId]) as Array<{ id: string; is_hibernated: boolean }>;
		const user = users.at(0);
		if (user == null || user.is_hibernated) return { kind: 'cursorExpired' };

		const states = await queryRunner.query(`
			SELECT s."epochId" AS epoch_id, s."mode" AS mode,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence
			FROM "hanami_user_feed_state" s
			WHERE s."userId" = $1
			FOR UPDATE OF s
		`, [input.requesterUserId]) as Array<{
			epoch_id: string | null;
			mode: 'personalized' | 'common';
			earliest_retained_sequence: string | null;
		}>;
		const state = states.at(0);
		if (state == null || state.epoch_id !== input.head.feedEpochId || state.earliest_retained_sequence == null) {
			return { kind: 'cursorExpired' };
		}

		const epochs = await queryRunner.query(`
			SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
			FROM "hanami_user_feed_epoch" e
			WHERE e."userId" = $1 AND e."epochId" = $2
			FOR UPDATE OF e
		`, [input.requesterUserId, input.head.feedEpochId]) as Array<{ epoch_id: string; retired_at: Date | string | null }>;
		if (epochs.length !== 1 || epochs.at(0)?.retired_at != null) return { kind: 'cursorExpired' };

		const headBatches = await queryRunner.query(`
			SELECT b."id" AS id
			FROM "hanami_user_feed_batch" b
			WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
			FOR UPDATE OF b
		`, [input.head.headBatchId, input.requesterUserId, input.head.feedEpochId]) as Array<{ id: string }>;
		if (headBatches.length !== 1) return { kind: 'cursorExpired' };

		const cursorSequence = input.beforeSequence ?? input.head.headSequence;
		if (this.compareDecimal(cursorSequence, state.earliest_retained_sequence) < 0) return { kind: 'cursorExpired' };

		const rows = await queryRunner.query(`
			SELECT e."epochId" AS epoch_id, e."sequence"::text AS sequence,
				e."batchId" AS batch_id, e."noteId" AS note_id, e."source" AS source,
				e."sources" AS sources, e."origin" AS origin, e."reasonMetadata" AS reason_metadata
			FROM "hanami_user_feed_entry" e
			JOIN "hanami_user_feed_batch" b
				ON b."id" = e."batchId" AND b."userId" = e."userId" AND b."epochId" = e."epochId"
				AND b."status" = 'ready'
			WHERE e."userId" = $1 AND e."epochId" = $2
				AND e."sequence" <= $3::bigint
				AND ($4::bigint IS NULL OR e."sequence" < $4::bigint)
			ORDER BY e."sequence" DESC
			LIMIT $5
		`, [
			input.requesterUserId,
			input.head.feedEpochId,
			input.head.headSequence,
			input.beforeSequence,
			input.scanLimit + 1,
		]) as PersonalEntryRow[];
		const hasMore = rows.length > input.scanLimit;
		const pageRows = rows.slice(0, input.scanLimit);
		const entries = pageRows.map((row) => this.personalEntry(row));
		return {
			kind: 'page',
			entries,
			lastScannedSequence: entries.at(-1)?.sequence ?? null,
			hasMore,
		};
	}

	private async scanCommon(queryRunner: QueryRunner, input: HanamiPersistedFeedScanInput): Promise<HanamiPersistedFeedScanResult> {
		if (input.head.mode !== 'common') throw new TypeError('A common Hanami head must use common mode');
		const users = await queryRunner.query(`
			SELECT u."id" AS id
			FROM "user" u
			WHERE u."id" = $1
			FOR UPDATE OF u
		`, [input.requesterUserId]) as Array<{ id: string }>;
		if (users.length !== 1) return { kind: 'cursorExpired' };

		const states = await queryRunner.query(`
			SELECT s."epochId" AS epoch_id,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence
			FROM "hanami_common_feed_state" s
			WHERE s."singletonId" = 'singleton'
			FOR SHARE OF s
		`) as Array<{
			epoch_id: string | null;
			earliest_retained_sequence: string | null;
		}>;
		const state = states.at(0);
		if (state == null || state.epoch_id == null || state.earliest_retained_sequence == null) return { kind: 'commonNotReady' };
		if (state.epoch_id !== input.head.feedEpochId) return { kind: 'cursorExpired' };

		const generations = await queryRunner.query(`
			SELECT g."id" AS id
			FROM "hanami_common_generation" g
			WHERE g."id" = $1 AND g."status" = 'ready'
			FOR SHARE OF g
		`, [input.head.headBatchId]) as Array<{ id: string }>;
		if (generations.length !== 1) return { kind: 'cursorExpired' };

		const cursorSequence = input.beforeSequence ?? input.head.headSequence;
		if (this.compareDecimal(cursorSequence, state.earliest_retained_sequence) < 0) return { kind: 'cursorExpired' };

		const rows = await queryRunner.query(`
			SELECT e."epochId" AS epoch_id, e."sequence"::text AS sequence,
				e."generationId" AS batch_id, e."noteId" AS note_id,
				e."source" AS source, e."sources" AS sources,
				to_char(e."generatedMonth", 'YYYY-MM') AS generated_month, e."id" AS row_id
			FROM "hanami_common_feed_entry" e
			JOIN "hanami_common_generation" g ON g."id" = e."generationId" AND g."status" = 'ready'
			WHERE e."epochId" = $1
				AND e."sequence" <= $2::bigint
				AND ($3::bigint IS NULL OR e."sequence" < $3::bigint)
			ORDER BY e."sequence" DESC
			LIMIT $4
		`, [input.head.feedEpochId, input.head.headSequence, input.beforeSequence, input.scanLimit + 1]) as CommonEntryRow[];
		const hasMore = rows.length > input.scanLimit;
		const pageRows = rows.slice(0, input.scanLimit);
		const entries = pageRows.map((row) => this.commonEntry(row));
		return {
			kind: 'page',
			entries,
			lastScannedSequence: entries.at(-1)?.sequence ?? null,
			hasMore,
		};
	}

	private async resumePersonal(queryRunner: QueryRunner, input: HanamiPersistedFeedCursorResumeInput): Promise<HanamiPersistedFeedCursorResumeResult> {
		const users = await queryRunner.query(`
			SELECT u."id" AS id, u."isHibernated" AS is_hibernated
			FROM "user" u
			WHERE u."id" = $1
			FOR UPDATE OF u
		`, [input.requesterUserId]) as Array<{ id: string; is_hibernated: boolean }>;
		const user = users.at(0);
		if (user == null || user.is_hibernated) return { kind: 'cursorExpired' };

		const states = await queryRunner.query(`
			SELECT s."epochId" AS epoch_id,
				s."latestReadyBatchId" AS latest_ready_batch_id,
				s."latestSequence"::text AS latest_sequence,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence
			FROM "hanami_user_feed_state" s
			WHERE s."userId" = $1
			FOR UPDATE OF s
		`, [input.requesterUserId]) as Array<{
			epoch_id: string;
			latest_ready_batch_id: string | null;
			latest_sequence: string;
			earliest_retained_sequence: string;
		}>;
		const state = states.at(0);
		if (state == null || state.epoch_id !== input.cursor.feedEpochId
			|| state.latest_ready_batch_id == null || !/^[1-9]\d*$/.test(state.latest_sequence)) {
			return { kind: 'cursorExpired' };
		}

		const epochs = await queryRunner.query(`
			SELECT e."epochId" AS epoch_id, e."retiredAt" AS retired_at
			FROM "hanami_user_feed_epoch" e
			WHERE e."userId" = $1 AND e."epochId" = $2
			FOR UPDATE OF e
		`, [input.requesterUserId, input.cursor.feedEpochId]) as Array<{ epoch_id: string; retired_at: Date | string | null }>;
		if (epochs.length !== 1 || epochs.at(0)?.retired_at != null) return { kind: 'cursorExpired' };

		const headBatches = await queryRunner.query(`
			SELECT b."id" AS id
			FROM "hanami_user_feed_batch" b
			WHERE b."id" = $1 AND b."userId" = $2 AND b."epochId" = $3 AND b."status" = 'ready'
			FOR UPDATE OF b
		`, [state.latest_ready_batch_id, input.requesterUserId, input.cursor.feedEpochId]) as Array<{ id: string }>;
		if (headBatches.length !== 1) return { kind: 'cursorExpired' };
		if (this.compareDecimal(input.cursor.sequence, state.earliest_retained_sequence) < 0) return { kind: 'cursorExpired' };

		const rows = await queryRunner.query(`
			SELECT e."epochId" AS epoch_id, e."sequence"::text AS sequence,
				e."batchId" AS batch_id, e."noteId" AS note_id, e."source" AS source,
				e."sources" AS sources, e."origin" AS origin, e."reasonMetadata" AS reason_metadata
			FROM "hanami_user_feed_entry" e
			JOIN "hanami_user_feed_batch" b
				ON b."id" = e."batchId" AND b."userId" = e."userId" AND b."epochId" = e."epochId"
				AND b."status" = 'ready'
			WHERE e."userId" = $1 AND e."epochId" = $2
				AND e."sequence" < $3::bigint
			ORDER BY e."sequence" DESC
			LIMIT $4
		`, [input.requesterUserId, input.cursor.feedEpochId, input.cursor.sequence, input.scanLimit + 1]) as PersonalEntryRow[];
		const entries = rows.slice(0, input.scanLimit).map((row) => this.personalEntry(row));
		return {
			kind: 'page',
			head: {
				mode: 'personalized',
				kind: 'personal',
				feedEpochId: state.epoch_id,
				headBatchId: state.latest_ready_batch_id,
				headSequence: state.latest_sequence,
			},
			entries,
			lastScannedSequence: entries.at(-1)?.sequence ?? null,
			hasMore: rows.length > input.scanLimit,
		};
	}

	private async resumeCommon(queryRunner: QueryRunner, input: HanamiPersistedFeedCursorResumeInput): Promise<HanamiPersistedFeedCursorResumeResult> {
		const users = await queryRunner.query(`
			SELECT u."id" AS id
			FROM "user" u
			WHERE u."id" = $1
			FOR UPDATE OF u
		`, [input.requesterUserId]) as Array<{ id: string }>;
		if (users.length !== 1) return { kind: 'cursorExpired' };

		const states = await queryRunner.query(`
			SELECT s."epochId" AS epoch_id,
				s."latestReadyGenerationId" AS latest_ready_generation_id,
				s."latestSequence"::text AS latest_sequence,
				s."earliestRetainedSequence"::text AS earliest_retained_sequence
			FROM "hanami_common_feed_state" s
			WHERE s."singletonId" = 'singleton'
			FOR SHARE OF s
		`) as Array<{
			epoch_id: string | null;
			latest_ready_generation_id: string | null;
			latest_sequence: string;
			earliest_retained_sequence: string;
		}>;
		const state = states.at(0);
		if (state == null || state.epoch_id == null || state.latest_ready_generation_id == null
			|| !/^[1-9]\d*$/.test(state.latest_sequence)) return { kind: 'commonNotReady' };
		if (state.epoch_id !== input.cursor.feedEpochId) return { kind: 'cursorExpired' };

		const headGenerations = await queryRunner.query(`
			SELECT g."id" AS id
			FROM "hanami_common_generation" g
			WHERE g."id" = $1 AND g."status" = 'ready'
			FOR SHARE OF g
		`, [state.latest_ready_generation_id]) as Array<{ id: string }>;
		if (headGenerations.length !== 1) return { kind: 'commonNotReady' };
		if (this.compareDecimal(input.cursor.sequence, state.earliest_retained_sequence) < 0) return { kind: 'cursorExpired' };

		const rows = await queryRunner.query(`
			SELECT e."epochId" AS epoch_id, e."sequence"::text AS sequence,
				e."generationId" AS batch_id, e."noteId" AS note_id,
				e."source" AS source, e."sources" AS sources,
				to_char(e."generatedMonth", 'YYYY-MM') AS generated_month, e."id" AS row_id
			FROM "hanami_common_feed_entry" e
			JOIN "hanami_common_generation" g ON g."id" = e."generationId" AND g."status" = 'ready'
			WHERE e."epochId" = $1
				AND e."sequence" < $2::bigint
			ORDER BY e."sequence" DESC
			LIMIT $3
		`, [input.cursor.feedEpochId, input.cursor.sequence, input.scanLimit + 1]) as CommonEntryRow[];
		const entries = rows.slice(0, input.scanLimit).map((row) => this.commonEntry(row));
		return {
			kind: 'page',
			head: {
				mode: 'common',
				kind: 'common',
				feedEpochId: state.epoch_id,
				headBatchId: state.latest_ready_generation_id,
				headSequence: state.latest_sequence,
			},
			entries,
			lastScannedSequence: entries.at(-1)?.sequence ?? null,
			hasMore: rows.length > input.scanLimit,
		};
	}

	private validateInput(input: HanamiPersistedFeedScanInput): void {
		if (typeof input.requesterUserId !== 'string' || input.requesterUserId.length === 0) throw new TypeError('requesterUserId must be nonempty');
		if (input.head == null || (input.head.kind !== 'personal' && input.head.kind !== 'common')) throw new TypeError('Invalid Hanami feed head kind');
		if (typeof input.head.feedEpochId !== 'string' || input.head.feedEpochId.length === 0) throw new TypeError('feedEpochId must be nonempty');
		if (typeof input.head.headBatchId !== 'string' || input.head.headBatchId.length === 0) throw new TypeError('headBatchId must be nonempty');
		this.validateDecimal(input.head.headSequence, 'headSequence');
		if (input.beforeSequence != null) this.validateDecimal(input.beforeSequence, 'beforeSequence');
		if (!Number.isSafeInteger(input.scanLimit) || input.scanLimit <= 0) throw new TypeError('scanLimit must be a positive safe integer');
	}

	private validateResumeInput(input: HanamiPersistedFeedCursorResumeInput): void {
		if (typeof input.requesterUserId !== 'string' || input.requesterUserId.length === 0) throw new TypeError('requesterUserId must be nonempty');
		if (input.cursor == null || (input.cursor.kind !== 'personal' && input.cursor.kind !== 'common')) throw new TypeError('Invalid Hanami feed cursor kind');
		if (typeof input.cursor.feedEpochId !== 'string' || input.cursor.feedEpochId.length === 0) throw new TypeError('feedEpochId must be nonempty');
		this.validateDecimal(input.cursor.sequence, 'sequence');
		if (!Number.isSafeInteger(input.scanLimit) || input.scanLimit <= 0) throw new TypeError('scanLimit must be a positive safe integer');
	}

	private personalEntry(row: PersonalEntryRow): HanamiPersistedPersonalFeedEntry {
		const source = this.validateAxis(row.source, 'personal source');
		const sources = this.validateAxes(row.sources, 'personal sources');
		if (row.origin !== 'commonCandidate' && row.origin !== 'personalCandidate') throw new Error(`Invalid persisted Hanami origin ${String(row.origin)}`);
		return {
			kind: 'personal',
			epochId: row.epoch_id,
			sequence: row.sequence,
			batchId: row.batch_id,
			noteId: row.note_id,
			source,
			sources,
			origin: row.origin,
			reasonMetadata: this.validateReasonMetadata(row.reason_metadata),
		};
	}

	private commonEntry(row: CommonEntryRow): HanamiPersistedCommonFeedEntry {
		return {
			kind: 'common',
			epochId: row.epoch_id,
			sequence: row.sequence,
			batchId: row.batch_id,
			noteId: row.note_id,
			source: this.validateAxis(row.source, 'common source'),
			sources: this.validateAxes(row.sources, 'common sources'),
			generatedMonth: row.generated_month,
			rowId: row.row_id,
		};
	}

	private validateDecimal(value: string, field: string): void {
		if (!/^(?:0|[1-9]\d*)$/.test(value)
			|| value.length > PG_BIGINT_MAX.length
			|| (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
			throw new TypeError(`${field} must be a canonical non-negative PostgreSQL bigint decimal string`);
		}
	}

	private compareDecimal(left: string, right: string): number {
		if (left.length !== right.length) return left.length < right.length ? -1 : 1;
		return left === right ? 0 : left < right ? -1 : 1;
	}

	private validateAxis(value: string, field: string): typeof HANAMI_USER_FEED_AXES[number] {
		if (!AXES.has(value)) throw new Error(`Invalid persisted Hanami ${field}: ${value}`);
		return value as typeof HANAMI_USER_FEED_AXES[number];
	}

	private validateAxes(value: unknown, field: string): typeof HANAMI_USER_FEED_AXES[number][] {
		if (!Array.isArray(value)) throw new Error(`Invalid persisted Hanami ${field}`);
		return value.map((axis) => {
			if (typeof axis !== 'string') throw new Error(`Invalid persisted Hanami ${field}`);
			return this.validateAxis(axis, field);
		});
	}

	private validateReasonMetadata(value: unknown): import('./HanamiUserFeedContracts.js').HanamiUserFeedReasonMetadata {
		if (typeof value !== 'object' || value == null || Array.isArray(value)) throw new Error('Invalid persisted Hanami reason metadata');
		const metadata = value as Record<string, unknown>;
		if (metadata.version !== 1 && metadata.version !== 2) throw new Error('Invalid persisted Hanami reason metadata version');
		if (metadata.term != null && typeof metadata.term !== 'string') throw new Error('Invalid persisted Hanami reason term');
		if (metadata.clusterId != null && (!Number.isSafeInteger(metadata.clusterId) || (metadata.clusterId as number) < 0)) throw new Error('Invalid persisted Hanami reason clusterId');
		if (metadata.bucket != null && metadata.bucket !== 'cluster' && metadata.bucket !== 'recent') throw new Error('Invalid persisted Hanami reason bucket');
		if (metadata.fallbackOverflow != null && metadata.fallbackOverflow !== true) throw new Error('Invalid persisted Hanami fallbackOverflow');
		if (metadata.version === 2 && metadata.qualityShadow != null) {
			const shadow = metadata.qualityShadow as Record<string, unknown>;
			if (typeof shadow !== 'object' || shadow == null
				|| !['directFollow', 'known', 'unknown'].includes(String(shadow.relationshipClass))
				|| (shadow.standaloneValue !== null && typeof shadow.standaloneValue !== 'boolean')
				|| (shadow.socialOnly !== null && typeof shadow.socialOnly !== 'boolean')
				|| typeof shadow.ruleVersion !== 'string' || typeof shadow.modelVersion !== 'string') throw new Error('Invalid persisted Hanami quality shadow');
		}
		return metadata as import('./HanamiUserFeedContracts.js').HanamiUserFeedReasonMetadata;
	}

	private async withTransaction<T>(callback: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
		const queryRunner = this.db.createQueryRunner();
		let connected = false;
		let transactionStarted = false;
		let hasPrimaryError = false;
		let primaryError: unknown;
		let result: T | undefined;

		try {
			await queryRunner.connect();
			connected = true;
			await queryRunner.startTransaction();
			transactionStarted = true;
			result = await callback(queryRunner);
			await queryRunner.commitTransaction();
			transactionStarted = false;
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
		return result as T;
	}

	private attachCleanupError(primaryError: unknown, cleanupError: unknown): void {
		try {
			if (primaryError instanceof Error) {
				const target = primaryError as Error & { cleanupErrors?: unknown[] };
				target.cleanupErrors = [...(target.cleanupErrors ?? []), cleanupError];
			}
		} catch {
			// Cleanup diagnostics must never replace the primary error.
		}
	}
}
