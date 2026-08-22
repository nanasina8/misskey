/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import type { MiLocalUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { Packed } from '@/misc/json-schema.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import type { HanamiPersistedPersonalFeedEntry } from '@/core/hanami/HanamiUserFeedContracts.js';

type BracketsLike = { whereFactory: (builder: FakeQuery) => void };

class FakeQuery {
	public readonly conditions: string[] = [];
	public readonly joins: string[] = [];
	public parameters: Record<string, unknown> = {};

	constructor(private readonly notes: readonly MiNote[]) {}

	private add(condition: unknown): void {
		if (typeof condition === 'string') this.conditions.push(condition);
		if (condition != null && typeof condition === 'object' && 'whereFactory' in condition) {
			(condition as BracketsLike).whereFactory(this);
		}
	}

	public where(condition: unknown, parameters?: Record<string, unknown>): this {
		this.add(condition);
		this.parameters = { ...this.parameters, ...parameters };
		return this;
	}

	public andWhere(condition: unknown): this { this.add(condition); return this; }
	public orWhere(condition: unknown): this { this.add(condition); return this; }
	public innerJoinAndSelect(relation: string, alias: string): this { this.joins.push(`${relation}:${alias}:inner`); return this; }
	public leftJoinAndSelect(relation: string, alias: string): this { this.joins.push(`${relation}:${alias}:left`); return this; }
	public async getMany(): Promise<MiNote[]> { return [...this.notes]; }
}

function note(id: string, userId = `author-${id}`, options: Partial<MiNote> = {}): MiNote {
	return {
		id,
		userId,
		user: { id: userId, host: null } as never,
		text: `text-${id}`,
		cw: null,
		reply: null,
		renote: null,
		...options,
	} as MiNote;
}

function entry(sequence: string, noteId: string, batchId = `batch-${sequence}`): HanamiPersistedPersonalFeedEntry {
	return {
		kind: 'personal',
		epochId: 'epoch-1',
		sequence,
		batchId,
		noteId,
		source: 'catchup',
		sources: ['catchup'],
		origin: 'personalCandidate',
		reasonMetadata: { version: 1 },
	};
}

function fixture(notes: readonly MiNote[], options: {
	muting?: Set<string>;
	blockedBy?: Set<string>;
	blocking?: Set<string>;
	profile?: Record<string, unknown>;
	pack?: (notes: MiNote[]) => Promise<Packed<'Note'>[]>;
} = {}) {
	const query = new FakeQuery(notes);
	const notesRepository = { createQueryBuilder: jest.fn(() => query) };
	const queryService = {
		generateBlockedHostQueryForNote: jest.fn(),
		generateSuspendedUserQueryForNote: jest.fn(),
	};
	const cacheService = {
		userMutingsCache: { fetch: jest.fn(async () => options.muting ?? new Set<string>()) },
		userBlockedCache: { fetch: jest.fn(async () => options.blockedBy ?? new Set<string>()) },
		userBlockingCache: { fetch: jest.fn(async () => options.blocking ?? new Set<string>()) },
		userProfileCache: { fetch: jest.fn(async () => ({
			mutedInstances: [],
			mutedWords: [],
			hardMutedWords: [],
			exploreMediaFilter: 'all',
			...options.profile,
		})) },
	};
	const packMany = jest.fn(async (ordered: MiNote[]) => options.pack == null
		? ordered.map(item => ({ id: item.id, cw: item.cw }) as Packed<'Note'>)
		: await options.pack(ordered));
	const service = new HanamiForYouSafetyService(
		notesRepository as never,
		queryService as never,
		cacheService as never,
		{ packMany } as never,
	);
	return { service, query, queryService, cacheService, packMany };
}

const me = { id: 'user-1' } as MiLocalUser;

describe('Hanami Phase 5 workstream C persisted-entry safety', () => {
	test('fetches unique Notes once, reconstructs duplicate occurrences, preserves CW, and limits before packing', async () => {
		const warning = note('note-a', 'author-a', { cw: 'content warning' });
		const other = note('note-b');
		const first = entry('5', 'note-a', 'batch-a');
		const duplicate = entry('4', 'note-a', 'batch-b');
		const third = entry('3', 'note-b');
		const target = fixture([warning, other]);

		const result = await target.service.filterAndPackPersistedEntries({
			me,
			entries: [first, duplicate, third],
			limit: 2,
			withFiles: false,
		});

		expect(target.query.parameters).toEqual({ noteIds: ['note-a', 'note-b'] });
		expect(target.packMany).toHaveBeenCalledTimes(1);
		expect(target.packMany.mock.calls[0]![0].map(item => item.id)).toEqual(['note-a', 'note-a']);
		expect(result.map(item => item.entry)).toEqual([first, duplicate]);
		expect(result[0]!.entry).toBe(first);
		expect(result[1]!.entry).toBe(duplicate);
		expect(result.map(item => item.note.cw)).toEqual(['content warning', 'content warning']);
	});

	test('applies relationship, instance, word, media, file, target, and reaction safety without served writes', async () => {
		const safe = note('safe', 'safe-author', { cw: 'keep this CW' });
		const blocked = note('blocked', 'blocked-author');
		const instance = note('instance', 'remote-author', { user: { id: 'remote-author', host: 'muted.example' } as never });
		const word = note('word', 'word-author', { text: 'contains forbidden phrase' });
		const target = fixture([safe, blocked, instance, word], {
			muting: new Set(['muted-reactor']),
			blockedBy: new Set(['blocked-author']),
			profile: {
				mutedInstances: ['muted.example'],
				mutedWords: [['forbidden']],
				exploreMediaFilter: 'hideSensitive',
			},
			pack: async ordered => ordered.map(item => ({
				id: item.id,
				cw: item.cw,
				reactions: { ':like:': 2 },
				reactionCount: 2,
				reactionAndUserPairCache: ['muted-reactor/:like:', 'visible-reactor/:like:'],
			}) as never),
		});

		const result = await target.service.filterAndPackPersistedEntries({
			me,
			entries: [entry('4', 'safe'), entry('3', 'blocked'), entry('2', 'instance'), entry('1', 'word')],
			limit: 10,
			withFiles: true,
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.entry.noteId).toBe('safe');
		expect(result[0]!.note.cw).toBe('keep this CW');
		expect(result[0]!.note.reactions).toEqual({ ':like:': 1 });
		expect(result[0]!.note.reactionCount).toBe(1);
		expect(result[0]!.note).not.toHaveProperty('reactionAndUserPairCache');
		expect(target.query.conditions).toEqual(expect.arrayContaining([
			'note.channelId IS NULL',
			'note.visibility = \'public\'',
			'note.visibility = \'home\'',
			'user.isSuspended = FALSE',
			'user.isDeleted = FALSE',
			'reply.id IS NOT NULL',
			'replyUser.isDeleted = FALSE',
			'renote.id IS NOT NULL',
			'renoteUser.isDeleted = FALSE',
			'note.fileIds != \'{}\'',
		]));
		expect(target.query.conditions.join('\n')).toContain('df."isSensitive" = true');
		expect(target.queryService.generateBlockedHostQueryForNote).toHaveBeenCalledWith(target.query);
		expect(target.queryService.generateSuspendedUserQueryForNote).toHaveBeenCalledWith(target.query);
	});

	test('fails rather than mis-zipping a partial packMany result', async () => {
		const target = fixture([note('note-a')], { pack: async () => [] });
		await expect(target.service.filterAndPackPersistedEntries({
			me,
			entries: [entry('1', 'note-a')],
			limit: 1,
			withFiles: false,
		})).rejects.toThrow('unexpected Note count');
	});
});
