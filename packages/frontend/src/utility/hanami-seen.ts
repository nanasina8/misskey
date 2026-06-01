/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// はなみTL おすすめの seen 報告（[[hanami-tl-osusume-redesign]] 仕様6）。
// 「実際に表示確認した」推薦ノートだけを seen として長TTL側の既出除外に積む。
// MkNote から推薦ノートが画面に入ったとき reportHanamiSeen(id) を呼ぶ。
// 1ノート1リクエストにならないよう、少し溜めて一括 POST する。セッション内で報告済みのIDは二度送らない。

import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const FLUSH_DELAY_MS = 2000;
const MAX_BATCH = 100;

type AccountState = {
	reported: Set<string>;
	pending: Set<string>;
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
			reported: new Set<string>(),
			pending: new Set<string>(),
			timer: null,
			token: $i.token,
		};
		stateByAccount.set(accountId, state);
	} else {
		state.token = $i.token;
	}
	return state;
}

function flush(state: AccountState): void {
	state.timer = null;
	if (state.pending.size === 0) return;

	const noteIds = Array.from(state.pending).slice(0, MAX_BATCH);
	for (const id of noteIds) {
		state.pending.delete(id);
		state.reported.add(id);
	}

	misskeyApi('notes/hanami-timeline-seen', { noteIds }, state.token).catch(() => {
		// 効果測定の補助なので失敗は致命ではない。報告済み扱いを解除して次の機会に再送する。
		for (const id of noteIds) state.reported.delete(id);
	});

	// あふれた分は次のフラッシュへ。
	if (state.pending.size > 0 && state.timer == null) {
		state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
	}
}

/**
 * 推薦ノートが実際に表示されたことを記録する（debounce・重複排除つき）。
 */
export function reportHanamiSeen(noteId: string): void {
	const state = getState();
	if (state == null) return;
	if (state.reported.has(noteId) || state.pending.has(noteId)) return;
	state.pending.add(noteId);
	if (state.timer == null) state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
}
