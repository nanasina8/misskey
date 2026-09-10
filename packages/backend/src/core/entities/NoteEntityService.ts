/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { EntityNotFoundError, In } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { Packed } from '@/misc/json-schema.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { UsersRepository, NotesRepository, FollowingsRepository, PollsRepository, PollVotesRepository, NoteReactionsRepository, ChannelsRepository, MiMeta, MiRole } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { DebounceLoader } from '@/misc/loader.js';
import { IdService } from '@/core/IdService.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';
import { CacheService } from '@/core/CacheService.js';
import type { OnModuleInit } from '@nestjs/common';
import type { CustomEmojiService, ReactionLocalEmojiCandidate } from '../CustomEmojiService.js';
import type { ReactionService } from '../ReactionService.js';
import type { RoleService } from '../RoleService.js';
import type { UserEntityService } from './UserEntityService.js';
import type { DriveFileEntityService } from './DriveFileEntityService.js';

// is-renote.tsとよしなにリンク
function isPureRenote(note: MiNote): note is MiNote & { renoteId: MiNote['id']; renote: MiNote } {
	return (
		note.renote != null &&
		note.reply == null &&
		note.text == null &&
		note.cw == null &&
		(note.fileIds == null || note.fileIds.length === 0) &&
		!note.hasPoll
	);
}

function getAppearNoteIds(notes: MiNote[]): Set<string> {
	const appearNoteIds = new Set<string>();
	for (const note of notes) {
		if (isPureRenote(note)) {
			appearNoteIds.add(note.renoteId);
		} else {
			appearNoteIds.add(note.id);
		}
	}
	return appearNoteIds;
}

async function nullIfEntityNotFound<T>(promise: Promise<T>): Promise<T | null> {
	try {
		return await promise;
	} catch (err) {
		if (err instanceof EntityNotFoundError) {
			return null;
		}
		throw err;
	}
}

/** reactionLocalEmojis の候補選別に必要なノート・ビューア側の文脈。 */
export type ReactionLocalEmojiContext = {
	noteUserHost: MiNote['userHost'];
	reactionAcceptance: MiNote['reactionAcceptance'];
	viewerRoleIds: ReadonlySet<MiRole['id']> | null;
};

/**
 * リモートリアクション参照に対するローカル絵文字候補から、利用可能なものをフィルタし、
 * 残った候補のうち最もIDが小さい（昇順）ものを決定的に選んでその name を返す。
 * 選べない場合は null。
 */
export function selectReactionLocalEmoji(
	candidates: readonly ReactionLocalEmojiCandidate[],
	context: ReactionLocalEmojiContext,
): string | null {
	if (candidates.length === 0) return null;
	if (context.reactionAcceptance === 'likeOnly') return null;

	const nonSensitiveOnly =
		context.reactionAcceptance === 'nonSensitiveOnly' ||
		context.reactionAcceptance === 'nonSensitiveOnlyForLocalLikeOnlyForRemote';

	const usable = candidates.filter(candidate => {
		// ノート作者がリモートの場合は localOnly なローカル絵文字は使わせない
		if (candidate.localOnly && context.noteUserHost != null) return false;
		// センシティブ制限
		if (candidate.isSensitive && nonSensitiveOnly) return false;
		// ロール制限（ロール指定があるなら、ビューアのロールに含まれる必要がある）
		if (candidate.roleIdsThatCanBeUsedThisEmojiAsReaction.length > 0) {
			if (context.viewerRoleIds == null) return false;
			if (!candidate.roleIdsThatCanBeUsedThisEmojiAsReaction.some(id => context.viewerRoleIds!.has(id))) return false;
		}
		return true;
	});

	if (usable.length === 0) return null;

	let selected = usable[0];
	for (let i = 1; i < usable.length; i++) {
		if (usable[i].id < selected.id) selected = usable[i];
	}
	return selected.name;
}

@Injectable()
export class NoteEntityService implements OnModuleInit {
	private userEntityService: UserEntityService;
	private driveFileEntityService: DriveFileEntityService;
	private customEmojiService: CustomEmojiService;
	private reactionService: ReactionService;
	private roleService: RoleService;
	private reactionsBufferingService: ReactionsBufferingService;
	private idService: IdService;
	private cacheService: CacheService;
	private noteLoader = new DebounceLoader(this.findNoteOrFail);

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,

		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,

		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,

		//private userEntityService: UserEntityService,
		//private driveFileEntityService: DriveFileEntityService,
		//private customEmojiService: CustomEmojiService,
		//private reactionService: ReactionService,
		//private reactionsBufferingService: ReactionsBufferingService,
		//private idService: IdService,
		//private cacheService: CacheService,
	) {
	}

	onModuleInit() {
		this.userEntityService = this.moduleRef.get('UserEntityService');
		this.driveFileEntityService = this.moduleRef.get('DriveFileEntityService');
		this.customEmojiService = this.moduleRef.get('CustomEmojiService');
		this.reactionService = this.moduleRef.get('ReactionService');
		this.roleService = this.moduleRef.get('RoleService');
		this.reactionsBufferingService = this.moduleRef.get('ReactionsBufferingService');
		this.idService = this.moduleRef.get('IdService');
		this.cacheService = this.moduleRef.get('CacheService');
	}

	@bindThis
	private treatVisibility(packedNote: Packed<'Note'>): Packed<'Note'>['visibility'] {
		if (packedNote.visibility === 'public' || packedNote.visibility === 'home') {
			const followersOnlyBefore = packedNote.user.makeNotesFollowersOnlyBefore;
			if (shouldHideNoteByTime(followersOnlyBefore, packedNote.createdAt)) {
				packedNote.visibility = 'followers';
			}
		}
		return packedNote.visibility;
	}

	@bindThis
	public async shouldHideNote(packedNote: Packed<'Note'>, meId: MiUser['id'] | null): Promise<boolean> {
		if (meId === packedNote.userId) return false;
		// TODO: isVisibleForMe を使うようにしても良さそう(型違うけど)

		if (packedNote.user.requireSigninToViewContents && meId == null) {
			return true;
		}

		const hiddenBefore = packedNote.user.makeNotesHiddenBefore;
		if (shouldHideNoteByTime(hiddenBefore, packedNote.createdAt)) {
			return true;
		}

		// visibility が specified かつ自分が指定されていなかったら非表示
		if (packedNote.visibility === 'specified') {
			if (meId == null) {
				return true;
			} else {
				// 指定されているかどうか
				const specified = packedNote.visibleUserIds!.some(id => meId === id);

				if (!specified) {
					return true;
				}
			}
		}

		// visibility が followers かつ自分が投稿者のフォロワーでなかったら非表示
		if (packedNote.visibility === 'followers') {
			if (meId == null) {
				return true;
			} else if (packedNote.reply && (meId === packedNote.reply.userId)) {
				// 自分の投稿に対するリプライ
				return false;
			} else if (packedNote.mentions && packedNote.mentions.some(id => meId === id)) {
				// 自分へのメンション
				return false;
			} else {
				// フォロワーかどうか
				const followings = await this.cacheService.userFollowingsCache.fetch(meId);
				if (!Object.hasOwn(followings, packedNote.userId)) {
					return true;
				}
			}
		}

		return false;
	}

	@bindThis
	public hideNote(packedNote: Packed<'Note'>): void {
		packedNote.visibleUserIds = undefined;
		packedNote.fileIds = [];
		packedNote.files = [];
		packedNote.text = null;
		packedNote.poll = undefined;
		packedNote.cw = null;
		packedNote.isHidden = true;
		// TODO: hiddenReason みたいなのを提供しても良さそう
	}

	@bindThis
	private async populatePoll(note: MiNote, meId: MiUser['id'] | null) {
		const poll = await this.pollsRepository.findOneByOrFail({ noteId: note.id });
		const choices = poll.choices.map(c => ({
			text: c,
			votes: poll.votes[poll.choices.indexOf(c)],
			isVoted: false,
		}));

		if (meId) {
			if (poll.multiple) {
				const votes = await this.pollVotesRepository.findBy({
					userId: meId,
					noteId: note.id,
				});

				const myChoices = votes.map(v => v.choice);
				for (const myChoice of myChoices) {
					choices[myChoice].isVoted = true;
				}
			} else {
				const vote = await this.pollVotesRepository.findOneBy({
					userId: meId,
					noteId: note.id,
				});

				if (vote) {
					choices[vote.choice].isVoted = true;
				}
			}
		}

		return {
			multiple: poll.multiple,
			expiresAt: poll.expiresAt?.toISOString() ?? null,
			choices,
		};
	}

	@bindThis
	public async populateMyReaction(note: { id: MiNote['id']; reactions: MiNote['reactions']; reactionAndUserPairCache?: MiNote['reactionAndUserPairCache']; }, meId: MiUser['id'], _hint_?: {
		myReactions: Map<MiNote['id'], string | null>;
	}) {
		if (_hint_?.myReactions) {
			const reaction = _hint_.myReactions.get(note.id);
			if (reaction) {
				return this.reactionService.convertLegacyReaction(reaction);
			} else {
				return undefined;
			}
		}

		const reactionsCount = Object.values(note.reactions).reduce((a, b) => a + b, 0);
		if (reactionsCount === 0) return undefined;
		if (note.reactionAndUserPairCache && reactionsCount <= note.reactionAndUserPairCache.length) {
			const pair = note.reactionAndUserPairCache.find(p => p.startsWith(meId));
			if (pair) {
				return this.reactionService.convertLegacyReaction(pair.split('/')[1]);
			} else {
				return undefined;
			}
		}

		// パフォーマンスのためノートが作成されてから2秒以上経っていない場合はリアクションを取得しない
		if (this.idService.parse(note.id).date.getTime() + 2000 > Date.now()) {
			return undefined;
		}

		const reaction = await this.noteReactionsRepository.findOneBy({
			userId: meId,
			noteId: note.id,
		});

		if (reaction) {
			return this.reactionService.convertLegacyReaction(reaction.reaction);
		}

		return undefined;
	}

	@bindThis
	public async isVisibleForMe(note: MiNote, meId: MiUser['id'] | null): Promise<boolean> {
		// This code must always be synchronized with the checks in QueryService.generateVisibilityQuery.
		// visibility が specified かつ自分が指定されていなかったら非表示
		if (note.visibility === 'specified') {
			if (meId == null) {
				return false;
			} else if (meId === note.userId) {
				return true;
			} else {
				// 指定されているかどうか
				return note.visibleUserIds.some(id => meId === id);
			}
		}

		// visibility が followers かつ自分が投稿者のフォロワーでなかったら非表示
		if (note.visibility === 'followers') {
			if (meId == null) {
				return false;
			} else if (meId === note.userId) {
				return true;
			} else if (note.reply && (meId === note.reply.userId)) {
				// 自分の投稿に対するリプライ
				return true;
			} else if (note.mentions && note.mentions.some(id => meId === id)) {
				// 自分へのメンション
				return true;
			} else {
				// フォロワーかどうか
				const [following, user] = await Promise.all([
					this.followingsRepository.count({
						where: {
							followeeId: note.userId,
							followerId: meId,
						},
						take: 1,
					}),
					this.usersRepository.findOneByOrFail({ id: meId }),
				]);

				/* If we know the following, everyhting is fine.

				But if we do not know the following, it might be that both the
				author of the note and the author of the like are remote users,
				in which case we can never know the following. Instead we have
				to assume that the users are following each other.
				*/
				return following > 0 || (note.userHost != null && user.host != null);
			}
		}

		return true;
	}

	@bindThis
	public async packAttachedFiles(fileIds: MiNote['fileIds'], packedFiles: Map<MiNote['fileIds'][number], Packed<'DriveFile'> | null>): Promise<Packed<'DriveFile'>[]> {
		const missingIds = [];
		for (const id of fileIds) {
			if (!packedFiles.has(id)) missingIds.push(id);
		}
		if (missingIds.length) {
			const additionalMap = await this.driveFileEntityService.packManyByIdsMap(missingIds);
			for (const [k, v] of additionalMap) {
				packedFiles.set(k, v);
			}
		}
		return fileIds.map(id => packedFiles.get(id)).filter(x => x != null);
	}

	@bindThis
	private getReactionEmojiNames(reactions: MiNote['reactions']): string[] {
		return Object.keys(reactions)
			.filter(x => x.startsWith(':') && x.includes('@') && !x.includes('@.')) // リモートカスタム絵文字のみ
			.map(x => this.reactionService.decodeReaction(x).reaction.replaceAll(':', ''));
	}

	@bindThis
	private getMergedReactions(note: MiNote, bufferedReactions: Map<MiNote['id'], { deltas: Record<string, number>; pairs: ([MiUser['id'], string])[] }> | null): MiNote['reactions'] {
		const deltas = bufferedReactions?.get(note.id)?.deltas ?? {};
		return this.reactionService.convertLegacyReactions(this.reactionsBufferingService.mergeReactions(note.reactions, deltas));
	}

	@bindThis
	private async getViewerRoleIds(meId: MiUser['id']): Promise<Set<MiRole['id']>> {
		const roles = await this.roleService.getUserRoles(meId);
		return new Set(roles.map(role => role.id));
	}

	/**
	 * 候補マップが与えられていればそれを使い、参照に対するローカル絵文字名の対応を組み立てる。
	 * DBアクセスは行わない（候補マップとビューアロールは呼び出し元で用意する）。
	 */
	@bindThis
	private buildReactionLocalEmojis(
		note: MiNote,
		reactionEmojiNames: string[],
		meId: MiUser['id'] | null,
		viewerRoleIds: ReadonlySet<MiRole['id']> | null,
		candidatesMap: ReadonlyMap<string, ReactionLocalEmojiCandidate[]>,
	): Record<string, string> {
		if (meId == null) return {};
		if (note.reactionAcceptance === 'likeOnly') return {};

		const result: Record<string, string> = {};
		for (const ref of reactionEmojiNames) {
			const selected = selectReactionLocalEmoji(candidatesMap.get(ref) ?? [], {
				noteUserHost: note.userHost,
				reactionAcceptance: note.reactionAcceptance,
				viewerRoleIds,
			});
			if (selected != null) result[ref] = selected;
		}
		return result;
	}

	/**
	 * pack から呼ばれるリアクション→ローカル絵文字名の解決。
	 * hint があればそこから候補・ロールを再利用し、不足分だけバウンドされた1クエリで補う（N+1回避）。
	 */
	@bindThis
	private async resolveReactionLocalEmojis(
		note: MiNote,
		reactions: MiNote['reactions'],
		meId: MiUser['id'] | null,
		hint?: {
			viewerRoleIds?: Set<MiRole['id']> | null;
			reactionLocalEmojiCandidates?: Map<string, ReactionLocalEmojiCandidate[]>;
			reactionLocalEmojiCandidatesPending?: Map<string, Promise<void>>;
		},
	): Promise<Record<string, string>> {
		if (meId == null) return {};
		if (note.reactionAcceptance === 'likeOnly') return {};

		const reactionEmojiNames = this.getReactionEmojiNames(reactions);
		if (reactionEmojiNames.length === 0) return {};

		let viewerRoleIds = hint?.viewerRoleIds;
		if (viewerRoleIds === undefined) {
			viewerRoleIds = await this.getViewerRoleIds(meId);
			if (hint) hint.viewerRoleIds = viewerRoleIds;
		}

		const candidatesMap = hint?.reactionLocalEmojiCandidates ?? new Map<string, ReactionLocalEmojiCandidate[]>();
		const pendingMap = hint?.reactionLocalEmojiCandidatesPending ?? new Map<string, Promise<void>>();
		if (hint) {
			hint.reactionLocalEmojiCandidates = candidatesMap;
			hint.reactionLocalEmojiCandidatesPending = pendingMap;
		}

		while (reactionEmojiNames.some(ref => !candidatesMap.has(ref))) {
			const missing = reactionEmojiNames.filter(ref => !candidatesMap.has(ref));
			const owned = missing.filter(ref => !pendingMap.has(ref));
			if (owned.length > 0) {
				// Publish ownership before yielding so concurrently packed reply/renote paths join this lookup.
				const lookup = Promise.resolve().then(async () => {
					const additional = await this.customEmojiService.getReactionLocalEmojiCandidates(owned);
					for (const ref of owned) {
						candidatesMap.set(ref, additional.get(ref) ?? []);
					}
				});
				for (const ref of owned) pendingMap.set(ref, lookup);
				void lookup.then(
					() => { for (const ref of owned) if (pendingMap.get(ref) === lookup) pendingMap.delete(ref); },
					() => { for (const ref of owned) if (pendingMap.get(ref) === lookup) pendingMap.delete(ref); },
				);
				await lookup;
			} else {
				await Promise.all([...new Set(missing.map(ref => pendingMap.get(ref)!))]);
			}
		}

		return this.buildReactionLocalEmojis(note, reactionEmojiNames, meId, viewerRoleIds, candidatesMap);
	}

	@bindThis
	public async pack(
		src: MiNote['id'] | MiNote,
		me?: { id: MiUser['id'] } | null | undefined,
		options?: {
			detail?: boolean;
			skipHide?: boolean;
			withReactionAndUserPairCache?: boolean;
			_hint_?: {
				bufferedReactions: Map<MiNote['id'], { deltas: Record<string, number>; pairs: ([MiUser['id'], string])[] }> | null;
				myReactions: Map<MiNote['id'], string | null>;
				packedFiles: Map<MiNote['fileIds'][number], Packed<'DriveFile'> | null>;
				packedUsers: Map<MiUser['id'], Packed<'UserLite'>>
				viewerRoleIds?: Set<MiRole['id']> | null;
				reactionLocalEmojiCandidates?: Map<string, ReactionLocalEmojiCandidate[]>;
				reactionLocalEmojiCandidatesPending?: Map<string, Promise<void>>;
			};
		},
	): Promise<Packed<'Note'>> {
		const opts = Object.assign({
			detail: true,
			skipHide: false,
			withReactionAndUserPairCache: false,
		}, options);

		const meId = me ? me.id : null;
		const note = typeof src === 'object' ? src : await this.noteLoader.load(src);
		const host = note.userHost;

		const bufferedReactions = opts._hint_?.bufferedReactions != null
			? (opts._hint_.bufferedReactions.get(note.id) ?? { deltas: {}, pairs: [] })
			: this.meta.enableReactionsBuffering
				? await this.reactionsBufferingService.get(note.id)
				: { deltas: {}, pairs: [] };
		const reactions = this.reactionService.convertLegacyReactions(this.reactionsBufferingService.mergeReactions(note.reactions, bufferedReactions.deltas ?? {}));

		const reactionAndUserPairCache = note.reactionAndUserPairCache.concat(bufferedReactions.pairs.map(x => x.join('/')));

		let text = note.text;

		if (note.name && (note.url ?? note.uri)) {
			text = `【${note.name}】\n${(note.text ?? '').trim()}\n\n${note.url ?? note.uri}`;
		}

		const channel = note.channelId
			? note.channel
				? note.channel
				: await this.channelsRepository.findOneBy({ id: note.channelId })
			: null;

		const reactionEmojiNames = this.getReactionEmojiNames(reactions);
		const packedFiles = options?._hint_?.packedFiles;
		const packedUsers = options?._hint_?.packedUsers;

		const packed: Packed<'Note'> = await awaitAll({
			id: note.id,
			createdAt: this.idService.parse(note.id).date.toISOString(),
			userId: note.userId,
			user: packedUsers?.get(note.userId) ?? this.userEntityService.pack(note.user ?? note.userId, me),
			text: text,
			cw: note.cw,
			visibility: note.visibility,
			localOnly: note.localOnly,
			reactionAcceptance: note.reactionAcceptance,
			visibleUserIds: note.visibility === 'specified' ? note.visibleUserIds : undefined,
			renoteCount: note.renoteCount,
			repliesCount: note.repliesCount,
			reactionCount: Object.values(reactions).reduce((a, b) => a + b, 0),
			reactions: reactions,
			reactionEmojis: this.customEmojiService.populateEmojis(reactionEmojiNames, host),
			reactionLocalEmojis: this.resolveReactionLocalEmojis(note, reactions, meId, options?._hint_),
			reactionAndUserPairCache: opts.withReactionAndUserPairCache ? reactionAndUserPairCache : undefined,
			emojis: host != null ? this.customEmojiService.populateEmojis(note.emojis, host) : undefined,
			tags: note.tags.length > 0 ? note.tags : undefined,
			fileIds: note.fileIds,
			files: packedFiles != null ? this.packAttachedFiles(note.fileIds, packedFiles) : this.driveFileEntityService.packManyByIds(note.fileIds),
			replyId: note.replyId,
			renoteId: note.renoteId,
			channelId: note.channelId ?? undefined,
			channel: channel ? {
				id: channel.id,
				name: channel.name,
				color: channel.color,
				isSensitive: channel.isSensitive,
				allowRenoteToExternal: channel.allowRenoteToExternal,
				userId: channel.userId,
			} : undefined,
			mentions: note.mentions.length > 0 ? note.mentions : undefined,
			hasPoll: note.hasPoll || undefined,
			uri: note.uri ?? undefined,
			url: note.url ?? undefined,
			isNoteInHanaMode: note.isNoteInHanaMode,

			...(opts.detail ? {
				clippedCount: note.clippedCount,

				// そもそもJOINしていない場合はundefined、JOINしたけど存在していなかった場合はnullで区別される
				reply: (note.replyId && note.reply === null) ? null : note.replyId ? nullIfEntityNotFound(this.pack(note.reply ?? note.replyId, me, {
					detail: false,
					skipHide: opts.skipHide,
					withReactionAndUserPairCache: opts.withReactionAndUserPairCache,
					_hint_: options?._hint_,
				})) : undefined,

				// そもそもJOINしていない場合はundefined、JOINしたけど存在していなかった場合はnullで区別される
				renote: (note.renoteId && note.renote === null) ? null : note.renoteId ? nullIfEntityNotFound(this.pack(note.renote ?? note.renoteId, me, {
					detail: true,
					skipHide: opts.skipHide,
					withReactionAndUserPairCache: opts.withReactionAndUserPairCache,
					_hint_: options?._hint_,
				})) : undefined,

				poll: note.hasPoll ? this.populatePoll(note, meId) : undefined,

				...(meId && Object.keys(reactions).length > 0 ? {
					myReaction: this.populateMyReaction({
						id: note.id,
						reactions: reactions,
						reactionAndUserPairCache: reactionAndUserPairCache,
					}, meId, options?._hint_),
				} : {}),
			} : {}),
		});

		this.treatVisibility(packed);

		if (!opts.skipHide && await this.shouldHideNote(packed, meId)) {
			this.hideNote(packed);
		}

		return packed;
	}

	@bindThis
	public async packMany(
		notes: MiNote[],
		me?: { id: MiUser['id'] } | null | undefined,
		options?: {
			detail?: boolean;
			skipHide?: boolean;
			withReactionAndUserPairCache?: boolean;
		},
	) {
		if (notes.length === 0) return [];

		const bufferedReactions = this.meta.enableReactionsBuffering ? await this.reactionsBufferingService.getMany([...getAppearNoteIds(notes)]) : null;

		const meId = me ? me.id : null;
		const myReactionsMap = new Map<MiNote['id'], string | null>();
		if (meId) {
			const idsNeedFetchMyReaction = new Set<MiNote['id']>();

			// パフォーマンスのためノートが作成されてから2秒以上経っていない場合はリアクションを取得しない
			const oldId = this.idService.gen(Date.now() - 2000);

			for (const note of notes) {
				if (isPureRenote(note)) {
					const reactionsCount = Object.values(this.reactionsBufferingService.mergeReactions(note.renote.reactions, bufferedReactions?.get(note.renote.id)?.deltas ?? {})).reduce((a, b) => a + b, 0);
					if (reactionsCount === 0) {
						myReactionsMap.set(note.renote.id, null);
					} else if (reactionsCount <= note.renote.reactionAndUserPairCache.length + (bufferedReactions?.get(note.renote.id)?.pairs.length ?? 0)) {
						const pairInBuffer = bufferedReactions?.get(note.renote.id)?.pairs.find(p => p[0] === meId);
						if (pairInBuffer) {
							myReactionsMap.set(note.renote.id, pairInBuffer[1]);
						} else {
							const pair = note.renote.reactionAndUserPairCache.find(p => p.startsWith(meId));
							myReactionsMap.set(note.renote.id, pair ? pair.split('/')[1] : null);
						}
					} else {
						idsNeedFetchMyReaction.add(note.renote.id);
					}
				} else {
					if (note.id < oldId) {
						const reactionsCount = Object.values(this.reactionsBufferingService.mergeReactions(note.reactions, bufferedReactions?.get(note.id)?.deltas ?? {})).reduce((a, b) => a + b, 0);
						if (reactionsCount === 0) {
							myReactionsMap.set(note.id, null);
						} else if (reactionsCount <= note.reactionAndUserPairCache.length + (bufferedReactions?.get(note.id)?.pairs.length ?? 0)) {
							const pairInBuffer = bufferedReactions?.get(note.id)?.pairs.find(p => p[0] === meId);
							if (pairInBuffer) {
								myReactionsMap.set(note.id, pairInBuffer[1]);
							} else {
								const pair = note.reactionAndUserPairCache.find(p => p.startsWith(meId));
								myReactionsMap.set(note.id, pair ? pair.split('/')[1] : null);
							}
						} else {
							idsNeedFetchMyReaction.add(note.id);
						}
					} else {
						myReactionsMap.set(note.id, null);
					}
				}
			}

			const myReactions = idsNeedFetchMyReaction.size > 0 ? await this.noteReactionsRepository.findBy({
				userId: meId,
				noteId: In(Array.from(idsNeedFetchMyReaction)),
			}) : [];

			for (const id of idsNeedFetchMyReaction) {
				myReactionsMap.set(id, myReactions.find(reaction => reaction.noteId === id)?.reaction ?? null);
			}
		}

		await this.customEmojiService.prefetchEmojis(this.aggregateNoteEmojis(notes));
		// TODO: 本当は renote とか reply がないのに renoteId とか replyId があったらここで解決しておく
		const fileIds = notes.map(n => [n.fileIds, n.renote?.fileIds, n.reply?.fileIds]).flat(2).filter(x => x != null);
		const packedFiles = fileIds.length > 0 ? await this.driveFileEntityService.packManyByIdsMap(fileIds) : new Map();
		const users = [
			...notes.map(({ user, userId }) => user ?? userId),
			...notes.map(({ replyUserId }) => replyUserId).filter(x => x != null),
			...notes.map(({ renoteUserId }) => renoteUserId).filter(x => x != null),
		];
		const packedUsers = await this.userEntityService.packMany(users, me)
			.then(users => new Map(users.map(u => [u.id, u])));

		// reactionLocalEmojis: ビューアロールとリモートリアクション参照の候補を一度だけまとめて解決する
		let viewerRoleIds: Set<MiRole['id']> | null = null;
		let reactionLocalEmojiCandidates: Map<string, ReactionLocalEmojiCandidate[]> | undefined;
		const reactionLocalEmojiCandidatesPending = new Map<string, Promise<void>>();
		if (meId != null) {
			viewerRoleIds = await this.getViewerRoleIds(meId);

			const reactionEmojiNamesSet = new Set<string>();
			for (const note of notes) {
				for (const name of this.getReactionEmojiNames(this.getMergedReactions(note, bufferedReactions))) {
					reactionEmojiNamesSet.add(name);
				}
				if (note.renote) {
					for (const name of this.getReactionEmojiNames(this.getMergedReactions(note.renote, bufferedReactions))) {
						reactionEmojiNamesSet.add(name);
					}
				}
			}
			if (reactionEmojiNamesSet.size > 0) {
				const refs = [...reactionEmojiNamesSet];
				const candidates = await this.customEmojiService.getReactionLocalEmojiCandidates(refs);
				reactionLocalEmojiCandidates = new Map(refs.map(ref => [ref, candidates.get(ref) ?? []]));
			}
		}

		return await Promise.all(notes.map(n => this.pack(n, me, {
			...options,
			_hint_: {
				bufferedReactions,
				myReactions: myReactionsMap,
				packedFiles,
				packedUsers,
				viewerRoleIds: viewerRoleIds ?? undefined,
				reactionLocalEmojiCandidates,
				reactionLocalEmojiCandidatesPending,
			},
		})));
	}

	@bindThis
	public aggregateNoteEmojis(notes: MiNote[]) {
		let emojis: { name: string | null; host: string | null; }[] = [];
		for (const note of notes) {
			emojis = emojis.concat(note.emojis
				.map(e => this.customEmojiService.parseEmojiStr(e, note.userHost)));
			if (note.renote) {
				emojis = emojis.concat(note.renote.emojis
					.map(e => this.customEmojiService.parseEmojiStr(e, note.renote!.userHost)));
				if (note.renote.user) {
					emojis = emojis.concat(note.renote.user.emojis
						.map(e => this.customEmojiService.parseEmojiStr(e, note.renote!.userHost)));
				}
			}
			const customReactions = Object.keys(note.reactions).map(x => this.reactionService.decodeReaction(x)).filter(x => x.name != null) as typeof emojis;
			emojis = emojis.concat(customReactions);
			if (note.user) {
				emojis = emojis.concat(note.user.emojis
					.map(e => this.customEmojiService.parseEmojiStr(e, note.userHost)));
			}
		}
		return emojis.filter(x => x.name != null && x.host != null) as { name: string; host: string; }[];
	}

	@bindThis
	private findNoteOrFail(id: string): Promise<MiNote> {
		return this.notesRepository.findOneOrFail({
			where: { id },
			relations: ['user', 'renote', 'reply'],
		});
	}

	@bindThis
	public async fetchDiffs(noteIds: MiNote['id'][], me?: { id: MiUser['id'] } | null) {
		if (noteIds.length === 0) return [];

		const notes = await this.notesRepository.find({
			where: {
				id: In(noteIds),
			},
			select: {
				id: true,
				userHost: true,
				reactions: true,
				reactionAndUserPairCache: true,
				reactionAcceptance: true,
			},
		});

		const bufferedReactionsMap = this.meta.enableReactionsBuffering ? await this.reactionsBufferingService.getMany(noteIds) : null;

		const meId = me ? me.id : null;

		// ビューアロールと候補を一度だけ解決して使い回す（最大100ノート分をまとめて）
		let viewerRoleIds: Set<MiRole['id']> | null = null;
		let candidatesMap = new Map<string, ReactionLocalEmojiCandidate[]>();
		if (meId != null) {
			viewerRoleIds = await this.getViewerRoleIds(meId);

			const reactionEmojiNamesSet = new Set<string>();
			for (const note of notes) {
				const reactions = this.getMergedReactions(note, bufferedReactionsMap);
				for (const name of this.getReactionEmojiNames(reactions)) {
					reactionEmojiNamesSet.add(name);
				}
			}
			if (reactionEmojiNamesSet.size > 0) {
				const refs = [...reactionEmojiNamesSet];
				const candidates = await this.customEmojiService.getReactionLocalEmojiCandidates(refs);
				candidatesMap = new Map(refs.map(ref => [ref, candidates.get(ref) ?? []]));
			}
		}

		const packings = notes.map(note => {
			const bufferedReactions = bufferedReactionsMap?.get(note.id);
			//const reactionAndUserPairCache = note.reactionAndUserPairCache.concat(bufferedReactions.pairs.map(x => x.join('/')));

			const reactions = this.reactionService.convertLegacyReactions(this.reactionsBufferingService.mergeReactions(note.reactions, bufferedReactions?.deltas ?? {}));

			const reactionEmojiNames = this.getReactionEmojiNames(reactions);

			return this.customEmojiService.populateEmojis(reactionEmojiNames, note.userHost).then(reactionEmojis => ({
				id: note.id,
				reactions,
				reactionEmojis,
				reactionLocalEmojis: this.buildReactionLocalEmojis(note, reactionEmojiNames, meId, viewerRoleIds, candidatesMap),
			}));
		});

		return await Promise.all(packings);
	}
}
