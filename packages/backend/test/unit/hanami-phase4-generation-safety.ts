/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import type { HanamiPersonalFeedCandidate } from '@/core/hanami/HanamiUserFeedContracts.js';

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

	public where(condition: unknown): this { this.add(condition); return this; }
	public andWhere(condition: unknown): this { this.add(condition); return this; }
	public orWhere(condition: unknown): this { this.add(condition); return this; }
}

class FakeNoteQueryBuilder extends FakeWhereBuilder {
	public readonly selections: string[] = [];
	public readonly joins: string[] = [];
	public parameters: Record<string, unknown> = {};
	public getManyCalled = false;

	constructor(private readonly rows: readonly { id: string; authorId: string }[]) {
		super();
	}

	public select(selection: string): this { this.selections.push(selection); return this; }
	public addSelect(selection: string): this { this.selections.push(selection); return this; }

	public override where(condition: unknown, parameters?: Record<string, unknown>): this {
		super.where(condition);
		this.parameters = { ...this.parameters, ...parameters };
		return this;
	}

	public innerJoin(relation: string, alias: string): this { this.joins.push(`${relation}:${alias}:inner`); return this; }
	public leftJoin(relation: string, alias: string): this { this.joins.push(`${relation}:${alias}:left`); return this; }
	public innerJoinAndSelect(relation: string, alias: string): this { this.joins.push(`${relation}:${alias}:inner-select`); return this; }
	public leftJoinAndSelect(relation: string, alias: string): this { this.joins.push(`${relation}:${alias}:left-select`); return this; }
	public async getRawMany<T>(): Promise<T[]> { return [...this.rows] as T[]; }
	public async getMany(): Promise<never[]> { this.getManyCalled = true; return []; }
}

class FakeProfileQueryBuilder extends FakeWhereBuilder {
	public readonly selections: Array<{ selection: string; alias?: string }> = [];
	public parameters: Record<string, unknown> = {};
	public rowLimit = 0;

	constructor(
		private readonly row: { exploreMediaFilter: string } | null,
		private readonly onRead?: () => void,
	) {
		super();
	}

	public select(selection: string, alias?: string): this { this.selections.push({ selection, alias }); return this; }
	public override where(condition: unknown, parameters?: Record<string, unknown>): this {
		super.where(condition);
		this.parameters = { ...this.parameters, ...parameters };
		return this;
	}
	public limit(limit: number): this { this.rowLimit = limit; return this; }
	public async getRawOne<T>(): Promise<T | null> {
		this.onRead?.();
		return this.row as T | null;
	}
}

function candidate(noteId: string, authorId: string, axis: HanamiPersonalFeedCandidate['axis']): HanamiPersonalFeedCandidate {
	return { noteId, authorId, axis, origin: 'personalCandidate', score: 1 };
}

function createService(queries: FakeNoteQueryBuilder[], profileFetch = jest.fn(async () => ({
	exploreMediaFilter: 'all',
	mutedInstances: [],
	mutedWords: [],
	hardMutedWords: [],
}))) {
	const notesRepository = { createQueryBuilder: jest.fn(() => queries.shift()!) };
	const queryService = {
		generateBlockedHostQueryForNote: jest.fn(),
		generateSuspendedUserQueryForNote: jest.fn(),
	};
	const cacheService = {
		userProfileCache: { fetch: profileFetch },
		userMutingsCache: { fetch: jest.fn(async () => []) },
		userBlockedCache: { fetch: jest.fn(async () => []) },
		userBlockingCache: { fetch: jest.fn(async () => []) },
	};
	const noteEntityService = { packMany: jest.fn(async () => []) };
	return {
		service: new HanamiForYouSafetyService(
			notesRepository as never,
			queryService as never,
			cacheService as never,
			noteEntityService as never,
		),
		notesRepository,
		queryService,
		cacheService,
		noteEntityService,
	};
}

describe('Phase 4 personal generation safety', () => {
	test('uses the legacy profile cache without a runner and filters plain candidates without packing', async () => {
		const query = new FakeNoteQueryBuilder([
			{ id: 'note-a', authorId: 'author-a' },
			{ id: 'note-b', authorId: 'actual-author-b' },
		]);
		const profileFetch = jest.fn(async () => ({ exploreMediaFilter: 'hideSensitive', mutedInstances: [], mutedWords: [], hardMutedWords: [] }));
		const fixture = createService([query], profileFetch);
		const first = candidate('note-a', 'author-a', 'catchup');
		const secondAxis = candidate('note-a', 'author-a', 'fof');
		const staleAuthor = candidate('note-b', 'stale-author-b', 'neighborTrending');
		const missing = candidate('missing', 'author-c', 'reactionSimilar');

		const result = await fixture.service.filterPersonalEligibleCandidates({
			userId: 'user-1',
			candidates: [first, staleAuthor, secondAxis, missing],
			signal: new AbortController().signal,
		});

		expect(result).toEqual([first, secondAxis]);
		expect(result[0]).toBe(first);
		expect(result[1]).toBe(secondAxis);
		expect(query.parameters).toEqual({ noteIds: ['note-a', 'note-b', 'missing'] });
		expect(query.selections).toEqual(['note.id', 'note.userId']);
		expect(query.conditions.join('\n')).toContain('df."isSensitive" = true');
		expect(query.getManyCalled).toBe(false);
		expect(fixture.noteEntityService.packMany).not.toHaveBeenCalled();
		expect(fixture.cacheService.userMutingsCache.fetch).not.toHaveBeenCalled();
		expect(profileFetch).toHaveBeenCalledWith('user-1');
	});

	test('shares common hard eligibility while leaving user-specific scan-ahead checks out', async () => {
		const commonQuery = new FakeNoteQueryBuilder([{ id: 'note-a', authorId: 'author-a' }]);
		const personalQuery = new FakeNoteQueryBuilder([{ id: 'note-a', authorId: 'author-a' }]);
		const fixture = createService([commonQuery, personalQuery]);

		await fixture.service.filterCommonEligibleNotes(['note-a']);
		await fixture.service.filterPersonalEligibleCandidates({
			userId: 'user-1',
			candidates: [candidate('note-a', 'author-a', 'globalPopular')],
			signal: new AbortController().signal,
		});

		expect(personalQuery.conditions).toEqual(commonQuery.conditions);
		expect(personalQuery.joins).toEqual(commonQuery.joins);
		expect(personalQuery.conditions.join('\n')).toContain('reply.id IS NOT NULL');
		expect(personalQuery.conditions.join('\n')).toContain('renote.id IS NOT NULL');
		expect(personalQuery.conditions).toEqual(expect.arrayContaining([
			'user.isDeleted = FALSE',
			'replyUser.isDeleted = FALSE',
			'renoteUser.isDeleted = FALSE',
		]));
		expect(fixture.queryService.generateBlockedHostQueryForNote).toHaveBeenNthCalledWith(1, commonQuery);
		expect(fixture.queryService.generateBlockedHostQueryForNote).toHaveBeenNthCalledWith(2, personalQuery);
		expect(fixture.cacheService.userBlockedCache.fetch).not.toHaveBeenCalled();
		expect(fixture.cacheService.userBlockingCache.fetch).not.toHaveBeenCalled();
	});

	test('uses strict deleted-author and deletion-race predicates in generation and legacy display safety', async () => {
		const generationQuery = new FakeNoteQueryBuilder([{ id: 'note-a', authorId: 'author-a' }]);
		const legacyIdQuery = new FakeNoteQueryBuilder([{ id: 'note-a', authorId: 'author-a' }]);
		const displayQuery = new FakeNoteQueryBuilder([]);
		const fixture = createService([generationQuery, legacyIdQuery, displayQuery]);

		await fixture.service.filterPersonalEligibleCandidates({
			userId: 'user-1',
			candidates: [candidate('note-a', 'author-a', 'catchup')],
			signal: new AbortController().signal,
		});
		await fixture.service.filterGloballySafeIds(['note-a'], { id: 'user-1' } as never, false);
		await fixture.service.filterAndPack(['note-a'], 1, { id: 'user-1' } as never, false);

		for (const query of [generationQuery, legacyIdQuery, displayQuery]) {
			expect(query.conditions).toEqual(expect.arrayContaining([
				'user.isSuspended = FALSE',
				'user.isDeleted = FALSE',
				'reply.id IS NOT NULL',
				'replyUser.id IS NOT NULL',
				'replyUser.isSuspended = FALSE',
				'replyUser.isDeleted = FALSE',
				'renote.id IS NOT NULL',
				'renoteUser.id IS NOT NULL',
				'renoteUser.isSuspended = FALSE',
				'renoteUser.isDeleted = FALSE',
			]));
			expect(query.conditions).not.toContain('reply.id IS NULL');
			expect(query.conditions).not.toContain('renote.id IS NULL');
		}
	});

	test('uses a caller-owned QueryRunner repository without managing its lifecycle', async () => {
		const profileQuery = new FakeProfileQueryBuilder({ exploreMediaFilter: 'hideSensitive' });
		const runnerQuery = new FakeNoteQueryBuilder([{ id: 'note-a', authorId: 'author-a' }]);
		const profileRepository = { createQueryBuilder: jest.fn(() => profileQuery) };
		const noteRepository = { createQueryBuilder: jest.fn(() => runnerQuery) };
		let repositoryCall = 0;
		const getRepository = jest.fn(() => [profileRepository, noteRepository][repositoryCall++]!);
		const queryRunner = {
			manager: { getRepository },
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(),
			rollbackTransaction: jest.fn(),
			release: jest.fn(),
		};
		const fixture = createService([]);

		await fixture.service.filterPersonalEligibleCandidates({
			userId: 'user-1',
			candidates: [candidate('note-a', 'author-a', 'catchup')],
			signal: new AbortController().signal,
			queryRunner: queryRunner as never,
		});

		expect(getRepository).toHaveBeenCalledTimes(2);
		expect(profileRepository.createQueryBuilder).toHaveBeenCalledWith('profile');
		expect(profileQuery.selections).toEqual([{ selection: 'profile.exploreMediaFilter', alias: 'exploreMediaFilter' }]);
		expect(profileQuery.conditions).toEqual(['profile.userId = :userId']);
		expect(profileQuery.parameters).toEqual({ userId: 'user-1' });
		expect(profileQuery.rowLimit).toBe(1);
		expect(noteRepository.createQueryBuilder).toHaveBeenCalledWith('note');
		expect(runnerQuery.conditions.join('\n')).toContain('df."isSensitive" = true');
		expect(fixture.notesRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(fixture.cacheService.userProfileCache.fetch).not.toHaveBeenCalled();
		expect(queryRunner.startTransaction).not.toHaveBeenCalled();
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).not.toHaveBeenCalled();
	});

	test('fails generation when the runner snapshot has no user profile row', async () => {
		const profileQuery = new FakeProfileQueryBuilder(null);
		const profileRepository = { createQueryBuilder: jest.fn(() => profileQuery) };
		const noteRepository = { createQueryBuilder: jest.fn() };
		let repositoryCall = 0;
		const getRepository = jest.fn(() => [profileRepository, noteRepository][repositoryCall++]!);
		const fixture = createService([]);

		await expect(fixture.service.filterPersonalEligibleCandidates({
			userId: 'missing-user',
			candidates: [candidate('note-a', 'author-a', 'catchup')],
			signal: new AbortController().signal,
			queryRunner: { manager: { getRepository } } as never,
		})).rejects.toThrow('Hanami generation user profile is missing: missing-user');
		expect(getRepository).toHaveBeenCalledTimes(1);
		expect(noteRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(fixture.cacheService.userProfileCache.fetch).not.toHaveBeenCalled();
	});

	test('checks AbortSignal after the runner profile query before querying Notes', async () => {
		const controller = new AbortController();
		const reason = new Error('deadline expired during profile read');
		const profileQuery = new FakeProfileQueryBuilder({ exploreMediaFilter: 'all' }, () => controller.abort(reason));
		const profileRepository = { createQueryBuilder: jest.fn(() => profileQuery) };
		const noteRepository = { createQueryBuilder: jest.fn() };
		let repositoryCall = 0;
		const getRepository = jest.fn(() => [profileRepository, noteRepository][repositoryCall++]!);
		const fixture = createService([]);

		await expect(fixture.service.filterPersonalEligibleCandidates({
			userId: 'user-1',
			candidates: [candidate('note-a', 'author-a', 'catchup')],
			signal: controller.signal,
			queryRunner: { manager: { getRepository } } as never,
		})).rejects.toBe(reason);
		expect(getRepository).toHaveBeenCalledTimes(1);
		expect(noteRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(fixture.cacheService.userProfileCache.fetch).not.toHaveBeenCalled();
	});

	test('honors the computation AbortSignal between external boundaries', async () => {
		const controller = new AbortController();
		const reason = new Error('generation lease lost');
		const profileFetch = jest.fn(async () => {
			controller.abort(reason);
			return { exploreMediaFilter: 'all', mutedInstances: [], mutedWords: [], hardMutedWords: [] };
		});
		const fixture = createService([new FakeNoteQueryBuilder([])], profileFetch);

		await expect(fixture.service.filterPersonalEligibleCandidates({
			userId: 'user-1',
			candidates: [candidate('note-a', 'author-a', 'catchup')],
			signal: controller.signal,
		})).rejects.toBe(reason);
		expect(fixture.notesRepository.createQueryBuilder).not.toHaveBeenCalled();
	});
});
