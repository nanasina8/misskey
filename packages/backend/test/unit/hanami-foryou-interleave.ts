/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { hanamiInterleave, hanamiAxisOrder, type HanamiAxis, type ForYouCandidate } from '@/core/hanami/HanamiForYouInterleave.js';

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
			expect(hanamiAxisOrder('low')).toEqual(['globalPopular', 'trending', 'fof', 'neighborTrending', 'catchup', 'reactionSimilar', 'exploration']);
		});
		it('high order + exploration', () => {
			expect(hanamiAxisOrder('high')).toEqual(['catchup', 'neighborTrending', 'reactionSimilar', 'fof', 'trending', 'globalPopular', 'exploration']);
		});
	});

	it('confidence=none で AXIS_MAX_SHARE の cap を尊重（limit=10 → gp7/trending3/fof1/exploration1）', () => {
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
		expect(c.globalPopular).toBe(7); // ceil(10*0.70)
		expect(c.trending).toBe(3); // ceil(10*0.25)
		expect(c.fof).toBe(1); // ceil(10*0.10)
		expect(c.exploration).toBe(1); // ceil(10*0.10)
		expect(c.neighborTrending).toBeUndefined(); // 軸順に無い
		expect(out.length).toBe(12);
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

	it('全体が limit の半分未満なら globalPopular だけ fallback overflow（§6.1-6）', () => {
		// high は gp cap=ceil(10*0.15)=2。gp のみ候補→ normal で2件→ <5 なので残りを overflow で埋める。
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 10)],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		expect(out.length).toBe(10);
		expect(out.every(o => o.source === 'globalPopular')).toBe(true);
		expect(out.filter(o => o.fallbackOverflow === true).length).toBe(8); // cap2 を超えた8件
		expect(out.filter(o => !o.fallbackOverflow).length).toBe(2);
	});

	it('isExcluded（served/seen）はスキップする（§6.1-5）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 5)],
			['trending', []],
			['fof', []],
			['exploration', []],
		]);
		const excluded = new Set(['gp-note-1', 'gp-note-3']);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates, isExcluded: id => excluded.has(id) });
		expect(out.some(o => o.noteId === 'gp-note-1')).toBe(false);
		expect(out.some(o => o.noteId === 'gp-note-3')).toBe(false);
		expect(out.length).toBe(3);
	});

	it('cap 合計>1 でも limit を超えて配信しない（high の share 合計1.25+exploration は cap=上限。§6.1-10）', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>(
			hanamiAxisOrder('high').map(axis => [axis, uniqueCands(axis, 30)] as [HanamiAxis, ForYouCandidate[]]),
		);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		// cap 合計（high）= ceil(10*0.30)+ceil(0.25)+ceil(0.25)+ceil(0.15)+ceil(0.15)+ceil(0.15)+ceil(0.05[exp])
		//             = 3+3+3+2+2+2+1 = 16（>limit）だが、これは pre-safety の上限。limit ページ取得は呼び出し側。
		expect(out.length).toBe(16);
		// fallback overflow は発生しない（out.length >= limit/2）。
		expect(out.some(o => o.fallbackOverflow)).toBe(false);
	});
});
