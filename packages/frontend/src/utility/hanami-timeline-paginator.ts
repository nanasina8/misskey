/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, shallowRef } from 'vue';
import * as Misskey from 'misskey-js';
import type { ComputedRef } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';
import { store } from '@/store.js';

const INITIAL_LIMIT = 15;
const OLDER_LIMIT = 30;
const MAX_AUTOMATIC_EMPTY_PAGES = 3;
const REFRESH_RATE_LIMIT_MS = 60_000;
const SESSION_SNAPSHOT_MS = 30 * 60_000;
// 裏の生成は中央 2〜3.4 秒で終わるので、最初の確認を詰める（1・2・3 秒後、以後 3 秒おき、およそ 60 秒まで）。
const PENDING_CHECK_FIRST_DELAYS_MS = [1000, 1000, 1000];
const PENDING_CHECK_INTERVAL_MS = 3000;
const PENDING_CHECK_MAX_MS = 60_000;

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
	reason?: 'tuning';
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

type HanamiTimelineSnapshot = {
	withFiles: boolean | undefined;
	savedAt: number;
	items: HanamiTimelineItem[];
	nextCursor: string | null;
	mode: HanamiTimelineResponse['mode'] | null;
	feedEpochId: string | null;
	headBatchId: string | null;
};

let reloadRefreshConsumed = false;
let lastSnapshot: HanamiTimelineSnapshot | null = null;

// デッキで列が複数あっても、同じ新しい先頭を取りにいくのは 1 回にする（取りに行っている間は相乗り）。
const headFetches = new Map<string, Promise<HanamiTimelineResponse>>();

function fetchNewHead(withFiles: boolean | undefined, expectedHeadBatchId: string): Promise<HanamiTimelineResponse> {
	const key = `${withFiles === undefined ? '' : String(withFiles)}:${expectedHeadBatchId}`;
	const running = headFetches.get(key);
	if (running != null) return running;
	const request = misskeyApi('notes/hanami-timeline', { limit: INITIAL_LIMIT, refresh: false, ...(withFiles === undefined ? {} : { withFiles }) });
	headFetches.set(key, request);
	const forget = () => { if (headFetches.get(key) === request) headFetches.delete(key); };
	request.then(forget, forget);
	return request;
}

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

/** ほかの TL が先に表示されたら、ブラウザの再読み込みをはなみTLの更新として扱わない。 */
export function markNonHanamiTimelineMounted(): void {
	reloadRefreshConsumed = true;
}

/** 30 分以内に戻ったときに、前の並びをすぐ出すための控え（サーバーの「しばらくぶり」と同じ 30 分）。 */
export function clearHanamiTimelineSnapshot(): void {
	lastSnapshot = null;
}

function takeSnapshot(withFiles: boolean | undefined): HanamiTimelineSnapshot | null {
	if (lastSnapshot == null || lastSnapshot.withFiles !== withFiles) return null;
	if (Date.now() - lastSnapshot.savedAt >= SESSION_SNAPSHOT_MS) return null;
	return lastSnapshot;
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
	/** 裏で作っていた新しい並びができた。押すまで今の並びは変えない。 */
	public readonly newHeadReady = ref(false);

	private readyHead: HanamiTimelineResponse | null = null;
	private pendingHeadTimer: number | null = null;
	private pendingHeadConnection: Misskey.IChannelConnection<Misskey.Channels['main']> | null = null;
	private headRevision = 0;
	private disposed = false;
	private inPlaceRefreshCount = 0;

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
		this.showReadyHead = this.showReadyHead.bind(this);
	}

	public async init(): Promise<void> {
		const refresh = consumeReloadRefresh();
		const snapshot = refresh ? null : takeSnapshot(this.computedParams.value.withFiles);
		if (snapshot != null) {
			// タブを切り替えて戻っただけなら、前の並びをすぐ出して裏で確かめる。
			this.restoreSnapshot(snapshot);
			await this.revalidate(snapshot.headBatchId);
			return;
		}
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
		const state: CursorlessRetry = {
			kind: 'cursorless',
			request: this.cursorlessRequest({ refresh: true, refreshToken: generateHanamiRefreshToken() }),
			allowRefreshTokenReplacement: true,
			allowCursorRestart: true,
		};
		if (this.items.value.length === 0 || this.error.value != null) {
			await this.startCursorless(state, true);
			return;
		}

		// 作っている間も今の並びを消さず、上の帯で知らせる。できたら差し替える。
		this.generationPending.value = true;
		this.inPlaceRefreshCount++;
		try {
			await this.startCursorless(state, false, false);
		} finally {
			this.inPlaceRefreshCount--;
		}
	}

	public async refreshTuning(refreshToken = generateHanamiRefreshToken()): Promise<void> {
		this.generationPending.value = true;
		await this.startCursorless({
			kind: 'cursorless', request: this.cursorlessRequest({ refresh: true, refreshToken, reason: 'tuning' }),
			allowRefreshTokenReplacement: true, allowCursorRestart: true,
		}, false);
	}

	public dispose(): void {
		if (!this.disposed && this.items.value.length > 0 && this.error.value == null && !this.fetching.value) {
			lastSnapshot = {
				withFiles: this.computedParams.value.withFiles,
				savedAt: Date.now(),
				items: this.items.value,
				nextCursor: this.nextCursor,
				mode: this.mode.value,
				feedEpochId: this.feedEpochId.value,
				headBatchId: this.headBatchId.value,
			};
		}
		this.disposed = true;
		this.operationId++;
		this.cancelPendingHead();
		this.clearRefreshRateLimit();
	}

	/** できていた新しい並びに入れ替える（「新しい並びができました」を押したとき）。 */
	public showReadyHead(): void {
		const response = this.readyHead;
		this.readyHead = null;
		this.newHeadReady.value = false;
		if (response != null) this.applyHead(response);
	}

	private cancelPendingHead(): void {
		this.headRevision++;
		this.stopPendingWatch();
		this.readyHead = null;
		this.newHeadReady.value = false;
	}

	/** 待つのをやめる（確認のタイマーとストリームの購読を片付ける）。できていた並びは残す。 */
	private stopPendingWatch(): void {
		if (this.pendingHeadTimer != null) window.clearTimeout(this.pendingHeadTimer);
		this.pendingHeadTimer = null;
		if (this.pendingHeadConnection != null) this.pendingHeadConnection.dispose();
		this.pendingHeadConnection = null;
	}

	/**
	 * 裏で作っている並びができるのを待つ（サーバーは待たない）。
	 * ストリームの hanamiFeedReady を受けたらすぐ本体を 1 回取る。取りこぼしやリアルタイムモードがオフの人のために、
	 * 先頭だけの軽い API（notes/hanami-timeline-head）でも確かめ、先頭が変わったときだけ本体を取る。
	 * 待っている間に本体を定期的には呼ばない。
	 * 調整を変えたときは自動で入れ替え、それ以外は今の並びを残してボタンで知らせる。
	 */
	private schedulePendingHead(withFiles: boolean | undefined, autoReplace: boolean): void {
		this.cancelPendingHead();
		const revision = this.headRevision;
		const previousHead = this.headBatchId.value;
		// 新しい並びを扱った・あきらめた後は、遅れて返ってきた確認の結果を使わない。
		let settled = false;
		const isCurrent = (): boolean => !settled && !this.disposed && revision === this.headRevision;
		let checks = 0;
		let waitedMs = 0;
		let fetchingBody = false;

		/** 新しい先頭の本体を 1 回取って扱う。扱えたら true（待ちは終わり）。 */
		const takeNewHead = async (headBatchId: string): Promise<boolean> => {
			// 今出している・ボタンで待たせている並びと同じなら取らない。同時に 2 回取りにいかない。
			if (fetchingBody || headBatchId === previousHead || headBatchId === this.readyHead?.headBatchId) return false;
			fetchingBody = true;
			try {
				const response = await fetchNewHead(withFiles, headBatchId);
				if (!isCurrent()) return true;
				if (response.headBatchId === previousHead || !this.validCursorProgress(response, null)) return false;
				settled = true;
				this.stopPendingWatch();
				if (autoReplace || this.items.value.length === 0) {
					this.applyHead(response);
				} else {
					this.readyHead = response;
					this.newHeadReady.value = true;
					this.generationPending.value = false;
				}
				return true;
			} catch {
				return false; // 次の確認でまた見る。ここで batch は作らない。
			} finally {
				fetchingBody = false;
			}
		};

		const giveUp = (): void => {
			settled = true;
			this.stopPendingWatch();
			this.generationPending.value = false;
		};

		const scheduleCheck = (): void => {
			const delay = PENDING_CHECK_FIRST_DELAYS_MS[checks] ?? PENDING_CHECK_INTERVAL_MS;
			if (waitedMs + delay > PENDING_CHECK_MAX_MS) {
				giveUp();
				return;
			}
			waitedMs += delay;
			this.pendingHeadTimer = window.setTimeout(async () => {
				this.pendingHeadTimer = null;
				checks++;
				try {
					const head = await misskeyApi('notes/hanami-timeline-head', {});
					if (!isCurrent()) return;
					if (head.headBatchId !== previousHead) {
						if (await takeNewHead(head.headBatchId)) return;
					} else if (!head.generationPending) {
						// 作っていた並びが無くなった（失敗など）。先頭は今のままなので待つのをやめる。
						giveUp();
						return;
					}
				} catch { /* 次の回でまた見る。 */ }
				if (!isCurrent() || this.pendingHeadTimer != null) return;
				scheduleCheck();
			}, delay);
		};

		if (store.s.realtimeMode) {
			const connection = useStream().useChannel('main');
			connection.on('hanamiFeedReady', payload => {
				if (!isCurrent()) return;
				void takeNewHead(payload.headBatchId);
			});
			this.pendingHeadConnection = connection;
		}
		scheduleCheck();
	}

	private applyHead(response: HanamiTimelineResponse): void {
		this.operationId++;
		this.fetchingOlder.value = false;
		this.mode.value = response.mode;
		this.feedEpochId.value = response.feedEpochId;
		this.headBatchId.value = response.headBatchId;
		this.generationPending.value = response.generationPending;
		this.error.value = null;
		this.retryState = null;
		this.replaceItems(response.items);
		this.updateCursor(response);
	}

	private restoreSnapshot(snapshot: HanamiTimelineSnapshot): void {
		this.cancelPendingHead();
		this.error.value = null;
		this.retryState = null;
		this.items.value = snapshot.items;
		this.nextCursor = snapshot.nextCursor;
		this.canFetchOlder.value = snapshot.nextCursor != null;
		this.mode.value = snapshot.mode;
		this.feedEpochId.value = snapshot.feedEpochId;
		this.headBatchId.value = snapshot.headBatchId;
		this.generationPending.value = false;
		this.fetching.value = false;
		this.fetchingOlder.value = false;
	}

	/** 前の並びを出したまま先頭を確かめ、変わっていたときだけ入れ替える。失敗したら前の並びのまま。 */
	private async revalidate(previousHead: string | null): Promise<void> {
		const operationId = ++this.operationId;
		const request = this.cursorlessRequest({ refresh: false });
		let response: HanamiTimelineResponse;
		try {
			response = await misskeyApi('notes/hanami-timeline', request);
		} catch {
			return;
		}
		if (this.disposed || operationId !== this.operationId || !this.validCursorProgress(response, null)) return;
		if (response.headBatchId !== previousHead) {
			this.applyHead(response);
		} else {
			this.generationPending.value = response.generationPending;
		}
		if (response.generationPending) this.schedulePendingHead(request.withFiles, false);
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
		// 差し替え待ちの間に古いページを読むと、更新の結果が捨てられてしまう。
		if (this.inPlaceRefreshCount > 0 || !this.canFetchOlder.value || this.fetching.value || this.fetchingOlder.value || this.nextCursor == null) return;
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
			? { ...request, refresh: true, refreshToken: options.refreshToken, ...(options.reason ? { reason: options.reason } : {}) }
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

	private async startCursorless(state: CursorlessRetry, reset: boolean, showLoading = state.request.reason !== 'tuning'): Promise<void> {
		this.cancelPendingHead();
		this.error.value = null;
		this.retryState = null;
		const operationId = ++this.operationId;
		if (reset) this.reset();
		this.fetching.value = showLoading;
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
		if (response.generationPending) this.schedulePendingHead(state.request.withFiles, state.request.reason === 'tuning');

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
