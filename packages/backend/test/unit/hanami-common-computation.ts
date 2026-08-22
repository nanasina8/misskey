/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { HanamiCommonComputationService, HANAMI_COMMON_ALGORITHM_VERSION } from '@/core/hanami/HanamiCommonComputationService.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import type { HanamiTrendComputationBundle } from '@/core/hanami/HanamiTrendService.js';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const GENERATED_AT = '2026-08-20T11:59:00.000Z';

function emptyTrend(): HanamiTrendComputationBundle {
	return {
		computedAt: '2026-08-20T12:00:00.000Z',
		terms: [],
		noteCandidates: [],
	};
}

function createComputation(options: {
	scores?: ReadonlyMap<string, number>;
	axisConfig?: Record<string, { available?: boolean; default?: boolean }>;
	trend?: HanamiTrendComputationBundle;
	safeAuthors?: (noteIds: readonly string[]) => ReadonlyMap<string, string>;
	dbQuery?: (sql: string, parameters: unknown[]) => Promise<unknown[]>;
}) {
	const scores = options.scores ?? new Map<string, number>();
	const trend = options.trend ?? emptyTrend();
	const db = { query: jest.fn(options.dbQuery ?? (async () => [])) };
	const featuredService = { getGlobalNotesScoresWithCache: jest.fn(async () => scores) };
	const idService = { gen: jest.fn(() => 'fallback-since-id') };
	const trendService = { computeTrendBundle: jest.fn(async (_scores: ReadonlyMap<string, number>) => trend) };
	const safetyService = {
		filterCommonEligibleNotes: jest.fn(async (noteIds: readonly string[]) => (
			options.safeAuthors?.(noteIds)
			?? new Map([...new Set(noteIds)].map(noteId => [noteId, `author:${noteId}`]))
		)),
	};
	const service = new HanamiCommonComputationService(
		db as never,
		{ hanamiRecommendationAxisConfig: options.axisConfig ?? {} } as never,
		featuredService as never,
		idService as never,
		trendService as never,
		safetyService as never,
	);
	return { service, db, featuredService, idService, trendService, safetyService, scores };
}

function buildInput(signal: AbortSignal) {
	return {
		generationId: 'generation-1',
		generationFence: '7',
		generatedAt: GENERATED_AT,
		signal,
	};
}

afterEach(() => {
	jest.restoreAllMocks();
});

describe('HanamiCommonComputationService', () => {
	test('acquires Featured and trend once, builds exact pools, and returns finite immutable metadata', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const scores = new Map<string, number>();
		for (let index = 0; index < 510; index++) {
			scores.set(`featured-${String(index).padStart(4, '0')}`, 1000 - index);
		}
		scores.set('', 9999);
		scores.set('not-finite', Number.NaN);
		const terms = Array.from({ length: 35 }, (_, termIndex) => ({
			term: `term-${termIndex}`,
			score: 100 - termIndex,
			distinctAuthors: 40 - termIndex,
			representativeNoteIds: Array.from({ length: 6 }, (_, noteIndex) => `representative-${termIndex}-${noteIndex}`),
		}));
		const noteCandidates = [
			{ noteId: 'trend-0', term: 'term-0' },
			{ noteId: 'trend-0', term: 'term-0' },
			...Array.from({ length: 205 }, (_, index) => ({ noteId: `trend-${index + 1}`, term: `term-${index % 8}` })),
		];
		const trend: HanamiTrendComputationBundle = {
			computedAt: '2026-08-20T11:59:59.000Z',
			terms,
			noteCandidates,
		};
		const setup = createComputation({ scores, trend });

		const result = await setup.service.buildSourceBundle(buildInput(new AbortController().signal));

		expect(setup.featuredService.getGlobalNotesScoresWithCache).toHaveBeenCalledTimes(1);
		expect(setup.trendService.computeTrendBundle).toHaveBeenCalledTimes(1);
		const observedScores = setup.trendService.computeTrendBundle.mock.calls[0]![0];
		expect(observedScores).toBe(scores);
		expect(observedScores.size).toBe(512);
		expect(observedScores.has('')).toBe(true);
		expect(observedScores.has('not-finite')).toBe(true);
		expect(setup.safetyService.filterCommonEligibleNotes).toHaveBeenCalledTimes(1);
		expect(result.candidates.globalPopular).toHaveLength(200);
		expect(result.candidates.trending).toHaveLength(200);
		expect(result.candidates.exploration).toHaveLength(500);
		expect(result.trendSnapshot.terms).toHaveLength(30);
		expect(result.trendSnapshot.terms.every(term => term.representativeNoteIds.length === 5)).toBe(true);
		expect(setup.service.algorithmVersion).toBe(HANAMI_COMMON_ALGORITHM_VERSION);
		expect(result.capturedAt).toBe(GENERATED_AT);
		expect(result.sourceAsOf).toEqual({
			version: 1,
			capturedAt: GENERATED_AT,
			featuredAt: '2026-08-20T12:00:00.000Z',
			trendAt: '2026-08-20T11:59:59.000Z',
			axisConfigAt: '2026-08-20T12:00:00.000Z',
		});
		for (const timestamp of Object.values(result.sourceAsOf).filter((value): value is string => typeof value === 'string')) {
			expect(new Date(timestamp).toISOString()).toBe(timestamp);
		}
		for (const [axis, candidates] of Object.entries(result.candidates)) {
			expect(new Set(candidates.map(candidate => candidate.noteId)).size).toBe(candidates.length);
			for (const candidate of candidates) {
				expect(candidate.noteId).not.toBe('');
				expect(candidate.authorId).not.toBe('');
				expect(Number.isFinite(candidate.baseScore)).toBe(true);
				expect(Object.isFrozen(candidate.metadata)).toBe(true);
				if (axis === 'trending') expect(candidate.metadata).toEqual({ term: expect.any(String) });
			}
		}
	});

	test('shares bounded Featured headroom and applies global and exploration caps after safety', async () => {
		const scores = new Map<string, number>();
		for (let index = 0; index < 5200; index++) {
			scores.set(`featured-${String(index).padStart(4, '0')}`, 10_000 - index);
		}
		const unsafe = new Set([
			...Array.from({ length: 250 }, (_, index) => `featured-${String(index).padStart(4, '0')}`),
			...Array.from({ length: 600 }, (_, index) => `featured-${String(4999 - index).padStart(4, '0')}`),
		]);
		const setup = createComputation({
			scores,
			safeAuthors: noteIds => new Map(noteIds
				.filter(noteId => !unsafe.has(noteId))
				.map(noteId => [noteId, `author:${noteId}`])),
		});

		const result = await setup.service.buildSourceBundle(buildInput(new AbortController().signal));
		const observedScores = setup.trendService.computeTrendBundle.mock.calls[0]![0];
		const safetyIds = setup.safetyService.filterCommonEligibleNotes.mock.calls[0]![0];

		expect(observedScores).toBe(scores);
		expect(observedScores.size).toBe(5200);
		expect(observedScores.has('featured-4999')).toBe(true);
		expect(observedScores.has('featured-5000')).toBe(true);
		expect(safetyIds).toHaveLength(5000);
		expect(new Set(safetyIds).size).toBe(5000);
		expect(result.candidates.globalPopular).toHaveLength(200);
		expect(result.candidates.globalPopular[0]!.noteId).toBe('featured-0250');
		expect(result.candidates.globalPopular.at(-1)!.noteId).toBe('featured-0449');
		expect(result.candidates.exploration).toHaveLength(500);
		expect(result.candidates.exploration[0]!.noteId).toBe('featured-4399');
		expect(result.candidates.exploration.at(-1)!.noteId).toBe('featured-3900');
	});

	test('keeps trend-relevant scores outside common headroom while bounding common safety IDs', async () => {
		const scores = new Map<string, number>();
		for (let index = 0; index < 5000; index++) {
			scores.set(`headroom-${String(index).padStart(4, '0')}`, 10_000 - index);
		}
		scores.set('trend-outside-headroom', 0.5);
		const setup = createComputation({
			scores,
			trend: {
				computedAt: '2026-08-20T12:00:00.000Z',
				terms: [{
					term: 'outside-term',
					score: 2,
					distinctAuthors: 3,
					representativeNoteIds: ['trend-outside-headroom'],
				}],
				noteCandidates: [{ noteId: 'trend-outside-headroom', term: 'outside-term' }],
			},
		});

		const result = await setup.service.buildSourceBundle(buildInput(new AbortController().signal));
		const observedScores = setup.trendService.computeTrendBundle.mock.calls[0]![0];
		const safetyIds = setup.safetyService.filterCommonEligibleNotes.mock.calls[0]![0];

		expect(observedScores).toBe(scores);
		expect(observedScores.get('trend-outside-headroom')).toBe(0.5);
		expect(safetyIds).toHaveLength(5001);
		expect(new Set(safetyIds).size).toBe(5001);
		expect(safetyIds).toContain('trend-outside-headroom');
		expect(result.candidates.globalPopular.some(candidate => candidate.noteId === 'trend-outside-headroom')).toBe(false);
		expect(result.candidates.exploration.some(candidate => candidate.noteId === 'trend-outside-headroom')).toBe(false);
		expect(result.candidates.trending[0]!.noteId).toBe('trend-outside-headroom');
		expect(result.trendSnapshot.terms[0]!.representativeNoteIds).toEqual(['trend-outside-headroom']);
	});

	test('uses only available=false, honors popular only when a new key is absent, and snapshots disabled trending', async () => {
		const trend: HanamiTrendComputationBundle = {
			computedAt: '2026-08-20T12:00:00.000Z',
			terms: [{
				term: 'still-snapshotted',
				score: 10,
				distinctAuthors: 5,
				representativeNoteIds: ['representative'],
			}],
			noteCandidates: [{ noteId: 'trend-note', term: 'still-snapshotted' }],
		};
		const scores = new Map([['featured', 1]]);
		const explicit = createComputation({
			scores,
			trend,
			axisConfig: {
				popular: { available: false, default: false },
				globalPopular: { default: false },
				trending: { available: false },
				exploration: { available: true, default: false },
			},
		});
		const explicitResult = await explicit.service.buildSourceBundle(buildInput(new AbortController().signal));

		expect(explicitResult.enabledAxes).toEqual(['globalPopular', 'exploration']);
		expect(explicitResult.candidates.trending).toEqual([]);
		expect(explicitResult.trendSnapshot.terms.map(term => term.term)).toEqual(['still-snapshotted']);
		expect(explicit.trendService.computeTrendBundle).toHaveBeenCalledTimes(1);

		const legacy = createComputation({
			scores,
			trend,
			axisConfig: {
				popular: { available: false },
				trending: { default: false },
			},
		});
		const legacyResult = await legacy.service.buildSourceBundle(buildInput(new AbortController().signal));
		expect(legacyResult.enabledAxes).toEqual(['trending']);
		expect(legacyResult.candidates.globalPopular).toEqual([]);
		expect(legacyResult.candidates.exploration).toEqual([]);
		expect(legacyResult.candidates.trending).toHaveLength(1);
	});

	test('backfills unsafe snapshot representatives and trending candidates from ranked headroom', async () => {
		const representativeNoteIds = Array.from({ length: 10 }, (_, index) => `representative-${index}`);
		const noteCandidates = Array.from({ length: 205 }, (_, index) => ({
			noteId: `trend-${index}`,
			term: 'backfill-term',
		}));
		const unsafe = new Set([
			...representativeNoteIds.slice(0, 5),
			...noteCandidates.slice(0, 5).map((candidate) => candidate.noteId),
		]);
		const setup = createComputation({
			scores: new Map([['featured', 1]]),
			trend: {
				computedAt: '2026-08-20T12:00:00.000Z',
				terms: [{
					term: 'backfill-term',
					score: 10,
					distinctAuthors: 10,
					representativeNoteIds,
				}],
				noteCandidates,
			},
			safeAuthors: noteIds => new Map(noteIds
				.filter(noteId => !unsafe.has(noteId))
				.map(noteId => [noteId, `author:${noteId}`])),
		});

		const result = await setup.service.buildSourceBundle(buildInput(new AbortController().signal));

		expect(setup.trendService.computeTrendBundle).toHaveBeenCalledTimes(1);
		expect(setup.safetyService.filterCommonEligibleNotes).toHaveBeenCalledTimes(1);
		expect(result.trendSnapshot.terms[0]!.representativeNoteIds).toEqual(representativeNoteIds.slice(5, 10));
		expect(result.candidates.trending).toHaveLength(200);
		expect(result.candidates.trending[0]!.noteId).toBe('trend-5');
		expect(result.candidates.trending.at(-1)!.noteId).toBe('trend-204');
	});

	test('scans bounded canonical DB fallback headroom and applies final caps after safety', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(NOW);
		const dbQuery = jest.fn(async (sql: string, _parameters: unknown[]) => {
			if (sql.includes('WITH recent AS')) {
				return Array.from({ length: 400 }, (_, index) => ({
					noteId: `popular-${index}`,
					userId: `stale-popular-author-${index}`,
					reactionCount: 400 - index,
				}));
			}
			return Array.from({ length: 1100 }, (_, index) => ({
				noteId: `recent-${index}`,
				userId: `stale-recent-author-${index}`,
			}));
		});
		const setup = createComputation({
			dbQuery,
			safeAuthors: noteIds => new Map(noteIds
				.filter(noteId => {
					if (noteId.startsWith('popular-')) return Number(noteId.slice('popular-'.length)) >= 200;
					if (noteId.startsWith('recent-')) return Number(noteId.slice('recent-'.length)) >= 600;
					return true;
				})
				.map(noteId => [noteId, `current:${noteId}`])),
		});

		const result = await setup.service.buildSourceBundle(buildInput(new AbortController().signal));

		expect(dbQuery).toHaveBeenCalledTimes(2);
		expect(setup.idService.gen).toHaveBeenCalledTimes(2);
		expect(dbQuery.mock.calls[0][1]).toEqual(['fallback-since-id', 5000]);
		expect(dbQuery.mock.calls[1][1]).toEqual(['fallback-since-id', 5000]);
		for (const [sql] of dbQuery.mock.calls) {
			expect(sql).toContain('n."renoteId" IS NOT NULL');
			expect(sql).toContain('n."replyId" IS NULL');
			expect(sql).toContain('n.text IS NULL');
			expect(sql).toContain('n.cw IS NULL');
			expect(sql).toContain('n."hasPoll" = FALSE');
			expect(sql).toContain('COALESCE(cardinality(n."fileIds"), 0) = 0');
		}
		expect(result.candidates.globalPopular).toHaveLength(200);
		expect(result.candidates.globalPopular[0]!.noteId).toBe('popular-200');
		expect(result.candidates.globalPopular.at(-1)!.noteId).toBe('popular-399');
		expect(result.candidates.exploration).toHaveLength(500);
		expect(result.candidates.exploration[0]!.noteId).toBe('recent-600');
		expect(result.candidates.exploration.at(-1)!.noteId).toBe('recent-1099');
	});

	test('throws the exact abort reason before and after expensive source acquisition', async () => {
		const before = createComputation({ scores: new Map([['note', 1]]) });
		const beforeController = new AbortController();
		const beforeReason = new Error('before');
		beforeController.abort(beforeReason);
		await expect(before.service.buildSourceBundle(buildInput(beforeController.signal))).rejects.toBe(beforeReason);
		expect(before.featuredService.getGlobalNotesScoresWithCache).not.toHaveBeenCalled();

		const afterController = new AbortController();
		const afterReason = new Error('after Featured');
		const after = createComputation({ scores: new Map([['note', 1]]) });
		after.featuredService.getGlobalNotesScoresWithCache.mockImplementation(async () => {
			afterController.abort(afterReason);
			return after.scores;
		});
		await expect(after.service.buildSourceBundle(buildInput(afterController.signal))).rejects.toBe(afterReason);
		expect(after.trendService.computeTrendBundle).not.toHaveBeenCalled();
	});
});

type BracketsLike = {
	whereFactory: (builder: FakeWhereBuilder) => void;
};

class FakeWhereBuilder {
	public readonly conditions: string[] = [];

	protected add(condition: unknown): void {
		if (typeof condition === 'string') {
			this.conditions.push(condition);
			return;
		}
		if (condition != null && typeof condition === 'object' && 'whereFactory' in condition) {
			const nested = new FakeWhereBuilder();
			(condition as BracketsLike).whereFactory(nested);
			this.conditions.push(...nested.conditions);
		}
	}

	public where(condition: unknown): this {
		this.add(condition);
		return this;
	}

	public andWhere(condition: unknown): this {
		this.add(condition);
		return this;
	}

	public orWhere(condition: unknown): this {
		this.add(condition);
		return this;
	}
}

class FakeNoteQueryBuilder extends FakeWhereBuilder {
	public readonly joins: string[] = [];
	public parameters: Record<string, unknown> = {};

	constructor(private readonly rows: readonly { id: string; authorId: string }[]) {
		super();
	}

	public select(): this { return this; }
	public addSelect(): this { return this; }

	public override where(condition: unknown, parameters?: Record<string, unknown>): this {
		super.where(condition);
		this.parameters = { ...this.parameters, ...parameters };
		return this;
	}

	public innerJoin(relation: string, alias: string): this {
		this.joins.push(`${relation}:${alias}:inner`);
		return this;
	}

	public leftJoin(relation: string, alias: string): this {
		this.joins.push(`${relation}:${alias}:left`);
		return this;
	}

	public async getRawMany<T>(): Promise<T[]> {
		return [...this.rows] as T[];
	}
}

describe('HanamiForYouSafetyService common eligibility', () => {
	test('uses only static Note/author/target/host rules and canonical pure-renote semantics', async () => {
		const query = new FakeNoteQueryBuilder([{ id: 'eligible', authorId: 'author-1' }]);
		const notesRepository = { createQueryBuilder: jest.fn(() => query) };
		const queryService = {
			generateBlockedHostQueryForNote: jest.fn(),
			generateSuspendedUserQueryForNote: jest.fn(),
		};
		const profileFetch = jest.fn(async () => { throw new Error('personalized profile must not be read'); });
		const cacheService = {
			userProfileCache: { fetch: profileFetch },
			userMutingsCache: { fetch: jest.fn() },
			userBlockedCache: { fetch: jest.fn() },
			userBlockingCache: { fetch: jest.fn() },
		};
		const service = new HanamiForYouSafetyService(
			notesRepository as never,
			queryService as never,
			cacheService as never,
			{} as never,
		);

		const eligible = await service.filterCommonEligibleNotes(['eligible', 'eligible', '']);
		const sql = query.conditions.join('\n');

		expect(eligible).toEqual(new Map([['eligible', 'author-1']]));
		expect(query.parameters).toEqual({ noteIds: ['eligible'] });
		expect(query.joins).toEqual(expect.arrayContaining([
			'note.user:user:inner',
			'note.reply:reply:left',
			'note.renote:renote:left',
			'reply.user:replyUser:left',
			'renote.user:renoteUser:left',
		]));
		expect(sql).toContain('note.channelId IS NULL');
		expect(sql).toContain('note.visibility IN (\'public\', \'home\')');
		expect(sql).toContain('note."renoteId" IS NOT NULL');
		expect(sql).toContain('note."replyId" IS NULL');
		expect(sql).toContain('note.text IS NULL');
		expect(sql).toContain('note.cw IS NULL');
		expect(sql).toContain('cardinality(note."fileIds")');
		expect(sql).toContain('reply.id IS NOT NULL');
		expect(sql).toContain('reply.visibility IN (\'public\', \'home\')');
		expect(sql).toContain('replyUser.id IS NOT NULL');
		expect(sql).toContain('replyUser.isSuspended = FALSE');
		expect(sql).toContain('renote.id IS NOT NULL');
		expect(sql).toContain('renote.visibility IN (\'public\', \'home\')');
		expect(sql).toContain('renoteUser.id IS NOT NULL');
		expect(sql).toContain('renoteUser.isSuspended = FALSE');
		expect(queryService.generateBlockedHostQueryForNote).toHaveBeenCalledWith(query);
		expect(queryService.generateSuspendedUserQueryForNote).toHaveBeenCalledWith(query);
		expect(profileFetch).not.toHaveBeenCalled();
		expect(cacheService.userMutingsCache.fetch).not.toHaveBeenCalled();
	});
});
