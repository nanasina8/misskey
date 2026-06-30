/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';

// For You-only 化後の HanamiRecommendationService は周辺ユーティリティのみ（score 混合・home 注入は廃止＝§6）。
// 配信本体のロジックは HanamiForYouInterleave / HanamiForYouService 側でテストする。
function createService(profile: object): HanamiRecommendationService {
	const cacheService = { userProfileCache: { fetch: jest.fn(async () => profile) } };
	return new HanamiRecommendationService(
		{} as never, // redis
		cacheService as never,
		{} as never, // hanamiTrendService
		{} as never, // hanamiUserRecommendationService
		{} as never, // hanamiForYouProvenanceService
	);
}

describe('HanamiRecommendationService (For You-only utilities)', () => {
	test('getAutoInjectPreset returns the strength preset when enabled and auto-inject is on', async () => {
		const service = createService({ hanamiRecommendationEnabled: true, hanamiRecommendationAutoInjectEnabled: true, hanamiRecommendationAutoInjectStrength: 'high' });
		expect(await service.getAutoInjectPreset('user-1')).toEqual({ homeNotesPerInjection: 4, injectCount: 2 });
	});

	test('getAutoInjectPreset returns null when recommendation is disabled', async () => {
		const service = createService({ hanamiRecommendationEnabled: false, hanamiRecommendationAutoInjectEnabled: true, hanamiRecommendationAutoInjectStrength: 'low' });
		expect(await service.getAutoInjectPreset('user-1')).toBeNull();
	});

	test('getAutoInjectPreset returns null when auto-inject is disabled', async () => {
		const service = createService({ hanamiRecommendationEnabled: true, hanamiRecommendationAutoInjectEnabled: false, hanamiRecommendationAutoInjectStrength: 'low' });
		expect(await service.getAutoInjectPreset('user-1')).toBeNull();
	});

	test('getAutoInjectPreset falls back to the low preset for an unknown strength', async () => {
		const service = createService({ hanamiRecommendationEnabled: true, hanamiRecommendationAutoInjectEnabled: true, hanamiRecommendationAutoInjectStrength: 'bogus' });
		expect(await service.getAutoInjectPreset('user-1')).toEqual({ homeNotesPerInjection: 10, injectCount: 1 });
	});
});
