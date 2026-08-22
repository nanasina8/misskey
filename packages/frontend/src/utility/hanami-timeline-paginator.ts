/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, shallowRef } from 'vue';
import * as Misskey from 'misskey-js';
import type { ComputedRef } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';

const INITIAL_LIMIT = 15;
const OLDER_LIMIT = 30;
const MAX_AUTOMATIC_EMPTY_PAGES = 3;
const REFRESH_RATE_LIMIT_MS = 60_000;

type HanamiTimelineRequest = Misskey.entities.NotesHanamiTimelineRequest;
type HanamiTimelineResponse = Misskey.entities.NotesHanamiTimelineResponse;
export type HanamiTimelineItem = HanamiTimelineResponse['items'][number];

type HanamiTimelineParams = Pick<HanamiTimelineRequest, 'withFiles'>;
type RequestSnapshot = HanamiTimelineRequest & {
	limit: number;
};
type CursorlessRequestOptions = {
	refresh: false;
} | {
	refresh: true;
	refreshToken: string;
};

type CursorlessRetry = {
	kind: 'cursorless';
	request: RequestSnapshot;
	allowRefreshTokenReplacement: boolean;
	allowCursorRestart: boolean;
};

type OlderRetry = {
	kind: 'older';
	request: RequestSnapshot & { cursor: string };
	emptyPageCount: number;
	allowCursorRestart: boolean;
};

type RetryState = CursorlessRetry | OlderRetry;

let reloadRefreshConsumed = false;

export class HanamiTimelineProtocolError extends Error {
	constructor() {
		super('The Hanami timeline returned hasMore without advancing its cursor.');
		this.name = 'HanamiTimelineProtocolError';
	}
}

export function generateHanamiRefreshToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function consumeReloadRefresh(): boolean {
	if (reloadRefreshConsumed) return false;
	if (typeof performance === 'undefined' || typeof PerformanceNavigationTiming === 'undefined') return false;

	const navigation = performance.getEntriesByType('navigation')
		.find((entry): entry is PerformanceNavigationTiming => entry instanceof PerformanceNavigationTiming);
	if (navigation?.type !== 'reload') return false;

	reloadRefreshConsumed = true;
	return true;
}

function getErrorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error == null || !('code' in error)) return null;
	return typeof error.code === 'string' ? error.code : null;
}

export class HanamiTimelinePaginator {
	public readonly items = shallowRef<HanamiTimelineItem[]>([]);
	public readonly fetching = ref(true);
	public readonly fetchingOlder = ref(false);
	public readonly canFetchOlder = ref(false);
	public readonly error = shallowRef<unknown | null>(null);
	public readonly mode = ref<HanamiTimelineResponse['mode'] | null>(null);
	public readonly generationPending = ref(false);
	public readonly feedEpochId = ref<string | null>(null);
	public readonly headBatchId = ref<string | null>(null);
	public readonly refreshRateLimited = ref(false);

	private nextCursor: string | null = null;
	private retryState: RetryState | null = null;
	private operationId = 0;
	private refreshRateLimitUntil = 0;
	private refreshRateLimitTimer: number | null = null;

	constructor(public readonly computedParams: ComputedRef<HanamiTimelineParams>) {
		this.init = this.init.bind(this);
		this.refresh = this.refresh.bind(this);
		this.retry = this.retry.bind(this);
		this.fetchOlder = this.fetchOlder.bind(this);
		this.removeNote = this.removeNote.bind(this);
	}

	public async init(): Promise<void> {
		const refresh = consumeReloadRefresh();
		const request = refresh
			? this.cursorlessRequest({ refresh: true, refreshToken: generateHanamiRefreshToken() })
			: this.cursorlessRequest({ refresh: false });
		await this.startCursorless({
			kind: 'cursorless',
			request,
			allowRefreshTokenReplacement: refresh,
			allowCursorRestart: true,
		}, true);
	}

	public async refresh(): Promise<void> {
		if (this.isRefreshRateLimited()) return;
		await this.startCursorless({
			kind: 'cursorless',
			request: this.cursorlessRequest({ refresh: true, refreshToken: generateHanamiRefreshToken() }),
			allowRefreshTokenReplacement: true,
			allowCursorRestart: true,
		}, true);
	}

	public async retry(): Promise<void> {
		const retryState = this.retryState;
		if (retryState == null) return;
		if (retryState.kind === 'cursorless' && retryState.request.refresh === true && this.isRefreshRateLimited()) return;

		this.error.value = null;
		this.retryState = null;
		if (retryState.kind === 'cursorless') {
			await this.startCursorless(retryState, false);
		} else {
			await this.startOlder(retryState);
		}
	}

	public async fetchOlder(): Promise<void> {
		if (!this.canFetchOlder.value || this.fetching.value || this.fetchingOlder.value || this.nextCursor == null) return;
		await this.startOlder({
			kind: 'older',
			request: this.olderRequest(this.nextCursor),
			emptyPageCount: 0,
			allowCursorRestart: true,
		});
	}

	public removeNote(noteId: string): void {
		this.items.value = this.items.value.filter(item => item.note.id !== noteId);
	}

	private cursorlessRequest(options: CursorlessRequestOptions, withFiles = this.computedParams.value.withFiles): RequestSnapshot {
		const request = {
			limit: INITIAL_LIMIT,
			...(withFiles === undefined ? {} : { withFiles }),
		};
		return options.refresh
			? { ...request, refresh: true, refreshToken: options.refreshToken }
			: request;
	}

	private olderRequest(cursor: string, withFiles = this.computedParams.value.withFiles): RequestSnapshot & { cursor: string } {
		return {
			limit: OLDER_LIMIT,
			cursor,
			...(withFiles === undefined ? {} : { withFiles }),
		};
	}

	private reset(): void {
		this.items.value = [];
		this.nextCursor = null;
		this.canFetchOlder.value = false;
		this.error.value = null;
		this.retryState = null;
		this.mode.value = null;
		this.generationPending.value = false;
		this.feedEpochId.value = null;
		this.headBatchId.value = null;
	}

	private async startCursorless(state: CursorlessRetry, reset: boolean): Promise<void> {
		const operationId = ++this.operationId;
		if (reset) this.reset();
		this.fetching.value = true;
		this.fetchingOlder.value = false;
		await this.loadCursorless(state, operationId);
		if (operationId === this.operationId) this.fetching.value = false;
	}

	private async startOlder(state: OlderRetry): Promise<void> {
		const operationId = ++this.operationId;
		this.error.value = null;
		this.retryState = null;
		this.fetchingOlder.value = true;
		await this.loadOlder(state, operationId);
		if (operationId === this.operationId) this.fetchingOlder.value = false;
	}

	private async loadCursorless(state: CursorlessRetry, operationId: number): Promise<void> {
		let response: HanamiTimelineResponse;
		try {
			response = await misskeyApi('notes/hanami-timeline', state.request);
		} catch (error) {
			if (operationId !== this.operationId) return;
			const errorCode = getErrorCode(error);
			if (errorCode === 'HANAMI_REFRESH_RATE_LIMITED') {
				this.suppressRefresh();
				this.fail(error, state);
				return;
			}
			if (errorCode === 'REFRESH_TOKEN_EXPIRED' && state.request.refresh === true && state.allowRefreshTokenReplacement && !this.isRefreshRateLimited()) {
				await this.loadCursorless({
					...state,
					request: { ...state.request, refreshToken: generateHanamiRefreshToken() },
					allowRefreshTokenReplacement: false,
				}, operationId);
				return;
			}
			this.fail(error, state);
			return;
		}

		if (operationId !== this.operationId) return;
		if (state.request.refresh === true) this.clearRefreshRateLimit();
		if (!this.validCursorProgress(response, null)) {
			this.fail(new HanamiTimelineProtocolError(), state);
			return;
		}

		this.mode.value = response.mode;
		this.generationPending.value = response.generationPending;
		this.feedEpochId.value = response.feedEpochId;
		this.headBatchId.value = response.headBatchId;
		const retainedCount = this.replaceItems(response.items);
		this.updateCursor(response);

		if (retainedCount === 0 && response.hasMore && response.nextCursor != null) {
			await this.loadOlder({
				kind: 'older',
				request: this.olderRequest(response.nextCursor, state.request.withFiles),
				emptyPageCount: 1,
				allowCursorRestart: state.allowCursorRestart,
			}, operationId);
		}
	}

	private async loadOlder(state: OlderRetry, operationId: number): Promise<void> {
		let response: HanamiTimelineResponse;
		try {
			response = await misskeyApi('notes/hanami-timeline', state.request);
		} catch (error) {
			if (operationId !== this.operationId) return;
			if (state.allowCursorRestart && ['INVALID_CURSOR', 'CURSOR_EXPIRED'].includes(getErrorCode(error) ?? '')) {
				await this.loadCursorless({
					kind: 'cursorless',
					request: this.cursorlessRequest({ refresh: false }, state.request.withFiles),
					allowRefreshTokenReplacement: false,
					allowCursorRestart: false,
				}, operationId);
				return;
			}
			this.fail(error, state);
			return;
		}

		if (operationId !== this.operationId) return;
		if (!this.validCursorProgress(response, state.request.cursor)) {
			this.fail(new HanamiTimelineProtocolError(), state);
			return;
		}

		const retainedCount = this.appendItems(response.items);
		this.updateCursor(response);
		if (retainedCount > 0 || !response.hasMore || response.nextCursor == null) return;

		const emptyPageCount = state.emptyPageCount + 1;
		if (emptyPageCount >= MAX_AUTOMATIC_EMPTY_PAGES) return;
		await this.loadOlder({
			kind: 'older',
			request: this.olderRequest(response.nextCursor, state.request.withFiles),
			emptyPageCount,
			allowCursorRestart: state.allowCursorRestart,
		}, operationId);
	}

	private validCursorProgress(response: HanamiTimelineResponse, requestCursor: string | null): boolean {
		return !response.hasMore || (response.nextCursor != null && response.nextCursor !== requestCursor);
	}

	private updateCursor(response: HanamiTimelineResponse): void {
		this.nextCursor = response.hasMore ? response.nextCursor : null;
		this.canFetchOlder.value = this.nextCursor != null;
	}

	private replaceItems(items: HanamiTimelineItem[]): number {
		const seen = new Set<string>();
		const retained = items.filter(item => {
			if (seen.has(item.feedEntryId)) return false;
			seen.add(item.feedEntryId);
			return true;
		});
		if (retained[3] != null) {
			(retained[3].note as Misskey.entities.Note & { _shouldInsertAd_?: boolean })._shouldInsertAd_ = true;
		}
		this.items.value = retained;
		return retained.length;
	}

	private appendItems(items: HanamiTimelineItem[]): number {
		const seen = new Set(this.items.value.map(item => item.feedEntryId));
		const retained = items.filter(item => {
			if (seen.has(item.feedEntryId)) return false;
			seen.add(item.feedEntryId);
			return true;
		});
		if (retained[10] != null) {
			(retained[10].note as Misskey.entities.Note & { _shouldInsertAd_?: boolean })._shouldInsertAd_ = true;
		}
		if (retained.length > 0) this.items.value = [...this.items.value, ...retained];
		return retained.length;
	}

	private isRefreshRateLimited(): boolean {
		if (this.refreshRateLimitUntil > Date.now()) return true;
		this.clearRefreshRateLimit();
		return false;
	}

	private suppressRefresh(): void {
		if (this.refreshRateLimitUntil > Date.now()) return;
		this.refreshRateLimitUntil = Date.now() + REFRESH_RATE_LIMIT_MS;
		this.refreshRateLimited.value = true;
		this.refreshRateLimitTimer = window.setTimeout(() => {
			this.refreshRateLimitTimer = null;
			this.refreshRateLimitUntil = 0;
			this.refreshRateLimited.value = false;
		}, REFRESH_RATE_LIMIT_MS);
	}

	private clearRefreshRateLimit(): void {
		if (this.refreshRateLimitTimer != null) window.clearTimeout(this.refreshRateLimitTimer);
		this.refreshRateLimitTimer = null;
		this.refreshRateLimitUntil = 0;
		this.refreshRateLimited.value = false;
	}

	private fail(error: unknown, retryState: RetryState): void {
		this.error.value = error;
		this.retryState = retryState;
	}
}
