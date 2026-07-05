/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// はなみ For You の軸・confidence・quota interleave の確定アルゴリズム（canonical spec §6.1/§10）。
// スコア混合はしない。各軸 top をラウンドロビン＋作者dedup＋上限cap で併合する（実証：スコア混合は人気に占領され破綻）。

export const HANAMI_FOR_YOU_AXES = [
	'globalPopular',
	'neighborTrending',
	'reactionSimilar',
	'catchup',
	'trending',
	'fof',
	'exploration',
] as const;

export type HanamiAxis = (typeof HANAMI_FOR_YOU_AXES)[number];

export type HanamiConfidence = 'high' | 'low' | 'none';
export type HanamiAxisLevel = 'off' | 'low' | 'normal' | 'high';

// 軸内候補（score は軸内順位専用。軸をまたいで比較しない＝§6.1-1）。
export type ForYouCandidate = {
	noteId: string;
	userId?: string | null; // 作者（dedup 用。orchestrator が事前解決）
	score: number;
	term?: string; // trending の該当用語
	clusterId?: number; // taste cluster 由来（globalPopular。provenance/インライン減らす用）
};

// interleave 出力（配信順）。source=枠を消費した軸 / sources=寄与した全軸（§6.1-2）。
export type InterleavedCandidate = {
	noteId: string;
	userId?: string | null;
	source: HanamiAxis;
	sources: HanamiAxis[];
	term?: string;
	clusterId?: number;
	fallbackOverflow?: boolean;
};

// confidence ごとの軸順（§10）。exploration は専用枠として末尾に足す（§6.1-9/§14-D1）。
const AXIS_ORDER: Record<HanamiConfidence, HanamiAxis[]> = {
	high: ['globalPopular', 'neighborTrending', 'reactionSimilar', 'trending', 'catchup', 'fof'],
	low: ['globalPopular', 'neighborTrending', 'trending', 'reactionSimilar', 'catchup', 'fof'],
	none: ['globalPopular', 'trending', 'fof'],
};

// AXIS_MAX_SHARE（§10）。cap は上限であり予約枠ではない（§6.1-3/-10。ceil と候補不足で実表示は揺れる）。
const AXIS_MAX_SHARE: Record<HanamiConfidence, Partial<Record<HanamiAxis, number>>> = {
	high: { globalPopular: 0.30, neighborTrending: 0.25, reactionSimilar: 0.15, catchup: 0.07, trending: 0.12, fof: 0.03 },
	low: { globalPopular: 0.55, neighborTrending: 0.12, reactionSimilar: 0.08, catchup: 0.03, trending: 0.12, fof: 0.02 },
	none: { globalPopular: 0.75, neighborTrending: 0.00, reactionSimilar: 0.00, catchup: 0.00, trending: 0.12, fof: 0.03 },
};

// exploration の専用 quota（§10/§14-D1。score には混ぜない独立枠）。
const EXPLORATION_SHARE: Record<HanamiConfidence, number> = { high: 0.08, low: 0.08, none: 0.10 };

// ユーザーが軸ごとに選ぶ量（切/少/普通/多）の重み。base share に掛けて軸の生重みを作る。
const AXIS_LEVEL_WEIGHT: Record<HanamiAxisLevel, number> = {
	off: 0,
	low: 0.55,
	normal: 1.0,
	high: 1.6,
};

// 作者は原則1ページ AUTHOR_PER_PAGE_CAP 件まで（§6.1-5）。
const AUTHOR_PER_PAGE_CAP = 2;

export function hanamiAxisOrder(confidence: HanamiConfidence): HanamiAxis[] {
	return [...AXIS_ORDER[confidence], 'exploration'];
}

/**
 * 軸ごとの cap を「有効軸での比率再配分」で決める。
 *
 * 生重み w(axis) = base share(confidence) × 量レベル倍率（off=0）。
 * budget = limit × (軸順の base share 合計)。各 confidence で base 合計は ≈1.0 に調整済なので budget ≈ limit。
 * cap(axis) = ceil(budget × w / Σw)（w=0 は 0）。
 *
 * これにより:
 *  - 全軸ON/normal → Σw = budget/limit なので cap = ceil(limit×base)＝従来の固定cap と一致（既存挙動を維持）。
 *  - 軸OFF → w=0 で cap=0、空いた分は有効軸へ比率で回る（page が埋まる）。
 *  - 1軸だけON → その軸が budget をほぼ総取り（≒ページ全部）。
 *  - globalPopular / exploration を「多」にすると Σw 内の比率が上がり、実際に増える（§Q1）。
 * cap はあくまで上限（候補不足/作者cap/ceil で実数は揺れる。§6.1-3/-10）。
 * axisLevels 未指定時は全軸 normal 扱い（呼び出し側が常に渡す。テスト互換用）。
 */
function computeCaps(confidence: HanamiConfidence, limit: number, order: readonly HanamiAxis[], axisLevels?: ReadonlyMap<HanamiAxis, HanamiAxisLevel>): Map<HanamiAxis, number> {
	const baseOf = (axis: HanamiAxis): number => axis === 'exploration' ? EXPLORATION_SHARE[confidence] : (AXIS_MAX_SHARE[confidence][axis] ?? 0);
	const weights = new Map<HanamiAxis, number>();
	let naturalTotal = 0;
	let totalWeight = 0;
	for (const axis of order) {
		const base = baseOf(axis);
		naturalTotal += base;
		// axisLevels 未指定＝全軸 normal（従来挙動）。指定時に map に無い軸は OFF 扱い＝有効軸だけで配分する。
		const level: HanamiAxisLevel = axisLevels == null ? 'normal' : (axisLevels.get(axis) ?? 'off');
		const w = base > 0 ? base * AXIS_LEVEL_WEIGHT[level] : 0;
		weights.set(axis, w);
		totalWeight += w;
	}
	const caps = new Map<HanamiAxis, number>(order.map(a => [a, 0]));
	if (totalWeight <= 0 || naturalTotal <= 0) return caps;
	const budget = limit * naturalTotal;
	for (const axis of order) {
		const w = weights.get(axis) ?? 0;
		if (w > 0) caps.set(axis, Math.max(1, Math.ceil(budget * w / totalWeight)));
	}
	return caps;
}

/**
 * §6.1 の quota interleave。確定アルゴリズム。
 *
 * - 各軸 candidates は score desc（呼び出し側責務）。同一 note は1件に統合し sources に全軸を残す。
 * - confidence ごとに軸順固定。1巡ごとに各軸から最大1件 round-robin。
 * - 既出（served/seen）は呼び出し側で軸内スコアを弱く減点済み＝「沈むが再登場」。ここでは除外もtierも行わない（決定論）。
 * - 作者上限超過はスキップ。直前作者と同じ作者は round0 では後回し（候補不足の later round で許可）。
 * - cap は computeCaps で「有効軸での比率再配分」（§Q1）。off軸=0、有効軸だけで budget を量レベル比で分配。
 *   通常枠では cap を超えない（level=off / share=0 の軸は拾わない）。
 * - 全体が limit 未満なら、候補が残っている有効軸から cap 比率で fallback overflow を許可（fallbackOverflow=true）。
 * - 出力は cap 合計（headroom）まで。safety filter で落ちた分の backfill 余裕を含む。最終 global sort はしない（§6.1-8）。
 */
export function hanamiInterleave(opts: {
	confidence: HanamiConfidence;
	limit: number;
	axisCandidates: Map<HanamiAxis, ForYouCandidate[]>;
	axisLevels?: ReadonlyMap<HanamiAxis, HanamiAxisLevel>;
}): InterleavedCandidate[] {
	const { confidence, limit } = opts;
	const order = hanamiAxisOrder(confidence);

	// 同一 note の sources / userId / term を統合（§6.1-2）。
	const merged = new Map<string, { sources: HanamiAxis[]; userId: string | null; term?: string; clusterId?: number }>();
	for (const axis of order) {
		for (const c of opts.axisCandidates.get(axis) ?? []) {
			let e = merged.get(c.noteId);
			if (e == null) { e = { sources: [], userId: c.userId ?? null, term: c.term, clusterId: c.clusterId }; merged.set(c.noteId, e); }
			if (!e.sources.includes(axis)) e.sources.push(axis);
			e.userId ??= c.userId ?? null;
			e.term ??= c.term;
			e.clusterId ??= c.clusterId;
		}
	}

	const cap = computeCaps(confidence, limit, order, opts.axisLevels); // 有効軸で比率再配分（§Q1）
	const headroom = [...cap.values()].reduce((a, b) => a + b, 0); // safety backfill 余裕込みの上限
	const used = new Map<HanamiAxis, number>(order.map(a => [a, 0]));
	const consumed = new Map<HanamiAxis, Set<number>>(order.map(a => [a, new Set<number>()]));
	const authorCount = new Map<string, number>();
	const selected = new Set<string>();
	const out: InterleavedCandidate[] = [];
	let lastAuthor: string | null = null;

	const pushPick = (axis: HanamiAxis, c: ForYouCandidate, flags: { fallbackOverflow?: boolean } = {}): void => {
		const m = merged.get(c.noteId)!;
		selected.add(c.noteId);
		used.set(axis, (used.get(axis) ?? 0) + 1);
		if (m.userId != null) authorCount.set(m.userId, (authorCount.get(m.userId) ?? 0) + 1);
		lastAuthor = m.userId ?? null;
		out.push({
			noteId: c.noteId, userId: m.userId, source: axis, sources: [...m.sources], term: m.term, clusterId: m.clusterId,
			...(flags.fallbackOverflow ? { fallbackOverflow: true } : {}),
		});
	};

	// round-robin で out を target まで埋める（軸内スコア順・既出は減点済み）。
	// cap は上限（level=off / share=0 の軸は cap=0 で常にスキップ）。round0 は直前作者制約あり、later round で緩める（作者上限は緩めない）。§6.1-5
	const fill = (target: number): void => {
		let round = 0;
		for (;;) {
			if (out.length >= target) break;
			let pickedThisRound = false;
			for (const axis of order) {
				if (out.length >= target) break;
				if ((used.get(axis) ?? 0) >= (cap.get(axis) ?? 0)) continue;
				const list = opts.axisCandidates.get(axis) ?? [];
				const done = consumed.get(axis)!;
				let chosenIdx = -1;
				let fallbackIdx = -1;
				for (let i = 0; i < list.length; i++) {
					if (done.has(i)) continue;
					const c = list[i];
					if (selected.has(c.noteId)) { done.add(i); continue; } // 他軸で採用済 → 恒久スキップ
					const author = merged.get(c.noteId)?.userId ?? null;
					// 作者上限超過 は恒久スキップ（authorCount は増加のみ）。
					if (author != null && (authorCount.get(author) ?? 0) >= AUTHOR_PER_PAGE_CAP) { done.add(i); continue; }
					if (fallbackIdx < 0) fallbackIdx = i;
					if (author == null || author !== lastAuthor) { chosenIdx = i; break; }
				}
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
	};

	const nextPickIndex = (axis: HanamiAxis, allowSameAuthor: boolean): number => {
		const list = opts.axisCandidates.get(axis) ?? [];
		const done = consumed.get(axis)!;
		let chosenIdx = -1;
		let fallbackIdx = -1;
		for (let i = 0; i < list.length; i++) {
			if (done.has(i)) continue;
			const c = list[i];
			if (selected.has(c.noteId)) { done.add(i); continue; }
			const author = merged.get(c.noteId)?.userId ?? null;
			if (author != null && (authorCount.get(author) ?? 0) >= AUTHOR_PER_PAGE_CAP) { done.add(i); continue; }
			if (fallbackIdx < 0) fallbackIdx = i;
			if (author == null || author !== lastAuthor) { chosenIdx = i; break; }
		}
		return chosenIdx >= 0 ? chosenIdx : (allowSameAuthor ? fallbackIdx : -1);
	};

	const fillOverflow = (target: number): void => {
		const credit = new Map<HanamiAxis, number>(order.map(a => [a, 0]));
		let allowSameAuthor = false;
		for (;;) {
			if (out.length >= target) break;
			const eligible: { axis: HanamiAxis; pickIdx: number; cap: number; credit: number }[] = [];
			for (const axis of order) {
				const axisCap = cap.get(axis) ?? 0;
				if (axisCap <= 0) continue; // off 軸 / share=0 軸は fallback でも拾わない。
				const pickIdx = nextPickIndex(axis, allowSameAuthor);
				if (pickIdx >= 0) eligible.push({ axis, pickIdx, cap: axisCap, credit: credit.get(axis) ?? 0 });
			}
			if (eligible.length === 0) {
				if (!allowSameAuthor) {
					allowSameAuthor = true;
					continue;
				}
				break;
			}

			const totalEligibleCap = eligible.reduce((sum, e) => sum + e.cap, 0);
			for (const e of eligible) {
				e.credit += e.cap;
				credit.set(e.axis, e.credit);
			}
			const pick = eligible.reduce((best, e) => e.credit > best.credit ? e : best);
			consumed.get(pick.axis)!.add(pick.pickIdx);
			pushPick(pick.axis, (opts.axisCandidates.get(pick.axis) ?? [])[pick.pickIdx], { fallbackOverflow: true });
			credit.set(pick.axis, (credit.get(pick.axis) ?? 0) - totalEligibleCap);
			allowSameAuthor = false;
		}
	};

	// 1) quota interleave（軸内スコア順・cap 上限まで＝headroom）。safety で落ちた分の backfill 余裕を含む。
	fill(headroom);

	// 2) fallback overflow（§6.1-6）: 候補がある軸が少ない実データでもページを痩せさせない。
	// 後段 safety filter の脱落に備え、通常capと同じ headroom まで余分に渡す。
	const overflowTarget = Math.max(limit, headroom);
	if (out.length < overflowTarget) fillOverflow(overflowTarget);

	return out;
}
