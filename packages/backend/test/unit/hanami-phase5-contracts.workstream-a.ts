/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import type { HanamiCursorPayload } from '@/core/hanami/HanamiFeedCodecTypes.js';
import type {
	HanamiPersistedFeedCursorResumeInput,
	HanamiPersistedFeedCursorResumeResult,
	HanamiPersistedPersonalFeedEntry,
	HanamiUserFeedAvailabilityResult,
	HanamiUserFeedRequestResult,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import type {
	HanamiDurableSeenEntryInput,
	HanamiDurableServedEntryInput,
	HanamiTimelineItem,
	HanamiTimelinePackedEntry,
	HanamiTimelinePackingInput,
	HanamiTimelinePackingOutput,
	HanamiTimelinePageInput,
	HanamiTimelinePageResult,
	HanamiTimelineRequest,
	HanamiTimelineResponse,
	HanamiTimelineSeenRequest,
} from '@/core/hanami/HanamiTimelineContracts.js';

const head = {
	mode: 'personalized',
	kind: 'personal',
	feedEpochId: 'epoch-1',
	headBatchId: 'batch-1',
	headSequence: '9',
} as const;

const entry: HanamiPersistedPersonalFeedEntry = {
	kind: 'personal',
	epochId: 'epoch-1',
	sequence: '9',
	batchId: 'batch-1',
	noteId: 'note-1',
	source: 'catchup',
	sources: ['catchup'],
	origin: 'personalCandidate',
	reasonMetadata: { version: 1, bucket: 'recent' },
};

describe('Hanami Phase 5 workstream A contracts', () => {
	test('availability and request results expose every frozen union variant', () => {
		const availability = [
			{ kind: 'available' },
			{ kind: 'roleDisabled' },
			{ kind: 'recommendationDisabled', head },
			{ kind: 'recommendationDisabled', head: null },
		] satisfies HanamiUserFeedAvailabilityResult[];
		const requestResults = [
			{ kind: 'serve', head, generationPending: true, requestedBatchId: 'batch-2' },
			{ kind: 'serve', head, generationPending: false, requestedBatchId: null },
			{ kind: 'roleDisabled' },
			{ kind: 'recommendationDisabled', head },
			{ kind: 'recommendationDisabled', head: null },
			{ kind: 'commonNotReady' },
			{ kind: 'invalidRefreshToken' },
			{ kind: 'refreshTokenExpired' },
			{ kind: 'refreshRateLimited' },
		] satisfies HanamiUserFeedRequestResult[];

		expect(availability.map(result => result.kind)).toEqual([
			'available',
			'roleDisabled',
			'recommendationDisabled',
			'recommendationDisabled',
		]);
		expect(requestResults.map(result => result.kind)).toEqual([
			'serve',
			'serve',
			'roleDisabled',
			'recommendationDisabled',
			'recommendationDisabled',
			'commonNotReady',
			'invalidRefreshToken',
			'refreshTokenExpired',
			'refreshRateLimited',
		]);
	});

	test('cursor resume carries owner, kind, epoch, and sequence without a batch id', () => {
		const resumeInput: HanamiPersistedFeedCursorResumeInput = {
			requesterUserId: 'user-1',
			cursor: {
				kind: 'personal',
				feedEpochId: 'epoch-1',
				sequence: '9',
			},
			scanLimit: 20,
		};
		const resumeResults = [
			{ kind: 'page', head, entries: [entry], lastScannedSequence: '9', hasMore: true },
			{ kind: 'cursorExpired' },
			{ kind: 'commonNotReady' },
		] satisfies HanamiPersistedFeedCursorResumeResult[];
		const cursorHasBatchId: 'batchId' extends keyof HanamiCursorPayload ? true : false = false;
		const resumeHasBatchId: 'batchId' extends keyof HanamiPersistedFeedCursorResumeInput ? true : false = false;
		const resumeCursorHasBatchId: 'batchId' extends keyof HanamiPersistedFeedCursorResumeInput['cursor'] ? true : false = false;

		expect(resumeInput).toEqual({
			requesterUserId: 'user-1',
			cursor: {
				kind: 'personal',
				feedEpochId: 'epoch-1',
				sequence: '9',
			},
			scanLimit: 20,
		});
		expect(resumeResults[0]).toMatchObject({ kind: 'page', head });
		expect(resumeResults.map(result => result.kind)).toEqual(['page', 'cursorExpired', 'commonNotReady']);
		expect(cursorHasBatchId).toBe(false);
		expect(resumeHasBatchId).toBe(false);
		expect(resumeCursorHasBatchId).toBe(false);
	});

	test('public page, packing, served, and seen shapes preserve entry identity', () => {
		const request: HanamiTimelineRequest = {
			limit: 20,
			cursor: null,
			refresh: false,
			refreshToken: null,
			withFiles: false,
		};
		const item: HanamiTimelineItem = {
			note: {} as Packed<'Note'>,
			feedEntryId: 'locator-1',
			batchId: entry.batchId,
		};
		const response: HanamiTimelineResponse = {
			items: [item],
			nextCursor: 'cursor-1',
			hasMore: true,
			mode: 'personalized',
			generationPending: false,
			feedEpochId: head.feedEpochId,
			headBatchId: head.headBatchId,
		};
		const pageInput: HanamiTimelinePageInput = { me: {} as MiLocalUser, request };
		const pageResults = [
			{ kind: 'ok', response },
			{ kind: 'roleDisabled' },
			{ kind: 'invalidCursor' },
			{ kind: 'cursorExpired' },
			{ kind: 'commonNotReady' },
			{ kind: 'invalidRefreshToken' },
			{ kind: 'refreshTokenExpired' },
			{ kind: 'refreshRateLimited' },
		] satisfies HanamiTimelinePageResult[];
		const packingInput: HanamiTimelinePackingInput = {
			me: pageInput.me,
			entries: [entry],
			limit: request.limit,
			withFiles: request.withFiles,
		};
		const packedEntry: HanamiTimelinePackedEntry = { entry, note: item.note };
		const packingOutput: HanamiTimelinePackingOutput = [packedEntry];
		const served: HanamiDurableServedEntryInput = { feedEntryId: item.feedEntryId, entry };
		const seen: HanamiDurableSeenEntryInput = { feedEntryId: item.feedEntryId, noteId: entry.noteId };
		const seenRequest: HanamiTimelineSeenRequest = { items: [seen] };

		expect(pageResults.map(result => result.kind)).toEqual([
			'ok',
			'roleDisabled',
			'invalidCursor',
			'cursorExpired',
			'commonNotReady',
			'invalidRefreshToken',
			'refreshTokenExpired',
			'refreshRateLimited',
		]);
		expect(packingInput.entries[0]).toBe(packingOutput[0]?.entry);
		expect(served.entry).toBe(entry);
		expect(seenRequest).toEqual({ items: [{ feedEntryId: 'locator-1', noteId: 'note-1' }] });
	});
});
