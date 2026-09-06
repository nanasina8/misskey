/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { QueryRunner } from 'typeorm';

export const HANAMI_COMMON_AXES = ['globalPopular', 'trending', 'exploration'] as const;

export type HanamiCommonAxis = typeof HANAMI_COMMON_AXES[number];

export type HanamiCommonTrigger = 'scheduled' | 'seed';

export type HanamiCommonSourceAsOf = {
	readonly version: 1;
	readonly capturedAt: string;
	readonly featuredAt: string;
	readonly trendAt: string;
	readonly axisConfigAt: string;
};

export type HanamiCommonCandidate = {
	readonly noteId: string;
	readonly authorId: string;
	readonly baseScore: number;
	readonly metadata: Readonly<Record<string, unknown>>;
};

export type HanamiCommonCandidateMap = {
	readonly [Axis in HanamiCommonAxis]: readonly HanamiCommonCandidate[];
};

export type HanamiTrendSnapshotTerm = {
	readonly term: string;
	readonly score: number;
	readonly distinctAuthors: number;
	readonly representativeNoteIds: readonly string[];
};

export type HanamiCommonSourceBundle = {
	readonly version: 1;
	readonly capturedAt: string;
	readonly sourceAsOf: HanamiCommonSourceAsOf;
	readonly enabledAxes: readonly HanamiCommonAxis[];
	readonly candidates: HanamiCommonCandidateMap;
	readonly trendSnapshot: {
		readonly terms: readonly HanamiTrendSnapshotTerm[];
	};
};

export type HanamiCommonFeedItem = {
	readonly noteId: string;
	readonly authorId: string;
	readonly source: HanamiCommonAxis;
	readonly sources: readonly HanamiCommonAxis[];
};

export type HanamiCommonFeedMaterialization = {
	readonly items: readonly HanamiCommonFeedItem[];
	readonly segmentLengths: readonly number[];
};

export type HanamiCommonSourceBuildInput = {
	readonly generationId: string;
	readonly generationFence: string;
	readonly generatedAt: string;
	readonly sourceAsOf: Date;
	readonly signal: AbortSignal;
};

export type HanamiCommonFeedBuildInput = {
	readonly source: HanamiCommonSourceBundle;
	readonly recentCommonNoteIds: ReadonlySet<string>;
};

export const HANAMI_COMMON_COMPUTATION = Symbol('HANAMI_COMMON_COMPUTATION');

export interface HanamiCommonComputationPort {
	readonly algorithmVersion: string;
	buildSourceBundle(input: HanamiCommonSourceBuildInput): Promise<HanamiCommonSourceBundle>;
	materializeFeed(input: HanamiCommonFeedBuildInput): HanamiCommonFeedMaterialization;
}

export type HanamiCommonGenerationRequestResult =
	| {
		readonly kind: 'dispatch';
		readonly generationId: string;
	}
	| {
		readonly kind: 'noop';
		readonly reason: 'active' | 'notDue' | 'alreadySeeded';
	};

export type HanamiCommonGenerationRunResult =
	| {
		readonly kind: 'published';
		readonly generationId: string;
		readonly generationFence: string;
		readonly itemCount: number;
	}
	| {
		readonly kind: 'alreadyReady';
		readonly generationId: string;
	}
	| {
		readonly kind: 'notClaimed';
		readonly generationId: string;
		readonly reason: 'leased' | 'terminal' | 'notCurrent';
	}
	| {
		readonly kind: 'stale';
		readonly generationId: string;
	};

export type HanamiCommonGenerationDispatch =
	| {
		readonly generationId: string;
		readonly reason: 'pending';
	}
	| {
		readonly generationId: string;
		readonly reason: 'leaseExpired';
	};

export const HANAMI_COMMON_GENERATION_LIFECYCLE = Symbol('HANAMI_COMMON_GENERATION_LIFECYCLE');

export interface HanamiCommonGenerationLifecyclePort {
	requestCommonGeneration(trigger: HanamiCommonTrigger): Promise<HanamiCommonGenerationRequestResult>;
	runCommonGeneration(generationId: string, options?: HanamiCommonGenerationRunOptions): Promise<HanamiCommonGenerationRunResult>;
	findDispatchableCommonGeneration(): Promise<HanamiCommonGenerationDispatch | null>;
}

export type HanamiCommonGenerationRunOptions = {
	readonly sourceAsOf?: Date;
};

export type HanamiReadyCommonHead = {
	readonly epochId: string;
	readonly generationId: string;
	readonly generationOrdinal: string;
	readonly generationFence: string;
	readonly latestSequence: string;
	readonly earliestRetainedSequence: string;
};

export type HanamiPersistedCommonCandidate = {
	readonly axis: HanamiCommonAxis;
	readonly rank: string;
	readonly noteId: string;
	readonly baseScore: number;
	readonly metadata: Readonly<Record<string, unknown>>;
};

export const HANAMI_COMMON_GENERATION_READ = Symbol('HANAMI_COMMON_GENERATION_READ');

export type HanamiCommonGenerationReadContext = {
	readonly queryRunner: QueryRunner;
	readonly signal: AbortSignal;
	readonly databaseDeadlineAt: string;
};

export interface HanamiCommonGenerationReadPort {
	getLatestReadyCommonHead(): Promise<HanamiReadyCommonHead | null>;
	loadReadyCommonCandidates(
		generationId: string,
		context?: HanamiCommonGenerationReadContext,
	): Promise<readonly HanamiPersistedCommonCandidate[]>;
}
