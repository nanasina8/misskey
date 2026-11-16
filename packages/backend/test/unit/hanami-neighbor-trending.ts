/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, vi as jest, test } from 'vitest';
import {
	HanamiForYouService,
	buildHanamiNeighborCircle,
	type HanamiPersonalFeedGenerationContext,
} from '@/core/hanami/HanamiForYouService.js';

const generatedAt = '2026-08-20T10:00:00.000Z';

type NeighborTrending = {
	neighborTrendingCandidates(userId: string, alsRunId: string | null, generation?: HanamiPersonalFeedGenerationContext): Promise<Array<{ noteId: string; userId: string; score: number; socialCount?: number }>>;
};

function createService(db: unknown = {}): NeighborTrending {
	return new HanamiForYouService(
		db as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ gen: jest.fn((..._args: unknown[]) => 'since-id') } as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
	) as unknown as NeighborTrending;
}

type Tables = {
	relations?: Array<{ id: string; relScore: number }>;
	neighbors?: Array<{ id: string }>;
	followees?: Array<{ id: string }>;
	reacted?: Array<{ noteId: string; userId: string; score: number; socialCount: number }>;
};

function answer(tables: Tables) {
	return jest.fn(async (sql: string, _parameters?: unknown[]) => {
		if (sql.includes('FROM "hanami_foryou_relation"')) return tables.relations ?? [];
		if (sql.includes('FROM "hanami_foryou_neighbor_user"')) return tables.neighbors ?? [];
		if (sql.includes('FROM following')) return tables.followees ?? [];
		if (sql.includes('WITH near AS MATERIALIZED')) return tables.reacted ?? [];
		return [];
	});
}

function generationOf(query: ReturnType<typeof answer>): HanamiPersonalFeedGenerationContext {
	return {
		userId: 'me',
		epochId: 'epoch-1',
		latestReadyBatchId: null,
		baseCommonGenerationId: 'common-generation',
		generatedAt,
		databaseDeadlineAt: '2026-08-20T10:00:45.000Z',
		signal: new AbortController().signal,
		queryRunner: { query } as never,
	} as HanamiPersonalFeedGenerationContext;
}

function nearOf(query: ReturnType<typeof answer>): Map<string, number> {
	const call = query.mock.calls.find(value => String(value[0]).includes('WITH near AS MATERIALIZED'));
	if (call == null) throw new Error('reaction query was not issued');
	const [ids, weights] = call[1] as [string[], number[]];
	return new Map(ids.map((id, index) => [id, weights[index]]));
}

describe('近くで話題の「近い人」', () => {
	test('フォロー中と ALS の近傍は重み 1、関係値の上位は 1〜2（最大の人が 2）', () => {
		const circle = buildHanamiNeighborCircle({
			meId: 'me',
			relations: [{ id: 'rel-top', relScore: 8 }, { id: 'rel-half', relScore: 4 }, { id: 'rel-zero', relScore: 0 }],
			alsNeighborIds: ['als'],
			followeeIds: ['followee'],
		});
		expect(circle).toEqual(new Map([['rel-top', 2], ['rel-half', 1.5], ['rel-zero', 1], ['als', 1], ['followee', 1]]));
	});

	test('複数に入る人は重みの大きいほう、本人は入れない', () => {
		const circle = buildHanamiNeighborCircle({
			meId: 'me',
			relations: [{ id: 'me', relScore: 10 }, { id: 'both', relScore: 3 }, { id: 'top', relScore: 4 }],
			alsNeighborIds: ['both', 'me', 'top'],
			followeeIds: ['both', 'me'],
		});
		expect(circle.get('both')).toBeCloseTo(1.75);
		expect(circle.get('top')).toBe(2);
		expect(circle.has('me')).toBe(false);
		expect(circle.size).toBe(2);
	});

	test('関係値の最大が 0 以下なら重みは 1', () => {
		const circle = buildHanamiNeighborCircle({
			meId: 'me',
			relations: [{ id: 'a', relScore: 0 }, { id: 'b', relScore: -1 }],
			alsNeighborIds: [],
			followeeIds: [],
		});
		expect(circle).toEqual(new Map([['a', 1], ['b', 1]]));
	});

	test('人数の上限は関係値 → ALS → フォロー中の順に詰める', () => {
		const circle = buildHanamiNeighborCircle({
			meId: 'me',
			relations: [{ id: 'rel-1', relScore: 2 }, { id: 'rel-2', relScore: 1 }],
			alsNeighborIds: ['als-1', 'als-2'],
			followeeIds: ['rel-1', 'f-1', 'f-2', 'f-3'],
			max: 5,
		});
		expect([...circle.keys()]).toEqual(['rel-1', 'rel-2', 'als-1', 'als-2', 'f-1']);
		expect(circle.get('rel-1')).toBe(2);
	});

	test('既定の上限は 1,500 人（フォローが数千人いても配列は止まる）', () => {
		const circle = buildHanamiNeighborCircle({
			meId: 'me',
			relations: [],
			alsNeighborIds: [],
			followeeIds: Array.from({ length: 4000 }, (_, index) => `f-${index}`),
		});
		expect(circle.size).toBe(1500);
	});
});

describe('近くで話題の候補', () => {
	test('ALS の run が無くても、フォロー中がいれば候補を出す', async () => {
		const query = answer({
			followees: [{ id: 'followee-1' }, { id: 'followee-2' }],
			reacted: [{ noteId: 'note-1', userId: 'author-1', score: 2, socialCount: 2 }],
		});
		const result = await createService().neighborTrendingCandidates('me', null, generationOf(query));

		expect(result).toEqual([{ noteId: 'note-1', userId: 'author-1', score: 1, socialCount: 2 }]);
		expect(query.mock.calls.some(value => String(value[0]).includes('hanami_foryou_neighbor_user'))).toBe(false);
		expect(nearOf(query)).toEqual(new Map([['followee-1', 1], ['followee-2', 1]]));
	});

	test('関係値・ALS・フォロー中を重みつきで渡し、点数は最大で割って socialCount を付ける', async () => {
		const query = answer({
			relations: [{ id: 'rel', relScore: 6 }, { id: 'both', relScore: 3 }],
			neighbors: [{ id: 'als' }, { id: 'both' }],
			followees: [{ id: 'followee' }, { id: 'me' }],
			reacted: [
				{ noteId: 'note-2', userId: 'author-2', score: 4, socialCount: 3 },
				{ noteId: 'note-1', userId: 'author-1', score: 1, socialCount: 1 },
			],
		});
		const result = await createService().neighborTrendingCandidates('me', 'als-run', generationOf(query));

		expect(result).toEqual([
			{ noteId: 'note-2', userId: 'author-2', score: 1, socialCount: 3 },
			{ noteId: 'note-1', userId: 'author-1', score: 0.25, socialCount: 1 },
		]);
		expect(nearOf(query)).toEqual(new Map([['rel', 2], ['both', 1.5], ['als', 1], ['followee', 1]]));
		const reactionCall = query.mock.calls.find(value => String(value[0]).includes('WITH near AS MATERIALIZED'))!;
		expect(reactionCall[1]?.slice(2)).toEqual(['since-id', 'me', 250, 500]);
		// 1 人ずつ索引を引く・1 人 1 回・本人の投稿は出さない・重みの合計で並べる
		expect(reactionCall[0]).toContain('CROSS JOIN LATERAL');
		expect(reactionCall[0]).toContain('WHERE nr."userId" = near.id AND nr.id >= $3');
		expect(reactionCall[0]).toContain('SELECT DISTINCT r."noteId", near.id AS "reactorId", near.weight');
		expect(reactionCall[0]).toContain('n."userId" <> $4');
		expect(reactionCall[0]).toContain('ORDER BY s.score DESC, n.id DESC');
		const neighborCall = query.mock.calls.find(value => String(value[0]).includes('hanami_foryou_neighbor_user'))!;
		expect(neighborCall[1]).toEqual(['als-run', 'me', 100]);
		const followingCall = query.mock.calls.find(value => String(value[0]).includes('FROM following'))!;
		expect(followingCall[0]).toContain('ORDER BY following.id DESC');
		expect(followingCall[1]).toEqual(['me', 1500]);
	});

	test('近い人が 0 人なら投稿を引かずに空を返す', async () => {
		const query = answer({ followees: [{ id: 'me' }] });
		await expect(createService().neighborTrendingCandidates('me', 'als-run', generationOf(query))).resolves.toEqual([]);
		expect(query.mock.calls.some(value => String(value[0]).includes('WITH near AS MATERIALIZED'))).toBe(false);
	});

	test('生成の外（generation なし）でも db から同じ決まりで引く', async () => {
		const query = answer({
			followees: [{ id: 'followee' }],
			reacted: [{ noteId: 'note-1', userId: 'author-1', score: 1, socialCount: 1 }],
		});
		const result = await createService({ query }).neighborTrendingCandidates('me', null);
		expect(result).toEqual([{ noteId: 'note-1', userId: 'author-1', score: 1, socialCount: 1 }]);
	});

	test('生成が中断されていたら問い合わせない', async () => {
		const query = answer({ followees: [{ id: 'followee' }] });
		const controller = new AbortController();
		controller.abort(new Error('stop'));
		const generation = { ...generationOf(query), signal: controller.signal };
		await expect(createService().neighborTrendingCandidates('me', null, generation)).rejects.toThrow('stop');
		expect(query).not.toHaveBeenCalled();
	});
});
