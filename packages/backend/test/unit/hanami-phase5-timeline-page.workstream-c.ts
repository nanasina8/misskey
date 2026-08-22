/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import type { Config } from '@/config.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import {
	decodeAndVerifyHanamiCursor,
	decodeHanamiCommonFeedEntryLocator,
	decodeHanamiPersonalFeedEntryLocator,
	encodeHanamiCursor,
} from '@/core/hanami/HanamiFeedCodec.js';
import type { HanamiCursorSigningKey } from '@/core/hanami/HanamiFeedCodecTypes.js';
import { HANAMI_FORYOU_ACTIVE_KEY_PREFIX, HANAMI_FORYOU_ACTIVE_TTL_SEC } from '@/core/hanami/HanamiForYouKeys.js';
import { HanamiInvalidFeedEntryError } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { HanamiTimelinePageService } from '@/core/hanami/HanamiTimelinePageService.js';
import type {
	HanamiDurableServedEntryInput,
	HanamiTimelinePackingInput,
	HanamiTimelinePackingOutput,
	HanamiTimelineRequest,
} from '@/core/hanami/HanamiTimelineContracts.js';
import type {
	HanamiFeedHeadSnapshot,
	HanamiPersistedCommonFeedEntry,
	HanamiPersistedFeedReadPort,
	HanamiPersistedPersonalFeedEntry,
	HanamiUserFeedRequestPort,
} from '@/core/hanami/HanamiUserFeedContracts.js';

const currentKey = { id: 'current', secret: Buffer.alloc(32, 1) } as const;
const previousKey = { id: 'previous', secret: Buffer.alloc(32, 2) } as const;
const unknownKey = { id: 'unknown', secret: Buffer.alloc(32, 3) } as const;

const personalHead: HanamiFeedHeadSnapshot = {
	mode: 'personalized',
	kind: 'personal',
	feedEpochId: 'personal-epoch',
	headBatchId: 'personal-batch',
	headSequence: '500',
};

const commonHead: HanamiFeedHeadSnapshot = {
	mode: 'common',
	kind: 'common',
	feedEpochId: 'common-epoch',
	headBatchId: 'common-generation',
	headSequence: '500',
};

function personalEntry(sequence: string, noteId = `note-${sequence}`, batchId = `batch-${sequence}`): HanamiPersistedPersonalFeedEntry {
	return {
		kind: 'personal',
		epochId: personalHead.feedEpochId,
		sequence,
		batchId,
		noteId,
		source: 'catchup',
		sources: ['catchup'],
		origin: 'personalCandidate',
		reasonMetadata: { version: 1 },
	};
}

function commonEntry(sequence: string, source: HanamiPersistedCommonFeedEntry['source']): HanamiPersistedCommonFeedEntry {
	return {
		kind: 'common',
		epochId: commonHead.feedEpochId,
		sequence,
		batchId: `generation-${sequence}`,
		noteId: `note-${sequence}`,
		source,
		sources: [source],
		generatedMonth: '2026-08',
		rowId: `row-${sequence}`,
	};
}

const me = { id: 'user-1' } as MiLocalUser;

function request(overrides: Partial<HanamiTimelineRequest> = {}): HanamiTimelineRequest {
	return {
		limit: 15,
		cursor: null,
		refresh: false,
		refreshToken: null,
		withFiles: false,
		...overrides,
	};
}

function fixture(options: {
	meta?: Partial<MiMeta>;
	profileAxes?: Record<string, string | boolean>;
	showReason?: boolean;
	redisFailure?: Error;
} = {}) {
	const requestPort = {
		checkAvailability: jest.fn<HanamiUserFeedRequestPort['checkAvailability']>(async () => ({ kind: 'available' })),
		evaluateCursorless: jest.fn<HanamiUserFeedRequestPort['evaluateCursorless']>(async () => ({
			kind: 'serve', head: personalHead, generationPending: false, requestedBatchId: null,
		})),
		requestRefresh: jest.fn<HanamiUserFeedRequestPort['requestRefresh']>(async () => ({
			kind: 'serve', head: personalHead, generationPending: false, requestedBatchId: 'refresh-batch',
		})),
	};
	const readPort = {
		scanReadyEntries: jest.fn<HanamiPersistedFeedReadPort['scanReadyEntries']>(async () => ({
			kind: 'page', entries: [], lastScannedSequence: null, hasMore: false,
		})),
		resumeReadyEntries: jest.fn<HanamiPersistedFeedReadPort['resumeReadyEntries']>(async () => ({
			kind: 'page', head: personalHead, entries: [], lastScannedSequence: null, hasMore: false,
		})),
	};
	const pack = jest.fn<(input: HanamiTimelinePackingInput) => Promise<HanamiTimelinePackingOutput>>(async input => (
		input.entries.slice(0, input.limit).map(entry => ({
			entry,
			note: { id: entry.noteId } as Packed<'Note'>,
		}))
	));
	const recordServedFeedEntries = jest.fn<(userId: string, entries: readonly HanamiDurableServedEntryInput[]) => Promise<void>>(async () => undefined);
	const profileFetch = jest.fn(async () => ({
		hanamiRecommendationAxes: options.profileAxes ?? {},
		hanamiShowRecommendationReason: options.showReason ?? false,
	}));
	const redisSet = jest.fn(async () => {
		if (options.redisFailure != null) throw options.redisFailure;
		return 'OK' as const;
	});
	const service = new HanamiTimelinePageService(
		{ hanamiCursorSigningKeys: [currentKey, previousKey] } as Config,
		{ hanamiRecommendationAxisConfig: {}, ...options.meta } as MiMeta,
		{ set: redisSet } as never,
		requestPort,
		readPort,
		{ userProfileCache: { fetch: profileFetch } } as never,
		{ filterAndPackPersistedEntries: pack } as never,
		{ recordServedFeedEntries } as never,
	);
	return { service, requestPort, readPort, pack, recordServedFeedEntries, profileFetch, redisSet };
}

function cursor(sequence = '400', key: HanamiCursorSigningKey = currentKey, userId = me.id): string {
	return encodeHanamiCursor({
		userId,
		kind: 'personal',
		epochId: personalHead.feedEpochId,
		sequence,
	}, [key]);
}

describe('Hanami Phase 5 workstream C timeline page service', () => {
	test('separates normal, refresh, and cursor calls and applies the exact clamp and scan-cap formula', async () => {
		const normal = fixture();
		await normal.service.serve({ me, request: request({ limit: 99, withFiles: true }) });
		expect(normal.requestPort.evaluateCursorless).toHaveBeenCalledTimes(1);
		expect(normal.requestPort.requestRefresh).not.toHaveBeenCalled();
		expect(normal.requestPort.checkAvailability).not.toHaveBeenCalled();
		expect(normal.readPort.scanReadyEntries).toHaveBeenCalledWith(expect.objectContaining({ scanLimit: 200 }));
		expect(normal.pack).toHaveBeenCalledWith(expect.objectContaining({ limit: 30, withFiles: true }));

		const refresh = fixture();
		const token = 'A'.repeat(43);
		await refresh.service.serve({ me, request: request({ refresh: true, refreshToken: token }) });
		expect(refresh.requestPort.requestRefresh).toHaveBeenCalledWith(me.id, token);
		expect(refresh.requestPort.evaluateCursorless).not.toHaveBeenCalled();
		expect(refresh.requestPort.checkAvailability).not.toHaveBeenCalled();

		const continuation = fixture();
		await continuation.service.serve({ me, request: request({ cursor: cursor() }) });
		expect(continuation.requestPort.checkAvailability).toHaveBeenCalledWith(me.id);
		expect(continuation.requestPort.evaluateCursorless).not.toHaveBeenCalled();
		expect(continuation.requestPort.requestRefresh).not.toHaveBeenCalled();
		expect(continuation.readPort.scanReadyEntries).not.toHaveBeenCalled();
		expect(continuation.readPort.resumeReadyEntries).toHaveBeenCalledWith(expect.objectContaining({
			requesterUserId: me.id,
			cursor: { kind: 'personal', feedEpochId: personalHead.feedEpochId, sequence: '400' },
			scanLimit: 200,
		}));
	});

	test('refreshes the 14-day taste-active marker after cursorless and cursor persisted pages', async () => {
		const cursorless = fixture();
		await expect(cursorless.service.serve({ me, request: request() })).resolves.toMatchObject({ kind: 'ok' });
		expect(cursorless.redisSet).toHaveBeenCalledWith(
			HANAMI_FORYOU_ACTIVE_KEY_PREFIX + me.id,
			'1',
			'EX',
			HANAMI_FORYOU_ACTIVE_TTL_SEC,
		);

		const continuation = fixture();
		await expect(continuation.service.serve({ me, request: request({ cursor: cursor() }) })).resolves.toMatchObject({ kind: 'ok' });
		expect(continuation.redisSet).toHaveBeenCalledWith(
			HANAMI_FORYOU_ACTIVE_KEY_PREFIX + me.id,
			'1',
			'EX',
			HANAMI_FORYOU_ACTIVE_TTL_SEC,
		);
	});

	test('keeps Redis marker failure non-fatal and cursor pagination generation-free', async () => {
		const target = fixture({ redisFailure: new Error('redis unavailable') });
		await expect(target.service.serve({ me, request: request({ cursor: cursor() }) })).resolves.toMatchObject({ kind: 'ok' });
		expect(target.redisSet).toHaveBeenCalledTimes(1);
		expect(target.requestPort.checkAvailability).toHaveBeenCalledTimes(1);
		expect(target.readPort.resumeReadyEntries).toHaveBeenCalledTimes(1);
		expect(target.requestPort.evaluateCursorless).not.toHaveBeenCalled();
		expect(target.requestPort.requestRefresh).not.toHaveBeenCalled();
	});

	test.each([
		{ name: 'current', makeCursor: () => cursor('400', currentKey), expectedKind: 'ok' },
		{ name: 'previous', makeCursor: () => cursor('400', previousKey), expectedKind: 'ok' },
		{ name: 'unknown', makeCursor: () => cursor('400', unknownKey), expectedKind: 'cursorExpired' },
		{ name: 'wrong user', makeCursor: () => cursor('400', currentKey, 'user-10'), expectedKind: 'invalidCursor' },
	] as const)('handles $name signing/ownership cursor case', async ({ makeCursor, expectedKind }) => {
		const target = fixture();
		const result = await target.service.serve({ me, request: request({ cursor: makeCursor() }) });
		expect(result.kind).toBe(expectedKind);
		expect(target.requestPort.checkAvailability).toHaveBeenCalledTimes(1);
		expect(target.readPort.resumeReadyEntries).toHaveBeenCalledTimes(expectedKind === 'ok' ? 1 : 0);
	});

	test('rejects malformed and tampered cursors without reading or generating', async () => {
		for (const value of ['malformed', `${cursor().slice(0, -1)}${cursor().endsWith('A') ? 'B' : 'A'}`]) {
			const target = fixture();
			await expect(target.service.serve({ me, request: request({ cursor: value }) })).resolves.toEqual({ kind: 'invalidCursor' });
			expect(target.readPort.resumeReadyEntries).not.toHaveBeenCalled();
			expect(target.requestPort.evaluateCursorless).not.toHaveBeenCalled();
			expect(target.requestPort.requestRefresh).not.toHaveBeenCalled();
		}
	});

	test('stops the scan cursor at the 30th visible raw entry rather than the 200th fetched entry', async () => {
		const target = fixture();
		const entries = Array.from({ length: 200 }, (_, index) => personalEntry(String(500 - index)));
		target.readPort.scanReadyEntries.mockResolvedValue({
			kind: 'page', entries, lastScannedSequence: '301', hasMore: false,
		});

		const result = await target.service.serve({ me, request: request({ limit: 30 }) });
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.response.items).toHaveLength(30);
		expect(result.response.hasMore).toBe(true);
		expect(decodeAndVerifyHanamiCursor(result.response.nextCursor!, [currentKey, previousKey]).sequence).toBe('471');
		expect(result.response.nextCursor).not.toContain(entries[29]!.noteId);
		expect(target.recordServedFeedEntries.mock.calls[0]![1]).toHaveLength(30);
	});

	test('advances across an all-filtered raw page and never emits an unchanged/null cursor with hasMore', async () => {
		const filtered = fixture();
		const entries = [personalEntry('300'), personalEntry('299')];
		filtered.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries, lastScannedSequence: '299', hasMore: true });
		filtered.pack.mockResolvedValue([]);
		const page = await filtered.service.serve({ me, request: request() });
		expect(page.kind).toBe('ok');
		if (page.kind !== 'ok') return;
		expect(page.response.items).toEqual([]);
		expect(page.response.hasMore).toBe(true);
		expect(decodeAndVerifyHanamiCursor(page.response.nextCursor!, [currentKey, previousKey]).sequence).toBe('299');
		expect(filtered.recordServedFeedEntries).not.toHaveBeenCalled();

		const unchanged = fixture();
		unchanged.readPort.resumeReadyEntries.mockResolvedValue({
			kind: 'page', head: personalHead, entries: [], lastScannedSequence: null, hasMore: true,
		});
		const terminal = await unchanged.service.serve({ me, request: request({ cursor: cursor('299') }) });
		expect(terminal.kind).toBe('ok');
		if (terminal.kind !== 'ok') return;
		expect(terminal.response).toMatchObject({ hasMore: false, nextCursor: null });
	});

	test('filters common primary sources and exposes only enabled source reasons', async () => {
		const current = fixture({ profileAxes: { trending: 'off' }, showReason: true });
		current.requestPort.evaluateCursorless.mockResolvedValue({
			kind: 'serve', head: commonHead, generationPending: false, requestedBatchId: null,
		});
		current.readPort.scanReadyEntries.mockResolvedValue({
			kind: 'page', entries: [commonEntry('4', 'globalPopular'), commonEntry('3', 'trending')], lastScannedSequence: '3', hasMore: false,
		});
		const currentResult = await current.service.serve({ me, request: request() });
		expect(current.pack.mock.calls[0]![0].entries.map(entry => entry.source)).toEqual(['globalPopular']);
		expect(currentResult.kind).toBe('ok');
		if (currentResult.kind !== 'ok') return;
		expect(decodeHanamiCommonFeedEntryLocator(currentResult.response.items[0]!.feedEntryId)).toEqual({
			version: 1,
			epochId: commonHead.feedEpochId,
			generatedMonth: '2026-08',
			rowId: 'row-4',
		});
		expect((currentResult.response.items[0]!.note as Record<string, unknown>)._hanamiReason).toEqual({ reason: 'globalPopular' });
		expect(current.profileFetch).toHaveBeenCalledTimes(1);

		const legacy = fixture({ meta: { hanamiRecommendationAxisConfig: { popular: { available: false } } } as never });
		legacy.requestPort.evaluateCursorless.mockResolvedValue({
			kind: 'serve', head: commonHead, generationPending: false, requestedBatchId: null,
		});
		legacy.readPort.scanReadyEntries.mockResolvedValue({
			kind: 'page', entries: [commonEntry('4', 'globalPopular'), commonEntry('3', 'exploration'), commonEntry('2', 'trending')], lastScannedSequence: '2', hasMore: false,
		});
		const legacyResult = await legacy.service.serve({ me, request: request() });
		expect(legacy.pack.mock.calls[0]![0].entries.map(entry => entry.source)).toEqual(['trending']);
		expect(legacyResult.kind).toBe('ok');
		if (legacyResult.kind !== 'ok') return;
		expect(legacyResult.response.items[0]!.note).not.toHaveProperty('_hanamiReason');

		const personal = fixture({ profileAxes: { catchup: 'off' } });
		personal.readPort.scanReadyEntries.mockResolvedValue({
			kind: 'page', entries: [personalEntry('4')], lastScannedSequence: '4', hasMore: false,
		});
		await personal.service.serve({ me, request: request() });
		expect(personal.pack.mock.calls[0]![0].entries).toHaveLength(1);
		expect(personal.profileFetch).toHaveBeenCalledTimes(1);
	});

	test('projects persisted personal source and reason metadata only when the profile setting is enabled', async () => {
		const entry: HanamiPersistedPersonalFeedEntry = {
			...personalEntry('8'),
			source: 'reactionSimilar',
			sources: ['reactionSimilar', 'trending'],
			origin: 'commonCandidate',
			reasonMetadata: { version: 1, term: 'gardening', clusterId: 0, bucket: 'cluster', fallbackOverflow: true },
		};
		const enabled = fixture({ showReason: true });
		enabled.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries: [entry], lastScannedSequence: '8', hasMore: false });
		const enabledResult = await enabled.service.serve({ me, request: request() });
		expect(enabledResult.kind).toBe('ok');
		if (enabledResult.kind !== 'ok') return;
		expect((enabledResult.response.items[0]!.note as Record<string, unknown>)._hanamiReason).toEqual({
			reason: 'reactionSimilar',
			term: 'gardening',
			clusterId: 0,
			bucket: 'cluster',
		});
		expect(enabledResult.response.items[0]!.note).not.toHaveProperty('_hanamiRecommended');
		expect(enabled.profileFetch).toHaveBeenCalledTimes(1);

		const disabled = fixture({ showReason: false });
		disabled.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries: [entry], lastScannedSequence: '8', hasMore: false });
		const disabledResult = await disabled.service.serve({ me, request: request() });
		expect(disabledResult.kind).toBe('ok');
		if (disabledResult.kind !== 'ok') return;
		expect(disabledResult.response.items[0]!.note).not.toHaveProperty('_hanamiReason');
	});

	test('omits absent optional personal reason fields', async () => {
		const target = fixture({ showReason: true });
		target.readPort.scanReadyEntries.mockResolvedValue({
			kind: 'page', entries: [personalEntry('7')], lastScannedSequence: '7', hasMore: false,
		});
		const result = await target.service.serve({ me, request: request() });
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect((result.response.items[0]!.note as Record<string, unknown>)._hanamiReason).toEqual({ reason: 'catchup' });
	});

	test('keeps duplicate Notes as distinct ordered items and deterministic personal locators', async () => {
		const target = fixture();
		const entries = [personalEntry('10', 'same-note', 'batch-new'), personalEntry('9', 'same-note', 'batch-old')];
		target.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries, lastScannedSequence: '9', hasMore: false });
		const result = await target.service.serve({ me, request: request({ limit: 2 }) });
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.response.items.map(item => [item.note.id, item.batchId])).toEqual([
			['same-note', 'batch-new'],
			['same-note', 'batch-old'],
		]);
		expect(result.response.items.map(item => decodeHanamiPersonalFeedEntryLocator(item.feedEntryId).sequence)).toEqual(['10', '9']);
		expect(target.recordServedFeedEntries.mock.calls[0]![1].map(item => item.entry)).toEqual(entries);
	});

	test('records only returned packed entries and exposes pending generation metadata', async () => {
		const target = fixture();
		const entries = [personalEntry('3'), personalEntry('2'), personalEntry('1')];
		target.requestPort.evaluateCursorless.mockResolvedValue({
			kind: 'serve', head: personalHead, generationPending: true, requestedBatchId: 'generated-batch',
		});
		target.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries, lastScannedSequence: '1', hasMore: false });
		target.pack.mockImplementation(async input => [{ entry: input.entries[1]!, note: { id: input.entries[1]!.noteId } as never }]);
		const result = await target.service.serve({ me, request: request({ limit: 2 }) });
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.response.generationPending).toBe(true);
		expect(target.recordServedFeedEntries).toHaveBeenCalledTimes(1);
		expect(target.recordServedFeedEntries.mock.calls[0]![1]).toHaveLength(1);
		expect(target.recordServedFeedEntries.mock.calls[0]![1][0]!.entry).toBe(entries[1]);
	});

	test('does not record served events after packing failure and propagates PostgreSQL served failure', async () => {
		const packing = fixture();
		packing.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries: [personalEntry('1')], lastScannedSequence: '1', hasMore: false });
		packing.pack.mockRejectedValue(new Error('pack failed'));
		await expect(packing.service.serve({ me, request: request() })).rejects.toThrow('pack failed');
		expect(packing.recordServedFeedEntries).not.toHaveBeenCalled();

		const postgres = fixture();
		postgres.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries: [personalEntry('1')], lastScannedSequence: '1', hasMore: false });
		postgres.recordServedFeedEntries.mockRejectedValue(new Error('postgres failed'));
		await expect(postgres.service.serve({ me, request: request() })).rejects.toThrow('postgres failed');
		expect(postgres.requestPort.evaluateCursorless).toHaveBeenCalledTimes(1);
	});

	test('retries a served lifecycle race once with the same refresh token', async () => {
		const target = fixture();
		const token = 'A'.repeat(43);
		target.readPort.scanReadyEntries.mockResolvedValue({ kind: 'page', entries: [personalEntry('1')], lastScannedSequence: '1', hasMore: false });
		target.recordServedFeedEntries
			.mockRejectedValueOnce(new HanamiInvalidFeedEntryError('race'))
			.mockResolvedValueOnce(undefined);
		await expect(target.service.serve({ me, request: request({ refresh: true, refreshToken: token }) })).resolves.toMatchObject({ kind: 'ok' });
		expect(target.requestPort.requestRefresh).toHaveBeenCalledTimes(2);
		expect(target.requestPort.requestRefresh.mock.calls.map(call => call[1])).toEqual([token, token]);
		expect(target.recordServedFeedEntries).toHaveBeenCalledTimes(2);
	});

	test('cursor lifecycle retries stay availability-only and map a second served race to cursorExpired', async () => {
		const target = fixture();
		target.readPort.resumeReadyEntries.mockResolvedValue({
			kind: 'page', head: personalHead, entries: [personalEntry('399')], lastScannedSequence: '399', hasMore: false,
		});
		target.recordServedFeedEntries.mockRejectedValue(new HanamiInvalidFeedEntryError('race'));
		await expect(target.service.serve({ me, request: request({ cursor: cursor('400') }) })).resolves.toEqual({ kind: 'cursorExpired' });
		expect(target.requestPort.checkAvailability).toHaveBeenCalledTimes(2);
		expect(target.readPort.resumeReadyEntries).toHaveBeenCalledTimes(2);
		expect(target.requestPort.evaluateCursorless).not.toHaveBeenCalled();
		expect(target.requestPort.requestRefresh).not.toHaveBeenCalled();
		expect(target.recordServedFeedEntries).toHaveBeenCalledTimes(2);
	});

	test.each([
		{ requestResult: { kind: 'roleDisabled' }, expectedKind: 'roleDisabled' },
		{ requestResult: { kind: 'commonNotReady' }, expectedKind: 'commonNotReady' },
		{ requestResult: { kind: 'invalidRefreshToken' }, expectedKind: 'invalidRefreshToken' },
		{ requestResult: { kind: 'refreshTokenExpired' }, expectedKind: 'refreshTokenExpired' },
		{ requestResult: { kind: 'refreshRateLimited' }, expectedKind: 'refreshRateLimited' },
	] as const)('maps request result $expectedKind', async ({ requestResult, expectedKind }) => {
		const target = fixture();
		target.requestPort.evaluateCursorless.mockResolvedValue(requestResult);
		const result = await target.service.serve({ me, request: request() });
		expect(result.kind).toBe(expectedKind);
		expect(target.readPort.scanReadyEntries).not.toHaveBeenCalled();
	});

	test('recommendation-disabled responses are empty with stable metadata and null heads are not ready', async () => {
		const target = fixture();
		target.requestPort.evaluateCursorless.mockResolvedValue({ kind: 'recommendationDisabled', head: commonHead });
		await expect(target.service.serve({ me, request: request() })).resolves.toEqual({
			kind: 'ok',
			response: {
				items: [], nextCursor: null, hasMore: false, mode: 'common', generationPending: false,
				feedEpochId: commonHead.feedEpochId, headBatchId: commonHead.headBatchId,
			},
		});
		expect(target.readPort.scanReadyEntries).not.toHaveBeenCalled();
		expect(target.pack).not.toHaveBeenCalled();
		expect(target.recordServedFeedEntries).not.toHaveBeenCalled();

		target.requestPort.evaluateCursorless.mockResolvedValue({ kind: 'recommendationDisabled', head: null });
		await expect(target.service.serve({ me, request: request() })).resolves.toEqual({ kind: 'commonNotReady' });
	});

	test('maps cursor availability and read errors without generation', async () => {
		const role = fixture();
		role.requestPort.checkAvailability.mockResolvedValue({ kind: 'roleDisabled' });
		await expect(role.service.serve({ me, request: request({ cursor: cursor() }) })).resolves.toEqual({ kind: 'roleDisabled' });
		expect(role.readPort.resumeReadyEntries).not.toHaveBeenCalled();

		const disabled = fixture();
		disabled.requestPort.checkAvailability.mockResolvedValue({ kind: 'recommendationDisabled', head: commonHead });
		await expect(disabled.service.serve({ me, request: request({ cursor: cursor() }) })).resolves.toMatchObject({
			kind: 'ok', response: { items: [], mode: 'common' },
		});
		expect(disabled.readPort.resumeReadyEntries).not.toHaveBeenCalled();

		for (const readResult of [{ kind: 'cursorExpired' }, { kind: 'commonNotReady' }] as const) {
			const target = fixture();
			target.readPort.resumeReadyEntries.mockResolvedValue(readResult);
			await expect(target.service.serve({ me, request: request({ cursor: cursor() }) })).resolves.toEqual(readResult);
		}
	});
});
