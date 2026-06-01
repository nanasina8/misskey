/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { FollowingsRepository, NotesRepository, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';

// FoF 探索の上限（自分のフォロイー数 / 中継経由のフォロイー数）。小規模前提で過剰探索しない。
const MAX_SEED_FOLLOWEES = 200;
const MAX_FOF_SCAN = 2000;
const FOF_NOTES_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 3; // 直近3日のノートを候補に

export type FollowCandidate = { userId: string; score: number; reason: 'fof' | 'similar'; mutualCount: number };

/**
 * 類似ユーザー / FoF（[[hanami-tl-osusume-redesign]] step9）と、フォロー候補（step10）。
 *
 * v1: FoF（友達の友達）を主軸にする。中継となる相互フォロイーが多いほど高スコア。
 * 類似ユーザー（Jaccard）は FoF 集合内での軽い補正として加える（フル比較はしない＝小規模で十分）。
 * 純粋RN/チャンネル投稿は候補ノートに含めない（はなみTL注入ポリシーと一致）。
 */
@Injectable()
export class HanamiUserRecommendationService {
	constructor(
		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private cacheService: CacheService,
		private idService: IdService,
	) {
	}

	/**
	 * 自分が直接フォローしているユーザーID集合（ローカルキャッシュ）。
	 */
	@bindThis
	private async getMyFolloweeIds(meId: MiUser['id']): Promise<Set<string>> {
		const followings = await this.cacheService.userFollowingsCache.fetch(meId);
		return new Set(Object.keys(followings));
	}

	/**
	 * FoF ユーザーをスコア付きで返す。score = 中継となる自分のフォロイー数（相互経路数）。
	 * 既にフォロー済み・自分・ブロック/ミュート相手は除外。
	 */
	@bindThis
	public async getFoFUserScores(meId: MiUser['id']): Promise<Map<string, FollowCandidate>> {
		const followeeIds = Array.from(await this.getMyFolloweeIds(meId)).slice(0, MAX_SEED_FOLLOWEES);
		const result = new Map<string, FollowCandidate>();
		if (followeeIds.length === 0) return result;

		const [muting, blocking] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(meId),
			this.cacheService.userBlockingCache.fetch(meId),
		]);
		const exclude = new Set<string>([meId, ...followeeIds, ...muting, ...blocking]);

		// 自分のフォロイーたちがフォローしている相手を集める。followeeId はローカル/リモートどちらも含む。
		const rows = await this.followingsRepository.createQueryBuilder('f')
			.select('f.followeeId', 'followeeId')
			.where('f.followerId IN (:...seed)', { seed: followeeIds })
			.limit(MAX_FOF_SCAN)
			.getRawMany<{ followeeId: string }>();

		for (const { followeeId } of rows) {
			if (exclude.has(followeeId)) continue;
			const cur = result.get(followeeId);
			if (cur) {
				cur.mutualCount++;
				cur.score = cur.mutualCount;
			} else {
				result.set(followeeId, { userId: followeeId, score: 1, reason: 'fof', mutualCount: 1 });
			}
		}
		return result;
	}

	/**
	 * フォロー候補（step10 のフォロー候補表示用）。FoF をスコア順に返す。
	 */
	@bindThis
	public async getFollowCandidates(meId: MiUser['id'], limit: number): Promise<FollowCandidate[]> {
		const scores = await this.getFoFUserScores(meId);
		return Array.from(scores.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	/**
	 * FoF ユーザーの最近ノートを推薦候補として返す（noteId と理由のユーザー）。
	 * チャンネル投稿・純粋RNは除外、public/home のみ。
	 */
	@bindThis
	public async getFoFNoteIds(meId: MiUser['id'], limit: number): Promise<{ noteId: string; userId: string }[]> {
		const candidates = await this.getFollowCandidates(meId, 40);
		if (candidates.length === 0) return [];

		const userIds = candidates.map(c => c.userId);
		// 直近 FOF_NOTES_LOOKBACK_MS の境界を、設定中のID方式で正しく生成する
		const sinceId = this.idService.gen(Date.now() - FOF_NOTES_LOOKBACK_MS);

		const notes = await this.notesRepository.createQueryBuilder('note')
			.select(['note.id AS id', 'note.userId AS "userId"'])
			.where('note.userId IN (:...userIds)', { userIds })
			.andWhere('note.id > :sinceId', { sinceId })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.andWhere(new Brackets(qb => {
				// 純粋RN除外（引用RN・本文/メディア/投票つきは許可）
				qb.where('note.renoteId IS NULL')
					.orWhere('note.text IS NOT NULL')
					.orWhere('note.fileIds != \'{}\'');
			}))
			.orderBy('note.id', 'DESC')
			.limit(limit * 3)
			.getRawMany<{ id: string; userId: string }>();

		// スコア順（候補ユーザーのスコア順）でノートを並べる
		const rank = new Map(candidates.map((c, i) => [c.userId, i]));
		notes.sort((a, b) => (rank.get(a.userId) ?? 1e9) - (rank.get(b.userId) ?? 1e9));
		return notes.slice(0, limit).map(n => ({ noteId: n.id, userId: n.userId }));
	}
}
