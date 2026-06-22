/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import type { Packed } from '@/misc/json-schema.js';
import { HanamiRecommendationService, type RecSource } from '@/core/HanamiRecommendationService.js';

type Candidate = {
	noteId: string;
	score: number;
	topContribution?: number;
	source: RecSource;
	reason: RecSource;
	term?: string;
	sources?: RecSource[];
};

type ServiceInternals = {
	mergeCandidates(lists: Candidate[][]): Candidate[];
	applyAxisCaps(candidates: Candidate[], opts: {
		limit: number;
		capLimit: number;
		axisMaxShare: Record<RecSource, number>;
	}): Candidate[];
};

function createService(opts: { meta?: object; cacheService?: object } = {}): HanamiRecommendationService {
	return new HanamiRecommendationService(
		{} as never,
		(opts.meta ?? {}) as never,
		{} as never,
		{} as never,
		{} as never,
		(opts.cacheService ?? {}) as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
	);
}

function candidate(noteId: string, source: RecSource, score: number): Candidate {
	return { noteId, source, reason: source, score };
}

describe('HanamiRecommendationService', () => {
	test('uses the largest individual contribution as source and reason', () => {
		const service = createService() as unknown as ServiceInternals;
		const [merged] = service.mergeCandidates([
			[{ ...candidate('note-1', 'popular', 0.4) }],
			[{ ...candidate('note-1', 'catchup', 0.3) }],
			[{ ...candidate('note-1', 'trending', 0.6), term: 'topic' }],
		]);

		expect(merged).toMatchObject({
			noteId: 'note-1',
			topContribution: 0.6,
			source: 'trending',
			reason: 'trending',
			term: 'topic',
			sources: ['popular', 'catchup', 'trending'],
		});
		expect(merged.score).toBeCloseTo(1.3);
	});

	test('does not add candidates back after an axis reaches its cap', () => {
		const service = createService() as unknown as ServiceInternals;
		const result = service.applyAxisCaps([
			candidate('popular-1', 'popular', 1),
			candidate('popular-2', 'popular', 0.9),
			candidate('popular-3', 'popular', 0.8),
			candidate('popular-4', 'popular', 0.7),
			candidate('trending-1', 'trending', 0.6),
			candidate('trending-2', 'trending', 0.5),
		], {
			limit: 5,
			capLimit: 5,
			axisMaxShare: {
				popular: 0.4,
				trending: 0.4,
				reactionSimilar: 0.2,
				catchup: 0.2,
				fof: 0.2,
			},
		});

		expect(result.map(item => item.noteId)).toEqual([
			'popular-1',
			'popular-2',
			'trending-1',
			'trending-2',
		]);
	});

	test('records auto-injected notes with their delivery metadata', async () => {
		const service = createService();
		const recordServedWithLog = jest.spyOn(service, 'recordServedWithLog').mockResolvedValue(undefined);
		const items = [{
			note: { id: 'note-1', userId: 'author-1' } as unknown as Packed<'Note'>,
			reason: { source: 'fof', reason: 'fof', sources: ['popular', 'fof'] } as const,
		}];

		await service.recordAutoInjectedServed('user-1', items);

		expect(recordServedWithLog).toHaveBeenCalledWith(
			'user-1',
			['note-1'],
			new Map([['note-1', items[0].reason]]),
			['author-1'],
			['author-1'],
		);
	});

	test('resolves reason visibility from the user profile', async () => {
		const service = createService({
			meta: { hanamiRecommendationAxisConfig: {} },
			cacheService: {
				userProfileCache: {
					fetch: async () => ({
						hanamiRecommendationEnabled: true,
						hanamiRecommendationStrength: 'normal',
						hanamiRecommendationAxes: {},
						hanamiRecommendationAutoInjectEnabled: true,
						hanamiRecommendationAutoInjectStrength: 'low',
						hanamiShowRecommendationReason: true,
					}),
				},
			},
		});
		const settings = await (service as unknown as {
			resolveSettings(meId: string): Promise<{ showReason: boolean }>;
		}).resolveSettings('user-1');

		expect(settings.showReason).toBe(true);
	});
});
