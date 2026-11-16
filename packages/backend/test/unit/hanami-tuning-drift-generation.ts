/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { HanamiForYouService, type HanamiPersonalFeedGenerationContext } from '@/core/hanami/HanamiForYouService.js';
import { HANAMI_FOR_YOU_AXES, type HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
import { HANAMI_TUNING_COUNTS_SQL } from '@/core/hanami/HanamiTuningSuggestion.js';
import type { HanamiTuningInput, HanamiTuningProfile, ResolvedHanamiTuning, HanamiAxisServerConfig } from '@/core/hanami/HanamiTuning.js';

type WithDrift = {
	resolveTuningWithDrift(userId: string, profile: HanamiTuningProfile, generation?: HanamiPersonalFeedGenerationContext): Promise<ResolvedHanamiTuning>;
};

// 近くで話題にはよく反応し、いま話題にはほとんど反応しない人。
const counts = HANAMI_FOR_YOU_AXES.map(axis => ({
	axis,
	seen: 100,
	reactions: axis === 'neighborTrending' ? 60 : axis === 'trending' ? 0 : 10,
	serverSeen: 1000,
	serverReactions: 100,
}));

function createService(query: (sql: string, parameters?: unknown[]) => Promise<unknown[]>, axisConfig: HanamiAxisServerConfig = {}): WithDrift {
	return new HanamiForYouService(
		{ query } as never,
		{ hanamiRecommendationAxisConfig: axisConfig } as never,
		{} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
	) as unknown as WithDrift;
}

function generationOf(query: (sql: string, parameters?: unknown[]) => Promise<unknown[]>): HanamiPersonalFeedGenerationContext {
	return {
		userId: 'me',
		epochId: 'epoch-1',
		latestReadyBatchId: null,
		baseCommonGenerationId: 'common-generation',
		generatedAt: '2026-08-20T10:00:00.000Z',
		databaseDeadlineAt: '2026-08-20T10:00:45.000Z',
		signal: new AbortController().signal,
		queryRunner: { query } as never,
	} as HanamiPersonalFeedGenerationContext;
}

const profile = (hanamiTuning: HanamiTuningInput): HanamiTuningProfile => ({ hanamiTuning });
const amountsOf = (tuning: ResolvedHanamiTuning) => Object.fromEntries(tuning.amounts) as Record<HanamiAxis, number>;

describe('はなみTL の生成で、反応に合わせて量を寄せる', () => {
	test('おまかせは、本人の集計を読んで「ふつう」の幅（0.7〜1.4）で寄せる', async () => {
		const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => counts as unknown[]);
		const amounts = amountsOf(await createService(query).resolveTuningWithDrift('me', profile({ mode: 'auto' })));
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]).toEqual([HANAMI_TUNING_COUNTS_SQL, ['me', [...HANAMI_FOR_YOU_AXES]]]);
		expect(amounts.neighborTrending).toBe(1.4);
		expect(amounts.trending).toBe(0.7);
		expect(amounts.exploration).toBeGreaterThanOrEqual(1);
		expect(amounts.globalPopular).toBeGreaterThan(0.7);
		expect(amounts.globalPopular).toBeLessThan(1);
	});

	test('方向だけ決める は、選んだ方向の量に、選んだ寄せ方の幅で掛ける', async () => {
		const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => counts as unknown[]);
		const service = createService(query);
		const gentle = amountsOf(await service.resolveTuningWithDrift('me', profile({ mode: 'direction', direction: 0, drift: 0 })));
		const strong = amountsOf(await service.resolveTuningWithDrift('me', profile({ mode: 'direction', direction: 0, drift: 2 })));
		// 身近な人中心の 1.3 に、ひかえめの上限 1.18／しっかりの上限 2 を掛ける。
		expect(gentle.neighborTrending).toBe(1.53);
		expect(strong.neighborTrending).toBeGreaterThan(gentle.neighborTrending);
		expect(strong.neighborTrending).toBeLessThanOrEqual(2.6);
		// みんなの話題の 0.55 に、ひかえめの下限 0.85／しっかりの下限 0.5 を掛ける。
		expect(gentle.trending).toBe(0.47);
		expect(strong.trending).toBe(0.28);
	});

	test('おすすめから調整・すべて自分で は自動では動かさず、集計も読まない', async () => {
		const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => counts as unknown[]);
		const service = createService(query);
		const recommend = amountsOf(await service.resolveTuningWithDrift('me', profile({ mode: 'recommend', groups: { close: 3, buzz: 1, fresh: 2 } })));
		const manual = amountsOf(await service.resolveTuningWithDrift('me', profile({ mode: 'manual', manual: { amounts: { neighborTrending: 0.5 }, authorCap: 2 } })));
		expect(query).not.toHaveBeenCalled();
		expect(recommend).toMatchObject({ neighborTrending: 1.4, trending: 0.7, exploration: 1 });
		expect(manual).toMatchObject({ neighborTrending: 0.5, trending: 1 });
	});

	test('生成の中では生成用の接続で読み、使えない種類は集計にも量にも入れない', async () => {
		const outside = vi.fn(async (_sql: string, _parameters?: unknown[]) => [] as unknown[]);
		const inside = vi.fn(async (_sql: string, _parameters?: unknown[]) => counts as unknown[]);
		const service = createService(outside, { trending: { available: false }, fof: { default: false } });
		const amounts = amountsOf(await service.resolveTuningWithDrift('me', profile({ mode: 'auto' }), generationOf(inside)));
		expect(outside).not.toHaveBeenCalled();
		expect(inside).toHaveBeenCalledTimes(1);
		expect(inside.mock.calls[0][1]).toEqual(['me', HANAMI_FOR_YOU_AXES.filter(axis => axis !== 'trending')]);
		expect(amounts.trending).toBe(0);
		expect(amounts.fof).toBe(0);
		expect(amounts.neighborTrending).toBe(1.4);
	});

	test('まだ何も記録が無い人は、初めの量のまま', async () => {
		const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => [] as unknown[]);
		const amounts = amountsOf(await createService(query).resolveTuningWithDrift('me', profile({})));
		expect(Object.values(amounts).every(amount => amount === 1)).toBe(true);
	});
});
