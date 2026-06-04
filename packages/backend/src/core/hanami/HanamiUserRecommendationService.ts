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

// ───── seed（FoF探索の起点になる自分のフォロイー）の選び方（[[hanami-rec-redesign-v2]] 案1） ─────
// 全フォロイーは「除外」には全数使うが、FoF 探索 seed は重み上位 MAX_SEED_FOLLOWEES 件に絞る。
const MAX_SEED_FOLLOWEES = 200;
// FoF 探索で走査する following 行の上限。
const MAX_FOF_SCAN = 4000;
// mutual / followback 判定用に取得する自分のフォロワー上限。
const MAX_MY_FOLLOWERS = 5000;
// 直近どれだけのノートを候補にするか。
const FOF_NOTES_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 3; // 直近3日
// ノート取得に使う候補ユーザー数 / 品質落ち分のオーバーフェッチ。
const FOF_CANDIDATE_POOL = 40;
const FOF_USER_OVERFETCH = 5;

// seed 重み（案1）。すべて提案値・ここ一箇所で調整可。
const SEED_BASE_WEIGHT = 1.0;
const SEED_MUTUAL_BOOST = 1.0; // 相互フォローの中継者は親密として重く
const SEED_WITHREPLIES_BONUS = 0.5; // 返信まで見ている相手（より関心が高い）

// 候補スコアの補正（案2）。提案値。
const FOLLOWBACK_BOOST = 1.3; // 候補が自分をフォロー中（フォロバ候補）
const LOCKED_PENALTY = 0.5; // 鍵アカウントは低め（除外まではしない）

// FoF ノートスコア（案3）。提案値。
const FOF_NOTE_REPLY_PENALTY = 0.5; // 返信は半分（決定4）
const FOF_NOTE_RECENCY = [
	{ withinMs: 1000 * 60 * 60 * 12, weight: 1.0 }, // 12h以内
	{ withinMs: 1000 * 60 * 60 * 24, weight: 0.75 }, // 24h以内
	{ withinMs: FOF_NOTES_LOOKBACK_MS, weight: 0.45 }, // 72h以内
] as const;

export type FollowCandidate = { userId: string; score: number; reason: 'fof' | 'similar'; mutualCount: number };
export type FoFNote = { noteId: string; userId: string; score: number };

/**
 * 仲間内（FoF / フォロー候補）推薦（[[hanami-tl-osusume-redesign]] step9/10、改善は [[hanami-rec-redesign-v2]] 案1-3）。
 *
 * v2:
 *  - seed は「相互フォロー / withReplies」を重く重み付けして上位を採用（slice の偏りを解消）。
 *  - 既フォローは全数除外（slice 前の全 followee で除外集合を作る）。
 *  - 候補は bot/suspended/deleted/非explorable を除外、鍵は減点、人気は log で軽く正規化（サークル内人気を出す）。
 *  - mute/block/被block/インスタンスミュートを尊重。
 *  - ノートは作者スコア × 新鮮さ × 可視性 × エンゲージ × 返信0.5x で並べ替える。
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
	 * 自分のフォロワーID集合（mutual / followback 判定用）。フォロワーキャッシュは無いので1クエリで取得。
	 */
	@bindThis
	private async getMyFollowerIds(meId: MiUser['id']): Promise<Set<string>> {
		const rows = await this.followingsRepository.createQueryBuilder('f')
			.select('f.followerId', 'followerId')
			.where('f.followeeId = :meId', { meId })
			.limit(MAX_MY_FOLLOWERS)
			.getRawMany<{ followerId: string }>();
		return new Set(rows.map(r => r.followerId));
	}

	/**
	 * FoF ユーザーをスコア付きで返す（案1-2）。
	 * score = Σ(seed重み for その候補をフォローしている seed) / log10(followers) × フォロバ補正 × 鍵補正。
	 * 既フォロー・自分・mute/block/被block・インスタンスミュート・bot/suspended/deleted/非explorable は除外。
	 */
	@bindThis
	public async getFoFUserScores(meId: MiUser['id']): Promise<Map<string, FollowCandidate>> {
		const followingMap = await this.cacheService.userFollowingsCache.fetch(meId);
		const allFolloweeIds = Object.keys(followingMap);
		if (allFolloweeIds.length === 0) return new Map();

		const [muting, blocking, blocked, profile, followerSet] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(meId),
			this.cacheService.userBlockingCache.fetch(meId),
			this.cacheService.userBlockedCache.fetch(meId),
			this.cacheService.userProfileCache.fetch(meId),
			this.getMyFollowerIds(meId),
		]);
		const mutedInstances = new Set(profile.mutedInstances);

		// seed 重み付け → 上位を採用（slice の偏り解消）。
		const weighted = allFolloweeIds.map(id => {
			const mutual = followerSet.has(id) ? SEED_MUTUAL_BOOST : 0;
			const withReplies = followingMap[id]?.withReplies ? SEED_WITHREPLIES_BONUS : 0;
			return { id, weight: SEED_BASE_WEIGHT + mutual + withReplies };
		});
		weighted.sort((a, b) => b.weight - a.weight);
		const seeds = weighted.slice(0, MAX_SEED_FOLLOWEES);
		const seedWeight = new Map(seeds.map(s => [s.id, s.weight]));
		const seedIds = seeds.map(s => s.id);

		// 既フォローは「全数」除外（seed の上限とは独立）。
		const exclude = new Set<string>([meId, ...allFolloweeIds, ...muting, ...blocking, ...blocked]);

		const rows = await this.followingsRepository.createQueryBuilder('f')
			.select('f.followerId', 'followerId')
			.addSelect('f.followeeId', 'followeeId')
			.where('f.followerId IN (:...seedIds)', { seedIds })
			.limit(MAX_FOF_SCAN)
			.getRawMany<{ followerId: string; followeeId: string }>();

		const raw = new Map<string, { score: number; mutualCount: number }>();
		for (const { followerId, followeeId } of rows) {
			if (exclude.has(followeeId)) continue;
			const w = seedWeight.get(followerId) ?? SEED_BASE_WEIGHT;
			const cur = raw.get(followeeId);
			if (cur) {
				cur.score += w;
				cur.mutualCount++;
			} else {
				raw.set(followeeId, { score: w, mutualCount: 1 });
			}
		}
		if (raw.size === 0) return new Map();

		// 上位候補を overfetch して品質フィルタ＋正規化（品質落ち分を見込む）。
		const top = Array.from(raw.entries())
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, FOF_CANDIDATE_POOL * FOF_USER_OVERFETCH);
		const topIds = top.map(([id]) => id);

		const userRows = await this.usersRepository.createQueryBuilder('u')
			.select('u.id', 'id')
			.addSelect('u.followersCount', 'followersCount')
			.addSelect('u.host', 'host')
			.addSelect('u.isLocked', 'isLocked')
			.where('u.id IN (:...topIds)', { topIds })
			.andWhere('u.isBot = FALSE')
			.andWhere('u.isSuspended = FALSE')
			.andWhere('u.isDeleted = FALSE')
			.andWhere('u.isExplorable = TRUE')
			.getRawMany<{ id: string; followersCount: number; host: string | null; isLocked: boolean }>();

		const result = new Map<string, FollowCandidate>();
		for (const u of userRows) {
			if (u.host != null && mutedInstances.has(u.host)) continue;
			const r = raw.get(u.id);
			if (r == null) continue;
			// 人気は log で軽く正規化（サークル内で濃い人を上に、グローバル有名人偏重を避ける）。
			const norm = r.score / Math.log10(Number(u.followersCount) + 10);
			const followback = followerSet.has(u.id) ? FOLLOWBACK_BOOST : 1;
			const locked = u.isLocked ? LOCKED_PENALTY : 1;
			result.set(u.id, { userId: u.id, score: norm * followback * locked, reason: 'fof', mutualCount: r.mutualCount });
		}
		return result;
	}

	/**
	 * フォロー候補（step10 表示用）。スコア順に返す。
	 */
	@bindThis
	public async getFollowCandidates(meId: MiUser['id'], limit: number): Promise<FollowCandidate[]> {
		const scores = await this.getFoFUserScores(meId);
		return Array.from(scores.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	/**
	 * FoF ユーザーの最近ノートを推薦候補として返す（案3）。
	 * noteScore = 作者スコア × 新鮮さ × 可視性 × エンゲージ × 返信0.5x。
	 * チャンネル投稿・純RNは除外、public/home のみ。
	 */
	@bindThis
	public async getFoFNoteIds(meId: MiUser['id'], limit: number): Promise<FoFNote[]> {
		const candidates = await this.getFollowCandidates(meId, FOF_CANDIDATE_POOL);
		if (candidates.length === 0) return [];

		const candScore = new Map(candidates.map(c => [c.userId, c.score]));
		const userIds = candidates.map(c => c.userId);
		const sinceId = this.idService.gen(Date.now() - FOF_NOTES_LOOKBACK_MS);

		const notes = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.addSelect('note.userId', 'userId')
			.addSelect('note.visibility', 'visibility')
			.addSelect('note.replyId', 'replyId')
			.addSelect('note.renoteCount', 'renoteCount')
			.addSelect('note.reactions', 'reactions')
			.where('note.userId IN (:...userIds)', { userIds })
			.andWhere('note.id > :sinceId', { sinceId })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.andWhere(new Brackets(qb => {
				// 純RN除外（引用RN・本文/メディアつきは許可）
				qb.where('note.renoteId IS NULL')
					.orWhere('note.text IS NOT NULL')
					.orWhere('note.fileIds != \'{}\'');
			}))
			.orderBy('note.id', 'DESC')
			.limit(limit * 5)
			.getRawMany<{ id: string; userId: string; visibility: string; replyId: string | null; renoteCount: number; reactions: Record<string, number> | null }>();

		const now = Date.now();
		const scored: FoFNote[] = notes.map(n => {
			const base = candScore.get(n.userId) ?? 0;
			const ageMs = now - this.idService.parse(n.id).date.getTime();
			const recency = FOF_NOTE_RECENCY.find(r => ageMs < r.withinMs)?.weight ?? 0;
			const vis = n.visibility === 'public' ? 1.0 : 0.8;
			const reactionsTotal = n.reactions ? Object.values(n.reactions).reduce((a, b) => a + Number(b), 0) : 0;
			// エンゲージは log で軽く（古い人気に偏らないよう base/recency と掛け合わせ）。bot反応の厳密除去は後続増分。
			const engagement = 1 + Math.log10(1 + reactionsTotal + 2 * Number(n.renoteCount ?? 0));
			const replyPenalty = n.replyId != null ? FOF_NOTE_REPLY_PENALTY : 1;
			return { noteId: n.id, userId: n.userId, score: base * recency * vis * engagement * replyPenalty };
		});
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}
}
