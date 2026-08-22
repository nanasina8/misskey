/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const FLUSH_DELAY_MS = 2000;
const MAX_BATCH = 100;
const MAX_SEND_ATTEMPTS = 5;
// 同一entryの再報告クールダウン。仕様上、再表示は occurredAt を更新してよい（既出減点の期間が伸びる）が、
// v-appear は IntersectionObserver なのでスクロールで出入りするたび発火する。素通しだと1ノートにつき
// 500ms間隔でPOSTが飛び、そのたびサーバーがuser行を FOR UPDATE する。更新の意味が出る間隔まで間引く。
const REREPORT_COOLDOWN_MS = 60_000;
const TERMINAL_ERROR_CODES = new Set([
	'ACCESS_DENIED',
	'AUTHENTICATION_FAILED',
	'CREDENTIAL_REQUIRED',
	'PERMISSION_DENIED',
	'ROLE_PERMISSION_DENIED',
	'YOUR_ACCOUNT_SUSPENDED',
]);

export type HanamiSeenItem = {
	feedEntryId: string;
	noteId: string;
};

type AccountState = {
	/** feedEntryId -> 直近に報告した時刻。REREPORT_COOLDOWN_MS 以内の再報告は握り潰す。 */
	reportedAt: Map<string, number>;
	pending: Map<string, HanamiSeenItem>;
	inFlight: Set<string>;
	sending: boolean;
	attempts: number;
	timer: number | null;
	token: string;
};

const stateByAccount = new Map<string, AccountState>();

function getState(): AccountState | null {
	if ($i == null) return null;
	const accountId = $i.id;
	let state = stateByAccount.get(accountId);
	if (state == null) {
		state = {
			reportedAt: new Map<string, number>(),
			pending: new Map<string, HanamiSeenItem>(),
			inFlight: new Set<string>(),
			sending: false,
			attempts: 0,
			timer: null,
			token: $i.token,
		};
		stateByAccount.set(accountId, state);
	} else {
		state.token = $i.token;
	}
	return state;
}

function scheduleFlush(state: AccountState, restart = false): void {
	if (restart && state.timer != null) {
		window.clearTimeout(state.timer);
		state.timer = null;
	}
	if (state.sending) return;
	if (state.timer == null) state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
}

function getErrorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error == null || !('code' in error)) return null;
	return typeof error.code === 'string' ? error.code : null;
}

/** 送信を終えた（成功・恒久失敗いずれも）entryを in-flight から外し、クールダウンを開始する。 */
function settle(state: AccountState, entries: HanamiSeenItem[]): void {
	const now = Date.now();
	for (const entry of entries) {
		state.inFlight.delete(entry.feedEntryId);
		state.reportedAt.set(entry.feedEntryId, now);
	}
}

/** 一時失敗。in-flight から外して再送キューへ戻す（reported には積まない）。 */
function requeue(state: AccountState, entries: HanamiSeenItem[]): void {
	for (const entry of entries) {
		state.inFlight.delete(entry.feedEntryId);
		state.pending.set(entry.feedEntryId, entry);
	}
}

async function sendBatch(state: AccountState, entries: HanamiSeenItem[]): Promise<void> {
	try {
		const response = await misskeyApi('notes/hanami-timeline-seen', { items: entries }, state.token);
		if (!response.ok) throw new Error('Hanami seen report was rejected.');
		state.attempts = 0;
		settle(state, entries);
	} catch (error) {
		if (getErrorCode(error) === 'INVALID_FEED_ENTRY') {
			if (entries.length === 1) {
				settle(state, entries);
				return;
			}

			const middle = Math.floor(entries.length / 2);
			await sendBatch(state, entries.slice(0, middle));
			await sendBatch(state, entries.slice(middle));
			return;
		}

		if (TERMINAL_ERROR_CODES.has(getErrorCode(error) ?? '')) {
			settle(state, entries);
			return;
		}

		// 一時的な失敗だけ再送する。恒久的に失敗し続けるものを2秒間隔で永久に投げ続けない。
		state.attempts++;
		if (state.attempts >= MAX_SEND_ATTEMPTS) {
			state.attempts = 0;
			settle(state, entries);
			return;
		}

		requeue(state, entries);
		scheduleFlush(state, true);
	}
}

function flush(state: AccountState): void {
	state.timer = null;
	if (state.sending || state.pending.size === 0) return;

	const entries = Array.from(state.pending.values()).slice(0, MAX_BATCH);
	for (const entry of entries) {
		state.pending.delete(entry.feedEntryId);
		state.inFlight.add(entry.feedEntryId);
	}

	state.sending = true;
	void sendBatch(state, entries).finally(() => {
		state.sending = false;
		if (state.pending.size > 0) scheduleFlush(state);
	});
}

export function reportHanamiSeen(feedEntryId: string, noteId: string): void {
	const state = getState();
	if (state == null) return;
	if (state.pending.has(feedEntryId) || state.inFlight.has(feedEntryId)) return;
	const reportedAt = state.reportedAt.get(feedEntryId);
	if (reportedAt != null && Date.now() - reportedAt < REREPORT_COOLDOWN_MS) return;
	state.pending.set(feedEntryId, { feedEntryId, noteId });
	scheduleFlush(state);
}
