/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// はなみTL の seen 報告（[[hanami-tl-osusume-redesign]] 仕様6）。
// kind=rec: 「実際に表示確認した」推薦ノート。長TTL側の既出除外に積む。
// kind=home: はなみTLに表示されたホーム由来ノート。catchup軸の「見逃し」判定の根拠になる。
// MkNote からノートが画面に入ったとき reportHanamiSeen(id, kind) を呼ぶ。
// 1ノート1リクエストにならないよう、少し溜めて一括 POST する。セッション内で報告済みのIDは二度送らない。

import { $i } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const FLUSH_DELAY_MS = 2000;
const MAX_BATCH = 100;

export type HanamiSeenKind = 'rec' | 'home';

type AccountState = {
	reported: Set<string>;
	pending: Map<string, { noteId: string; kind: HanamiSeenKind }>;
	timer: number | null;
	token: string;
};

const stateByAccount = new Map<string, AccountState>();

function seenKey(noteId: string, kind: HanamiSeenKind): string {
	return `${kind}:${noteId}`;
}

function getState(): AccountState | null {
	if ($i == null) return null;
	const accountId = $i.id;
	let state = stateByAccount.get(accountId);
	if (state == null) {
		state = {
			reported: new Set<string>(),
			pending: new Map<string, { noteId: string; kind: HanamiSeenKind }>(),
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

	const byKind = new Map<HanamiSeenKind, { key: string; noteId: string }[]>();
	let taken = 0;
	for (const [key, entry] of state.pending) {
		if (taken >= MAX_BATCH) break;
		const list = byKind.get(entry.kind) ?? [];
		list.push({ key, noteId: entry.noteId });
		byKind.set(entry.kind, list);
		taken++;
	}
	for (const entries of byKind.values()) {
		for (const entry of entries) {
			state.pending.delete(entry.key);
			state.reported.add(entry.key);
		}
	}

	for (const [kind, entries] of byKind) {
		const noteIds = entries.map(entry => entry.noteId);
		misskeyApi('notes/hanami-timeline-seen', { noteIds, kind }, state.token).catch(() => {
			// 効果測定の補助なので失敗は致命ではない。報告済み扱いを解除して次の機会に再送する。
			for (const entry of entries) state.reported.delete(entry.key);
		});
	}

	// あふれた分は次のフラッシュへ。
	if (state.pending.size > 0 && state.timer == null) {
		state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
	}
}

/**
 * ノートが実際に表示されたことを記録する（debounce・重複排除つき）。
 * 同じ (noteId, kind) は一度だけ報告する。home と rec は用途が異なるため別々に記録する。
 */
export function reportHanamiSeen(noteId: string, kind: HanamiSeenKind = 'rec'): void {
	const state = getState();
	if (state == null) return;
	const key = seenKey(noteId, kind);
	if (state.reported.has(key) || state.pending.has(key)) return;
	state.pending.set(key, { noteId, kind });
	if (state.timer == null) state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
}
