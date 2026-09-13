/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import {
	HANAMI_FOR_YOU_AXES,
	type HanamiAxis,
	type HanamiAxisLevel,
	type HanamiConfidence,
} from '@/core/hanami/HanamiForYouInterleave.js';
import {
	HanamiPersonalFeedComputationService,
	HANAMI_PERSONAL_FEED_ALGORITHM_VERSION,
	hanamiHasUnhealablePersonalSeedHead,
} from '@/core/hanami/HanamiPersonalFeedComputationService.js';
import {
	HanamiForYouService,
	type HanamiPersonalFeedCandidatePreparation,
	type HanamiPersonalFeedGenerationContext,
} from '@/core/hanami/HanamiForYouService.js';
import { HanamiUserRecommendationService } from '@/core/hanami/HanamiUserRecommendationService.js';
import type { HanamiCommonGenerationReadContext, HanamiPersistedCommonCandidate } from '@/core/hanami/HanamiCommonGenerationContracts.js';
import {
	HanamiInvalidPersonalSeedError,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import type {
	HanamiPersonalFeedCandidate,
	HanamiPersonalFeedComputationInput,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { createHanamiExactTextFingerprint } from '@/core/hanami/HanamiForYouTextNormalization.js';

const generatedAt = '2026-08-20T10:00:00.000Z';
const databaseDeadlineAt = '2026-08-20T10:00:45.000Z';

function input(signal = new AbortController().signal): HanamiPersonalFeedComputationInput {
	return {
		userId: 'user-1',
		epochId: 'epoch-1',
		latestReadyBatchId: null,
		baseCommonGenerationId: 'common-generation-pinned',
		generatedAt,
		databaseDeadlineAt,
		signal,
	};
}

function generationInput(signal = new AbortController().signal): HanamiPersonalFeedGenerationContext {
	return { ...input(signal), queryRunner: createQueryRunner() as never };
}

function candidate(
	axis: HanamiAxis,
	noteId: string,
	authorId = `author-${noteId}`,
	overrides: Partial<HanamiPersonalFeedCandidate> = {},
): HanamiPersonalFeedCandidate {
	return {
		noteId,
		authorId,
		axis,
		origin: axis === 'globalPopular' || axis === 'trending' || axis === 'exploration'
			? 'commonCandidate'
			: 'personalCandidate',
		score: 1,
		...overrides,
	};
}

function candidates(axis: HanamiAxis, count: number, authorOf: (index: number) => string = index => `${axis}-author-${index}`): HanamiPersonalFeedCandidate[] {
	return Array.from({ length: count }, (_, index) => candidate(axis, `${axis}-note-${index}`, authorOf(index), { score: count - index }));
}

function commonRow(axis: 'globalPopular' | 'trending' | 'exploration', noteId: string, metadata: Readonly<Record<string, unknown>> = {}): HanamiPersistedCommonCandidate {
	return { axis, rank: '9007199254740993', noteId, baseScore: 1, metadata };
}

function allLevels(level: HanamiAxisLevel = 'normal'): ReadonlyMap<HanamiAxis, HanamiAxisLevel> {
	return new Map(HANAMI_FOR_YOU_AXES.map(axis => [axis, level]));
}

function createQueryRunner(queryImplementation?: (sql: string, parameters?: unknown[]) => Promise<unknown[]>) {
	const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
		if (queryImplementation != null) return await queryImplementation(sql, parameters);
		if (sql.includes("set_config('statement_timeout'")) return [{}];
		if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
		return [];
	});
	const queryRunner = {
		query,
		connect: jest.fn(async () => undefined),
		startTransaction: jest.fn(async () => { queryRunner.isTransactionActive = true; }),
		commitTransaction: jest.fn(async () => { queryRunner.isTransactionActive = false; }),
		rollbackTransaction: jest.fn(async () => { queryRunner.isTransactionActive = false; }),
		release: jest.fn(async () => { queryRunner.isReleased = true; }),
		isTransactionActive: false,
		isReleased: false,
		manager: { getRepository: jest.fn() },
	};
	return queryRunner;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	throw new Error('condition was not reached');
}

function createComputation(options: {
	confidence?: HanamiConfidence;
	axisLevels?: ReadonlyMap<HanamiAxis, HanamiAxisLevel>;
	candidates?: readonly HanamiPersonalFeedCandidate[];
	commonRows?: readonly HanamiPersistedCommonCandidate[];
	gather?: (input: HanamiPersonalFeedGenerationContext, common: readonly HanamiPersonalFeedCandidate[]) => Promise<HanamiPersonalFeedCandidatePreparation>;
	filterCommon?: (noteIds: readonly string[], signal: AbortSignal, runner?: unknown) => Promise<ReadonlyMap<string, string>>;
	queryRunner?: ReturnType<typeof createQueryRunner>;
} = {}) {
	const commonRows = options.commonRows ?? [];
	const queryRunner = options.queryRunner ?? createQueryRunner();
	const driverQuery = queryRunner.query;
	const db = { createQueryRunner: jest.fn(() => queryRunner) };
	const commonGenerationRead = {
		loadReadyCommonCandidates: jest.fn(async (_generationId: string, _context?: HanamiCommonGenerationReadContext) => commonRows),
		getLatestReadyCommonHead: jest.fn(),
	};
	const defaultFilterCommon = async (noteIds: readonly string[], signal: AbortSignal, runner?: unknown): Promise<ReadonlyMap<string, string>> => {
		void signal;
		void runner;
		return new Map(noteIds.map(noteId => [noteId, `author-${noteId}`]));
	};
	const filterCommonEligibleNotes = jest.fn(options.filterCommon ?? defaultFilterCommon);
	const filterPersonalEligibleCandidates = jest.fn(async ({ candidates: values }: { candidates: readonly HanamiPersonalFeedCandidate[]; signal: AbortSignal; queryRunner?: unknown }) => values);
	const filterAndPack = jest.fn();
	const safety = { filterCommonEligibleNotes, filterPersonalEligibleCandidates, filterAndPack };
	const defaultGather = async (_computationInput: HanamiPersonalFeedGenerationContext, common: readonly HanamiPersonalFeedCandidate[]): Promise<HanamiPersonalFeedCandidatePreparation> => ({
		confidence: options.confidence ?? 'high',
		axisLevels: options.axisLevels ?? allLevels(),
		candidates: [...common, ...(options.candidates ?? [])],
	});
	const gatherPersonalFeedCandidates = jest.fn(options.gather ?? defaultGather);
	const rankPersonalFeedCandidates = jest.fn(async (_computationInput: HanamiPersonalFeedGenerationContext, _preparation: HanamiPersonalFeedCandidatePreparation, safe: readonly HanamiPersonalFeedCandidate[]) => safe);
	const getForYouPage = jest.fn();
	const forYou = { gatherPersonalFeedCandidates, rankPersonalFeedCandidates, getForYouPage };
	const buildReasonMetadata = jest.fn((value: Pick<HanamiPersonalFeedCandidate, 'term' | 'clusterId' | 'bucket'>, fallbackOverflow = false) => Object.freeze({
		version: 1 as const,
		...(value.term !== undefined ? { term: value.term } : {}),
		...(value.clusterId !== undefined ? { clusterId: value.clusterId } : {}),
		...(value.bucket !== undefined ? { bucket: value.bucket } : {}),
		...(fallbackOverflow ? { fallbackOverflow: true as const } : {}),
	}));
	const recordServedEvents = jest.fn();
	const provenance = { buildReasonMetadata, recordServedEvents };
	return {
		service: new HanamiPersonalFeedComputationService(
			db as never,
			commonGenerationRead as never,
			forYou as never,
			safety as never,
			provenance as never,
		),
		commonGenerationRead,
		forYou,
		safety,
		provenance,
		db,
		queryRunner,
		driverQuery,
	};
}

function firstSegmentSources(result: Awaited<ReturnType<HanamiPersonalFeedComputationService['computePersonalFeed']>>): HanamiAxis[] {
	return result.items.slice(0, result.segmentLengths[0] ?? 0).map(item => item.source);
}

const CONFIDENCE_CASES: ReadonlyArray<readonly [HanamiConfidence, readonly HanamiAxis[]]> = [
	['high', ['globalPopular', 'neighborTrending', 'reactionSimilar', 'trending', 'catchup', 'fof', 'exploration']],
	['low', ['globalPopular', 'neighborTrending', 'trending', 'reactionSimilar', 'catchup', 'fof', 'exploration']],
	['none', ['globalPopular', 'trending', 'fof', 'exploration']],
];

describe('Phase 4 workstream A personal feed computation', () => {
	test('pins common reads and maps all seven axes to authoritative origins and reason metadata', async () => {
		const commonRows = [
			commonRow('globalPopular', 'global'),
			commonRow('trending', 'trend', { term: 'typescript' }),
			...Array.from({ length: 20 }, (_, index) => commonRow('exploration', index === 0 ? 'explore' : `explore-${index}`)),
		];
		const personal = [
			candidate('neighborTrending', 'neighbor'),
			candidate('reactionSimilar', 'reaction', 'reaction-author', { clusterId: 7, bucket: 'cluster' }),
			candidate('catchup', 'catchup'),
			candidate('fof', 'fof'),
			candidate('neighborTrending', 'global', 'author-global'),
		];
		const fixture = createComputation({ commonRows, candidates: personal, confidence: 'high' });

		const result = await fixture.service.computePersonalFeed({ ...input(), latestReadyBatchId: 'head' });

		expect(fixture.service.algorithmVersion).toBe(HANAMI_PERSONAL_FEED_ALGORITHM_VERSION);
		expect(fixture.commonGenerationRead.loadReadyCommonCandidates).toHaveBeenCalledWith('common-generation-pinned', {
			queryRunner: fixture.queryRunner,
			signal: expect.any(AbortSignal),
			databaseDeadlineAt,
		});
		expect(fixture.queryRunner.startTransaction.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.commonGenerationRead.loadReadyCommonCandidates.mock.invocationCallOrder[0]!,
		);
		expect(fixture.commonGenerationRead.loadReadyCommonCandidates.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.queryRunner.commitTransaction.mock.invocationCallOrder[0]!,
		);
		expect(fixture.commonGenerationRead.getLatestReadyCommonHead).not.toHaveBeenCalled();
		expect(fixture.forYou.gatherPersonalFeedCandidates.mock.calls[0]![1]).toEqual(expect.arrayContaining([
			expect.objectContaining({ noteId: 'global', axis: 'globalPopular', origin: 'commonCandidate', authorId: 'author-global' }),
			expect.objectContaining({ noteId: 'trend', axis: 'trending', origin: 'commonCandidate', term: 'typescript' }),
			expect.objectContaining({ noteId: 'explore', axis: 'exploration', origin: 'commonCandidate' }),
		]));
		expect(new Set(result.items.flatMap(item => item.sources))).toEqual(new Set(HANAMI_FOR_YOU_AXES));
		expect(result.items.find(item => item.noteId === 'global')).toMatchObject({
			source: 'globalPopular',
			sources: ['globalPopular', 'neighborTrending'],
			origin: 'commonCandidate',
		});
		expect(result.items.find(item => item.noteId === 'trend')?.reasonMetadata).toEqual({ version: 1, term: 'typescript' });
		expect(result.items.find(item => item.noteId === 'reaction')?.reasonMetadata).toEqual({ version: 1, clusterId: 7, bucket: 'cluster' });
		for (const item of result.items) {
			const common = item.source === 'globalPopular' || item.source === 'trending' || item.source === 'exploration';
			expect(item.origin).toBe(common ? 'commonCandidate' : 'personalCandidate');
		}
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.items)).toBe(true);
		expect(Object.isFrozen(result.items[0])).toBe(true);
		expect(Object.isFrozen(result.items[0]!.sources)).toBe(true);
		expect(Object.isFrozen(result.items[0]!.reasonMetadata)).toBe(true);
	});

	test('accepts only the bounded common acquisition envelope', async () => {
		const commonRows = [
			...Array.from({ length: 500 }, (_, i) => commonRow('globalPopular', `global-${i}`)),
			...Array.from({ length: 200 }, (_, i) => commonRow('trending', `trend-${i}`)),
			...Array.from({ length: 500 }, (_, i) => commonRow('exploration', `explore-${i}`)),
		];
		const fixture = createComputation({ commonRows });

		await fixture.service.computePersonalFeed(input());

		expect(fixture.safety.filterCommonEligibleNotes.mock.calls[0]![0]).toHaveLength(1200);
		const overLimit = createComputation({
			commonRows: Array.from({ length: 501 }, (_, i) => commonRow('globalPopular', `global-${i}`)),
		});
		await expect(overLimit.service.computePersonalFeed(input())).rejects.toThrow('globalPopular candidate read exceeded 500 rows');
		expect(overLimit.db.createQueryRunner).toHaveBeenCalledTimes(1);
		expect(overLimit.safety.filterCommonEligibleNotes).not.toHaveBeenCalled();
	});

	test.each(CONFIDENCE_CASES)('uses the current %s confidence axis order', async (confidence, expected) => {
		const fixture = createComputation({
			confidence,
			candidates: HANAMI_FOR_YOU_AXES.flatMap(axis => axis === 'exploration'
				? Array.from({ length: 20 }, (_, index) => candidate(axis, `note-${axis}-${index}`))
				: [candidate(axis, `note-${axis}`)]),
		});
		const result = await fixture.service.computePersonalFeed(input());
		expect(firstSegmentSources(result).slice(0, expected.length)).toEqual(expected);
	});

	test('honors off/low/normal/high settings and preserves overflow reason metadata', async () => {
		const counts: number[] = [];
		for (const level of ['off', 'low', 'normal', 'high'] as const) {
			const fixture = createComputation({
				confidence: 'none',
				axisLevels: new Map<HanamiAxis, HanamiAxisLevel>([
					['globalPopular', 'normal'],
					['trending', level],
				]),
				candidates: [...candidates('globalPopular', 100), ...candidates('trending', 100)],
			});
			const result = await fixture.service.computePersonalFeed(input());
			const first = result.items.slice(0, result.segmentLengths[0]);
			counts.push(first.filter(item => item.source === 'trending').length);
			expect(first.some(item => item.source === 'trending')).toBe(level !== 'off');
		}
		expect(counts[0]).toBe(0);
		expect(counts[1]).toBeLessThan(counts[2]);
		expect(counts[2]).toBeLessThan(counts[3]);

		const overflow = createComputation({
			confidence: 'high',
			axisLevels: allLevels(),
			candidates: candidates('catchup', 30),
		});
		const overflowResult = await overflow.service.computePersonalFeed(input());
		const firstOverflowSegment = overflowResult.items.slice(0, overflowResult.segmentLengths[0]);
		expect(firstOverflowSegment.slice(0, 3).every(item => item.reasonMetadata.fallbackOverflow === undefined)).toBe(true);
		expect(firstOverflowSegment.slice(3).every(item => item.reasonMetadata.fallbackOverflow === true)).toBe(true);
	});

	test('restarts quota and cursor state for seven 30-item segments and keeps discarded headroom available', async () => {
		const fixture = createComputation({
			confidence: 'high',
			candidates: HANAMI_FOR_YOU_AXES.flatMap(axis => candidates(axis, 50)),
		});
		const result = await fixture.service.computePersonalFeed(input());

		expect(result.items).toHaveLength(210);
		expect(result.segmentLengths).toEqual([30, 30, 30, 30, 30, 30, 30]);
		expect(new Set(result.items.map(item => item.noteId)).size).toBe(210);
		expect(result.segmentLengths.reduce((sum, length) => sum + length, 0)).toBe(result.items.length);
	});

	test('deduplicates Notes across segments while retaining sliding author constraints', async () => {
		const oneAuthor = createComputation({
			confidence: 'none',
			axisLevels: new Map([['globalPopular', 'normal']]),
			candidates: candidates('globalPopular', 20, () => 'same-author'),
		});
		const authorResult = await oneAuthor.service.computePersonalFeed(input());
		expect(authorResult.segmentLengths).toEqual([1]);
		expect(new Set(authorResult.items.map(item => item.noteId)).size).toBe(1);

		const duplicates = createComputation({
			confidence: 'high',
			candidates: HANAMI_FOR_YOU_AXES.flatMap(axis => [candidate(axis, 'shared-note', 'shared-author'), ...candidates(axis, 40)]),
		});
		const duplicateResult = await duplicates.service.computePersonalFeed(input());
		expect(duplicateResult.items.filter(item => item.noteId === 'shared-note')).toHaveLength(1);
		expect(new Set(duplicateResult.items.map(item => item.noteId)).size).toBe(duplicateResult.items.length);
	});

	test('caps at 210 and returns a short final segment on clean exhaustion', async () => {
		const full = createComputation({
			confidence: 'none',
			axisLevels: new Map([['globalPopular', 'normal']]),
			candidates: candidates('globalPopular', 220),
		});
		await expect(full.service.computePersonalFeed(input())).resolves.toMatchObject({
			segmentLengths: [30, 30, 30, 30, 30, 30, 30],
		});

		const short = createComputation({
			confidence: 'none',
			axisLevels: new Map([['globalPopular', 'normal']]),
			candidates: candidates('globalPopular', 35),
		});
		const shortResult = await short.service.computePersonalFeed(input());
		expect(shortResult.items).toHaveLength(35);
		expect(shortResult.segmentLengths).toEqual([30, 5]);
	});

	test('keeps a deterministic <=5% exploration pool with exactly twenty eligible authors', async () => {
		const fixture = createComputation();
		const diversity = fixture.service as unknown as { finalExplorationDiversity(values: readonly HanamiPersonalFeedCandidate[]): readonly HanamiPersonalFeedCandidate[] };
		const exploration = Array.from({ length: 20 }, (_, index) => candidate('exploration', `explore-${index}`, `author-${index}`));
		const result = diversity.finalExplorationDiversity(exploration);
		const counts = new Map<string, number>();
		for (const value of result) counts.set(value.authorId, (counts.get(value.authorId) ?? 0) + 1);
		expect(result).toHaveLength(20);
		expect(Math.max(...counts.values()) / result.length).toBeLessThanOrEqual(0.05);
	});

	test('keeps complete ranked exploration rounds deterministically', async () => {
		const fixture = createComputation();
		const diversity = fixture.service as unknown as { finalExplorationDiversity(values: readonly HanamiPersonalFeedCandidate[]): readonly HanamiPersonalFeedCandidate[] };
		const exploration = Array.from({ length: 20 }, (_, author) => [
			candidate('exploration', `author-${author}-high`, `author-${author}`, { score: 2 }),
			candidate('exploration', `author-${author}-low`, `author-${author}`, { score: 1 }),
		]).flat();
		const result = diversity.finalExplorationDiversity(exploration);
		expect(result.map(value => value.noteId)).toEqual([
			...Array.from({ length: 20 }, (_, index) => `author-${index}-high`),
			...Array.from({ length: 20 }, (_, index) => `author-${index}-low`),
		]);
		expect(Math.max(...Array.from(new Set(result.map(value => value.authorId))).map(author => result.filter(value => value.authorId === author).length)) / result.length).toBeLessThanOrEqual(0.05);
	});

	test('applies safety then served and seven-day seen exclusions before exploration diversity', async () => {
		const exploration = Array.from({ length: 21 }, (_, index) => candidate('exploration', `explore-${index}`, `author-${index}`));
		const global = candidate('globalPopular', 'global-survives', 'global-author');
		const queryRunner = createQueryRunner(async (sql) => {
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
			if (sql.includes("ev.\"eventType\" = 'served'")) return [{ note_id: 'explore-0' }];
			if (sql.includes('FROM "hanami_recommendation_event"')) return [{ note_id: 'explore-1' }];
			return [];
		});
		const fixture = createComputation({
			confidence: 'none',
			axisLevels: new Map([['globalPopular', 'normal'], ['exploration', 'normal']]),
			candidates: [global, ...exploration],
			queryRunner,
		});

		const result = await fixture.service.computePersonalFeed(input());

		const epochQueryOrder = fixture.driverQuery.mock.invocationCallOrder[
			fixture.driverQuery.mock.calls.findIndex(call => String(call[0]).includes("ev.\"eventType\" = 'served'"))
		]!;
		expect(fixture.safety.filterPersonalEligibleCandidates.mock.invocationCallOrder[0]).toBeLessThan(epochQueryOrder);
		expect(result.items.some(item => item.noteId.startsWith('explore-'))).toBe(false);
		expect(result.items.some(item => item.noteId === 'global-survives')).toBe(true);
	});

	test('retains a persisted-but-unserved candidate while excluding an actually served candidate', async () => {
		const queryRunner = createQueryRunner(async (sql, parameters) => {
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
			if (sql.includes("ev.\"eventType\" = 'served'")) return [{ note_id: 'actually-served' }];
			if (sql.includes('FROM "hanami_recommendation_event"')) return [];
			if (sql.includes('FROM note n JOIN "user" u')) return (parameters?.[1] as string[]).map(noteId => ({ note_id: noteId, author_id: `author-${noteId}`, text: noteId, is_bot: false, relationship_class: 'unknown' }));
			return [];
		});
		const fixture = createComputation({ confidence: 'none', axisLevels: new Map([['globalPopular', 'normal']]), candidates: [
			// This candidate is conceptually already present in hanami_user_feed_entry,
			// but no served event is returned for it.
			candidate('globalPopular', 'persisted-unserved'),
			candidate('globalPopular', 'actually-served'),
		], queryRunner });
		const result = await fixture.service.computePersonalFeed({ ...input(), latestReadyBatchId: 'latest-batch' });

		expect(result.items.map(item => item.noteId)).toContain('persisted-unserved');
		expect(result.items.map(item => item.noteId)).not.toContain('actually-served');
		const entryExclusionQueries = fixture.driverQuery.mock.calls.filter(call => {
			const sql = String(call[0]);
			return sql.includes('FROM "hanami_user_feed_entry"') && !sql.includes('ORDER BY e."sequence" DESC LIMIT 210');
		});
		expect(entryExclusionQueries).toEqual([]);
		const seedQuery = fixture.driverQuery.mock.calls.find(call => String(call[0]).includes('ORDER BY e."sequence" DESC LIMIT 210'));
		expect(seedQuery?.[0]).toContain('AND e."batchId" = $3');
		expect(seedQuery?.[1]).toEqual(['user-1', 'epoch-1', 'latest-batch']);

		const nullSeedFixture = createComputation({ candidates: [candidate('globalPopular', 'persisted-unserved')] });
		await nullSeedFixture.service.computePersonalFeed(input());
		expect(nullSeedFixture.driverQuery.mock.calls.some(call => String(call[0]).includes('ORDER BY e."sequence" DESC LIMIT 210'))).toBe(false);
	});

	test('omits insufficient exploration without removing non-exploration candidates', async () => {
		const fixture = createComputation({
			confidence: 'none',
			axisLevels: new Map([['globalPopular', 'normal'], ['exploration', 'normal']]),
			candidates: [candidate('globalPopular', 'global-survives'), ...Array.from({ length: 19 }, (_, index) => candidate('exploration', `explore-${index}`, `author-${index}`))],
		});
		const result = await fixture.service.computePersonalFeed({ ...input(), latestReadyBatchId: 'head' });
		expect(result.items.map(item => item.noteId)).toContain('global-survives');
		expect(result.items.some(item => item.source === 'exploration')).toBe(false);
	});

	test('heals a legacy old-head unknown deficit before returning a personal prefix', async () => {
		const candidatesForRun = Array.from({ length: 15 }, (_, index) => candidate('globalPopular', `new-unknown-${index}`, `new-author-${index}`));
		const seed = [
			...Array.from({ length: 14 }, (_, index) => ({ note_id: `old-unknown-${index}`, author_id: `old-unknown-author-${index}`, text: `old unknown ${index}`, is_bot: false, relationship_class: 'unknown' as const })),
			...Array.from({ length: 12 }, (_, index) => ({ note_id: `old-known-${index}`, author_id: `old-known-author-${index}`, text: `old known ${index}`, is_bot: false, relationship_class: 'known' as const })),
			...Array.from({ length: 3 }, (_, index) => ({ note_id: `old-neutral-${index}`, author_id: `old-neutral-author-${index}`, text: `old neutral ${index}`, is_bot: false, relationship_class: undefined })),
		];
		const queryRunner = createQueryRunner(async (sql, parameters) => {
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
			if (sql.includes('ORDER BY e."sequence" DESC LIMIT 210')) return seed;
			if (sql.includes('FROM note n JOIN "user" u')) return (parameters?.[1] as string[]).map(noteId => ({
				note_id: noteId, author_id: `resolved-${noteId}`, text: noteId, is_bot: false, relationship_class: 'unknown',
			}));
			return [];
		});
		const fixture = createComputation({
			confidence: 'none',
			axisLevels: new Map([['globalPopular', 'normal']]),
			candidates: candidatesForRun,
			queryRunner,
		});

		const result = await fixture.service.computePersonalFeed({ ...input(), latestReadyBatchId: 'head' });

		expect(result.items).toHaveLength(15);
		expect(result.items.every(item => item.noteId.startsWith('new-unknown-'))).toBe(true);
		expect(fixture.driverQuery.mock.calls.some(call => String(call[0]).includes('ORDER BY e."sequence" DESC LIMIT 210'))).toBe(true);
	});

	test('throws the typed seed error only for mathematically unhealable old heads', async () => {
		const makeSeed = (kind: 'exact' | 'combined') => Array.from({ length: 29 }, (_, index) => ({
			note_id: `old-${kind}-${index}`, author_id: `old-author-${index}`, text: kind === 'exact' && index < 2 ? 'duplicate' : `old ${index}`,
			is_bot: false, relationship_class: kind === 'combined' && index < 7 ? 'directFollow' as const : kind === 'combined' && index < 13 ? 'known' as const : 'unknown' as const,
		}));
		for (const kind of ['exact', 'combined'] as const) {
			const queryRunner = createQueryRunner(async (sql, parameters) => {
				if (sql.includes("set_config('statement_timeout'")) return [{}];
				if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
				if (sql.includes('ORDER BY e."sequence" DESC LIMIT 210')) return makeSeed(kind);
				if (sql.includes('FROM note n JOIN "user" u')) return (parameters?.[1] as string[]).map(noteId => ({ note_id: noteId, author_id: `author-${noteId}`, text: noteId, is_bot: false, relationship_class: 'unknown' }));
				return [];
			});
			const fixture = createComputation({ candidates: Array.from({ length: 15 }, (_, index) => candidate('globalPopular', `new-${kind}-${index}`)), queryRunner });
			await expect(fixture.service.computePersonalFeed({ ...input(), latestReadyBatchId: 'head' })).rejects.toBeInstanceOf(HanamiInvalidPersonalSeedError);
		}
	});

	test('classifies only active unknown-floor and upper-cap seed heads as unhealable', () => {
		const base = Array.from({ length: 29 }, (_, index) => ({ noteId: `old-${index}`, userId: `author-${index}`, score: 0, relationshipClass: index < 13 ? 'unknown' as const : undefined }));
		expect(hanamiHasUnhealablePersonalSeedHead(base, true)).toBe(true);
		expect(hanamiHasUnhealablePersonalSeedHead(base, false)).toBe(false);
		const fourteenUnknown = base.map((item, index) => ({ ...item, relationshipClass: index < 14 ? 'unknown' as const : undefined }));
		expect(hanamiHasUnhealablePersonalSeedHead(fourteenUnknown, true)).toBe(false);
		expect(hanamiHasUnhealablePersonalSeedHead([], true)).toBe(false);
	});

	test('returns an ordinary empty result when candidates are exhausted', async () => {
		const fixture = createComputation({ candidates: [] });
		await expect(fixture.service.computePersonalFeed(input())).resolves.toMatchObject({ items: [], segmentLengths: [] });
	});

	test('propagates normalized transient fingerprints through computePersonalFeed without persisting them', async () => {
		const global = Array.from({ length: 35 }, (_, index) => candidate('globalPopular', `global-${index}`, `author-global-${index}`));
		const candidatesForRun = [
			candidate('globalPopular', 'exact-fullwidth-mfm', 'author-exact-a', { exactTextFingerprint: createHanamiExactTextFingerprint('$[x2 Ｈｅｌｌｏ\nworld!\u200b]') }),
			candidate('trending', 'exact-ascii-mfm', 'author-exact-b', { exactTextFingerprint: createHanamiExactTextFingerprint('Hello world!') }),
			...global,
		];
		const queryRunner = createQueryRunner(async (sql, parameters) => {
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
			if (sql.includes('COALESCE(n.text') && sql.includes('WHERE n.id = ANY($2::varchar[])')) {
				return (parameters?.[1] as string[]).map(noteId => ({
					note_id: noteId, author_id: `resolved-${noteId}`, is_bot: false, relationship_class: 'unknown',
					text: noteId === 'exact-fullwidth-mfm' ? '$[x2 Ｈｅｌｌｏ\nworld!\u200b]' : noteId === 'exact-ascii-mfm' ? 'Hello world!' : noteId,
				}));
			}
			return [];
		});
		const fixture = createComputation({ confidence: 'none', candidates: candidatesForRun, queryRunner });
		expect(createHanamiExactTextFingerprint('$[x2 Ｈｅｌｌｏ\nworld!\u200b]')).toBe(createHanamiExactTextFingerprint('Hello world!'));

		const result = await fixture.service.computePersonalFeed(input());

		const detailQuery = fixture.driverQuery.mock.calls.find(call => String(call[0]).includes('FROM note n JOIN "user" u'));
		expect(detailQuery).toBeDefined();
		expect(detailQuery?.[1]?.[1]).toEqual(expect.arrayContaining(['exact-fullwidth-mfm', 'exact-ascii-mfm']));
		expect(result.segmentLengths.length).toBeGreaterThan(1);
		expect(fixture.forYou.rankPersonalFeedCandidates.mock.calls[0]![2]).toEqual(expect.arrayContaining([
			expect.objectContaining({ noteId: 'exact-fullwidth-mfm', exactTextFingerprint: expect.any(String) }),
			expect.objectContaining({ noteId: 'exact-ascii-mfm', exactTextFingerprint: expect.any(String) }),
		]));
		expect(result.items.every(item => !JSON.stringify(item.reasonMetadata).includes('exact-mfm-nfkc-v1'))).toBe(true);
		expect(result.items.every(item => !JSON.stringify(item.reasonMetadata).includes('fingerprint'))).toBe(true);
	});

	test('propagates one signal and deadline without packing, serving writes, or legacy page execution', async () => {
		const controller = new AbortController();
		const computationInput = input(controller.signal);
		const fixture = createComputation({ candidates: [candidate('globalPopular', 'note')] });

		await fixture.service.computePersonalFeed(computationInput);

		expect(fixture.commonGenerationRead.loadReadyCommonCandidates.mock.calls[0]![1]).toEqual({
			queryRunner: fixture.queryRunner,
			signal: controller.signal,
			databaseDeadlineAt,
		});
		expect(fixture.safety.filterCommonEligibleNotes.mock.calls[0]![1]).toBe(controller.signal);
		expect(fixture.safety.filterPersonalEligibleCandidates.mock.calls[0]![0].signal).toBe(controller.signal);
		expect(fixture.forYou.gatherPersonalFeedCandidates.mock.calls[0]![0].signal).toBe(computationInput.signal);
		expect(fixture.forYou.gatherPersonalFeedCandidates.mock.calls[0]![0].databaseDeadlineAt).toBe(computationInput.databaseDeadlineAt);
		expect(fixture.forYou.gatherPersonalFeedCandidates.mock.calls[0]![0].queryRunner).toBe(fixture.queryRunner);
		expect(fixture.safety.filterCommonEligibleNotes.mock.calls[0]![2]).toBe(fixture.queryRunner);
		expect(fixture.safety.filterPersonalEligibleCandidates.mock.calls[0]![0].queryRunner).toBe(fixture.queryRunner);
		expect(fixture.forYou.rankPersonalFeedCandidates.mock.calls[0]![0].databaseDeadlineAt).toBe(databaseDeadlineAt);
		expect(fixture.forYou.gatherPersonalFeedCandidates).toHaveBeenCalledTimes(1);
		expect(fixture.forYou.rankPersonalFeedCandidates).toHaveBeenCalledTimes(1);
		expect(fixture.forYou.rankPersonalFeedCandidates.mock.calls[0]![2].map(value => value.noteId)).toEqual(['note']);
		expect(fixture.db.createQueryRunner).toHaveBeenCalledTimes(1);
		expect(fixture.queryRunner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
		expect(fixture.driverQuery.mock.calls[0]![0]).toBe('SET TRANSACTION READ ONLY');
		expect(fixture.driverQuery.mock.calls[1]![0]).toContain("set_config('statement_timeout'");
		expect(fixture.driverQuery.mock.calls[1]![1]).toEqual([databaseDeadlineAt, '5000']);
		expect(fixture.driverQuery.mock.calls.at(-1)?.[0]).toContain('clock_timestamp() < $1::timestamptz');
		expect(fixture.driverQuery.mock.calls.filter(call => String(call[0]).includes("set_config('statement_timeout'"))).toHaveLength(5);
		expect(fixture.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(fixture.queryRunner.release).toHaveBeenCalledTimes(1);
		expect(fixture.safety.filterAndPack).not.toHaveBeenCalled();
		expect(fixture.forYou.getForYouPage).not.toHaveBeenCalled();
		expect(fixture.provenance.recordServedEvents).not.toHaveBeenCalled();

		const abortReason = new Error('lease lost');
		fixture.commonGenerationRead.loadReadyCommonCandidates.mockImplementationOnce(async () => {
			controller.abort(abortReason);
			return [];
		});
		await expect(fixture.service.computePersonalFeed(computationInput)).rejects.toBe(abortReason);
		expect(fixture.safety.filterCommonEligibleNotes).toHaveBeenCalledTimes(1);
	});

	test('rejects promptly on abort and cleans up only after a pending driver query settles', async () => {
		let resolveQuery!: (rows: unknown[]) => void;
		const pendingQuery = new Promise<unknown[]>(resolve => { resolveQuery = resolve; });
		const queryRunner = createQueryRunner(async sql => {
			if (sql === 'SELECT pending_generation_query') return await pendingQuery;
			if (sql.includes("set_config('statement_timeout'")) return [{}];
			if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
			return [];
		});
		const driverQuery = queryRunner.query;
		const controller = new AbortController();
		const abortReason = new Error('generation lease expired');
		const fixture = createComputation({
			commonRows: [commonRow('globalPopular', 'global')],
			queryRunner,
			filterCommon: async (noteIds, _signal, runner) => {
				await (runner as typeof queryRunner).query('SELECT pending_generation_query');
				return new Map(noteIds.map(noteId => [noteId, `author-${noteId}`]));
			},
		});

		const computation = fixture.service.computePersonalFeed(input(controller.signal));
		await waitUntil(() => driverQuery.mock.calls.some(call => call[0] === 'SELECT pending_generation_query'));
		controller.abort(abortReason);
		await expect(computation).rejects.toBe(abortReason);
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).not.toHaveBeenCalled();

		resolveQuery([]);
		await waitUntil(() => queryRunner.release.mock.calls.length === 1);
		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
	});

	test('observes an aborted connect and releases the runner after the driver settles', async () => {
		let resolveConnect!: () => void;
		const pendingConnect = new Promise<undefined>(resolve => { resolveConnect = () => resolve(undefined); });
		const queryRunner = createQueryRunner();
		queryRunner.connect.mockImplementationOnce(async () => await pendingConnect);
		const controller = new AbortController();
		const abortReason = new Error('connect deadline');
		const fixture = createComputation({ queryRunner });

		const computation = fixture.service.computePersonalFeed(input(controller.signal));
		await waitUntil(() => queryRunner.connect.mock.calls.length === 1);
		controller.abort(abortReason);
		await expect(computation).rejects.toBe(abortReason);
		expect(queryRunner.release).not.toHaveBeenCalled();

		resolveConnect();
		await waitUntil(() => queryRunner.release.mock.calls.length === 1);
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
	});

	test('preserves the generation failure while attempting release after rollback failure', async () => {
		const primaryError = new Error('candidate acquisition failed');
		const queryRunner = createQueryRunner();
		queryRunner.rollbackTransaction.mockRejectedValueOnce(new Error('rollback failed'));
		queryRunner.release.mockRejectedValueOnce(new Error('release failed'));
		const fixture = createComputation({
			queryRunner,
			gather: async () => { throw primaryError; },
		});

		await expect(fixture.service.computePersonalFeed(input())).rejects.toBe(primaryError);

		expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(queryRunner.release).toHaveBeenCalledTimes(1);
		expect((primaryError as Error & { cleanupErrors?: unknown[] }).cleanupErrors).toHaveLength(2);
	});
});

describe('HanamiForYouService generation-only ranking adaptation', () => {
	function createGenerationForYou(redis: unknown, durable: unknown, db: unknown = {}, options: {
		meta?: unknown;
		cache?: unknown;
		idService?: unknown;
		userRecommendation?: unknown;
	} = {}) {
		return new HanamiForYouService(
			db as never,
			(options.meta ?? {}) as never,
			redis as never,
			{} as never,
			{} as never,
			(options.cache ?? {}) as never,
			(options.idService ?? {}) as never,
			{} as never,
			(options.userRecommendation ?? {}) as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			durable as never,
		);
	}

	test('unions candidate-specific durable and Redis recency without writing Redis', async () => {
		const recent = String(Date.parse(generatedAt) - 1000);
		const redis = {
			zmscore: jest.fn<(...args: string[]) => Promise<Array<string | null>>>()
				.mockResolvedValueOnce([null, null, recent, recent, null])
				.mockResolvedValueOnce([null, null, recent, null, recent]),
			set: jest.fn(),
		};
		const durable = {
			getDurableServedSeenForCandidates: jest.fn(async () => ({
				served: new Set(['durable-served', 'shared']),
				seen: new Set(['durable-seen', 'shared']),
			})),
		};
		const service = createGenerationForYou(redis, durable);
		const generation = generationInput();
		const reader = service as unknown as {
			getGenerationCandidateServedSeen(input: HanamiPersonalFeedGenerationContext, noteIds: readonly string[]): Promise<{ served: Set<string>; seen: Set<string> }>;
		};
		const noteIds = ['durable-served', 'durable-seen', 'shared', 'redis-served', 'redis-seen'];

		const result = await reader.getGenerationCandidateServedSeen(generation, noteIds);

		expect(result.served).toEqual(new Set(['durable-served', 'shared', 'redis-served']));
		expect(result.seen).toEqual(new Set(['durable-seen', 'shared', 'redis-seen']));
		expect(durable.getDurableServedSeenForCandidates).toHaveBeenCalledWith(expect.objectContaining({
			userId: generation.userId,
			generatedAt: generation.generatedAt,
			noteIds,
			signal: generation.signal,
			queryRunner: generation.queryRunner,
		}));
		expect(redis.zmscore.mock.calls[0]).toEqual([`hanami:rec:served:${generation.userId}`, ...noteIds]);
		expect(redis.zmscore.mock.calls[1]).toEqual([`hanami:rec:seen:${generation.userId}`, ...noteIds]);
		expect(redis.set).not.toHaveBeenCalled();
	});

	test('keeps durable recency on Redis rejection and aborts a hung Redis read', async () => {
		const durable = {
			getDurableServedSeenForCandidates: jest.fn(async () => ({
				served: new Set(['durable-served']),
				seen: new Set(['durable-seen']),
			})),
		};
		const rejectingRedis = { zmscore: jest.fn(async () => { throw new Error('redis unavailable'); }), set: jest.fn() };
		const rejectingService = createGenerationForYou(rejectingRedis, durable) as unknown as {
			getGenerationCandidateServedSeen(input: HanamiPersonalFeedGenerationContext, noteIds: readonly string[]): Promise<{ served: Set<string>; seen: Set<string> }>;
		};
		await expect(rejectingService.getGenerationCandidateServedSeen(generationInput(), ['durable-served', 'durable-seen'])).resolves.toEqual({
			served: new Set(['durable-served']),
			seen: new Set(['durable-seen']),
		});
		expect(rejectingRedis.set).not.toHaveBeenCalled();

		const controller = new AbortController();
		const abortReason = new Error('recency read deadline');
		const hangingRedis = { zmscore: jest.fn(() => new Promise<Array<string | null>>(() => undefined)), set: jest.fn() };
		const hangingService = createGenerationForYou(hangingRedis, durable) as unknown as {
			getGenerationCandidateServedSeen(input: HanamiPersonalFeedGenerationContext, noteIds: readonly string[]): Promise<{ served: Set<string>; seen: Set<string> }>;
		};
		const reading = hangingService.getGenerationCandidateServedSeen(generationInput(controller.signal), ['durable-served']);
		await waitUntil(() => hangingRedis.zmscore.mock.calls.length === 1);
		controller.abort(abortReason);
		await expect(reading).rejects.toBe(abortReason);
		expect(hangingRedis.set).not.toHaveBeenCalled();
	});

	test('uses threshold-limited confidence SQL on the generation QueryRunner', async () => {
		const db = { query: jest.fn() };
		const service = createGenerationForYou({}, {}, db) as unknown as {
			computeConfidence(userId: string, hasFollowing: boolean, runId: string | null, input: HanamiPersonalFeedGenerationContext): Promise<HanamiConfidence>;
		};
		const queryRunner = createQueryRunner();
		queryRunner.query
			.mockResolvedValueOnce([{ c: 50 }])
			.mockResolvedValueOnce([{ present: 1 }])
			.mockResolvedValueOnce([{ present: 1 }]);
		const generation = { ...input(), queryRunner: queryRunner as never };

		await expect(service.computeConfidence('user', false, 'run', generation)).resolves.toBe('high');

		const confidenceSql = queryRunner.query.mock.calls[0]![0];
		expect(confidenceSql).toContain('SELECT r.id FROM note_reaction r');
		expect(confidenceSql).toContain('SELECT n.id FROM note n');
		expect(confidenceSql.match(/LIMIT 50/g)).toHaveLength(2);
		expect(db.query).not.toHaveBeenCalled();
	});

	test('bounds reaction-similar author checks to the Redis pool and excludes followed candidates relatively', async () => {
		const redisRaw = Array.from({ length: 350 }, (_, index) => [`note-${index}:author-${index}:1`, '1']).flat();
		const relationshipCaches = {
			userFollowingsCache: { fetch: jest.fn() },
			userMutingsCache: { fetch: jest.fn() },
			userBlockingCache: { fetch: jest.fn() },
			userBlockedCache: { fetch: jest.fn() },
		};
		const redis = {
			zrevrange: jest.fn(async () => redisRaw),
			hgetall: jest.fn(async () => ({})),
		};
		const service = createGenerationForYou(redis, {}, {}, {
			cache: relationshipCaches,
			idService: { parse: jest.fn(() => ({ date: new Date(generatedAt) })) },
		}) as unknown as {
			reactionSimilarCandidates(userId: string, followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>, input: HanamiPersonalFeedGenerationContext): Promise<Array<{ userId: string | null }>>;
		};
		const queryRunner = createQueryRunner(async sql => {
			if (sql.includes('FROM following f')) return [{ id: 'author-5' }];
			if (sql.includes('FROM "hanami_foryou_user_taste_cluster"')) return [{ clusterId: 1, size: 1, userWeight: 1 }];
			return [];
		});
		const generation = { ...input(), queryRunner: queryRunner as never };

		const result = await service.reactionSimilarCandidates(generation.userId, [], new Set(), new Set(), generation);

		expect(result).toHaveLength(299);
		expect(result.some(candidate => candidate.userId === 'author-5')).toBe(false);
		expect(redis.zrevrange).toHaveBeenCalledWith(expect.any(String), 0, 299, 'WITHSCORES');
		const followingQuery = queryRunner.query.mock.calls.find(call => String(call[0]).includes('FROM following f'))!;
		expect(followingQuery[0]).toContain('f."followeeId" = ANY($2::varchar[])');
		expect(followingQuery[0]).toContain('ORDER BY f."followeeId" ASC');
		expect(followingQuery[1]?.[1]).toHaveLength(300);
		expect(followingQuery[1]?.[2]).toBe(300);
		expect(relationshipCaches.userFollowingsCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userMutingsCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userBlockingCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userBlockedCache.fetch).not.toHaveBeenCalled();
	});

	test('uses the author-driven bounded top-relation CTE for generation catchup', async () => {
		const service = createGenerationForYou({}, {}, {}, {
			idService: { gen: jest.fn(() => 'since-id') },
		}) as unknown as {
			catchupCandidates(userId: string, followeeIds: string[], input: HanamiPersonalFeedGenerationContext): Promise<Array<{ noteId: string; userId: string; score: number }>>;
		};
		const queryRunner = createQueryRunner(async sql => sql.includes('WITH top_relation AS MATERIALIZED')
			? [{ noteId: 'catchup-note', userId: 'catchup-author', reactionCount: 2, relScore: 4, maxRel: 8 }]
			: []);
		const generation = { ...input(), queryRunner: queryRunner as never };

		const result = await service.catchupCandidates(generation.userId, [], generation);
		expect(result).toEqual([expect.objectContaining({ noteId: 'catchup-note', userId: 'catchup-author' })]);
		expect(result[0]!.score).toBeCloseTo(1.2);

		const catchupQuery = queryRunner.query.mock.calls.find(call => String(call[0]).includes('WITH top_relation AS MATERIALIZED'))!;
		expect(catchupQuery[0]).toContain('ORDER BY "relScore" DESC, "otherUserId" ASC');
		expect(catchupQuery[0]).toContain('authors AS MATERIALIZED');
		expect(catchupQuery[0]).toContain('JOIN note n ON n."userId" = a.id');
		expect(catchupQuery[1]).toEqual([generation.userId, 100, 'since-id', 250]);
	});

	test('maps persisted and personal acquisition to the authoritative seven axes without Featured or trend calls', async () => {
		const featured = { getGlobalNotesRankingWithScores: jest.fn() };
		const trend = { getTrendingNoteIds: jest.fn() };
		const relationshipCaches = {
			userProfileCache: { fetch: jest.fn() },
			userFollowingsCache: { fetch: jest.fn() },
			userMutingsCache: { fetch: jest.fn() },
			userBlockingCache: { fetch: jest.fn() },
			userBlockedCache: { fetch: jest.fn() },
		};
		const service = new HanamiForYouService(
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			featured as never,
			relationshipCaches as never,
			{} as never,
			trend as never,
			{} as never,
			{ getLatestReadyRunId: jest.fn(async () => 'als-run') } as never,
			{} as never,
			{} as never,
			{} as never,
		);
		const computeConfidence = jest.fn(async (): Promise<HanamiConfidence> => 'high');
		Object.defineProperties(service, {
			computeConfidence: { value: computeConfidence },
			applyAuthorAffinityRerank: { value: jest.fn(async (_userId: string, _runId: string, values: unknown[]) => values) },
			applyTasteClusterOrdering: { value: jest.fn(async (_userId: string, values: unknown[]) => values) },
			neighborTrendingCandidates: { value: jest.fn(async () => [{ noteId: 'neighbor', userId: 'neighbor-author', score: 1 }]) },
			reactionSimilarCandidates: { value: jest.fn(async () => [{ noteId: 'reaction', userId: 'reaction-author', score: 1, clusterId: 3, bucket: 'cluster' as const }]) },
			catchupCandidates: { value: jest.fn(async () => [{ noteId: 'catchup', userId: 'catchup-author', score: 1 }]) },
			fofCandidates: { value: jest.fn(async () => [{ noteId: 'fof', userId: 'fof-author', score: 1 }]) },
		});
		const common = [
			candidate('globalPopular', 'global'),
			candidate('trending', 'trend', 'trend-author', { term: 'term' }),
			candidate('exploration', 'explore'),
		];
		const queryRunner = createQueryRunner(async sql => {
			if (sql.includes('FROM "user_profile"')) return [{ hanamiRecommendationEnabled: true, hanamiRecommendationAxes: {} }];
			if (sql.includes('SELECT 1 FROM following')) return [{ present: 1 }];
			if (sql.includes('FROM "hanami_foryou_model_run"')) return [{ id: 'als-run' }];
			return [];
		});
		const generation = { ...input(), queryRunner: queryRunner as never };

		const result = await service.gatherPersonalFeedCandidates(generation, common);

		expect(result.confidence).toBe('high');
		expect(new Set(result.candidates.map(value => value.axis))).toEqual(new Set(HANAMI_FOR_YOU_AXES));
		for (const value of result.candidates) {
			const commonAxis = value.axis === 'globalPopular' || value.axis === 'trending' || value.axis === 'exploration';
			expect(value.origin).toBe(commonAxis ? 'commonCandidate' : 'personalCandidate');
		}
		expect(featured.getGlobalNotesRankingWithScores).not.toHaveBeenCalled();
		expect(trend.getTrendingNoteIds).not.toHaveBeenCalled();
		expect(computeConfidence).toHaveBeenCalledWith(generation.userId, true, 'als-run', generation);
		const followingProbe = queryRunner.query.mock.calls.find(call => String(call[0]).includes('SELECT 1 FROM following'));
		expect(followingProbe?.[0]).toContain('"followerId" = $1 LIMIT 1');
		expect(followingProbe?.[1]).toEqual([generation.userId]);
		expect(relationshipCaches.userProfileCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userFollowingsCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userMutingsCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userBlockingCache.fetch).not.toHaveBeenCalled();
		expect(relationshipCaches.userBlockedCache.fetch).not.toHaveBeenCalled();
	});

	test('applies served=0.5 and seen=0.7 on every axis without invoking serving APIs', async () => {
		const db = { query: jest.fn(async () => []) };
		const redis = { zmscore: jest.fn(async (_key: string, ...noteIds: string[]) => noteIds.map(() => null)) };
		const durable = {
			getDurableServedSeenForCandidates: jest.fn(async () => ({
				served: new Set(HANAMI_FOR_YOU_AXES.map(axis => `served-${axis}`)),
				seen: new Set(HANAMI_FOR_YOU_AXES.map(axis => `seen-${axis}`)),
			})),
		};
		const service = createGenerationForYou(redis, durable, db);
		const safe = HANAMI_FOR_YOU_AXES.flatMap(axis => [
			candidate(axis, `fresh-${axis}`, `fresh-author-${axis}`, { score: 0.8 }),
			candidate(axis, `served-${axis}`, `served-author-${axis}`, { score: 1 }),
			candidate(axis, `seen-${axis}`, `seen-author-${axis}`, { score: 0.9 }),
		]);
		const preparation: HanamiPersonalFeedCandidatePreparation = {
			confidence: 'high',
			axisLevels: allLevels(),
			candidates: safe,
		};

		const generation = generationInput();
		const ranked = await service.rankPersonalFeedCandidates(generation, preparation, safe);

		for (const axis of HANAMI_FOR_YOU_AXES) {
			expect(ranked.find(value => value.noteId === `served-${axis}`)?.score).toBeCloseTo(0.5);
			expect(ranked.find(value => value.noteId === `seen-${axis}`)?.score).toBeCloseTo(0.63);
		}
		expect(db.query).not.toHaveBeenCalled();
		expect(generation.queryRunner.query).toHaveBeenCalledTimes(2);
		expect(durable.getDurableServedSeenForCandidates).toHaveBeenCalledWith(expect.objectContaining({
			noteIds: safe.map(value => value.noteId),
			queryRunner: generation.queryRunner,
		}));
	});

	test('keeps the legacy page on its request-time profile-cache path', async () => {
		const cache = {
			userProfileCache: { fetch: jest.fn(async () => ({ hanamiRecommendationEnabled: false })) },
			userFollowingsCache: { fetch: jest.fn() },
		};
		const service = createGenerationForYou({}, {}, {}, { cache });

		await expect(service.getForYouPage({ id: 'legacy-user' } as never, { limit: 30, withFiles: false })).resolves.toEqual([]);

		expect(cache.userProfileCache.fetch).toHaveBeenCalledWith('legacy-user');
		expect(cache.userFollowingsCache.fetch).not.toHaveBeenCalled();
	});
});

describe('HanamiUserRecommendationService personal-feed adapter', () => {
	test('bounds generation FoF relationships and applies candidate-relative indexed exclusions without relationship caches', async () => {
		const redis = {
			get: jest.fn<(key: string) => Promise<string | null>>()
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(JSON.stringify([])),
			set: jest.fn(),
			zrevrangebyscore: jest.fn(),
		};
		const relationshipCaches = {
			userFollowingsCache: { fetch: jest.fn() },
			userMutingsCache: { fetch: jest.fn() },
			userBlockingCache: { fetch: jest.fn() },
			userBlockedCache: { fetch: jest.fn() },
			userProfileCache: { fetch: jest.fn() },
		};
		const repositories = Array.from({ length: 5 }, () => ({ createQueryBuilder: jest.fn(), query: jest.fn() }));
		const service = new HanamiUserRecommendationService(
			redis as never,
			repositories[0] as never,
			repositories[1] as never,
			repositories[2] as never,
			repositories[3] as never,
			repositories[4] as never,
			relationshipCaches as never,
			{ gen: jest.fn(() => 'since-id') } as never,
		);
		const queryRunner = createQueryRunner(async sql => {
			if (sql.includes('AS "withReplies"')) {
				return Array.from({ length: 600 }, (_, index) => ({ id: `seed-${String(index).padStart(3, '0')}`, withReplies: false, mutual: false }));
			}
			if (sql.includes('SELECT p."mutedInstances"')) return [{ mutedInstances: ['muted.example'] }];
			if (sql.includes('WITH seed AS MATERIALIZED')) return [];
			return [];
		});
		const generation = { ...input(), queryRunner: queryRunner as never };

		await expect(service.getPersonalFeedFoFNoteIds(generation, 10)).resolves.toEqual([]);

		const seedQuery = queryRunner.query.mock.calls.find(call => String(call[0]).includes('AS "withReplies"'))!;
		expect(seedQuery[0]).toContain('ORDER BY f."followeeId" ASC');
		expect(seedQuery[1]).toEqual([generation.userId, 500]);
		const candidateQuery = queryRunner.query.mock.calls.find(call => String(call[0]).includes('WITH seed AS MATERIALIZED'))!;
		expect(candidateQuery[1]?.[1]).toHaveLength(200);
		expect(candidateQuery[1]?.[2]).toHaveLength(200);
		expect(candidateQuery[1]?.slice(3)).toEqual([20, 4000, ['muted.example'], 1000]);
		expect(candidateQuery[0]).toContain('ORDER BY f."followeeId" ASC');
		expect(candidateQuery[0]).toContain('ORDER BY "candidateId" ASC, "seedId" ASC');
		expect(candidateQuery[0]).toContain('ORDER BY candidate.score DESC, u.id ASC');
		expect(candidateQuery[0]).toContain('FROM follow_request pending');
		expect(candidateQuery[0]).toContain('FROM muting muted');
		expect(candidateQuery[0]).toContain('FROM blocking outgoing_block');
		expect(candidateQuery[0]).toContain('FROM blocking incoming_block');
		expect(candidateQuery[0]).toContain('FROM following followed');
		expect(candidateQuery[0]).toContain('FROM following follows_me');
		for (const cache of Object.values(relationshipCaches)) expect(cache.fetch).not.toHaveBeenCalled();
		for (const repository of repositories) {
			expect(repository.createQueryBuilder).not.toHaveBeenCalled();
			expect(repository.query).not.toHaveBeenCalled();
		}
		expect(redis.set).not.toHaveBeenCalled();
		expect((service as unknown as { fofNotePoolInflight: Map<string, unknown> }).fofNotePoolInflight.size).toBe(0);
	});

	test('retains complete uncapped legacy pending-follow exclusion', async () => {
		const pendingRows = Array.from({ length: 6001 }, (_, index) => ({ followeeId: `pending-${index}` }));
		const builder = {
			select: jest.fn(),
			where: jest.fn(),
			orderBy: jest.fn(),
			limit: jest.fn(),
			getRawMany: jest.fn(async () => pendingRows),
		};
		builder.select.mockReturnValue(builder);
		builder.where.mockReturnValue(builder);
		const followRequestsRepository = { createQueryBuilder: jest.fn(() => builder) };
		const service = new HanamiUserRecommendationService(
			{} as never,
			{} as never,
			followRequestsRepository as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		) as unknown as { getPendingFolloweeIds(userId: string): Promise<Set<string>> };

		const pending = await service.getPendingFolloweeIds('user');

		expect(pending.size).toBe(6001);
		expect(pending.has('pending-6000')).toBe(true);
		expect(builder.orderBy).not.toHaveBeenCalled();
		expect(builder.limit).not.toHaveBeenCalled();
	});

	test('retains complete relationship-cache materialization on the legacy FoF path', async () => {
		const queryBuilder = {
			select: jest.fn(),
			addSelect: jest.fn(),
			where: jest.fn(),
			limit: jest.fn(),
			getRawMany: jest.fn(async () => []),
		};
		queryBuilder.select.mockReturnValue(queryBuilder);
		queryBuilder.addSelect.mockReturnValue(queryBuilder);
		queryBuilder.where.mockReturnValue(queryBuilder);
		queryBuilder.limit.mockReturnValue(queryBuilder);
		const cache = {
			userFollowingsCache: { fetch: jest.fn(async () => ({ seed: { withReplies: false } })) },
			userMutingsCache: { fetch: jest.fn(async () => new Set(['muted'])) },
			userBlockingCache: { fetch: jest.fn(async () => new Set(['blocked'])) },
			userBlockedCache: { fetch: jest.fn(async () => new Set(['blocker'])) },
			userProfileCache: { fetch: jest.fn(async () => ({ mutedInstances: ['muted.example'] })) },
		};
		const service = new HanamiUserRecommendationService(
			{ get: jest.fn(async () => JSON.stringify([])) } as never,
			{ createQueryBuilder: jest.fn(() => queryBuilder) } as never,
			{ createQueryBuilder: jest.fn(() => queryBuilder) } as never,
			{} as never,
			{} as never,
			{} as never,
			cache as never,
			{} as never,
		) as unknown as { getFoFUserCandidates(userId: string): Promise<Map<string, unknown>> };

		await expect(service.getFoFUserCandidates('user')).resolves.toEqual(new Map());

		expect(cache.userFollowingsCache.fetch).toHaveBeenCalledWith('user');
		expect(cache.userMutingsCache.fetch).toHaveBeenCalledWith('user');
		expect(cache.userBlockingCache.fetch).toHaveBeenCalledWith('user');
		expect(cache.userBlockedCache.fetch).toHaveBeenCalledWith('user');
		expect(cache.userProfileCache.fetch).toHaveBeenCalledWith('user');
	});

	test('caps generation shown-history reads without changing the legacy Redis command', async () => {
		const redis = {
			zrevrangebyscore: jest.fn(async () => [`candidate\t${Date.parse(generatedAt)}\t0`, String(Date.parse(generatedAt))]),
			zrangebyscore: jest.fn(async () => []),
		};
		const service = new HanamiUserRecommendationService(
			redis as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
		) as unknown as {
			getShownStats(userId: string, input?: HanamiPersonalFeedGenerationContext): Promise<Map<string, { count: number; lastAt: number }>>;
		};
		const generation = generationInput();

		await service.getShownStats('user', generation);
		await service.getShownStats('user');

		expect(redis.zrevrangebyscore.mock.calls[0]!.slice(-4)).toEqual(['WITHSCORES', 'LIMIT', 0, 5000]);
		expect(redis.zrangebyscore).toHaveBeenCalledWith(expect.any(String), expect.any(Number), '+inf', 'WITHSCORES');
	});

	test('uses the supplied signal for a read-only cached FoF acquisition', async () => {
		const redis = {
			get: jest.fn<() => Promise<string | null>>(async () => JSON.stringify([{ noteId: 'fof-note', userId: 'fof-author', score: 2 }])),
			set: jest.fn(),
		};
		const relationshipCaches = {
			userFollowingsCache: { fetch: jest.fn() },
			userMutingsCache: { fetch: jest.fn() },
			userBlockingCache: { fetch: jest.fn() },
			userBlockedCache: { fetch: jest.fn() },
			userProfileCache: { fetch: jest.fn() },
		};
		const service = new HanamiUserRecommendationService(
			redis as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			relationshipCaches as never,
			{} as never,
		);
		const queryRunner = createQueryRunner(async sql => {
			if (sql.includes('SELECT p."mutedInstances"')) return [{ mutedInstances: [] }];
			if (sql.includes('SELECT u.id')) return [{ id: 'fof-author' }];
			return [];
		});
		const generation = { ...input(), queryRunner: queryRunner as never };
		await expect(service.getPersonalFeedFoFNoteIds(generation, 10)).resolves.toEqual([
			{ noteId: 'fof-note', userId: 'fof-author', score: 2 },
		]);
		const eligibilityQuery = queryRunner.query.mock.calls.find(call => String(call[0]).includes('SELECT u.id'))!;
		expect(eligibilityQuery[1]).toEqual([generation.userId, ['fof-author'], [], 1]);
		expect(eligibilityQuery[0]).toContain('FROM follow_request pending');
		for (const cache of Object.values(relationshipCaches)) expect(cache.fetch).not.toHaveBeenCalled();
		expect(redis.set).not.toHaveBeenCalled();
		expect((service as unknown as { fofNotePoolInflight: Map<string, unknown> }).fofNotePoolInflight.size).toBe(0);

		const controller = new AbortController();
		const reason = new Error('deadline');
		redis.get.mockImplementationOnce(async () => {
			controller.abort(reason);
			return null;
		});
		await expect(service.getPersonalFeedFoFNoteIds(generationInput(controller.signal), 10)).rejects.toBe(reason);
		expect(redis.set).not.toHaveBeenCalled();
	});
});
