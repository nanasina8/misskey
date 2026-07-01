/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { hanamiInterleave, hanamiAxisOrder, type HanamiAxis, type HanamiAxisLevel, type ForYouCandidate } from '@/core/hanami/HanamiForYouInterleave.js';

function cand(noteId: string, author: string, term?: string): ForYouCandidate {
	return { noteId, userId: author, score: 1, term };
}

// n 件、note/author ともユニークな候補（dedup/作者cap が干渉しないケース用）。
function uniqueCands(prefix: string, n: number): ForYouCandidate[] {
	return Array.from({ length: n }, (_, i) => cand(`${prefix}-note-${i}`, `${prefix}-author-${i}`));
}

function countBySource(out: { source: HanamiAxis }[]): Record<string, number> {
	const c: Record<string, number> = {};
	for (const o of out) c[o.source] = (c[o.source] ?? 0) + 1;
	return c;
}

describe('hanamiInterleave (canonical spec §6.1/§10)', () => {
	describe('hanamiAxisOrder', () => {
		it('none = globalPopular/trending/fof + exploration', () => {
			expect(hanamiAxisOrder('none')).toEqual(['globalPopular', 'trending', 'fof', 'exploration']);
		});
		it('low order + exploration', () => {
			expect(hanamiAxisOrder('low')).toEqual(['globalPopular', 'neighborTrending', 'trending', 'reactionSimilar', 'catchup', 'fof', 'exploration']);
		});
		it('high order + exploration', () => {
			expect(hanamiAxisOrder('high')).toEqual(['globalPopular', 'neighborTrending', 'reactionSimilar', 'trending', 'catchup', 'fof', 'exploration']);
		});
	});

	it('confidence=none で AXIS_MAX_SHARE の cap を尊重（limit=10 → gp8/trending2/fof1/exploration1）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 20)],
			['trending', uniqueCands('tr', 20)],
			['fof', uniqueCands('fof', 20)],
			['exploration', uniqueCands('ex', 20)],
			// none の軸順に無い軸は無視される
			['neighborTrending', uniqueCands('nb', 20)],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates });
		const c = countBySource(out);
		expect(c.globalPopular).toBe(8); // ceil(10*0.75)
		expect(c.trending).toBe(2); // ceil(10*0.12)
		expect(c.fof).toBe(1); // ceil(10*0.03)
		expect(c.exploration).toBe(1); // ceil(10*0.10)
		expect(c.neighborTrending).toBeUndefined(); // 軸順に無い
		expect(out.length).toBe(12);
	});

	it('Q1: 有効軸で比率再配分する（OFFは0、量「多」は実際に増える）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 20)],
			['trending', uniqueCands('tr', 20)],
			['fof', uniqueCands('fof', 20)],
			['exploration', uniqueCands('ex', 20)],
		]);
		const axisLevels = new Map<HanamiAxis, HanamiAxisLevel>([
			['globalPopular', 'off'],
			['trending', 'high'],
			['fof', 'normal'],
			['exploration', 'off'],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates, axisLevels });
		const c = countBySource(out);
		expect(c.globalPopular).toBeUndefined(); // OFF=0
		expect(c.exploration).toBeUndefined(); // OFF=0
		// 有効なのは trending(高=0.12*1.6=0.192) と fof(普通=0.03)。budget(=limit*1.0=10) を比率配分:
		//   trending=ceil(10*0.192/0.222)=9 / fof=ceil(10*0.03/0.222)=2。固定cap時代(trending2/fof1)より増える。
		expect(c.trending).toBe(9);
		expect(c.fof).toBe(2);
		expect(out.length).toBe(11);
	});

	it('Q1: 有効軸が1つだけならそれがページをほぼ総取りする（1つだけON）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 30)], // axisLevels に無い → OFF
			['trending', uniqueCands('tr', 30)],
		]);
		const axisLevels = new Map<HanamiAxis, HanamiAxisLevel>([['trending', 'normal']]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates, axisLevels });
		// OFF軸(globalPopular)は一切出ない。単独有効軸がページを埋める（固定cap=ceil(10*0.12)=2件ではない）。
		expect(out.every(o => o.source === 'trending')).toBe(true);
		expect(out.length).toBeGreaterThanOrEqual(10);
	});

	it('同一 note は1件に統合し sources に全寄与軸を残す（source=枠を消費した軸）', () => {
		const shared = cand('shared', 'authorX');
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', [shared, cand('gp1', 'a1')]],
			['trending', [cand('shared', 'authorX'), cand('tr1', 'a2')]],
			['fof', []],
			['exploration', []],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates });
		const sharedOut = out.filter(o => o.noteId === 'shared');
		expect(sharedOut.length).toBe(1); // 統合
		expect(sharedOut[0].source).toBe('globalPopular'); // none で gp が先に枠を消費
		expect(sharedOut[0].sources.sort()).toEqual(['globalPopular', 'trending']);
	});

	it('作者は1ページ2件まで（§6.1-5）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', [cand('n1', 'A'), cand('n2', 'A'), cand('n3', 'A'), cand('n4', 'A'), cand('n5', 'A')]],
			['trending', []],
			['fof', []],
			['exploration', []],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates });
		expect(out.length).toBe(2); // 同一作者は2件まで
		expect(out.every(o => o.userId === 'A')).toBe(true);
	});

	it('全体が limit 未満なら有効軸から fallback overflow（§6.1-6）', () => {
		// high は gp cap=ceil(10*0.30)=3。gp のみ候補→ normal で3件→ limit 未満なので残りを overflow で埋める。
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 10)],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		expect(out.length).toBe(10);
		expect(out.every(o => o.source === 'globalPopular')).toBe(true);
		expect(out.filter(o => o.fallbackOverflow === true).length).toBe(7); // cap3 を超えた7件
		expect(out.filter(o => !o.fallbackOverflow).length).toBe(3);
	});

	it('一部の軸が空でも候補が残る有効軸から headroom まで補充する', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', []],
			['neighborTrending', uniqueCands('nb', 10)],
			['reactionSimilar', uniqueCands('rs', 10)],
			['trending', []],
			['catchup', uniqueCands('cu', 10)],
			['fof', uniqueCands('fof', 10)],
			['exploration', []],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		// cap 合計（headroom）は13。後段 safety filter の脱落に備えて limit より厚く渡す。
		expect(out.length).toBe(13);
		expect(out.some(o => o.fallbackOverflow)).toBe(true);
		expect(countBySource(out)).toEqual(expect.objectContaining({
			neighborTrending: expect.any(Number),
			reactionSimilar: expect.any(Number),
			catchup: expect.any(Number),
			fof: expect.any(Number),
		}));
	});

	it('fallback overflow でもユーザーが off にした軸は拾わない', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 20)],
			['trending', uniqueCands('tr', 20)],
			['fof', uniqueCands('fof', 20)],
			['exploration', uniqueCands('ex', 20)],
		]);
		const axisLevels = new Map<HanamiAxis, HanamiAxisLevel>([
			['globalPopular', 'off'],
			['trending', 'normal'],
			['fof', 'off'],
			['exploration', 'off'],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates, axisLevels });
		expect(out.length).toBe(10);
		expect(out.every(o => o.source === 'trending')).toBe(true);
	});

	it('fallback overflow の追加分も少なめ/多め由来の cap 比率に寄せる', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', []],
			['neighborTrending', uniqueCands('nb', 30)],
			['reactionSimilar', uniqueCands('rs', 30)],
			['trending', []],
			['catchup', uniqueCands('cu', 30)],
			['fof', uniqueCands('fof', 30)],
			['exploration', []],
		]);
		const axisLevels = new Map<HanamiAxis, HanamiAxisLevel>([
			['globalPopular', 'high'],
			['neighborTrending', 'high'],
			['reactionSimilar', 'low'],
			['trending', 'high'],
			['catchup', 'normal'],
			['fof', 'low'],
			['exploration', 'high'],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 20, axisCandidates, axisLevels });
		expect(countBySource(out)).toEqual({
			neighborTrending: 13,
			reactionSimilar: 5,
			catchup: 4,
			fof: 2,
		});
	});

	it('FoF だけ候補が残る実データでも fallback overflow でページを埋める', () => {
		// high は fof cap=ceil(10*0.03)=1。FoF だけ候補がある場合でも1件で止めない。
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['fof', uniqueCands('fof', 10)],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		expect(out.length).toBe(10);
		expect(out.every(o => o.source === 'fof')).toBe(true);
		expect(out.filter(o => o.fallbackOverflow === true).length).toBe(9);
		expect(out.filter(o => !o.fallbackOverflow).length).toBe(1);
	});

	it('interleave はハード除外しない: 与えた候補を軸内 score 順に全部返す（既出減点は呼び出し側・§6.1-5）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 5)],
			['trending', []],
			['fof', []],
			['exploration', []],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates });
		// 5件すべて出る（除外しない・空にしない）。軸内 score 順（=入力順）を保つ。
		expect(out.length).toBe(5);
		expect(out.map(o => o.noteId)).toEqual(['gp-note-0', 'gp-note-1', 'gp-note-2', 'gp-note-3', 'gp-note-4']);
	});

	it('interleave は与えた候補を必ず返す（呼び出し側の既出減点に関わらず空にしない・§9）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 6)],
			['trending', []],
			['fof', []],
			['exploration', []],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates });
		expect(out.length).toBe(6);
	});

	it('cap 合計が limit を超えても interleave は pre-safety 上限だけを返す（§6.1-10）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>(
			hanamiAxisOrder('high').map(axis => [axis, uniqueCands(axis, 30)] as [HanamiAxis, ForYouCandidate[]]),
		);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		// cap 合計（high）= ceil(10*0.30)+ceil(0.25)+ceil(0.15)+ceil(0.12)+ceil(0.07)+ceil(0.03)+ceil(0.08[exp])
		//             = 3+3+2+2+1+1+1 = 13（>limit）だが、これは pre-safety の上限。limit ページ取得は呼び出し側。
		expect(out.length).toBe(13);
		// fallback overflow は発生しない（通常capだけで limit 以上）。
		expect(out.some(o => o.fallbackOverflow)).toBe(false);
	});
});
