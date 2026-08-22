/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets, type QueryRunner, type SelectQueryBuilder } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { NotesRepository } from '@/models/_.js';
import { MiNote } from '@/models/Note.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { removeMutedUsersReactions } from '@/misc/reactions-mute.js';
import { checkWordMute } from '@/misc/check-word-mute.js';
import { pureRenoteSql } from '@/misc/is-renote.js';
import type { HanamiPersonalFeedCandidate, HanamiPersonalFeedComputationInput } from '@/core/hanami/HanamiUserFeedContracts.js';
import type { HanamiTimelinePackingInput, HanamiTimelinePackingOutput } from '@/core/hanami/HanamiTimelineContracts.js';

export type HanamiPersonalGenerationSafetyInput = Pick<HanamiPersonalFeedComputationInput, 'userId' | 'signal'> & {
	readonly candidates: readonly HanamiPersonalFeedCandidate[];
	readonly queryRunner?: QueryRunner;
};

/**
 * はなみ For You の safety filter 中央化（canonical spec §8）。
 *
 * 2段構え:
 *  - filterGloballySafeIds: interleave の【前】に候補を noteベースのグローバル安全＋ユーザーのメディア設定で絞る。
 *    除外で空いた枠は interleave が他候補で埋め直す＝hideSensitive/hideMedia でもページが痩せない。
 *  - filterAndPack: interleave の【後】に個別ユーザー項目(mute/block/word/instance)＋pack。
 *
 * 落とす: visibility public/home 限定 / reply・renote 元の可視性 / block(双方向)・mute・instance mute /
 *   muted word / pure renote / channel note / suspended / blocked host /
 *   メディア（ユーザーの exploreMediaFilter: all=表示 / hideSensitive / hideMedia）。
 * 落とさない: CW（クライアント折りたたみ）・silenced（拡散抑制はするが For You では除外しない＝運用方針）。
 */
@Injectable()
export class HanamiForYouSafetyService {
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private queryService: QueryService,
		private cacheService: CacheService,
		private noteEntityService: NoteEntityService,
	) {
	}

	// メディアフィルタ（ユーザー設定 exploreMediaFilter）。For You 候補は channelId IS NULL 前提なので channel.isSensitive は見ない。
	// 引用RNは元ノートの添付も画面に出るため、wrapper(note) と元(renote) の両方を見る。
	private applyMediaFilter(query: SelectQueryBuilder<MiNote>, mediaFilter: string): void {
		if (mediaFilter === 'hideMedia') {
			query
				.andWhere('NOT EXISTS (SELECT 1 FROM "drive_file" df WHERE df.id = ANY(note."fileIds") AND (df."type" LIKE \'image/%\' OR df."type" LIKE \'video/%\'))')
				.andWhere('NOT EXISTS (SELECT 1 FROM "drive_file" df WHERE df.id = ANY(renote."fileIds") AND (df."type" LIKE \'image/%\' OR df."type" LIKE \'video/%\'))');
		} else if (mediaFilter === 'hideSensitive') {
			query
				.andWhere('NOT EXISTS (SELECT 1 FROM "drive_file" df WHERE df.id = ANY(note."fileIds") AND df."isSensitive" = true)')
				.andWhere('NOT EXISTS (SELECT 1 FROM "drive_file" df WHERE df.id = ANY(renote."fileIds") AND df."isSensitive" = true)');
		}
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted !== true) return;
		if (signal.reason !== undefined) throw signal.reason;
		const error = new Error('The operation was aborted');
		error.name = 'AbortError';
		throw error;
	}

	private noteQueryBuilder(queryRunner?: QueryRunner): SelectQueryBuilder<MiNote> {
		return queryRunner == null
			? this.notesRepository.createQueryBuilder('note')
			: queryRunner.manager.getRepository(MiNote).createQueryBuilder('note');
	}

	private async generationMediaFilter(userId: string, signal: AbortSignal, queryRunner?: QueryRunner): Promise<string> {
		this.throwIfAborted(signal);
		if (queryRunner == null) {
			const profile = await this.cacheService.userProfileCache.fetch(userId);
			this.throwIfAborted(signal);
			return profile.exploreMediaFilter;
		}

		const row = await queryRunner.manager.getRepository(MiUserProfile).createQueryBuilder('profile')
			.select('profile.exploreMediaFilter', 'exploreMediaFilter')
			.where('profile.userId = :userId', { userId })
			.limit(1)
			.getRawOne<{ exploreMediaFilter: string }>();
		this.throwIfAborted(signal);
		if (row == null || typeof row.exploreMediaFilter !== 'string') {
			throw new Error(`Hanami generation user profile is missing: ${userId}`);
		}
		return row.exploreMediaFilter;
	}

	private applyHardAuthorAndTargetSafety(query: SelectQueryBuilder<MiNote>): void {
		query
			.andWhere('user.isSuspended = FALSE')
			.andWhere('user.isDeleted = FALSE');
		query.andWhere(new Brackets(qb => {
			qb.where('note.replyId IS NULL').orWhere(new Brackets(target => {
				target.where('reply.id IS NOT NULL')
					.andWhere('reply.visibility IN (\'public\', \'home\')')
					.andWhere('replyUser.id IS NOT NULL')
					.andWhere('replyUser.isSuspended = FALSE')
					.andWhere('replyUser.isDeleted = FALSE');
			}));
		}));
		query.andWhere(new Brackets(qb => {
			qb.where('note.renoteId IS NULL').orWhere(new Brackets(target => {
				target.where('renote.id IS NOT NULL')
					.andWhere('renote.visibility IN (\'public\', \'home\')')
					.andWhere('renoteUser.id IS NOT NULL')
					.andWhere('renoteUser.isSuspended = FALSE')
					.andWhere('renoteUser.isDeleted = FALSE');
			}));
		}));
	}

	private generationEligibilityQuery(noteIds: readonly string[], queryRunner?: QueryRunner): SelectQueryBuilder<MiNote> {
		const query = this.noteQueryBuilder(queryRunner)
			.select('note.id', 'id')
			.addSelect('note.userId', 'authorId')
			.where('note.id IN (:...noteIds)', { noteIds })
			.andWhere('note.channelId IS NULL')
			.andWhere('note.visibility IN (\'public\', \'home\')')
			.andWhere(`NOT (${pureRenoteSql('note')})`)
			.innerJoin('note.user', 'user')
			.leftJoin('note.reply', 'reply')
			.leftJoin('note.renote', 'renote')
			.leftJoin('reply.user', 'replyUser')
			.leftJoin('renote.user', 'renoteUser');

		this.applyHardAuthorAndTargetSafety(query);
		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);
		return query;
	}

	/**
	 * 共通世代向けのユーザー非依存hard eligibility。作者IDも同じsnapshotで解決する。
	 */
	@bindThis
	public async filterCommonEligibleNotes(noteIds: readonly string[], signal?: AbortSignal, queryRunner?: QueryRunner): Promise<ReadonlyMap<string, string>> {
		this.throwIfAborted(signal);
		const uniqueNoteIds = [...new Set(noteIds.filter(noteId => noteId.length > 0))];
		if (uniqueNoteIds.length === 0) return new Map();

		const query = this.generationEligibilityQuery(uniqueNoteIds, queryRunner);
		const rows = await query.getRawMany<{ id: string; authorId: string }>();
		this.throwIfAborted(signal);
		return new Map(rows
			.filter(row => row.id.length > 0 && row.authorId.length > 0)
			.map(row => [row.id, row.authorId]));
	}

	/**
	 * Personal-generation safety over IDs and immutable candidate metadata only.
	 * User-specific relationship/word checks and packing belong to Phase 5 scan-ahead.
	 */
	@bindThis
	public async filterPersonalEligibleCandidates(input: HanamiPersonalGenerationSafetyInput): Promise<readonly HanamiPersonalFeedCandidate[]> {
		this.throwIfAborted(input.signal);
		const noteIds = [...new Set(input.candidates.map(candidate => candidate.noteId).filter(noteId => noteId.length > 0))];
		if (noteIds.length === 0) return [];

		const mediaFilter = await this.generationMediaFilter(input.userId, input.signal, input.queryRunner);

		const query = this.generationEligibilityQuery(noteIds, input.queryRunner);
		this.applyMediaFilter(query, mediaFilter);
		const rows = await query.getRawMany<{ id: string; authorId: string }>();
		this.throwIfAborted(input.signal);

		const authorByNoteId = new Map(rows
			.filter(row => row.id.length > 0 && row.authorId.length > 0)
			.map(row => [row.id, row.authorId]));
		return input.candidates.filter(candidate => authorByNoteId.get(candidate.noteId) === candidate.authorId);
	}

	/**
	 * interleave の【前段】: noteベースのグローバル安全＋ユーザーのメディア設定を通る候補 id の Set を返す。
	 * 個別ユーザー項目(mute/block/word/instance)は含めない（後段 filterAndPack の責務）。
	 * これで除外された枠を interleave が他候補で埋め直すため、hideSensitive/hideMedia でもページが痩せない。
	 */
	@bindThis
	public async filterGloballySafeIds(noteIds: string[], me: MiLocalUser, withFiles: boolean): Promise<Set<string>> {
		if (noteIds.length === 0) return new Set();
		const profile = await this.cacheService.userProfileCache.fetch(me.id);

		const query = this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.where('note.id IN (:...noteIds)', { noteIds })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.innerJoin('note.user', 'user')
			.leftJoin('note.reply', 'reply')
			.leftJoin('note.renote', 'renote')
			.leftJoin('reply.user', 'replyUser')
			.leftJoin('renote.user', 'renoteUser');

		this.applyHardAuthorAndTargetSafety(query);
		query.andWhere(`NOT (${pureRenoteSql('note')})`);
		if (withFiles) query.andWhere('note.fileIds != \'{}\'');

		this.applyMediaFilter(query, profile.exploreMediaFilter);
		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const rows = await query.getRawMany<{ id: string }>();
		return new Set(rows.map(r => r.id));
	}

	/**
	 * orderedNoteIds（interleave 順）を §8 で安全化して pack し、順序を保って最大 limit 件返す。
	 */
	@bindThis
	public async filterAndPack(orderedNoteIds: string[], limit: number, me: MiLocalUser, withFiles: boolean): Promise<Packed<'Note'>[]> {
		if (orderedNoteIds.length === 0) return [];

		const [userIdsWhoMeMuting, userIdsWhoBlockingMe, userIdsWhoMeBlocking, profile] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(me.id),
			this.cacheService.userBlockedCache.fetch(me.id),
			this.cacheService.userBlockingCache.fetch(me.id),
			this.cacheService.userProfileCache.fetch(me.id),
		]);
		const userMutedInstances = new Set(profile.mutedInstances);
		const mutedWords = [...(profile.mutedWords ?? []), ...(profile.hardMutedWords ?? [])];

		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id IN (:...noteIds)', { noteIds: orderedNoteIds })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		// reply・renote 元が削除されたraceも含め、対象Note・作者が現存しhard safetyを通る場合だけ残す。
		this.applyHardAuthorAndTargetSafety(query);

		// 純粋RN除外（引用RN・本文/メディア/投票つきは元ノートとして許可。§8）。
		query.andWhere(`NOT (${pureRenoteSql('note')})`);
		if (withFiles) query.andWhere('note.fileIds != \'{}\'');
		this.applyMediaFilter(query, profile.exploreMediaFilter); // メディアはユーザー設定に従う。CW は落とさない（クライアント折りたたみ）。

		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const fetched = await query.getMany();

		// block/mute/instance mute（§8）。
		let candidates = fetched.filter(note => {
			if (isUserRelated(note, userIdsWhoBlockingMe)) return false;
			if (isUserRelated(note, userIdsWhoMeBlocking)) return false;
			if (isUserRelated(note, userIdsWhoMeMuting)) return false;
			if (isInstanceMuted(note, userMutedInstances)) return false;
			return true;
		});

		// muted word（mutedWords＋hardMutedWords。§8）。引用RN/返信の元テキストも見る。
		if (mutedWords.length > 0) {
			const muted = await Promise.all(candidates.map(async n => (
				await checkWordMute(n, me, mutedWords)
				|| (n.renote != null && await checkWordMute(n.renote, me, mutedWords))
				|| (n.reply != null && await checkWordMute(n.reply, me, mutedWords))
			)));
			candidates = candidates.filter((_, i) => !muted[i]);
		}

		// interleave 順を維持して並べる（safety で落ちた分は自然に backfill される。§6.1-7）。
		const safeMap = new Map(candidates.map(n => [n.id, n]));
		const ordered = orderedNoteIds.flatMap(id => {
			const n = safeMap.get(id);
			return n ? [n] : [];
		});

		const packed = await this.noteEntityService.packMany(ordered, me, { withReactionAndUserPairCache: true });
		// メディア除外は query 側(applyMediaFilter)でユーザー設定に従い適用済。CW/センシティブは既定表示（クライアントがぼかし/折りたたみ）。

		await Promise.all(packed.map(note => removeMutedUsersReactions(note, userIdsWhoMeMuting)));
		return packed.slice(0, limit);
	}

	@bindThis
	public async filterAndPackPublic(orderedNoteIds: string[], me: MiLocalUser | null): Promise<Packed<'Note'>[]> {
		if (orderedNoteIds.length === 0) return [];
		if (me != null) return await this.filterAndPack(orderedNoteIds, orderedNoteIds.length, me, false);

		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id IN (:...noteIds)', { noteIds: orderedNoteIds })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');
		this.applyHardAuthorAndTargetSafety(query);
		query.andWhere(`NOT (${pureRenoteSql('note')})`);
		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const fetched = await query.getMany();
		const safeMap = new Map(fetched.map(note => [note.id, note]));
		const ordered = orderedNoteIds.flatMap(id => {
			const note = safeMap.get(id);
			return note == null ? [] : [note];
		});
		const packed = await this.noteEntityService.packMany(ordered, null, { withReactionAndUserPairCache: true });
		return packed.filter(note => note.isHidden !== true);
	}

	/**
	 * Applies display-time safety while retaining each durable feed occurrence.
	 * The legacy Note-ID API above remains unchanged until all callers migrate.
	 */
	@bindThis
	public async filterAndPackPersistedEntries(input: HanamiTimelinePackingInput): Promise<HanamiTimelinePackingOutput> {
		if (input.entries.length === 0 || input.limit <= 0) return [];

		const [userIdsWhoMeMuting, userIdsWhoBlockingMe, userIdsWhoMeBlocking, profile] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(input.me.id),
			this.cacheService.userBlockedCache.fetch(input.me.id),
			this.cacheService.userBlockingCache.fetch(input.me.id),
			this.cacheService.userProfileCache.fetch(input.me.id),
		]);
		const userMutedInstances = new Set(profile.mutedInstances);
		const mutedWords = [...(profile.mutedWords ?? []), ...(profile.hardMutedWords ?? [])];
		const uniqueNoteIds = [...new Set(input.entries.map(entry => entry.noteId))];

		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id IN (:...noteIds)', { noteIds: uniqueNoteIds })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		this.applyHardAuthorAndTargetSafety(query);
		query.andWhere(`NOT (${pureRenoteSql('note')})`);
		if (input.withFiles) query.andWhere('note.fileIds != \'{}\'');
		this.applyMediaFilter(query, profile.exploreMediaFilter);
		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		let candidates = (await query.getMany()).filter(note => {
			if (isUserRelated(note, userIdsWhoBlockingMe)) return false;
			if (isUserRelated(note, userIdsWhoMeBlocking)) return false;
			if (isUserRelated(note, userIdsWhoMeMuting)) return false;
			if (isInstanceMuted(note, userMutedInstances)) return false;
			return true;
		});

		if (mutedWords.length > 0) {
			const muted = await Promise.all(candidates.map(async note => (
				await checkWordMute(note, input.me, mutedWords)
				|| (note.renote != null && await checkWordMute(note.renote, input.me, mutedWords))
				|| (note.reply != null && await checkWordMute(note.reply, input.me, mutedWords))
			)));
			candidates = candidates.filter((_, index) => !muted[index]);
		}

		const safeByNoteId = new Map(candidates.map(note => [note.id, note]));
		const orderedOccurrences = input.entries.flatMap(entry => {
			const note = safeByNoteId.get(entry.noteId);
			return note == null ? [] : [{ entry, note }];
		}).slice(0, input.limit);
		const packed = await this.noteEntityService.packMany(
			orderedOccurrences.map(occurrence => occurrence.note),
			input.me,
			{ withReactionAndUserPairCache: true },
		);
		if (packed.length !== orderedOccurrences.length) {
			throw new Error('Hanami persisted-entry packing returned an unexpected Note count');
		}

		await Promise.all(packed.map(note => removeMutedUsersReactions(note, userIdsWhoMeMuting)));
		return packed.map((note, index) => ({
			entry: orderedOccurrences[index]!.entry,
			note,
		}));
	}
}
