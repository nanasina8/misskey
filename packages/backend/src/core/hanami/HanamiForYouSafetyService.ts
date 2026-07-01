/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets, type SelectQueryBuilder } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { NotesRepository } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { removeMutedUsersReactions } from '@/misc/reactions-mute.js';
import { checkWordMute } from '@/misc/check-word-mute.js';

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

		query.andWhere(new Brackets(qb => {
			qb.where('note.replyId IS NULL').orWhere('reply.id IS NULL').orWhere('reply.visibility IN (\'public\', \'home\')');
		}));
		query.andWhere(new Brackets(qb => {
			qb.where('note.renoteId IS NULL').orWhere('renote.id IS NULL').orWhere('renote.visibility IN (\'public\', \'home\')');
		}));
		query.andWhere(new Brackets(qb => {
			qb.where('note.renoteId IS NULL')
				.orWhere('note.text IS NOT NULL')
				.orWhere('note.fileIds != \'{}\'')
				.orWhere('note.hasPoll = TRUE');
		}));
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

		// reply・renote 元の可視性（public/home のみ。§8）。元が削除済(join が NULL)なら wrapper を過剰除外しない（suspended helper と同様 id IS NULL を許可）。
		query.andWhere(new Brackets(qb => {
			qb.where('note.replyId IS NULL').orWhere('reply.id IS NULL').orWhere('reply.visibility IN (\'public\', \'home\')');
		}));
		query.andWhere(new Brackets(qb => {
			qb.where('note.renoteId IS NULL').orWhere('renote.id IS NULL').orWhere('renote.visibility IN (\'public\', \'home\')');
		}));

		// 純粋RN除外（引用RN・本文/メディア/投票つきは元ノートとして許可。§8）。
		query.andWhere(new Brackets(qb => {
			qb.where('note.renoteId IS NULL')
				.orWhere('note.text IS NOT NULL')
				.orWhere('note.fileIds != \'{}\'')
				.orWhere('note.hasPoll = TRUE');
		}));
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
}
