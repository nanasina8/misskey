/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed } from 'vue';
import * as Misskey from 'misskey-js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	generateHanamiRefreshToken,
	HanamiTimelinePaginator,
	HanamiTimelineProtocolError,
} from '@/utility/hanami-timeline-paginator.js';
import type { HanamiTimelineItem } from '@/utility/hanami-timeline-paginator.js';

const misskeyApiMock = vi.hoisted(() => vi.fn());

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: misskeyApiMock,
}));

function note(id: string): Misskey.entities.Note {
	return { id, createdAt: '2026-08-20T00:00:00.000Z' } as Misskey.entities.Note;
}

function item(feedEntryId: string, noteId = feedEntryId): HanamiTimelineItem {
	return { feedEntryId, batchId: 'batch', note: note(noteId) };
}

function response(overrides: Partial<Misskey.entities.NotesHanamiTimelineResponse> = {}): Misskey.entities.NotesHanamiTimelineResponse {
	return {
		items: [item('entry-1')],
		nextCursor: null,
		hasMore: false,
		mode: 'personalized',
		generationPending: false,
		feedEpochId: 'epoch-1',
		headBatchId: 'head-1',
		...overrides,
	};
}

function paginator(withFiles = false): HanamiTimelinePaginator {
	return new HanamiTimelinePaginator(computed(() => ({ withFiles })));
}

describe.sequential('HanamiTimelinePaginator', () => {
	beforeEach(() => {
		misskeyApiMock.mockReset();
		misskeyApiMock.mockResolvedValue(response());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test('generates an unpadded base64url token containing 32 random bytes', () => {
		const token = generateHanamiRefreshToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const padded = token.replaceAll('-', '+').replaceAll('_', '/') + '=';
		expect(Uint8Array.from(atob(padded), char => char.charCodeAt(0))).toHaveLength(32);
	});

	test('uses cursorless limit 15 and cursor limit 30', async () => {
		misskeyApiMock
			.mockResolvedValueOnce(response({ nextCursor: 'cursor-1', hasMore: true }))
			.mockResolvedValueOnce(response());
		const target = paginator(true);

		await target.init();
		await target.fetchOlder();

		expect(misskeyApiMock.mock.calls[0]?.[1]).toEqual({ limit: 15, withFiles: true });
		expect(misskeyApiMock.mock.calls[1]?.[1]).toEqual({ limit: 30, cursor: 'cursor-1', withFiles: true });
	});

	test('reuses the refresh token on transport retry', async () => {
		misskeyApiMock
			.mockRejectedValueOnce(new Error('network error'))
			.mockResolvedValueOnce(response());
		const target = paginator();

		await target.refresh();
		const firstToken = misskeyApiMock.mock.calls[0]?.[1].refreshToken;
		await target.retry();

		expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(misskeyApiMock.mock.calls[1]?.[1].refreshToken).toBe(firstToken);
		expect(target.error.value).toBeNull();
	});

	test('suppresses new refreshes for one minute after rate limiting without generating tokens', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
		const randomSpy = vi.spyOn(crypto, 'getRandomValues');
		const rateLimitError = { code: 'HANAMI_REFRESH_RATE_LIMITED' };
		misskeyApiMock.mockRejectedValueOnce(rateLimitError);
		const target = paginator();

		await target.refresh();
		expect(target.refreshRateLimited.value).toBe(true);
		expect(target.error.value).toBe(rateLimitError);
		expect(target.fetching.value).toBe(false);
		expect(misskeyApiMock).toHaveBeenCalledOnce();
		expect(randomSpy).toHaveBeenCalledOnce();

		await target.refresh();
		await vi.advanceTimersByTimeAsync(59_999);
		await target.refresh();
		expect(misskeyApiMock).toHaveBeenCalledOnce();
		expect(randomSpy).toHaveBeenCalledOnce();
		expect(target.error.value).toBe(rateLimitError);

		await vi.advanceTimersByTimeAsync(1);
		expect(target.refreshRateLimited.value).toBe(false);
		misskeyApiMock.mockResolvedValueOnce(response());
		await target.refresh();

		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		expect(randomSpy).toHaveBeenCalledTimes(2);
		expect(target.error.value).toBeNull();
	});

	test('preserves a rate-limited refresh retry until cooldown expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
		const randomSpy = vi.spyOn(crypto, 'getRandomValues');
		const rateLimitError = { code: 'HANAMI_REFRESH_RATE_LIMITED' };
		misskeyApiMock
			.mockRejectedValueOnce(rateLimitError)
			.mockResolvedValueOnce(response());
		const target = paginator();

		await target.refresh();
		const refreshToken = misskeyApiMock.mock.calls[0]?.[1].refreshToken;
		await target.retry();

		expect(misskeyApiMock).toHaveBeenCalledOnce();
		expect(randomSpy).toHaveBeenCalledOnce();
		expect(target.error.value).toBe(rateLimitError);
		expect(target.refreshRateLimited.value).toBe(true);

		await vi.advanceTimersByTimeAsync(60_000);
		await target.retry();

		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		expect(misskeyApiMock.mock.calls[1]?.[1].refreshToken).toBe(refreshToken);
		expect(randomSpy).toHaveBeenCalledOnce();
		expect(target.error.value).toBeNull();
	});

	test('replaces an expired refresh token once and then surfaces failure', async () => {
		misskeyApiMock
			.mockRejectedValueOnce({ code: 'REFRESH_TOKEN_EXPIRED' })
			.mockRejectedValueOnce({ code: 'REFRESH_TOKEN_EXPIRED' });
		const target = paginator();

		await target.refresh();

		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		expect(misskeyApiMock.mock.calls[1]?.[1].refreshToken).not.toBe(misskeyApiMock.mock.calls[0]?.[1].refreshToken);
		expect(target.error.value).toMatchObject({ code: 'REFRESH_TOKEN_EXPIRED' });
	});

	test('silently restarts cursorless once after an expired cursor', async () => {
		misskeyApiMock
			.mockResolvedValueOnce(response({ items: [item('old')], nextCursor: 'cursor-1', hasMore: true }))
			.mockRejectedValueOnce({ code: 'CURSOR_EXPIRED' })
			.mockResolvedValueOnce(response({ items: [item('new')] }));
		const target = paginator();

		await target.init();
		await target.fetchOlder();

		expect(misskeyApiMock.mock.calls[2]?.[1]).toEqual({ limit: 15, withFiles: false });
		expect(target.items.value.map(entry => entry.feedEntryId)).toEqual(['new']);
		expect(target.error.value).toBeNull();
	});

	test('bounds empty-page chaining and gives each manual continuation another three pages', async () => {
		misskeyApiMock
			.mockResolvedValueOnce(response({ nextCursor: 'cursor-0', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-1', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-2', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-3', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-4', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-5', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-6', hasMore: true }));
		const target = paginator();

		await target.init();
		await target.fetchOlder();
		expect(misskeyApiMock).toHaveBeenCalledTimes(4);
		expect(target.canFetchOlder.value).toBe(true);

		await target.fetchOlder();
		expect(misskeyApiMock).toHaveBeenCalledTimes(7);
		expect(target.canFetchOlder.value).toBe(true);
	});

	test('retains duplicate note IDs under distinct locators and removes all matches', async () => {
		misskeyApiMock.mockResolvedValueOnce(response({
			items: [item('entry-1', 'note-1'), item('entry-2', 'note-1'), item('entry-1', 'note-1')],
		}));
		const target = paginator();

		await target.init();
		expect(target.items.value.map(entry => entry.feedEntryId)).toEqual(['entry-1', 'entry-2']);

		target.removeNote('note-1');
		expect(target.items.value).toEqual([]);
	});

	test('rejects null or unchanged advancing cursors as retryable protocol errors', async () => {
		misskeyApiMock
			.mockResolvedValueOnce(response({ items: [], nextCursor: null, hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-1', hasMore: true }))
			.mockResolvedValueOnce(response({ items: [], nextCursor: 'cursor-1', hasMore: true }));
		const initialTarget = paginator();

		await initialTarget.init();
		expect(initialTarget.error.value).toBeInstanceOf(HanamiTimelineProtocolError);
		await initialTarget.retry();

		expect(initialTarget.error.value).toBeInstanceOf(HanamiTimelineProtocolError);
		expect(misskeyApiMock).toHaveBeenCalledTimes(3);
	});

	test('updates head metadata only from cursorless responses and has no live-timeline API', async () => {
		misskeyApiMock
			.mockResolvedValueOnce(response({ nextCursor: 'cursor-1', hasMore: true, generationPending: true }))
			.mockResolvedValueOnce(response({
				mode: 'common',
				generationPending: false,
				feedEpochId: 'epoch-2',
				headBatchId: 'head-2',
			}));
		const target = paginator();

		await target.init();
		await target.fetchOlder();

		expect(target.mode.value).toBe('personalized');
		expect(target.generationPending.value).toBe(true);
		expect(target.feedEpochId.value).toBe('epoch-1');
		expect(target.headBatchId.value).toBe('head-1');
		expect('fetchNewer' in target).toBe(false);
		expect('releaseQueue' in target).toBe(false);
		expect('channel' in target).toBe(false);
	});

	test('consumes browser reload refresh only for the first Hanami init', async () => {
		class NavigationTiming {
			constructor(public readonly type: 'navigate' | 'reload') {}
		}
		vi.stubGlobal('PerformanceNavigationTiming', NavigationTiming);
		const navigationSpy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([new NavigationTiming('navigate') as unknown as PerformanceEntry]);
		misskeyApiMock.mockResolvedValue(response());

		await paginator().init();
		navigationSpy.mockReturnValue([new NavigationTiming('reload') as unknown as PerformanceEntry]);
		await paginator().init();
		await paginator().init();

		expect(misskeyApiMock.mock.calls[0]?.[1]).toEqual({ limit: 15, withFiles: false });
		expect(misskeyApiMock.mock.calls[1]?.[1]).toMatchObject({ limit: 15, refresh: true });
		expect(misskeyApiMock.mock.calls[1]?.[1].refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(misskeyApiMock.mock.calls[2]?.[1]).toEqual({ limit: 15, withFiles: false });

		navigationSpy.mockRestore();
		vi.unstubAllGlobals();
	});
});
