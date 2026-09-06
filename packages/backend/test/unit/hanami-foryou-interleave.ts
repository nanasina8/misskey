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

function expectFinalWindows(selected: readonly ForYouCandidate[], following: readonly ForYouCandidate[]): void {
	const visible = [...selected, ...following];
	for (const size of [10, 30, 210]) {
		for (let start = 0; start + size <= visible.length; start++) {
			const window = visible.slice(start, start + size);
			const authorLimit = size === 10 ? 1 : size === 30 ? 2 : 6;
			for (const author of new Set(window.map(value => value.userId).filter((value): value is string => value != null))) {
				const count = window.filter(value => value.userId === author).length;
				if (count > authorLimit) throw new Error(`author window violation ${size}/${start}/${author}`);
			}
			if (size !== 30) continue;
			for (const fingerprint of new Set(window.map(value => value.exactTextFingerprint).filter((value): value is string => value != null))) {
				expect(window.filter(value => value.exactTextFingerprint === fingerprint).length).toBeLessThanOrEqual(1);
			}
			for (const fingerprint of new Set(window.filter(value => value.isBot).map(value => value.strictBotTemplateFingerprint).filter((value): value is string => value != null))) {
				expect(window.filter(value => value.isBot && value.strictBotTemplateFingerprint === fingerprint).length).toBeLessThanOrEqual(1);
			}
			expect(window.filter(value => value.relationshipClass === 'directFollow').length).toBeLessThanOrEqual(6);
			expect(window.filter(value => value.relationshipClass === 'directFollow' || value.relationshipClass === 'known').length).toBeLessThanOrEqual(12);
		}
	}
}

function expectPartialUpperFeasible(selected: readonly ForYouCandidate[], following: readonly ForYouCandidate[]): void {
	const partial = [...selected, ...following];
	for (const author of new Set(partial.map(value => value.userId).filter((value): value is string => value != null))) {
		expect(partial.filter(value => value.userId === author).length).toBeLessThanOrEqual(1);
	}
	const fingerprints = partial.map(value => value.exactTextFingerprint).filter((value): value is string => value != null);
	for (const fingerprint of new Set(fingerprints)) expect(fingerprints.filter(value => value === fingerprint)).toHaveLength(1);
	const templates = partial.filter(value => value.isBot && value.userId != null && value.strictBotTemplateFingerprint != null)
		.map(value => `${value.userId}\u0000${value.strictBotTemplateFingerprint}`);
	for (const template of new Set(templates)) expect(templates.filter(value => value === template)).toHaveLength(1);
	expect(partial.filter(value => value.relationshipClass === 'directFollow').length).toBeLessThanOrEqual(6);
	expect(partial.filter(value => value.relationshipClass === 'directFollow' || value.relationshipClass === 'known').length).toBeLessThanOrEqual(12);
}

function bruteFinalValid(selected: readonly ForYouCandidate[], following: readonly ForYouCandidate[], unknownSufficient: boolean): boolean {
	const visible = [...selected, ...following];
	for (const size of [10, 30, 210]) {
		for (let start = 0; start + size <= visible.length && start < selected.length; start++) {
			const window = visible.slice(start, start + size);
			const authorLimit = size === 10 ? 1 : size === 30 ? 2 : 6;
			for (const author of new Set(window.map(item => item.userId).filter((value): value is string => value != null))) {
				if (window.filter(item => item.userId === author).length > authorLimit) return false;
			}
			if (size !== 30) continue;
			for (const fingerprint of new Set(window.map(item => item.exactTextFingerprint).filter((value): value is string => value != null))) {
				if (window.filter(item => item.exactTextFingerprint === fingerprint).length > 1) return false;
			}
			for (const key of new Set(window.filter(item => item.isBot && item.userId != null && item.strictBotTemplateFingerprint != null).map(item => `${item.userId}\u0000${item.strictBotTemplateFingerprint}`))) {
				if (window.filter(item => item.isBot && `${item.userId}\u0000${item.strictBotTemplateFingerprint}` === key).length > 1) return false;
			}
			if (window.filter(item => item.relationshipClass === 'directFollow').length > 6) return false;
			if (window.filter(item => item.relationshipClass === 'directFollow' || item.relationshipClass === 'known').length > 12) return false;
			if (unknownSufficient && window.filter(item => item.relationshipClass === 'unknown').length < 15) return false;
		}
	}
	return true;
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

	it('author sliding cap is one per contiguous ten entries', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', [cand('n1', 'A'), cand('n2', 'A'), cand('n3', 'A'), cand('n4', 'A'), cand('n5', 'A')]],
			['trending', []],
			['fof', []],
			['exploration', []],
		]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates, personalConstraints: true });
		expect(out.length).toBe(1);
		expect(out.every(o => o.userId === 'A')).toBe(true);
	});

	it('keeps the legacy two-per-page author cap for non-personal callers', () => {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([['globalPopular', [cand('n1', 'A'), cand('n2', 'A'), cand('n3', 'A')]]]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates });
		expect(out.map(item => item.noteId)).toEqual(['n1', 'n2']);
	});

	it('heals a pre-existing unknown-floor deficit without publishing an invalid boundary', () => {
		const followingSeedVisible = [
			...Array.from({ length: 14 }, (_, index) => ({ ...cand(`old-unknown-${index}`, `unknown-${index}`), relationshipClass: 'unknown' as const })),
			...Array.from({ length: 16 }, (_, index) => cand(`old-known-${index}`, `old-${index}`)),
		];
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, unknownSufficient: true, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', [{ ...cand('healing-unknown', 'new-unknown'), relationshipClass: 'unknown' as const }]]]) });
		expect(out.map(item => item.noteId)).toEqual(['healing-unknown']);
		expect(bruteFinalValid(out, followingSeedVisible, true)).toBe(true);
	});

	it('prefers unknown candidates over higher-ranked known ones when a window would seal below the floor', () => {
		// 手前29件の unknown が14件しかない seed。ここで known を採ると窓が14件で確定し、
		// 最終 prefix validator が全件切り落として空バッチになる（＝生成失敗）。
		const followingSeedVisible = [
			...Array.from({ length: 14 }, (_, index) => ({ ...cand(`old-unknown-${index}`, `unknown-${index}`), relationshipClass: 'unknown' as const })),
			...Array.from({ length: 16 }, (_, index) => cand(`old-known-${index}`, `old-${index}`)),
		];
		const candidates = [
			...Array.from({ length: 5 }, (_, index) => ({ ...cand(`top-known-${index}`, `known-author-${index}`), score: 100 - index, relationshipClass: 'known' as const })),
			...Array.from({ length: 10 }, (_, index) => ({ ...cand(`fresh-unknown-${index}`, `fresh-author-${index}`), score: 10 - index, relationshipClass: 'unknown' as const })),
		];
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, unknownSufficient: true, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', candidates]]) });
		expect(out.length).toBeGreaterThan(0);
		expect(out[0].noteId).toBe('fresh-unknown-0');
		expect(bruteFinalValid(out, followingSeedVisible, true)).toBe(true);
	});

	it('rejects a candidate that worsens a legacy upper violation context', () => {
		const followingSeedVisible = [
			...Array.from({ length: 15 }, (_, index) => ({ ...cand(`old-unknown-${index}`, `unknown-${index}`), relationshipClass: 'unknown' as const })),
			...uniqueCands('old', 5), cand('old-a-1', 'A'), cand('old-a-2', 'A'), ...uniqueCands('old-tail', 8),
		];
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, unknownSufficient: true, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', [cand('worsening-a', 'A'), { ...cand('safe-unknown', 'fresh'), relationshipClass: 'unknown' as const }]]]) });
		expect(out.map(item => item.noteId)).toEqual(['safe-unknown']);
		expect(bruteFinalValid(out, followingSeedVisible, true)).toBe(true);
	});

	it('matches independent brute-force final validity for deterministic randomized constraints', () => {
		let state = 0x5eed1234;
		const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
		let nonemptyCases = 0;
		for (let run = 0; run < 40; run++) {
			const unknownSufficient = run % 2 === 0;
			const make = (prefix: string, index: number): ForYouCandidate => ({
				noteId: `${prefix}-${run}-${index}`, userId: `author-${random() % 24}`, score: 100 - index,
				relationshipClass: unknownSufficient ? 'unknown' : (random() % 2 === 0 ? 'directFollow' : 'known'),
				exactTextFingerprint: `fp-${prefix}-${run}-${index}`,
				isBot: random() % 4 === 0, strictBotTemplateFingerprint: `tpl-${prefix}-${run}-${index}`,
			});
			const following = Array.from({ length: 30 }, (_, index) => ({ ...make('old', index), userId: `old-author-${run}-${index}`,
				relationshipClass: unknownSufficient && index < 15 ? 'unknown' : undefined }));
			const candidates = Array.from({ length: 45 }, (_, index) => make('new', index));
			const out = hanamiInterleave({ confidence: 'none', limit: 30, personalConstraints: true, unknownSufficient,
				followingSeedVisible: following, axisCandidates: new Map([['globalPopular', candidates]]) });
			if (out.length > 0) nonemptyCases++;
			expect(bruteFinalValid(out, following, unknownSufficient)).toBe(true);
		}
		expect(nonemptyCases).toBeGreaterThan(0);
	});

	it('enforces author, exact text, and strict bot-template caps across a persisted boundary', () => {
		const followingSeedVisible = Array.from({ length: 29 }, (_, i) => ({ noteId: `old-${i}`, userId: i === 0 ? 'A' : i === 1 ? 'C' : `old-author-${i}`, score: 0,
			exactTextFingerprint: i === 0 ? 'exact-x' : `old-${i}`, isBot: i === 1, strictBotTemplateFingerprint: i === 1 ? 'bot-x' : undefined }));
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([['globalPopular', [
			cand('author-repeat', 'A'), { ...cand('exact-repeat', 'B'), exactTextFingerprint: 'exact-x' },
			{ ...cand('bot-repeat', 'C'), isBot: true, strictBotTemplateFingerprint: 'bot-x' }, cand('fresh', 'D'),
		]]]);
		const out = hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates, followingSeedVisible, personalConstraints: true });
		expect(out.map(x => x.noteId)).toEqual(['fresh']);
	});

	it('keeps direct/known caps and the unknown floor when fifteen unknown Notes are eligible', () => {
		const unknown = Array.from({ length: 15 }, (_, index) => ({ ...cand(`unknown-${index}`, `unknown-author-${index}`), relationshipClass: 'unknown' as const }));
		const direct = Array.from({ length: 10 }, (_, index) => ({ ...cand(`direct-${index}`, `direct-author-${index}`), relationshipClass: 'directFollow' as const }));
		const known = Array.from({ length: 10 }, (_, index) => ({ ...cand(`known-${index}`, `known-author-${index}`), relationshipClass: 'known' as const }));
		const out = hanamiInterleave({ confidence: 'none', limit: 30, personalConstraints: true,
			axisCandidates: new Map<HanamiAxis, ForYouCandidate[]>([['globalPopular', [...unknown, ...direct, ...known]]]) });
		const selected = new Map([...unknown, ...direct, ...known].map(value => [value.noteId, value.relationshipClass]));
		const classes = out.map(value => selected.get(value.noteId));
		expect(classes.filter(value => value === 'unknown')).toHaveLength(15);
		expect(classes.filter(value => value === 'directFollow').length).toBeLessThanOrEqual(6);
		expect(classes.filter(value => value === 'directFollow' || value === 'known').length).toBeLessThanOrEqual(12);
	});

	it('uses the stable batch unknown-sufficiency snapshot instead of the local candidate count', () => {
		const candidates = Array.from({ length: 31 }, (_, index) => cand(`unclassified-${index}`, `author-${index}`));
		const constrained = hanamiInterleave({ confidence: 'none', limit: 30, personalConstraints: true, unknownSufficient: true, axisCandidates: new Map([['globalPopular', candidates]]) });
		const legacy = hanamiInterleave({ confidence: 'none', limit: 30, personalConstraints: true, unknownEligibleCount: 0, axisCandidates: new Map([['globalPopular', candidates]]) });
		expect(constrained).toHaveLength(29); // The 30th would complete an unknown-floor-invalid window.
		expect(legacy).toHaveLength(31);
	});

	it('keeps the longest valid prefix and returns no prefix when the first new item is invalid', () => {
		const following = uniqueCands('old', 8);
		const prefix = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, followingSeedVisible: following, axisCandidates: new Map([['globalPopular', [cand('first', 'B'), cand('rejected', 'B')]]]) });
		expect(prefix.map(value => value.noteId)).toEqual(['first']);

		const noPrefix = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, followingSeedVisible: [...following, cand('old-b', 'B')], axisCandidates: new Map([['globalPopular', [cand('invalid-first', 'B')]]]) });
		expect(noPrefix).toEqual([]);
	});

	it('handles a 1900-candidate refresh with a 210-item boundary using bounded sliding checks', () => {
		const candidates = uniqueCands('volume', 1900);
		const seed = uniqueCands('seed', 210);
		const startedAt = Date.now();
		const out = hanamiInterleave({
			confidence: 'none',
			limit: 210,
			personalConstraints: true,
			axisCandidates: new Map([['globalPopular', candidates]]),
			followingSeedVisible: seed,
		});
		// Deliberately generous: this guards against accidentally restoring the
		// former per-window slice/recount quadratic implementation, not p95 timing.
		expect(Date.now() - startedAt).toBeLessThan(5000);
		expect(out.length).toBeGreaterThanOrEqual(210);
		expect(out.length).toBeLessThanOrEqual(212); // none-confidence cap headroom
	});

	it('checks every final visible window against old-head seed and earlier selected segments', () => {
		const cases: Array<{ size: number; positions: number[]; author: string }> = [
			{ size: 10, positions: [0], author: 'two-in-ten' },
			{ size: 30, positions: [0, 15], author: 'three-in-thirty' },
			{ size: 210, positions: [0, 35, 70, 105, 140, 175], author: 'seven-in-two-ten' },
		];
		for (const testCase of cases) {
			const selectedVisible = Array.from({ length: testCase.size - 2 }, (_, index) => cand(`selected-${testCase.size}-${index}`, testCase.positions.includes(index) ? testCase.author : `selected-author-${index}`));
			const followingSeedVisible = [cand(`old-head-${testCase.size}`, `old-author-${testCase.size}`)];
			const bad = cand(`bad-${testCase.size}`, testCase.author);
			const good = cand(`good-${testCase.size}`, `good-author-${testCase.size}`);
			const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, selectedVisible, followingSeedVisible,
				axisCandidates: new Map([['globalPopular', [bad, good]]]) });
			expect(out.map(value => value.noteId)).toContain(good.noteId);
			expect(out.map(value => value.noteId)).not.toContain(bad.noteId);
			expectFinalWindows([...selectedVisible, good], followingSeedVisible);
		}
	});

	it('rejects exact/template duplicates across a new tail and old-head prefix', () => {
		const selectedVisible = [{ ...cand('new-tail-exact', 'new-author'), exactTextFingerprint: 'same' },
			{ ...cand('new-tail-template', 'bot-author'), isBot: true, strictBotTemplateFingerprint: 'template' }];
		const followingSeedVisible = Array.from({ length: 28 }, (_, index) => cand(`old-${index}`, `old-author-${index}`));
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, selectedVisible, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', [
				{ ...cand('duplicate-exact', 'different-author'), exactTextFingerprint: 'same' },
				{ ...cand('duplicate-template', 'bot-author'), isBot: true, strictBotTemplateFingerprint: 'template' },
				cand('valid', 'valid-author'),
			]]]) });
		expect(out.map(value => value.noteId)).toEqual(['valid']);
		expectFinalWindows([...selectedVisible, ...out.map(value => cand(value.noteId, value.userId!))], followingSeedVisible);
	});

	it('enforces direct and known relationship caps at the old-head boundary', () => {
		const followingSeedVisible: ForYouCandidate[] = [
			...Array.from({ length: 6 }, (_, index) => ({ ...cand(`old-direct-${index}`, `direct-${index}`), relationshipClass: 'directFollow' as const })),
			...Array.from({ length: 6 }, (_, index) => ({ ...cand(`old-known-${index}`, `known-${index}`), relationshipClass: 'known' as const })),
			...Array.from({ length: 17 }, (_, index) => ({ ...cand(`old-unknown-${index}`, `unknown-${index}`), relationshipClass: 'unknown' as const })),
		];
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', [
				{ ...cand('new-direct', 'new-direct'), relationshipClass: 'directFollow' as const },
				{ ...cand('new-known', 'new-known'), relationshipClass: 'known' as const },
				{ ...cand('new-unknown', 'new-unknown'), relationshipClass: 'unknown' as const },
			]]]) });
		expect(out.map(value => value.noteId)).toEqual(['new-unknown']);
		expectFinalWindows(out.map(value => ({ ...cand(value.noteId, value.userId!), relationshipClass: value.noteId === 'new-known' ? 'known' as const : 'unknown' as const })), followingSeedVisible);
	});

	it('rejects a different candidate when its insertion completes an author-A window', () => {
		const selectedVisible = [cand('newer', 'newer-author')];
		const followingSeedVisible = [cand('old-a-1', 'A'), cand('old-a-2', 'A'), ...uniqueCands('old', 6)];
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, selectedVisible, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', [cand('different-B', 'B')]]]) });
		expect(out).toEqual([]);
	});

	it('rejects a different fingerprint when insertion shifts a duplicate pair into full thirty', () => {
		const selectedVisible = [cand('newer', 'newer-author')];
		const followingSeedVisible = [{ ...cand('old-fp-1', 'old-a'), exactTextFingerprint: 'duplicate' }, { ...cand('old-fp-2', 'old-b'), exactTextFingerprint: 'duplicate' }, ...uniqueCands('old', 27)];
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, selectedVisible, followingSeedVisible,
			axisCandidates: new Map([['globalPopular', [{ ...cand('different-fp', 'B'), exactTextFingerprint: 'other' }]]]) });
		expect(out).toEqual([]);
	});

	it('uses partial windows only for irreversible upper feasibility, not unknown lower floor', () => {
		const unknown = Array.from({ length: 15 }, (_, index) => ({ ...cand(`unknown-${index}`, `unknown-${index}`), relationshipClass: 'unknown' as const }));
		const out = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true,
			axisCandidates: new Map([['globalPopular', [{ ...cand('known-prefix', 'known'), relationshipClass: 'known' as const }, ...unknown]]]) });
		expect(out[0]?.noteId).toBe('known-prefix');
		expectPartialUpperFeasible(out.map(value => ({ ...cand(value.noteId, value.userId!), relationshipClass: value.relationshipClass })), []);

		const rejected = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true,
			selectedVisible: [cand('previous-a', 'A')], axisCandidates: new Map([['globalPopular', [cand('new-a', 'A')]]]) });
		expect(rejected).toEqual([]);
	});

	it('does not blame an old-only partial seed, but refuses a new-inclusive full invalid window', () => {
		const invalidPartialSeed = [cand('old-a-1', 'A'), cand('old-a-2', 'A')];
		const partial = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, followingSeedVisible: invalidPartialSeed,
			axisCandidates: new Map([['globalPopular', [cand('unrelated', 'B')]]]) });
		expect(partial.map(value => value.noteId)).toContain('unrelated');

		const invalidFullSeed = [...invalidPartialSeed, ...uniqueCands('old', 7)];
		const full = hanamiInterleave({ confidence: 'none', limit: 10, personalConstraints: true, followingSeedVisible: invalidFullSeed,
			axisCandidates: new Map([['globalPopular', [cand('unrelated-full', 'B')]]]) });
		expect(full).toEqual([]);
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

	it('clusterId は枠を消費した軸自身の値を使う（軸間で merge しない。v0.7 R2-M4）', () => {
		// 同一 note が globalPopular（general=clusterId 無し）と reactionSimilar（c5）の両方にいる。
		const shared: ForYouCandidate = { noteId: 'shared-note', userId: 'author-x', score: 1 };
		const sharedWithCluster: ForYouCandidate = { noteId: 'shared-note', userId: 'author-x', score: 1, clusterId: 5 };
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', [shared, ...uniqueCands('gp', 5)]],
			['reactionSimilar', [sharedWithCluster, ...uniqueCands('rs', 5)]],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		const pick = out.find(o => o.noteId === 'shared-note')!;
		// 軸順で globalPopular が先に消費する → reactionSimilar 由来の c5 を引き継いではいけない。
		expect(pick.source).toBe('globalPopular');
		expect(pick.sources).toEqual(expect.arrayContaining(['globalPopular', 'reactionSimilar']));
		expect(pick.clusterId).toBeUndefined();
	});

	it('reactionSimilar が枠を消費した候補は自軸の clusterId を保持する（v0.7 R2-M4）', () => {
		const rsWithCluster: ForYouCandidate = { noteId: 'rs-c7-note', userId: 'author-rs7', score: 1, clusterId: 7 };
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>([
			['globalPopular', uniqueCands('gp', 5)],
			['reactionSimilar', [rsWithCluster, ...uniqueCands('rs', 5)]],
		]);
		const out = hanamiInterleave({ confidence: 'high', limit: 10, axisCandidates });
		const pick = out.find(o => o.noteId === 'rs-c7-note')!;
		expect(pick).toBeDefined();
		expect(pick.source).toBe('reactionSimilar');
		expect(pick.clusterId).toBe(7);
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
