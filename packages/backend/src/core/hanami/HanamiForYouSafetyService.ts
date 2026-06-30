/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { NotesRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { RoleService } from '@/core/RoleService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { removeMutedUsersReactions } from '@/misc/reactions-mute.js';
import { checkWordMute } from '@/misc/check-word-mute.js';

/**
 * はなみ For You の safety filter 中央化（canonical spec §8）。
 *
 * 候補 noteId を interleave 順で DB 取得→ §8 全項目を通す→ pack。落ちた分は順に backfill して limit まで埋める（§6.1-7）。
 *
 * §8 全項目:
 *  - visibility public/home 限定（followers-only・specified・private 除外）
 *  - reply・renote 元の可視性（public/home のみ）
 *  - block（双方向）/ mute / instance mute
 *  - muted word（mutedWords＋hardMutedWords）
 *  - CW 除外 / sensitive media 除外
	 *  - pure renote 除外 / channel note 除外
	 *  - suspended 除外 / silenced 除外（= role policy canPublicNote=false）
	 *  - seen 除外（interleave 側で served/seen を除外済）
	 */
@Injectable()
export class HanamiForYouSafetyService {
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private queryService: QueryService,
		private cacheService: CacheService,
		private roleService: RoleService,
		private noteEntityService: NoteEntityService,
	) {
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
			.andWhere('note.cw IS NULL') // CW 除外（§8）
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

		// silenced 除外（= role policy canPublicNote=false。§8。現状未実装だったので追加）。
		// 引用RN/返信の元作者が silenced のケースも除外する（wrapper だけでなく元も見る）。
		const authorIds = [...new Set(candidates.flatMap(n => [n.userId, n.renote?.userId, n.reply?.userId].filter((x): x is string => x != null)))];
		const silenced = new Set<string>();
		await Promise.all(authorIds.map(async id => {
			const policies = await this.roleService.getUserPolicies(id);
			if (!policies.canPublicNote) silenced.add(id);
		}));
		candidates = candidates.filter(n => !silenced.has(n.userId) && !(n.renote != null && silenced.has(n.renote.userId)) && !(n.reply != null && silenced.has(n.reply.userId)));

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

		// sensitive media 除外（§8）。pack 後の files で判定（添付に sensitive があれば丸ごと落とす）。引用RN元の添付も見る。
		const safe = packed.filter(note => !(note.files ?? []).some(f => f.isSensitive) && !(note.renote?.files ?? []).some(f => f.isSensitive));

		await Promise.all(safe.map(note => removeMutedUsersReactions(note, userIdsWhoMeMuting)));
		return safe.slice(0, limit);
	}
}
