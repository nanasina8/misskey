/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed } from 'vue';
import * as Misskey from 'misskey-js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	clearHanamiTimelineSnapshot,
	generateHanamiRefreshToken,
	HanamiTimelinePaginator,
	HanamiTimelineProtocolError,
} from '@/utility/hanami-timeline-paginator.js';
import type { HanamiTimelineItem } from '@/utility/hanami-timeline-paginator.js';

const misskeyApiMock = vi.hoisted(() => vi.fn());

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: misskeyApiMock,
}));

// メインのストリームの代わり。hanamiFeedReady を手で流せるようにする。
const streamMock = vi.hoisted(() => {
	type Listener = (payload: { headBatchId: string }) => void;
	const connections: Array<{ name: string; listeners: Listener[]; disposed: boolean }> = [];
	return {
		realtimeMode: false,
		connections,
		emitFeedReady(headBatchId: string): void {
			for (const connection of connections) {
				if (!connection.disposed) for (const listener of connection.listeners) listener({ headBatchId });
			}
		},
		useStream: () => ({
			useChannel: (name: string) => {
				const connection = { name, listeners: [] as Listener[], disposed: false };
				connections.push(connection);
				return {
					on: (event: string, listener: Listener) => { if (event === 'hanamiFeedReady') connection.listeners.push(listener); },
					dispose: () => { connection.disposed = true; },
				};
			},
		}),
	};
});

vi.mock('@/stream.js', () => ({ useStream: streamMock.useStream }));
vi.mock('@/store.js', () => ({ store: { s: { get realtimeMode() { return streamMock.realtimeMode; } } } }));

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

// dispose した並びの控えがテストをまたいで残らないようにする。
beforeEach(() => { clearHanamiTimelineSnapshot(); });

describe('HanamiTimelinePaginator', () => {
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
		target.dispose();
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

type HeadResponse = Misskey.entities.NotesHanamiTimelineHeadResponse;

function head(overrides: Partial<HeadResponse> = {}): HeadResponse {
	return { mode: 'personalized', feedEpochId: 'epoch-1', headBatchId: 'head-1', generationPending: true, ...overrides };
}

/** 本体と軽い確認 API を別々のモックに振り分ける。 */
function routeApi() {
	const body = vi.fn<(params: unknown) => Promise<Misskey.entities.NotesHanamiTimelineResponse>>();
	const headCheck = vi.fn<() => Promise<HeadResponse>>(async () => head());
	misskeyApiMock.mockImplementation((endpoint: string, params: unknown) => endpoint === 'notes/hanami-timeline-head' ? headCheck() : body(params));
	const bodyCalls = () => misskeyApiMock.mock.calls.filter(call => call[0] === 'notes/hanami-timeline').length;
	const headCalls = () => misskeyApiMock.mock.calls.filter(call => call[0] === 'notes/hanami-timeline-head').length;
	return { body, headCheck, bodyCalls, headCalls };
}

describe('Hanami H3 and tuning refresh', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		misskeyApiMock.mockReset();
		streamMock.realtimeMode = false;
		streamMock.connections.length = 0;
	});
	afterEach(() => { vi.useRealTimers(); });

	test('tuning keeps existing items, uses its own reason, checks the light head API and replaces a changed head automatically', async () => {
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		api.headCheck.mockResolvedValueOnce(head()).mockResolvedValueOnce(head({ headBatchId: 'head-2', generationPending: false }));
		const p = paginator(); await p.init();
		const refreshing = p.refreshTuning('new-token');
		expect(p.items.value).toHaveLength(1); expect(p.generationPending.value).toBe(true); expect(p.fetching.value).toBe(false);
		await refreshing;
		expect(misskeyApiMock.mock.calls[1][1]).toMatchObject({ refresh: true, reason: 'tuning', refreshToken: 'new-token', limit: 15 });
		await vi.advanceTimersByTimeAsync(999); expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(misskeyApiMock.mock.calls[2]).toEqual(['notes/hanami-timeline-head', {}]);
		expect(p.items.value[0].feedEntryId).toBe('entry-1'); expect(p.generationPending.value).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		// 先頭が変わったときだけ、本体を今までと同じ引数で 1 回取る。
		expect(misskeyApiMock.mock.calls[4]).toEqual(['notes/hanami-timeline', { limit: 15, refresh: false, withFiles: false }]);
		expect(p.items.value[0].feedEntryId).toBe('new-entry'); expect(p.generationPending.value).toBe(false); expect(p.newHeadReady.value).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000); expect(misskeyApiMock).toHaveBeenCalledTimes(5);
		p.dispose();
	});

	test('checks at 1, 2 and 3 seconds then every 3 seconds, never calls the body while waiting, and gives up after about 60 seconds', async () => {
		const api = routeApi();
		api.body.mockResolvedValueOnce(response({ generationPending: true })).mockResolvedValue(response({ items: [item('should-not-replace')] }));
		const p = paginator(); await p.init();
		const checkedAt: number[] = [];
		for (let elapsed = 1000; elapsed <= 70_000; elapsed += 1000) {
			const before = api.headCalls();
			await vi.advanceTimersByTimeAsync(1000);
			if (api.headCalls() > before) checkedAt.push(elapsed / 1000);
		}
		expect(checkedAt).toEqual([1, 2, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60]);
		expect(api.bodyCalls()).toBe(1);
		expect(p.generationPending.value).toBe(false); expect(p.items.value[0].feedEntryId).toBe('entry-1');
		p.dispose();
	});

	test('stops waiting when the head API reports the same head with nothing being generated', async () => {
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }));
		api.headCheck.mockResolvedValueOnce(head()).mockResolvedValueOnce(head({ generationPending: false }));
		const p = paginator(); await p.init(); await p.refresh();
		await vi.advanceTimersByTimeAsync(2000);
		expect(p.generationPending.value).toBe(false); expect(p.newHeadReady.value).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.headCalls()).toBe(2); expect(api.bodyCalls()).toBe(2);
		p.dispose();
	});

	test('a hanamiFeedReady notification fetches the body once right away and is ignored for a head already taken', async () => {
		streamMock.realtimeMode = true;
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		const p = paginator(); await p.init(); await p.refresh();
		expect(streamMock.connections.map(c => [c.name, c.disposed])).toEqual([['main', false]]);
		await vi.advanceTimersByTimeAsync(200);
		streamMock.emitFeedReady('head-1'); // 今出している先頭と同じなら取らない
		streamMock.emitFeedReady('head-2');
		await vi.advanceTimersByTimeAsync(0);
		expect(api.bodyCalls()).toBe(3); expect(api.headCalls()).toBe(0);
		expect(p.newHeadReady.value).toBe(true); expect(p.generationPending.value).toBe(false);
		expect(p.items.value[0].feedEntryId).toBe('entry-1');
		expect(streamMock.connections[0].disposed).toBe(true);
		streamMock.emitFeedReady('head-2');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.bodyCalls()).toBe(3); expect(api.headCalls()).toBe(0);
		p.showReadyHead(); expect(p.items.value[0].feedEntryId).toBe('new-entry');
		p.dispose();
	});

	test('notices the new head through the light check when the notification never arrives', async () => {
		streamMock.realtimeMode = true;
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		api.headCheck.mockResolvedValue(head({ headBatchId: 'head-2', generationPending: false }));
		const p = paginator(); await p.init(); await p.refresh();
		await vi.advanceTimersByTimeAsync(1000);
		expect(api.headCalls()).toBe(1); expect(api.bodyCalls()).toBe(3);
		expect(p.newHeadReady.value).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.headCalls()).toBe(1); expect(api.bodyCalls()).toBe(3);
		p.dispose();
	});

	test('does not open a stream when realtime mode is off', async () => {
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }));
		const p = paginator(); await p.init(); await p.refresh();
		expect(streamMock.connections).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1000); expect(api.headCalls()).toBe(1);
		p.dispose();
	});

	test('a new refresh cancels the previous wait, a late check result from the old wait is dropped, and dispose stops everything', async () => {
		streamMock.realtimeMode = true;
		const api = routeApi();
		api.body.mockResolvedValue(response({ generationPending: true }));
		let resolveOldCheck!: (value: HeadResponse) => void;
		api.headCheck.mockReturnValueOnce(new Promise(resolve => { resolveOldCheck = resolve; }));
		const p = paginator(); await p.init();
		await vi.advanceTimersByTimeAsync(1000); expect(api.headCalls()).toBe(1);
		await p.refreshTuning('next');
		expect(streamMock.connections.map(c => c.disposed)).toEqual([true, false]);
		resolveOldCheck(head({ headBatchId: 'head-old', generationPending: false }));
		await vi.advanceTimersByTimeAsync(0);
		expect(api.bodyCalls()).toBe(2); expect(p.generationPending.value).toBe(true);
		p.dispose();
		expect(streamMock.connections.every(c => c.disposed)).toBe(true);
		streamMock.emitFeedReady('head-2');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.bodyCalls()).toBe(2); expect(api.headCalls()).toBe(1);
	});

	test('two deck columns waiting for the same new head share one body fetch', async () => {
		streamMock.realtimeMode = true;
		const api = routeApi();
		api.body.mockResolvedValueOnce(response({ generationPending: true })).mockResolvedValueOnce(response({ generationPending: true }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		const left = paginator(); await left.init();
		const right = paginator(); await right.init();
		streamMock.emitFeedReady('head-2');
		await vi.advanceTimersByTimeAsync(0);
		expect(api.bodyCalls()).toBe(3);
		expect(left.newHeadReady.value).toBe(true); expect(right.newHeadReady.value).toBe(true);
		left.dispose(); right.dispose();
	});

	test('a normal refresh without stock keeps the list and offers the new head through a button', async () => {
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		api.headCheck.mockResolvedValue(head({ headBatchId: 'head-2', generationPending: false }));
		const p = paginator(); await p.init();
		await p.refresh();
		expect(p.generationPending.value).toBe(true); expect(p.items.value[0].feedEntryId).toBe('entry-1');
		await vi.advanceTimersByTimeAsync(1000);
		expect(p.newHeadReady.value).toBe(true); expect(p.generationPending.value).toBe(false);
		expect(p.items.value[0].feedEntryId).toBe('entry-1');
		p.showReadyHead();
		expect(p.items.value[0].feedEntryId).toBe('new-entry'); expect(p.headBatchId.value).toBe('head-2'); expect(p.newHeadReady.value).toBe(false);
		p.dispose();
	});

	test('starting another refresh clears a ready-head button', async () => {
		const api = routeApi();
		api.body.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ generationPending: true }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }))
			.mockResolvedValueOnce(response({ headBatchId: 'head-3', items: [item('third')] }));
		api.headCheck.mockResolvedValue(head({ headBatchId: 'head-2', generationPending: false }));
		const p = paginator(); await p.init();
		await p.refresh(); await vi.advanceTimersByTimeAsync(1000);
		expect(p.newHeadReady.value).toBe(true);
		await p.refresh();
		expect(p.newHeadReady.value).toBe(false); expect(p.items.value[0].feedEntryId).toBe('third');
		p.showReadyHead(); expect(p.items.value[0].feedEntryId).toBe('third');
		p.dispose();
	});
});

describe('Hanami tab-switch snapshot', () => {
	beforeEach(() => { misskeyApiMock.mockReset(); });
	afterEach(() => { vi.useRealTimers(); });

	test('shows the previous list immediately within 30 minutes and keeps it when the head is unchanged', async () => {
		misskeyApiMock.mockResolvedValueOnce(response({ nextCursor: 'cursor-1', hasMore: true }));
		const first = paginator(); await first.init(); first.dispose();

		let resolveCheck!: (value: Misskey.entities.NotesHanamiTimelineResponse) => void;
		misskeyApiMock.mockReturnValueOnce(new Promise(resolve => { resolveCheck = resolve; }));
		const second = paginator();
		const initializing = second.init();
		expect(second.fetching.value).toBe(false);
		expect(second.items.value.map(i => i.feedEntryId)).toEqual(['entry-1']);
		expect(second.canFetchOlder.value).toBe(true);
		expect(misskeyApiMock.mock.calls[1]?.[1]).toEqual({ limit: 15, withFiles: false });

		resolveCheck(response({ items: [item('server-copy')], nextCursor: 'cursor-1', hasMore: true }));
		await initializing;
		expect(second.items.value.map(i => i.feedEntryId)).toEqual(['entry-1']);
		second.dispose();
	});

	test('replaces the restored list when the server head changed', async () => {
		misskeyApiMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		const first = paginator(); await first.init(); first.dispose();
		const second = paginator(); await second.init();
		expect(second.items.value.map(i => i.feedEntryId)).toEqual(['new-entry']);
		expect(second.headBatchId.value).toBe('head-2');
		second.dispose();
	});

	test('keeps the restored list when the background check fails', async () => {
		misskeyApiMock.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('offline'));
		const first = paginator(); await first.init(); first.dispose();
		const second = paginator(); await second.init();
		expect(second.items.value.map(i => i.feedEntryId)).toEqual(['entry-1']);
		expect(second.error.value).toBeNull();
		second.dispose();
	});

	test('loads normally after 30 minutes or with a different file filter', async () => {
		vi.useFakeTimers();
		misskeyApiMock.mockResolvedValue(response());
		const first = paginator(); await first.init(); first.dispose();
		const otherFilter = paginator(true);
		const loadingOther = otherFilter.init();
		expect(otherFilter.fetching.value).toBe(true);
		await loadingOther; otherFilter.dispose();

		clearHanamiTimelineSnapshot();
		const again = paginator(); await again.init(); again.dispose();
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		const later = paginator();
		const loadingLater = later.init();
		expect(later.fetching.value).toBe(true);
		await loadingLater; later.dispose();
	});

	test('does not keep a failed or empty list', async () => {
		misskeyApiMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response());
		const failed = paginator(); await failed.init(); failed.dispose();
		const next = paginator();
		const loading = next.init();
		expect(next.fetching.value).toBe(true);
		await loading; next.dispose();
	});
});

describe('Hanami reload refresh after another timeline', () => {
	test('a browser reload counts as a Hanami refresh only when Hanami is the first timeline', async () => {
		class NavigationTiming {
			constructor(public readonly type: 'navigate' | 'reload') {}
		}
		vi.stubGlobal('PerformanceNavigationTiming', NavigationTiming);
		const navigationSpy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([new NavigationTiming('reload') as unknown as PerformanceEntry]);
		misskeyApiMock.mockReset();
		misskeyApiMock.mockResolvedValue(response());

		vi.resetModules();
		const fresh = await import('@/utility/hanami-timeline-paginator.js');
		fresh.markNonHanamiTimelineMounted();
		const p = new fresh.HanamiTimelinePaginator(computed(() => ({ withFiles: false })));
		await p.init();
		expect(misskeyApiMock.mock.calls[0]?.[1]).toEqual({ limit: 15, withFiles: false });

		vi.resetModules();
		const reloaded = await import('@/utility/hanami-timeline-paginator.js');
		const q = new reloaded.HanamiTimelinePaginator(computed(() => ({ withFiles: false })));
		await q.init();
		expect(misskeyApiMock.mock.calls[1]?.[1]).toMatchObject({ refresh: true });

		navigationSpy.mockRestore();
		vi.unstubAllGlobals();
	});
});

test('a successful tuning retry clears a previous timeline error', async () => {
	misskeyApiMock.mockReset();
	misskeyApiMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response());
	const p = paginator();
	await p.refreshTuning('first'); expect(p.error.value).not.toBeNull();
	await p.refreshTuning('second'); expect(p.error.value).toBeNull(); expect(p.items.value).toHaveLength(1);
	p.dispose();
});

describe('Hanami in-place refresh', () => {
	beforeEach(() => { misskeyApiMock.mockReset(); });

	test('keeps the current items with the pending banner until the refreshed head replaces them', async () => {
		let resolveRefresh!: (value: Misskey.entities.NotesHanamiTimelineResponse) => void;
		misskeyApiMock
			.mockResolvedValueOnce(response({ nextCursor: 'cursor-1', hasMore: true }))
			.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
		const p = paginator(); await p.init();

		const refreshing = p.refresh();
		expect(p.items.value.map(i => i.feedEntryId)).toEqual(['entry-1']);
		expect(p.fetching.value).toBe(false);
		expect(p.generationPending.value).toBe(true);
		expect(misskeyApiMock.mock.calls[1]?.[1]).toMatchObject({ refresh: true, limit: 15 });

		await p.fetchOlder();
		expect(misskeyApiMock).toHaveBeenCalledTimes(2);

		resolveRefresh(response({ headBatchId: 'head-2', items: [item('new-entry')] }));
		await refreshing;
		expect(p.items.value.map(i => i.feedEntryId)).toEqual(['new-entry']);
		expect(p.headBatchId.value).toBe('head-2');
		expect(p.generationPending.value).toBe(false);
		expect(p.canFetchOlder.value).toBe(false);
		p.dispose();
	});

	test('shows the loading state when there is nothing to keep', async () => {
		let resolveRefresh!: (value: Misskey.entities.NotesHanamiTimelineResponse) => void;
		misskeyApiMock
			.mockResolvedValueOnce(response({ items: [] }))
			.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
		const p = paginator(); await p.init();

		const refreshing = p.refresh();
		expect(p.fetching.value).toBe(true);
		resolveRefresh(response({ headBatchId: 'head-2' }));
		await refreshing;
		expect(p.fetching.value).toBe(false);
		expect(p.items.value).toHaveLength(1);
		p.dispose();
	});

	test('a failed in-place refresh surfaces the error and allows older pages again', async () => {
		misskeyApiMock
			.mockResolvedValueOnce(response({ nextCursor: 'cursor-1', hasMore: true }))
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(response({ headBatchId: 'head-2', items: [item('retried')] }));
		const p = paginator(); await p.init();

		await p.refresh();
		expect(p.error.value).not.toBeNull();
		await p.retry();
		expect(p.error.value).toBeNull();
		expect(p.items.value.map(i => i.feedEntryId)).toEqual(['retried']);
		expect(misskeyApiMock.mock.calls[2]?.[1]).toMatchObject({ refresh: true, refreshToken: misskeyApiMock.mock.calls[1]?.[1].refreshToken });
		p.dispose();
	});
});
