/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import type { HanamiPersistedFeedEntry } from '@/core/hanami/HanamiUserFeedContracts.js';

/** Public request body for notes/hanami-timeline after schema defaults. */
export type HanamiTimelineRequest = {
	readonly limit: number;
	readonly cursor: string | null;
	readonly refresh: boolean;
	readonly refreshToken: string | null;
	readonly withFiles: boolean;
};

export type HanamiTimelineItem = {
	readonly feedEntryId: string;
	readonly batchId: string;
	readonly note: Packed<'Note'>;
};

export type HanamiTimelineResponse = {
	readonly items: readonly HanamiTimelineItem[];
	readonly nextCursor: string | null;
	readonly hasMore: boolean;
	readonly mode: 'personalized' | 'common';
	readonly generationPending: boolean;
	readonly feedEpochId: string;
	readonly headBatchId: string;
};

/** Backend input for one cursorless, refresh, or cursor-resume page request. */
export type HanamiTimelinePageInput = {
	readonly me: MiLocalUser;
	readonly request: HanamiTimelineRequest;
};

/** Core outcomes are mapped to endpoint errors at the API boundary. */
export type HanamiTimelinePageResult =
	| {
		readonly kind: 'ok';
		readonly response: HanamiTimelineResponse;
	}
	| {
		readonly kind: 'roleDisabled';
	}
	| {
		readonly kind: 'invalidCursor';
	}
	| {
		readonly kind: 'cursorExpired';
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

/** Safety/packing input that keeps durable entries attached to packed Notes. */
export type HanamiTimelinePackingInput = {
	readonly me: MiLocalUser;
	readonly entries: readonly HanamiPersistedFeedEntry[];
	readonly limit: number;
	readonly withFiles: boolean;
};

export type HanamiTimelinePackedEntry = {
	readonly entry: HanamiPersistedFeedEntry;
	readonly note: Packed<'Note'>;
};

export type HanamiTimelinePackingOutput = readonly HanamiTimelinePackedEntry[];

/** One durable served event, before database-clock timestamping. */
export type HanamiDurableServedEntryInput = {
	readonly feedEntryId: string;
	readonly entry: HanamiPersistedFeedEntry;
};

/** One durable seen event supplied by the authenticated user. */
export type HanamiDurableSeenEntryInput = {
	readonly feedEntryId: string;
	readonly noteId: string;
};

export type HanamiTimelineSeenRequest = {
	readonly items: readonly HanamiDurableSeenEntryInput[];
};
