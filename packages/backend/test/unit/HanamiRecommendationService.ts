/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';

// For You-only 化後の HanamiRecommendationService は周辺ユーティリティのみ（score 混合・home 注入は廃止＝§6）。
// 配信本体のロジックは HanamiForYouInterleave / HanamiForYouService 側でテストする。
function createService() {
	const transaction = {
		zadd: jest.fn(),
		zremrangebyscore: jest.fn(),
		expire: jest.fn(),
		exec: jest.fn(async () => [[null, 1]]),
	};
	transaction.zadd.mockReturnValue(transaction);
	transaction.zremrangebyscore.mockReturnValue(transaction);
	transaction.expire.mockReturnValue(transaction);
	const redis = {
		zrangebyscore: jest.fn(async (key: string) => key.includes(':served:') ? ['served-1'] : ['seen-1']),
		multi: jest.fn(() => transaction),
	};
	const trend = {
		getTrendingTerms: jest.fn(async () => [{ term: 'term', score: 3, distinctAuthors: 2, ignored: true }]),
	};
	const userRecommendation = {
		getFollowCandidates: jest.fn(async () => [{ userId: 'user-2', reason: 'mutual', mutualCount: 4, ignored: true }]),
		recordShown: jest.fn(async () => undefined),
	};
	const service = new HanamiRecommendationService(
		redis as never,
		trend as never,
		userRecommendation as never,
		{} as never,
	);
	return { redis, service, transaction, trend, userRecommendation };
}

describe('HanamiRecommendationService (For You-only utilities)', () => {
	test('retains served utilities without auto-inject or legacy seen writers', async () => {
		const { redis, service } = createService();

		expect(await service.getServedSeenForExclusion('user-1')).toEqual({
			served: new Set(['served-1']),
			seen: new Set(['seen-1']),
		});
		await service.recordServed('user-1', ['note-1']);

		expect(redis.multi).toHaveBeenCalledTimes(1);
		expect('getAutoInjectPreset' in service).toBe(false);
		expect('recordSeen' in service).toBe(false);
		expect('recordHomeSeen' in service).toBe(false);
	});

	test('retains the trend and user recommendation endpoint wrappers', async () => {
		const { service, trend, userRecommendation } = createService();

		expect(await service.getFollowCandidates('user-1', 5)).toEqual([
			{ userId: 'user-2', reason: 'mutual', mutualCount: 4 },
		]);
		await service.recordFollowCandidatesShown('user-1', ['user-2']);
		expect(await service.getTrendingTerms(5)).toEqual([
			{ term: 'term', score: 3, distinctAuthors: 2 },
		]);

		expect(userRecommendation.getFollowCandidates).toHaveBeenCalledWith('user-1', 5);
		expect(userRecommendation.recordShown).toHaveBeenCalledWith('user-1', ['user-2']);
		expect(trend.getTrendingTerms).toHaveBeenCalledWith(5);
	});
});
