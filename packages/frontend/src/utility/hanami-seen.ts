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
	pending: Map<string, HanamiSeenKind>;
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
			pending: new Map<string, HanamiSeenKind>(),
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

	const byKind = new Map<HanamiSeenKind, string[]>();
	let taken = 0;
	for (const [id, kind] of state.pending) {
		if (taken >= MAX_BATCH) break;
		const list = byKind.get(kind) ?? [];
		list.push(id);
		byKind.set(kind, list);
		taken++;
	}
	for (const ids of byKind.values()) {
		for (const id of ids) {
			state.pending.delete(id);
			state.reported.add(id);
		}
	}

	for (const [kind, noteIds] of byKind) {
		misskeyApi('notes/hanami-timeline-seen', { noteIds, kind }, state.token).catch(() => {
			// 効果測定の補助なので失敗は致命ではない。報告済み扱いを解除して次の機会に再送する。
			for (const id of noteIds) state.reported.delete(id);
		});
	}

	// あふれた分は次のフラッシュへ。
	if (state.pending.size > 0 && state.timer == null) {
		state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
	}
}

/**
 * ノートが実際に表示されたことを記録する（debounce・重複排除つき）。
 * 同じノートIDは kind を問わず一度だけ報告する（recのseenはサーバー側で全軸の再推薦除外に効く）。
 */
export function reportHanamiSeen(noteId: string, kind: HanamiSeenKind = 'rec'): void {
	const state = getState();
	if (state == null) return;
	if (state.reported.has(noteId) || state.pending.has(noteId)) return;
	state.pending.set(noteId, kind);
	if (state.timer == null) state.timer = window.setTimeout(() => flush(state), FLUSH_DELAY_MS);
}
