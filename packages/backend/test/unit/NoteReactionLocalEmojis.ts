/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { MemoryKVCache } from '@/misc/cache.js';
import type { ReactionLocalEmojiCandidate } from '@/core/CustomEmojiService.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { EmojiEntityService } from '@/core/entities/EmojiEntityService.js';
import { selectReactionLocalEmoji } from '@/core/entities/NoteEntityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { MiEmoji } from '@/models/Emoji.js';
import type { MiNote } from '@/models/Note.js';

function candidate(overrides: Partial<ReactionLocalEmojiCandidate> & Pick<ReactionLocalEmojiCandidate, 'id'>): ReactionLocalEmojiCandidate {
	return {
		name: 'local',
		localOnly: false,
		isSensitive: false,
		roleIdsThatCanBeUsedThisEmojiAsReaction: [],
		...overrides,
	};
}

type RemoteRow = { name: string; host: string; imageFingerprint: string | null };
type LocalRow = Partial<ReactionLocalEmojiCandidate> & { imageFingerprint: string | null; host: string | null };

/** DBフリーで CustomEmojiService.getReactionLocalEmojiCandidates を検証するためのモック。 */
function makeCustomEmojiService(remoteRows: RemoteRow[], localRows: LocalRow[]) {
	const find = jest.fn(async (options: any) => {
		if (Array.isArray(options.where)) {
			// リモート側: ホスト/名前/非null fingerprint でフィルタしたつもりの行を返す
			const result = [];
			for (const cond of options.where) {
				const names: string[] = cond.name.value;
				const host: string = cond.host;
				for (const row of remoteRows) {
					if (row.host === host && names.includes(row.name) && row.imageFingerprint != null) {
						result.push(row);
					}
				}
			}
			return result;
		}
		// ローカル側: host IS NULL かつ fingerprint IN (...)
		const fingerprints: string[] = options.where.imageFingerprint.value;
		return localRows.filter(row => row.host === null && row.imageFingerprint != null && fingerprints.includes(row.imageFingerprint));
	});

	const service = Object.create(CustomEmojiService.prototype) as CustomEmojiService;
	(service as any).emojisRepository = { find };
	(service as any).utilityService = {
		toPunyNullable: (x: string | null) => x,
		isSelfHost: () => false,
	};
	const cache = new MemoryKVCache<ReactionLocalEmojiCandidate[]>(1000 * 60 * 5);
	(service as any).reactionLocalEmojiCandidatesCache = cache;
	caches.push(cache);
	return { service, find };
}

const caches: MemoryKVCache<ReactionLocalEmojiCandidate[]>[] = [];

afterEach(() => {
	while (caches.length > 0) caches.pop()!.dispose();
});

describe('selectReactionLocalEmoji', () => {
	test('exact match: single usable candidate is returned by name', () => {
		const actual = selectReactionLocalEmoji([
			candidate({ id: '9k1', name: 'party_local' }),
		], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		});
		expect(actual).toBe('party_local');
	});

	test('no candidates returns null (no match)', () => {
		expect(selectReactionLocalEmoji([], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		})).toBeNull();
	});

	test('multiple local matches resolve deterministically by ID ASC', () => {
		const actual = selectReactionLocalEmoji([
			candidate({ id: '9k9', name: 'highest' }),
			candidate({ id: '9k3', name: 'lowest' }),
			candidate({ id: '9k5', name: 'middle' }),
		], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		});
		expect(actual).toBe('lowest');
	});

	test('localOnly is allowed on a local note but excluded on a remote-origin note', () => {
		const c = candidate({ id: '9k1', name: 'local_only_emoji', localOnly: true });
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		})).toBe('local_only_emoji');
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: 'remote.example',
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		})).toBeNull();
	});

	test('likeOnly never maps custom reactions; likeOnlyForRemote still permits a local viewer', () => {
		const c = candidate({ id: '9k1', name: 'custom' });
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: 'remote.example',
			reactionAcceptance: 'likeOnly',
			viewerRoleIds: new Set(),
		})).toBeNull();
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: 'remote.example',
			reactionAcceptance: 'likeOnlyForRemote',
			viewerRoleIds: new Set(),
		})).toBe('custom');
	});

	test.each(['nonSensitiveOnly', 'nonSensitiveOnlyForLocalLikeOnlyForRemote'] as const)('sensitive candidate is excluded under %s', (acceptance) => {
		expect(selectReactionLocalEmoji([
			candidate({ id: '9k1', name: 'sensitive', isSensitive: true }),
		], {
			noteUserHost: null,
			reactionAcceptance: acceptance,
			viewerRoleIds: new Set(),
		})).toBeNull();
	});

	test('sensitive candidate is allowed without a non-sensitive restriction', () => {
		expect(selectReactionLocalEmoji([
			candidate({ id: '9k1', name: 'sensitive', isSensitive: true }),
		], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		})).toBe('sensitive');
	});

	test('role-restricted candidate is excluded without a matching viewer role', () => {
		const c = candidate({ id: '9k1', name: 'role_gated', roleIdsThatCanBeUsedThisEmojiAsReaction: ['role-1'] });
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(['other-role']),
		})).toBeNull();
		// guest has no roles
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: null,
		})).toBeNull();
	});

	test('role-restricted candidate is allowed when the viewer holds a matching role', () => {
		const c = candidate({ id: '9k1', name: 'role_gated', roleIdsThatCanBeUsedThisEmojiAsReaction: ['role-1', 'role-2'] });
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(['role-2']),
		})).toBe('role_gated');
	});

	test('empty role list means no role restriction', () => {
		const c = candidate({ id: '9k1', name: 'public' });
		expect(selectReactionLocalEmoji([c], {
			noteUserHost: null,
			reactionAcceptance: null,
			viewerRoleIds: new Set(),
		})).toBe('public');
	});
});

describe('CustomEmojiService.getReactionLocalEmojiCandidates', () => {
	test('joins remote and local rows on exact non-null imageFingerprint with 2 bounded queries', async () => {
		const { service, find } = makeCustomEmojiService([
			{ name: 'party', host: 'remote.example', imageFingerprint: 'pix-v1:aaa' },
			{ name: 'nomatch', host: 'remote.example', imageFingerprint: 'pix-v1:ccc' },
			{ name: 'unprocessed', host: 'remote.example', imageFingerprint: null },
		], [
			{ id: '9k1', name: 'party_local', localOnly: false, isSensitive: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [], imageFingerprint: 'pix-v1:aaa', host: null },
			{ id: '9k2', name: 'other_local', imageFingerprint: 'pix-v1:zzz', host: null },
		]);

		const actual = await service.getReactionLocalEmojiCandidates([
			'party@remote.example',
			'nomatch@remote.example',
			'unprocessed@remote.example',
		]);

		expect(find).toHaveBeenCalledTimes(2);

		// リモート側クエリはホスト単位にグループ化される
		const remoteCall = find.mock.calls[0][0];
		expect(Array.isArray(remoteCall.where)).toBe(true);
		expect(remoteCall.where).toHaveLength(1);
		expect(remoteCall.where[0].host).toBe('remote.example');

		// ローカル側クエリは host IS NULL + fingerprint IN の形（部分インデックス利用可）
		const localCall = find.mock.calls[1][0];
		expect(localCall.where.host).toBeDefined();
		expect(localCall.where.imageFingerprint).toBeDefined();

		// 完全一致した参照だけが候補を持ち、キーは与えた参照文字列そのもの
		expect([...actual.keys()].sort()).toEqual(['party@remote.example']);
		expect(actual.get('party@remote.example')!.map(x => x.name)).toEqual(['party_local']);
		expect(actual.get('party@remote.example')!.some(x => x.name === 'other_local')).toBe(false);
		// 未処理(null)・未マッチの参照は候補を持たない
		expect(actual.get('nomatch@remote.example')).toBeUndefined();
		expect(actual.get('unprocessed@remote.example')).toBeUndefined();
	});

	test('mixed hosts/keys map to their own candidates, and the same fingerprint serves multiple refs', async () => {
		const { service } = makeCustomEmojiService([
			{ name: 'party', host: 'a.example', imageFingerprint: 'pix-v1:aaa' },
			{ name: 'party', host: 'b.example', imageFingerprint: 'pix-v1:bbb' },
			{ name: 'alias', host: 'a.example', imageFingerprint: 'pix-v1:aaa' },
		], [
			{ id: '9k1', name: 'a_local', localOnly: false, isSensitive: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [], imageFingerprint: 'pix-v1:aaa', host: null },
			{ id: '9k2', name: 'b_local', imageFingerprint: 'pix-v1:bbb', host: null },
		]);

		const actual = await service.getReactionLocalEmojiCandidates([
			'party@a.example',
			'party@b.example',
			'alias@a.example',
		]);

		expect([...actual.keys()].sort()).toEqual(['alias@a.example', 'party@a.example', 'party@b.example']);
		expect(actual.get('party@a.example')!.map(x => x.name)).toEqual(['a_local']);
		expect(actual.get('alias@a.example')!.map(x => x.name)).toEqual(['a_local']);
		expect(actual.get('party@b.example')!.map(x => x.name)).toEqual(['b_local']);
	});

	test('deleted local candidate is naturally omitted and empty input short-circuits', async () => {
		const { service, find } = makeCustomEmojiService(
			[{ name: 'party', host: 'remote.example', imageFingerprint: 'pix-v1:aaa' }],
			// ローカル側に該当行が無い = 削除済み
			[],
		);

		const actual = await service.getReactionLocalEmojiCandidates(['party@remote.example']);
		expect(actual.get('party@remote.example')).toBeUndefined();

		await service.getReactionLocalEmojiCandidates([]);
		// 空入力ではクエリを発行しない（既存2回のまま）
		expect(find).toHaveBeenCalledTimes(2);
	});

	test('serves a repeated ref from cache, including one with no candidates', async () => {
		const { service, find } = makeCustomEmojiService(
			[
				{ name: 'party', host: 'remote.example', imageFingerprint: 'pix-v1:aaa' },
				{ name: 'nomatch', host: 'remote.example', imageFingerprint: 'pix-v1:ccc' },
			],
			[{ id: '9k1', name: 'party_local', imageFingerprint: 'pix-v1:aaa', host: null }],
		);

		const refs = ['party@remote.example', 'nomatch@remote.example'];
		const first = await service.getReactionLocalEmojiCandidates(refs);
		expect(find).toHaveBeenCalledTimes(2);

		// _hint_ を持たないストリーミング配信は同じ参照を何度も引くため、候補なしも含めてキャッシュが効く必要がある
		const second = await service.getReactionLocalEmojiCandidates(refs);
		expect(find).toHaveBeenCalledTimes(2);
		expect([...second.keys()]).toEqual([...first.keys()]);
		expect(second.get('party@remote.example')!.map(x => x.name)).toEqual(['party_local']);
		expect(second.get('nomatch@remote.example')).toBeUndefined();
	});

	test('ignores non-remote refs (local @. reference)', async () => {
		const { service, find } = makeCustomEmojiService(
			[{ name: 'party', host: 'remote.example', imageFingerprint: 'pix-v1:aaa' }],
			[{ id: '9k1', name: 'party_local', imageFingerprint: 'pix-v1:aaa', host: null }],
		);

		const actual = await service.getReactionLocalEmojiCandidates(['party@.']);
		expect(actual.size).toBe(0);
		expect(find).not.toHaveBeenCalled();
	});
});

describe('EmojiEntityService.packDetailedAdminMany', () => {
	test('looks up deduplicated remote fingerprints locally exactly once', async () => {
		const find = jest.fn(async (_options: any) => [{ imageFingerprint: 'pix-v1:matched' }]);
		const service = Object.create(EmojiEntityService.prototype) as EmojiEntityService;
		(service as any).emojisRepository = { find };
		(service as any).rolesRepository = { findBy: jest.fn() };
		const emoji = (overrides: Partial<MiEmoji>) => ({
			id: '9k1', updatedAt: null, name: 'emoji', host: 'remote.example', uri: null, type: null,
			aliases: [], category: null, publicUrl: 'https://example.com/emoji.png', originalUrl: 'https://example.com/emoji.png',
			license: null, localOnly: false, isSensitive: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [],
			imageFingerprint: null, imageFingerprintAttemptedAt: null, imageFingerprintErrorCode: null,
			...overrides,
		}) as MiEmoji;

		const actual = await service.packDetailedAdminMany([
			emoji({ id: '9k1', imageFingerprint: 'pix-v1:matched' }),
			emoji({ id: '9k2', imageFingerprint: 'pix-v1:matched' }),
			emoji({ id: '9k3', imageFingerprint: 'pix-v1:unmatched' }),
			emoji({ id: '9k4', host: null, imageFingerprint: 'pix-v1:matched' }),
		]);

		expect(find).toHaveBeenCalledTimes(1);
		expect(find).toHaveBeenCalledWith(expect.objectContaining({ select: ['imageFingerprint'] }));
		expect(find.mock.calls[0][0].where.imageFingerprint.value).toEqual(['pix-v1:matched', 'pix-v1:unmatched']);
		expect(actual.map(x => x.imageFingerprintState)).toEqual(['matched', 'matched', 'unmatched', null]);
	});
});

describe('NoteEntityService.buildReactionLocalEmojis', () => {
	function makeService(): NoteEntityService {
		return Object.create(NoteEntityService.prototype) as NoteEntityService;
	}

	test('guest (meId null) yields no entries and likeOnly yields no entries', () => {
		const service = makeService();
		const note = { userHost: null, reactionAcceptance: null } as unknown as MiNote;
		const candidates = new Map([
			['party@remote.example', [candidate({ id: '9k1', name: 'party_local' })]],
		]);

		expect((service as any).buildReactionLocalEmojis(note, ['party@remote.example'], null, new Set(), candidates)).toEqual({});
		expect((service as any).buildReactionLocalEmojis(
			{ ...note, reactionAcceptance: 'likeOnly' }, ['party@remote.example'], 'me', new Set(), candidates,
		)).toEqual({});
	});

	test('outputs colonless remote ref keys mapped to the selected local name', () => {
		const service = makeService();
		const note = { userHost: 'remote.example', reactionAcceptance: null } as unknown as MiNote;
		const candidates = new Map([
			['party@remote.example', [candidate({ id: '9k2', name: 'dup_later' }), candidate({ id: '9k1', name: 'dup_first' })]],
			['ghost@remote.example', []],
		]);

		const actual = (service as any).buildReactionLocalEmojis(
			note, ['party@remote.example', 'ghost@remote.example'], 'me', new Set(), candidates,
		);

		expect(actual).toEqual({ 'party@remote.example': 'dup_first' });
	});
});

describe('NoteEntityService.resolveReactionLocalEmojis', () => {
	function makeService(): NoteEntityService {
		const service = Object.create(NoteEntityService.prototype) as NoteEntityService;
		(service as any).reactionService = {
			decodeReaction: (x: string) => ({ reaction: x, name: 'party', host: 'remote.example' }),
		};
		return service;
	}

	test('reuses hint viewer roles and candidates without issuing extra queries', async () => {
		const service = makeService();
		const getRoles = jest.fn();
		const getCandidates = jest.fn();
		(service as any).roleService = { getUserRoles: getRoles };
		(service as any).customEmojiService = { getReactionLocalEmojiCandidates: getCandidates };

		const hint = {
			viewerRoleIds: new Set(['role-1']),
			reactionLocalEmojiCandidates: new Map<string, ReactionLocalEmojiCandidate[]>([
				['party@remote.example', [candidate({ id: '9k1', name: 'party_local' })]],
			]),
		};
		const note = { userHost: null, reactionAcceptance: null } as unknown as MiNote;

		const actual = await (service as any).resolveReactionLocalEmojis(note, { ':party@remote.example:': 1 }, 'me', hint);

		expect(actual).toEqual({ 'party@remote.example': 'party_local' });
		expect(getRoles).not.toHaveBeenCalled();
		expect(getCandidates).not.toHaveBeenCalled();
	});

	test('populates the hint on first call so a subsequent note reuses the cached state', async () => {
		const service = makeService();
		const getRoles = jest.fn(async () => [{ id: 'role-1' }]);
		const getCandidates = jest.fn(async () => new Map<string, ReactionLocalEmojiCandidate[]>([
			['party@remote.example', [candidate({ id: '9k1', name: 'party_local' })]],
		]));
		(service as any).roleService = { getUserRoles: getRoles };
		(service as any).customEmojiService = { getReactionLocalEmojiCandidates: getCandidates };

		const hint: { viewerRoleIds?: Set<string> | null; reactionLocalEmojiCandidates?: Map<string, ReactionLocalEmojiCandidate[]> } = {};
		const note = { userHost: null, reactionAcceptance: null } as unknown as MiNote;

		const first = await (service as any).resolveReactionLocalEmojis(note, { ':party@remote.example:': 1 }, 'me', hint);
		const second = await (service as any).resolveReactionLocalEmojis(note, { ':party@remote.example:': 1 }, 'me', hint);

		expect(first).toEqual({ 'party@remote.example': 'party_local' });
		expect(second).toEqual(first);
		expect(getRoles).toHaveBeenCalledTimes(1);
		expect(getCandidates).toHaveBeenCalledTimes(1);
		expect(hint.viewerRoleIds).toEqual(new Set(['role-1']));
		expect(hint.reactionLocalEmojiCandidates?.has('party@remote.example')).toBe(true);
	});
});

describe('NoteEntityService.fetchDiffs', () => {
	test('resolves viewer roles and candidates once and maps each note only to its own local emoji', async () => {
		const service = Object.create(NoteEntityService.prototype) as NoteEntityService;
		const getRoles = jest.fn(async () => [{ id: 'role-1' }]);
		const getCandidates = jest.fn(async (names: string[]) => {
			const map = new Map<string, ReactionLocalEmojiCandidate[]>();
			if (names.includes('party@remote.example')) {
				map.set('party@remote.example', [candidate({ id: '9k1', name: 'party_local' })]);
			}
			return map;
		});
		const populateEmojis = jest.fn(async () => ({}));
		(service as any).roleService = { getUserRoles: getRoles };
		(service as any).customEmojiService = {
			getReactionLocalEmojiCandidates: getCandidates,
			populateEmojis,
		};
		(service as any).reactionService = {
			decodeReaction: (x: string) => ({ reaction: x, name: 'party', host: 'remote.example' }),
			convertLegacyReactions: (r: MiNote['reactions']) => r,
		};
		(service as any).reactionsBufferingService = { mergeReactions: (r: MiNote['reactions']) => r };
		(service as any).meta = { enableReactionsBuffering: false };
		(service as any).notesRepository = {
			find: jest.fn(async () => [
				{ id: 'n1', userHost: null, reactions: { ':party@remote.example:': 1 }, reactionAndUserPairCache: [], reactionAcceptance: null },
				{ id: 'n2', userHost: 'remote.example', reactions: { ':ghost@remote.example:': 1 }, reactionAndUserPairCache: [], reactionAcceptance: null },
			]),
		};

		const actual = await service.fetchDiffs(['n1', 'n2'], { id: 'me' });

		expect(getRoles).toHaveBeenCalledTimes(1);
		expect(getCandidates).toHaveBeenCalledTimes(1);
		// 全ノートの参照を一度にまとめて解決する（バッチ化）
		expect(getCandidates).toHaveBeenCalledWith(['party@remote.example', 'ghost@remote.example']);

		expect(actual).toEqual([
			{ id: 'n1', reactions: { ':party@remote.example:': 1 }, reactionEmojis: {}, reactionLocalEmojis: { 'party@remote.example': 'party_local' } },
			{ id: 'n2', reactions: { ':ghost@remote.example:': 1 }, reactionEmojis: {}, reactionLocalEmojis: {} },
		]);
	});
});

describe('NoteEntityService.packMany', () => {
	test('coalesces an unmatched remote ref across concurrently loader-resolved replies', async () => {
		const service = Object.create(NoteEntityService.prototype) as NoteEntityService;
		let resolveCandidates!: (value: Map<string, ReactionLocalEmojiCandidate[]>) => void;
		const getCandidates = jest.fn(() => new Promise<Map<string, ReactionLocalEmojiCandidate[]>>(resolve => {
			resolveCandidates = resolve;
		}));
		(service as any).roleService = { getUserRoles: jest.fn(async () => [{ id: 'role-1' }]) };
		(service as any).customEmojiService = {
			getReactionLocalEmojiCandidates: getCandidates,
			prefetchEmojis: jest.fn(async () => {}),
			populateEmojis: jest.fn(async () => ({})),
		};
		(service as any).reactionService = {
			decodeReaction: (x: string) => ({ reaction: x.slice(1, -1), name: 'ghost', host: 'remote.example' }),
			convertLegacyReactions: (r: MiNote['reactions']) => r,
		};
		(service as any).reactionsBufferingService = { getMany: jest.fn(async () => null), mergeReactions: (r: MiNote['reactions']) => r };
		(service as any).meta = { enableReactionsBuffering: false };
		(service as any).idService = { gen: () => '0000000000000000', parse: () => ({ date: new Date(0) }) };
		(service as any).driveFileEntityService = { packManyByIdsMap: jest.fn(async () => new Map()), packManyByIds: jest.fn(async () => []) };
		(service as any).userEntityService = {
			packMany: jest.fn(async (users: string[]) => users.map(id => ({ id }))),
			pack: jest.fn(async (user: string) => ({ id: user })),
		};
		(service as any).noteReactionsRepository = { findBy: jest.fn(async () => []) };
		Object.defineProperties(service, {
			shouldHideNote: { value: jest.fn(async () => false), configurable: true },
			treatVisibility: { value: jest.fn(), configurable: true },
		});

		const note = (id: string, replyId: string | null, reactions: MiNote['reactions']) => ({
			id, userId: `${id}-user`, userHost: null, reactions, reactionAndUserPairCache: [], fileIds: [], emojis: [],
			text: null, name: null, url: null, uri: null, channelId: null, visibility: 'public', localOnly: false,
			reactionAcceptance: null, visibleUserIds: [], renoteCount: 0, repliesCount: 0, tags: [], mentions: [],
			hasPoll: false, isNoteInHanaMode: false, replyId, renoteId: null, clippedCount: 0,
		}) as unknown as MiNote;
		const replyA = note('reply-a', null, { ':ghost@remote.example:': 1 });
		const replyB = note('reply-b', null, { ':ghost@remote.example:': 1 });
		(service as any).noteLoader = { load: jest.fn(async (id: string) => id === 'reply-a' ? replyA : replyB) };

		const packed = service.packMany([
			note('root-a', 'reply-a', {}),
			note('root-b', 'reply-b', {}),
		], { id: 'me' });
		await new Promise(resolve => setImmediate(resolve));
		expect(getCandidates).toHaveBeenCalledTimes(1);
		expect(getCandidates).toHaveBeenCalledWith(['ghost@remote.example']);
		resolveCandidates(new Map());
		void packed.catch(() => {});
		await new Promise(resolve => setImmediate(resolve));
	});

	test('looks up an unmatched remote ref once and shares its empty candidate hint with every pack call', async () => {
		const service = Object.create(NoteEntityService.prototype) as NoteEntityService;
		const getRoles = jest.fn(async () => [{ id: 'role-1' }]);
		const getCandidates = jest.fn(async (names: string[]) => {
			const map = new Map<string, ReactionLocalEmojiCandidate[]>();
			if (names.includes('party@remote.example')) {
				map.set('party@remote.example', [candidate({ id: '9k1', name: 'party_local' })]);
			}
			return map;
		});
		(service as any).roleService = { getUserRoles: getRoles };
		(service as any).customEmojiService = {
			getReactionLocalEmojiCandidates: getCandidates,
			prefetchEmojis: jest.fn(async () => {}),
			populateEmojis: jest.fn(async () => ({})),
		};
		(service as any).reactionService = {
			decodeReaction: (x: string) => ({ reaction: x, name: 'party', host: 'remote.example' }),
			convertLegacyReactions: (r: MiNote['reactions']) => r,
		};
		(service as any).reactionsBufferingService = {
			getMany: jest.fn(async () => null),
			mergeReactions: (r: MiNote['reactions']) => r,
		};
		(service as any).meta = { enableReactionsBuffering: false };
		// oldId を常に将来にすることで「新しすぎてリアクション取得を省略」パスに落とす（DBアクセス回避）
		(service as any).idService = { gen: () => '0000000000000000' };
		(service as any).driveFileEntityService = { packManyByIdsMap: jest.fn(async () => new Map()) };
		(service as any).userEntityService = { packMany: jest.fn(async (users: string[]) => users.map(id => ({ id }))) };
		(service as any).noteReactionsRepository = { findBy: jest.fn(async () => []) };

		const packSpy = jest.fn(async (n: any, _me: { id: string }, opts: any) => ({
			id: n.id,
			reactionLocalEmojis: await (service as any).resolveReactionLocalEmojis(n, n.reactions, _me.id, opts?._hint_),
		}));
		// pack は @bindThis により getter として定義されるため、own property で上書きして shadow する
		Object.defineProperty(service, 'pack', {
			value: packSpy,
			configurable: true,
			writable: true,
		});

		const notes = [
			{ id: 'n1', userHost: null, reactions: { ':ghost@remote.example:': 1 }, reactionAndUserPairCache: [], fileIds: [], emojis: [], renote: undefined, renoteId: null, replyId: null, replyUserId: null, renoteUserId: null, userId: 'u1' },
			{ id: 'n2', userHost: null, reactions: { ':ghost@remote.example:': 1 }, reactionAndUserPairCache: [], fileIds: [], emojis: [], renote: undefined, renoteId: null, replyId: null, replyUserId: null, renoteUserId: null, userId: 'u2' },
		] as unknown as MiNote[];

		const packed = await service.packMany(notes, { id: 'me' });

		expect(getRoles).toHaveBeenCalledTimes(1);
		expect(getCandidates).toHaveBeenCalledTimes(1);
		expect(getCandidates).toHaveBeenCalledWith(['ghost@remote.example']);
		expect(packSpy).toHaveBeenCalledTimes(2);
		expect(packed.map(note => note.reactionLocalEmojis)).toEqual([{}, {}]);
	});
});
