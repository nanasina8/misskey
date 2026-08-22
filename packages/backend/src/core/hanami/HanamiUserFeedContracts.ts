/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const HANAMI_USER_FEED_AXES = Object.freeze([
	'globalPopular',
	'neighborTrending',
	'reactionSimilar',
	'catchup',
	'trending',
	'fof',
	'exploration',
] as const);

export type HanamiUserFeedAxis = typeof HANAMI_USER_FEED_AXES[number];
export type HanamiUserFeedConfidence = 'high' | 'low' | 'none';
export type HanamiUserFeedMode = 'personalized' | 'common';
export type HanamiUserFeedKind = 'personal' | 'common';
export type HanamiUserFeedOrigin = 'commonCandidate' | 'personalCandidate';
export type HanamiUserFeedReasonBucket = 'cluster' | 'recent';

/**
 * Latest ready common head captured while the common state and referenced
 * generation are locked in the caller's transaction.
 */
export type HanamiCommonFeedHeadSnapshot = {
	readonly epochId: string;
	readonly generationId: string;
	readonly headSequence: string;
};

/**
 * Stable feed head selected by cursorless evaluation or a refresh mapping.
 * `headBatchId` is a personal batch ID in personalized mode and a common
 * generation ID in common mode.
 */
export type HanamiFeedHeadSnapshot = {
	readonly mode: HanamiUserFeedMode;
	readonly kind: HanamiUserFeedKind;
	readonly feedEpochId: string;
	readonly headBatchId: string;
	readonly headSequence: string;
};

export type HanamiUserFeedAvailabilityResult =
	| {
		readonly kind: 'available';
	}
	| {
		readonly kind: 'roleDisabled';
	}
	| {
		readonly kind: 'recommendationDisabled';
		readonly head: HanamiFeedHeadSnapshot | null;
	};

/**
 * Phase 4 returns only a stable head and generation state. Reading, safety,
 * packing, served recording, and endpoint response construction are separate.
 */
export type HanamiUserFeedRequestResult =
	| {
		readonly kind: 'serve';
		readonly head: HanamiFeedHeadSnapshot;
		readonly generationPending: true;
		readonly requestedBatchId: string;
	}
	| {
		readonly kind: 'serve';
		readonly head: HanamiFeedHeadSnapshot;
		readonly generationPending: false;
		readonly requestedBatchId: string | null;
	}
	| {
		readonly kind: 'roleDisabled';
	}
	| {
		readonly kind: 'recommendationDisabled';
		readonly head: HanamiFeedHeadSnapshot | null;
	}
	| {
		readonly kind: 'commonNotReady';
	}
	| {
		readonly kind: 'invalidRefreshToken';
	}
	| {
		readonly kind: 'refreshTokenExpired';
	}
	| {
		readonly kind: 'refreshRateLimited';
	};

export const HANAMI_USER_FEED_REQUEST = Symbol('HANAMI_USER_FEED_REQUEST');

export interface HanamiUserFeedRequestPort {
	/**
	 * Reads role/profile availability without creating feed state, batches,
	 * refresh mappings, or queue work.
	 */
	checkAvailability(userId: string): Promise<HanamiUserFeedAvailabilityResult>;

	/**
	 * Evaluates a cursorless request. It may create the first durable batch only
	 * when state is absent or notEvaluated, and otherwise never creates work
	 * except by joining an existing initial request.
	 */
	evaluateCursorless(userId: string): Promise<HanamiUserFeedRequestResult>;

	/**
	 * Evaluates an explicit cursorless refresh. The token is the original
	 * 32-byte base64url value; only its SHA-256 digest may be persisted.
	 */
	requestRefresh(
		userId: string,
		refreshToken: string,
	): Promise<HanamiUserFeedRequestResult>;
}

export type HanamiPersonalFeedCandidate = {
	readonly noteId: string;
	readonly authorId: string;
	readonly axis: HanamiUserFeedAxis;
	readonly origin: HanamiUserFeedOrigin;
	readonly score: number;
	readonly term?: string;
	readonly clusterId?: number;
	readonly bucket?: HanamiUserFeedReasonBucket;
};

export type HanamiUserFeedReasonMetadata = {
	readonly version: 1;
	readonly term?: string;
	readonly clusterId?: number;
	readonly bucket?: HanamiUserFeedReasonBucket;
	readonly fallbackOverflow?: true;
};

export type HanamiPersonalFeedItem = {
	readonly noteId: string;
	readonly source: HanamiUserFeedAxis;
	readonly sources: readonly HanamiUserFeedAxis[];
	readonly origin: HanamiUserFeedOrigin;
	readonly reasonMetadata: HanamiUserFeedReasonMetadata;
};

export type HanamiPersonalFeedComputationInput = {
	readonly userId: string;
	readonly baseCommonGenerationId: string;

	/**
	 * Database-clock timestamp captured for this attempt. Candidate windows and
	 * persisted generatedAt values are derived from this timestamp.
	 */
	readonly generatedAt: string;

	/**
	 * Absolute database-clock hard deadline for the entire attempt.
	 */
	readonly databaseDeadlineAt: string;

	readonly signal: AbortSignal;
};

export type HanamiPersonalFeedComputationResult = {
	readonly confidence: HanamiUserFeedConfidence;
	readonly items: readonly HanamiPersonalFeedItem[];

	/**
	 * One element per completed segment. Each value is 1..30, there are at most
	 * seven values, and their sum equals items.length.
	 */
	readonly segmentLengths: readonly number[];
};

export const HANAMI_PERSONAL_FEED_COMPUTATION = Symbol('HANAMI_PERSONAL_FEED_COMPUTATION');

export interface HanamiPersonalFeedComputationPort {
	readonly algorithmVersion: string;

	computePersonalFeed(
		input: HanamiPersonalFeedComputationInput,
	): Promise<HanamiPersonalFeedComputationResult>;
}

/**
 * Result of executing one queue delivery for a durable personal batch.
 *
 * pending: batch exists but is not currently claimable.
 * leased: another owner has a live lease.
 * terminal: batch was already failed or was deleted by ownership cascade.
 * stale: this worker claimed it but lost its owner/attempt/lifecycle CAS.
 * obsolete: batch was already obsolete or was invalidated by this run.
 * alreadyReady: publication had already committed.
 * published: this run atomically published the batch.
 * failed: this attempt failed and was either returned to pending or terminalized.
 */
export type HanamiUserFeedGenerationRunResult =
	| {
		readonly kind: 'pending';
		readonly batchId: string;
	}
	| {
		readonly kind: 'leased';
		readonly batchId: string;
		readonly attempt: number;
	}
	| {
		readonly kind: 'terminal';
		readonly batchId: string;
		readonly status: 'failed' | 'missing';
	}
	| {
		readonly kind: 'stale';
		readonly batchId: string;
		readonly attempt: number;
	}
	| {
		readonly kind: 'obsolete';
		readonly batchId: string;
	}
	| {
		readonly kind: 'alreadyReady';
		readonly batchId: string;
		readonly itemCount: number;
	}
	| {
		readonly kind: 'published';
		readonly batchId: string;
		readonly attempt: number;
		readonly itemCount: number;
		readonly feedEpochId: string;
		readonly headSequence: string;
	}
	| {
		readonly kind: 'failed';
		readonly batchId: string;
		readonly attempt: number;
		/**
		 * false means the same batch was returned to pending.
		 * true means the batch and pending refresh mappings became failed.
		 */
		readonly terminal: boolean;
	};

export type HanamiUserFeedGenerationReconcileResult = {
	/**
	 * Pending or lease-expired durable batches that queue code should enqueue.
	 * Reconciliation does not claim them or increment attempts.
	 */
	readonly batchIdsToEnqueue: readonly string[];

	readonly failedBatchCount: number;
	readonly obsoleteBatchCount: number;
	readonly deletedRefreshCount: number;

	/**
	 * More eligible rows existed beyond this bounded reconciliation pass.
	 */
	readonly hasMore: boolean;
};

export const HANAMI_USER_FEED_GENERATION_LIFECYCLE = Symbol('HANAMI_USER_FEED_GENERATION_LIFECYCLE');

export interface HanamiUserFeedGenerationLifecyclePort {
	runUserFeedGeneration(
		batchId: string,
	): Promise<HanamiUserFeedGenerationRunResult>;

	/**
	 * Processes at most `limit` active batches and at most `limit` expired
	 * refresh mappings. It terminalizes invalid/max-attempt work and returns
	 * only valid pending/expired batch IDs for queue dispatch.
	 */
	reconcileUserFeedGeneration(
		limit: number,
	): Promise<HanamiUserFeedGenerationReconcileResult>;
}

export type HanamiPersistedPersonalFeedEntry = {
	readonly kind: 'personal';
	readonly epochId: string;
	readonly sequence: string;
	readonly batchId: string;
	readonly noteId: string;
	readonly source: HanamiUserFeedAxis;
	readonly sources: readonly HanamiUserFeedAxis[];
	readonly origin: HanamiUserFeedOrigin;
	readonly reasonMetadata: HanamiUserFeedReasonMetadata;
};

export type HanamiPersistedCommonFeedEntry = {
	readonly kind: 'common';
	readonly epochId: string;
	readonly sequence: string;

	/**
	 * Common generation ID, exposed as batchId by the eventual endpoint.
	 */
	readonly batchId: string;

	readonly noteId: string;
	readonly source: HanamiUserFeedAxis;
	readonly sources: readonly HanamiUserFeedAxis[];

	/**
	 * Canonical YYYY-MM value and row ID needed for the common feed-entry
	 * locator. The read port does not encode that locator.
	 */
	readonly generatedMonth: string;
	readonly rowId: string;
};

export type HanamiPersistedFeedEntry =
	| HanamiPersistedPersonalFeedEntry
	| HanamiPersistedCommonFeedEntry;

export type HanamiPersistedFeedScanInput = {
	readonly requesterUserId: string;
	readonly head: HanamiFeedHeadSnapshot;

	/**
	 * Null for the first scan under head.headSequence. Otherwise this is the
	 * last raw sequence scanned by the preceding page and is an exclusive bound.
	 */
	readonly beforeSequence: string | null;

	readonly scanLimit: number;
};

export type HanamiPersistedFeedScanResult =
	| {
		readonly kind: 'page';
		readonly entries: readonly HanamiPersistedFeedEntry[];
		readonly lastScannedSequence: string | null;
		readonly hasMore: boolean;
	}
	| {
		readonly kind: 'cursorExpired';
	}
	| {
		readonly kind: 'commonNotReady';
	};

/**
 * Resumes a raw scan from a verified cursor. The cursor boundary consists only
 * of its owner, feed kind, epoch, and sequence; batch IDs are entry metadata
 * and are deliberately not part of cursor identity.
 */
export type HanamiPersistedFeedCursorResumeInput = {
	readonly requesterUserId: string;
	readonly cursor: {
		readonly kind: HanamiUserFeedKind;
		readonly feedEpochId: string;
		readonly sequence: string;
	};
	readonly scanLimit: number;
};

export type HanamiPersistedFeedCursorResumeResult =
	| {
		readonly kind: 'page';
		readonly head: HanamiFeedHeadSnapshot;
		readonly entries: readonly HanamiPersistedFeedEntry[];
		readonly lastScannedSequence: string | null;
		readonly hasMore: boolean;
	}
	| {
		readonly kind: 'cursorExpired';
	}
	| {
		readonly kind: 'commonNotReady';
	};

export const HANAMI_PERSISTED_FEED_READ = Symbol('HANAMI_PERSISTED_FEED_READ');

export interface HanamiPersistedFeedReadPort {
	/**
	 * Reads raw ready-parent entries and validates user/epoch/retention state.
	 * It does not decode/sign cursors, apply safety, filter withFiles, pack
	 * Notes, or record served events.
	 */
	scanReadyEntries(
		input: HanamiPersistedFeedScanInput,
	): Promise<HanamiPersistedFeedScanResult>;

	/**
	 * Reads raw ready-parent entries below cursor.sequence, validates cursor
	 * ownership, active epoch, and retention state, and reconstructs the current
	 * stable head used for response metadata.
	 */
	resumeReadyEntries(
		input: HanamiPersistedFeedCursorResumeInput,
	): Promise<HanamiPersistedFeedCursorResumeResult>;
}
