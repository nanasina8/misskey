/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// はなみ For You の軸・confidence・quota interleave の確定アルゴリズム（canonical spec §6.1/§10）。
// スコア混合はしない。各軸 top をラウンドロビン＋作者dedup＋上限cap で併合する（実証：スコア混合は人気に占領され破綻）。

export type HanamiAxis =
	| 'globalPopular'
	| 'neighborTrending'
	| 'reactionSimilar'
	| 'catchup'
	| 'trending'
	| 'fof'
	| 'exploration';

export type HanamiConfidence = 'high' | 'low' | 'none';

// 軸内候補（score は軸内順位専用。軸をまたいで比較しない＝§6.1-1）。
export type ForYouCandidate = {
	noteId: string;
	userId?: string | null; // 作者（dedup 用。orchestrator が事前解決）
	score: number;
	term?: string; // trending の該当用語
};

// interleave 出力（配信順）。source=枠を消費した軸 / sources=寄与した全軸（§6.1-2）。
export type InterleavedCandidate = {
	noteId: string;
	userId?: string | null;
	source: HanamiAxis;
	sources: HanamiAxis[];
	term?: string;
	fallbackOverflow?: boolean;
};

// confidence ごとの軸順（§10）。exploration は専用枠として末尾に足す（§6.1-9/§14-D1）。
const AXIS_ORDER: Record<HanamiConfidence, HanamiAxis[]> = {
	high: ['catchup', 'neighborTrending', 'reactionSimilar', 'fof', 'trending', 'globalPopular'],
	low: ['globalPopular', 'trending', 'fof', 'neighborTrending', 'catchup', 'reactionSimilar'],
	none: ['globalPopular', 'trending', 'fof'],
};

// AXIS_MAX_SHARE（§10）。cap は上限であり予約枠ではない（§6.1-3/-10。high の合計>1 は正常）。
const AXIS_MAX_SHARE: Record<HanamiConfidence, Partial<Record<HanamiAxis, number>>> = {
	high: { globalPopular: 0.15, neighborTrending: 0.25, reactionSimilar: 0.25, catchup: 0.30, trending: 0.15, fof: 0.15 },
	low: { globalPopular: 0.45, neighborTrending: 0.20, reactionSimilar: 0.10, catchup: 0.15, trending: 0.25, fof: 0.20 },
	none: { globalPopular: 0.70, neighborTrending: 0.00, reactionSimilar: 0.00, catchup: 0.00, trending: 0.25, fof: 0.10 },
};

// exploration の専用 quota（§10/§14-D1。score には混ぜない独立枠）。
const EXPLORATION_SHARE: Record<HanamiConfidence, number> = { high: 0.05, low: 0.10, none: 0.10 };

// 作者は原則1ページ AUTHOR_PER_PAGE_CAP 件まで（§6.1-5）。
const AUTHOR_PER_PAGE_CAP = 2;

export function hanamiAxisOrder(confidence: HanamiConfidence): HanamiAxis[] {
	return [...AXIS_ORDER[confidence], 'exploration'];
}

function axisCap(axis: HanamiAxis, confidence: HanamiConfidence, limit: number): number {
	const share = axis === 'exploration' ? EXPLORATION_SHARE[confidence] : (AXIS_MAX_SHARE[confidence][axis] ?? 0);
	if (share <= 0) return 0;
	return Math.max(1, Math.ceil(limit * share));
}

/**
 * §6.1 の quota interleave。確定アルゴリズム。
 *
 * - 各軸 candidates は score desc（呼び出し側責務）。同一 note は1件に統合し sources に全軸を残す。
 * - confidence ごとに軸順固定。1巡ごとに各軸から最大1件 round-robin。
 * - 既出/除外/作者上限超過はスキップ。直前作者と同じ作者は round0 では後回し（候補不足の later round で許可）。
 * - cap は上限。軸が枯れたら他軸へ流れるが cap は超えない。
 * - 全体が limit の半分未満なら globalPopular だけ fallback overflow を許可（fallbackOverflow=true）。
 * - 出力は cap 内の最大件数（≈ limit*1.35）。safety filter で落ちた分の backfill 余裕を含む。最終 global sort はしない（§6.1-8）。
 */
export function hanamiInterleave(opts: {
	confidence: HanamiConfidence;
	limit: number;
	axisCandidates: Map<HanamiAxis, ForYouCandidate[]>;
	isExcluded?: (noteId: string) => boolean;
}): InterleavedCandidate[] {
	const { confidence, limit } = opts;
	const order = hanamiAxisOrder(confidence);
	const isExcluded = opts.isExcluded ?? (() => false);

	// 同一 note の sources / userId / term を統合（§6.1-2）。
	const merged = new Map<string, { sources: HanamiAxis[]; userId: string | null; term?: string }>();
	for (const axis of order) {
		for (const c of opts.axisCandidates.get(axis) ?? []) {
			let e = merged.get(c.noteId);
			if (e == null) { e = { sources: [], userId: c.userId ?? null, term: c.term }; merged.set(c.noteId, e); }
			if (!e.sources.includes(axis)) e.sources.push(axis);
			e.userId ??= c.userId ?? null;
			e.term ??= c.term;
		}
	}

	const cap = new Map<HanamiAxis, number>(order.map(a => [a, axisCap(a, confidence, limit)]));
	const used = new Map<HanamiAxis, number>(order.map(a => [a, 0]));
	const consumed = new Map<HanamiAxis, Set<number>>(order.map(a => [a, new Set<number>()]));
	const authorCount = new Map<string, number>();
	const selected = new Set<string>();
	const out: InterleavedCandidate[] = [];
	let lastAuthor: string | null = null;

	const pushPick = (axis: HanamiAxis, c: ForYouCandidate, fallbackOverflow = false): void => {
		const m = merged.get(c.noteId)!;
		selected.add(c.noteId);
		used.set(axis, (used.get(axis) ?? 0) + 1);
		if (m.userId != null) authorCount.set(m.userId, (authorCount.get(m.userId) ?? 0) + 1);
		lastAuthor = m.userId ?? null;
		out.push({ noteId: c.noteId, userId: m.userId, source: axis, sources: [...m.sources], term: m.term, ...(fallbackOverflow ? { fallbackOverflow: true } : {}) });
	};

	// round-robin。round0 は直前作者制約あり、later round で緩める（mute/filter は緩めない）。§6.1-5
	let round = 0;
	for (;;) {
		let pickedThisRound = false;
		for (const axis of order) {
			if ((used.get(axis) ?? 0) >= (cap.get(axis) ?? 0)) continue;
			const list = opts.axisCandidates.get(axis) ?? [];
			const done = consumed.get(axis)!;
			let chosenIdx = -1;
			let fallbackIdx = -1;
			for (let i = 0; i < list.length; i++) {
				if (done.has(i)) continue;
				const c = list[i];
				// 既出/除外 は恒久スキップ。
				if (selected.has(c.noteId) || isExcluded(c.noteId)) { done.add(i); continue; }
				const author = merged.get(c.noteId)?.userId ?? null;
				// 作者上限超過 は恒久スキップ（authorCount は増加のみ）。
				if (author != null && (authorCount.get(author) ?? 0) >= AUTHOR_PER_PAGE_CAP) { done.add(i); continue; }
				if (fallbackIdx < 0) fallbackIdx = i;
				if (author == null || author !== lastAuthor) { chosenIdx = i; break; }
			}
			// round0 は直前作者違いを優先し、同作者しか無ければ今回は見送り（他軸に回す）。later round は fallback 許可。
			const pickIdx = chosenIdx >= 0 ? chosenIdx : (round > 0 ? fallbackIdx : -1);
			if (pickIdx >= 0) {
				done.add(pickIdx);
				pushPick(axis, list[pickIdx]);
				pickedThisRound = true;
			}
		}
		round++;
		if (!pickedThisRound) break;
	}

	// fallback overflow（§6.1-6）: 全体が limit の半分未満なら globalPopular だけ cap を超えて足す。
	if (out.length < Math.floor(limit / 2)) {
		const list = opts.axisCandidates.get('globalPopular') ?? [];
		const done = consumed.get('globalPopular')!;
		for (let i = 0; i < list.length && out.length < limit; i++) {
			if (done.has(i)) continue;
			const c = list[i];
			if (selected.has(c.noteId) || isExcluded(c.noteId)) continue;
			done.add(i);
			pushPick('globalPopular', c, true);
		}
	}

	return out;
}
