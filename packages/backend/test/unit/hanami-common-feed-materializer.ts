/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import {
	HANAMI_COMMON_AXES,
	type HanamiCommonAxis,
	type HanamiCommonCandidate,
	type HanamiCommonSourceBundle,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { materializeHanamiCommonFeed } from '@/core/hanami/HanamiCommonFeedMaterializer.js';

const AT = '2026-08-20T00:00:00.000Z';

function candidate(noteId: string, authorId: string, baseScore: number, term?: string): HanamiCommonCandidate {
	return {
		noteId,
		authorId,
		baseScore,
		metadata: term == null ? {} : { term },
	};
}

function candidates(prefix: string, count: number): HanamiCommonCandidate[] {
	return Array.from({ length: count }, (_, index) => candidate(
		`${prefix}-note-${String(index).padStart(3, '0')}`,
		`${prefix}-author-${String(index).padStart(3, '0')}`,
		count - index,
		prefix === 'trending' ? `term-${index % 8}` : undefined,
	));
}

function source(
	axisCandidates: Partial<Record<HanamiCommonAxis, readonly HanamiCommonCandidate[]>>,
	enabledAxes: readonly HanamiCommonAxis[] = HANAMI_COMMON_AXES,
): HanamiCommonSourceBundle {
	return {
		version: 1,
		capturedAt: AT,
		sourceAsOf: {
			version: 1,
			capturedAt: AT,
			featuredAt: AT,
			trendAt: AT,
			axisConfigAt: AT,
		},
		enabledAxes,
		candidates: {
			globalPopular: axisCandidates.globalPopular ?? [],
			trending: axisCandidates.trending ?? [],
			exploration: axisCandidates.exploration ?? [],
		},
		trendSnapshot: { terms: [] },
	};
}

describe('HanamiCommonFeedMaterializer', () => {
	test('multiplies recurrence by exactly 0.5 once, keeps it eligible, and uses original rank for ties', () => {
		const bundle = source({
			globalPopular: [
				candidate('recent', 'author-recent', 4),
				candidate('equal-after-penalty', 'author-equal', 2),
				candidate('stable-a', 'author-a', 1),
				candidate('stable-b', 'author-b', 1),
			],
		}, ['globalPopular']);
		const before = JSON.stringify(bundle);

		const result = materializeHanamiCommonFeed({
			source: bundle,
			recentCommonNoteIds: new Set(['recent']),
		});

		expect(result.items.map(item => item.noteId)).toEqual([
			'recent',
			'equal-after-penalty',
			'stable-a',
			'stable-b',
		]);
		expect(result.items.some(item => item.noteId === 'recent')).toBe(true);
		expect(JSON.stringify(bundle)).toBe(before);
		expect(bundle.candidates.globalPopular[0].baseScore).toBe(4);
	});

	test('deduplicates across axes and preserves canonical source/sources semantics', () => {
		const sharedGlobal = candidate('shared', 'shared-author', 10);
		const sharedTrend = candidate('shared', 'shared-author', 9, 'shared-term');
		const sharedExplore = candidate('shared', 'shared-author', 8);
		const result = materializeHanamiCommonFeed({
			source: source({
				globalPopular: [sharedGlobal, candidate('global', 'global-author', 1)],
				trending: [sharedTrend, candidate('trend', 'trend-author', 1, 'trend-term')],
				exploration: [sharedExplore, candidate('explore', 'explore-author', 1)],
			}),
			recentCommonNoteIds: new Set(),
		});

		const shared = result.items.find(item => item.noteId === 'shared');
		expect(shared).toEqual({
			noteId: 'shared',
			authorId: 'shared-author',
			source: 'globalPopular',
			sources: ['globalPopular', 'trending', 'exploration'],
		});
		expect(result.items.filter(item => item.noteId === 'shared')).toHaveLength(1);
		expect(new Set(result.items.map(item => item.noteId)).size).toBe(result.items.length);
	});

	test('resets quotas and interleave state for seven independent 30-item segments', () => {
		const result = materializeHanamiCommonFeed({
			source: source({
				globalPopular: candidates('globalPopular', 154),
				trending: candidates('trending', 28),
				exploration: candidates('exploration', 28),
			}),
			recentCommonNoteIds: new Set(),
		});

		expect(result.items).toHaveLength(210);
		expect(result.segmentLengths).toEqual([30, 30, 30, 30, 30, 30, 30]);
		for (let start = 0; start < result.items.length; start += 30) {
			const counts = new Map<HanamiCommonAxis, number>();
			for (const item of result.items.slice(start, start + 30)) {
				counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
			}
			expect(Object.fromEntries(counts)).toEqual({ globalPopular: 22, trending: 4, exploration: 4 });
		}
		expect(new Set(result.items.map(item => item.noteId)).size).toBe(210);
	});

	test('enforces two Notes per author within a segment and resets the cap across segments', () => {
		const sameAuthor = Array.from({ length: 20 }, (_, index) => candidate(`same-${index}`, 'same-author', 20 - index));
		const result = materializeHanamiCommonFeed({
			source: source({ globalPopular: sameAuthor }, ['globalPopular']),
			recentCommonNoteIds: new Set(),
		});

		expect(result.segmentLengths).toEqual([2, 2, 2, 2, 2, 2, 2]);
		expect(result.items).toHaveLength(14);
		expect(result.items.map(item => item.noteId)).toEqual(sameAuthor.slice(0, 14).map(item => item.noteId));
	});

	test('redistributes disabled-axis capacity without allowing disabled candidates to participate', () => {
		const result = materializeHanamiCommonFeed({
			source: source({
				globalPopular: candidates('disabled-global', 40),
				trending: candidates('trending', 35),
				exploration: candidates('disabled-exploration', 40),
			}, ['trending']),
			recentCommonNoteIds: new Set(),
		});

		expect(result.segmentLengths).toEqual([30, 5]);
		expect(result.items).toHaveLength(35);
		expect(result.items.every(item => item.source === 'trending' && item.sources.join(',') === 'trending')).toBe(true);
	});
});
