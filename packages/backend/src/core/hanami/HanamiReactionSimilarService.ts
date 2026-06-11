/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { NoteReactionsRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { IdService } from '@/core/IdService.js';
import { CacheService } from '@/core/CacheService.js';

// ───────────────────────── 近傍ユーザー（趣味の近い人）の算出 ─────────────────────────
// seed: 自分の最近のリアクション。少なすぎる人はコールドスタートとして候補ゼロを返す（他軸が埋める）。
const SEED_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 30; // 30日
const SEED_REACTIONS_LIMIT = 300;
const SEED_MIN_REACTIONS = 5;
// 近傍: 同じノートにリアクションした他ユーザー。重複1件は偶然なので floor をかける。
const NEIGHBOR_FETCH_LIMIT = 100;
const NEIGHBOR_LIMIT = 50;
const NEIGHBOR_MIN_OVERLAP = 2;
// 無差別に大量リアクションする人は「誰とでも重複する」ので、総リアクション数で正規化して薄める。
// similarity = 重複数 / log10(10 + 30日の総リアクション数)
const NEIGHBORS_CACHE_KEY_PREFIX = 'hanami:rsim:neighbors:';
const NEIGHBORS_CACHE_TTL_SECONDS = 60 * 60 * 3; // 3時間
const NEIGHBORS_EMPTY_CACHE_TTL_SECONDS = 60 * 10; // コールドスタート時の再計算は10分おきで十分

// ───────────────────────── 候補ノートの集計 ─────────────────────────
const CANDIDATE_REACTIONS_LOOKBACK_MS = 1000 * 60 * 60 * 72; // 近傍の直近72hのリアクション先を見る
const CANDIDATE_REACTIONS_FETCH_LIMIT = 1500;
const CANDIDATE_PER_AUTHOR_CAP = 2; // 同一作者のノートで埋まらないように
const CANDIDATES_CACHE_KEY_PREFIX = 'hanami:rsim:cand:';
const CANDIDATES_CACHE_TTL_SECONDS = 60; // 「もっと読む」連打で重い集計が連発しないための短期キャッシュ

// ノート鮮度の減衰（リアクションが集まり続ける限り候補に残るが、新しいものを優先する）。
const FRESHNESS_BUCKETS: { withinMs: number; weight: number }[] = [
	{ withinMs: 1000 * 60 * 60 * 12, weight: 1.0 },
	{ withinMs: 1000 * 60 * 60 * 24, weight: 0.8 },
	{ withinMs: 1000 * 60 * 60 * 48, weight: 0.55 },
	{ withinMs: 1000 * 60 * 60 * 72, weight: 0.35 },
];
const FRESHNESS_FLOOR = 0.2;

type Neighbor = { userId: string; similarity: number };
export type ReactionSimilarNote = { noteId: string; userId: string; score: number };

/**
 * リアクション類似軸（協調フィルタリング軽量版）。
 *
 * 「自分がリアクションしたノートに、同じくリアクションした人たち」を趣味の近い近傍とみなし、
 * その近傍が最近リアクションしたノートを推薦する。popular（サーバー全体の人気）と違い、
 * 自分のクラスタの人気が出る個人化軸。
 *
 * - 近傍はノート単位の重複数ベース。無差別リアクション勢は総数の log で正規化して薄める
 * - フォロー中作者のノートは除外（ホームTL/catchup軸の領分。この軸は「未知との出会い」担当）
 * - 自分が既にリアクションしたノートは除外
 * - 可視性/ミュート/ブロックの最終フィルタは HanamiRecommendationService の pack 段で行う
 */
@Injectable()
export class HanamiReactionSimilarService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,

		private idService: IdService,
		private cacheService: CacheService,
	) {
	}

	private freshnessMultiplier(noteId: string, now: number): number {
		const age = now - this.idService.parse(noteId).date.getTime();
		for (const bucket of FRESHNESS_BUCKETS) {
			if (age <= bucket.withinMs) return bucket.weight;
		}
		return FRESHNESS_FLOOR;
	}

	/**
	 * 趣味の近い近傍ユーザー（3hキャッシュ）。
	 * 近傍の身元はAPIに出さない（理由ラベルは「あなたの反応と近い」の総称のみ）。
	 */
	@bindThis
	private async getNeighbors(meId: MiUser['id']): Promise<Neighbor[]> {
		const cacheKey = `${NEIGHBORS_CACHE_KEY_PREFIX}${meId}`;
		const cached = await this.redisClient.get(cacheKey);
		if (cached != null) {
			return JSON.parse(cached) as Neighbor[];
		}

		const seedCutoffId = this.idService.gen(Date.now() - SEED_LOOKBACK_MS);
		const seedRows = await this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.noteId', 'noteId')
			.where('reaction.userId = :meId', { meId })
			.andWhere('reaction.id > :seedCutoffId', { seedCutoffId })
			.orderBy('reaction.id', 'DESC')
			.limit(SEED_REACTIONS_LIMIT)
			.getRawMany<{ noteId: string }>();
		const seedNoteIds = seedRows.map(r => r.noteId);

		if (seedNoteIds.length < SEED_MIN_REACTIONS) {
			await this.redisClient.set(cacheKey, '[]', 'EX', NEIGHBORS_EMPTY_CACHE_TTL_SECONDS);
			return [];
		}

		// 同じノートにリアクションした他ユーザーを重複数で集計。
		const overlapRows = await this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.userId', 'userId')
			.addSelect('COUNT(*)', 'cnt')
			.where('reaction.noteId IN (:...seedNoteIds)', { seedNoteIds })
			.andWhere('reaction.userId != :meId', { meId })
			.groupBy('reaction.userId')
			.orderBy('cnt', 'DESC')
			.limit(NEIGHBOR_FETCH_LIMIT)
			.getRawMany<{ userId: string; cnt: string }>();

		const overlaps = overlapRows
			.map(r => ({ userId: r.userId, overlap: Number(r.cnt) }))
			.filter(r => r.overlap >= NEIGHBOR_MIN_OVERLAP);

		let neighbors: Neighbor[] = [];
		if (overlaps.length > 0) {
			const totalRows = await this.noteReactionsRepository.createQueryBuilder('reaction')
				.select('reaction.userId', 'userId')
				.addSelect('COUNT(*)', 'cnt')
				.where('reaction.userId IN (:...userIds)', { userIds: overlaps.map(o => o.userId) })
				.andWhere('reaction.id > :seedCutoffId', { seedCutoffId })
				.groupBy('reaction.userId')
				.getRawMany<{ userId: string; cnt: string }>();
			const totalByUser = new Map(totalRows.map(r => [r.userId, Number(r.cnt)]));

			neighbors = overlaps
				.map(o => ({
					userId: o.userId,
					similarity: o.overlap / Math.log10(10 + (totalByUser.get(o.userId) ?? o.overlap)),
				}))
				.sort((a, b) => b.similarity - a.similarity)
				.slice(0, NEIGHBOR_LIMIT);
		}

		await this.redisClient.set(
			cacheKey,
			JSON.stringify(neighbors),
			'EX',
			neighbors.length > 0 ? NEIGHBORS_CACHE_TTL_SECONDS : NEIGHBORS_EMPTY_CACHE_TTL_SECONDS);
		return neighbors;
	}

	/**
	 * 近傍が最近リアクションしたノートを集計して返す（スコア降順）。
	 * score = Σ(近傍のsimilarity) × ノート鮮度。
	 */
	@bindThis
	public async getReactionSimilarNoteIds(meId: MiUser['id'], limit: number): Promise<ReactionSimilarNote[]> {
		const cacheKey = `${CANDIDATES_CACHE_KEY_PREFIX}${meId}`;
		const cached = await this.redisClient.get(cacheKey);
		if (cached != null) {
			return (JSON.parse(cached) as ReactionSimilarNote[]).slice(0, limit);
		}

		const neighbors = await this.getNeighbors(meId);
		if (neighbors.length === 0) {
			await this.redisClient.set(cacheKey, '[]', 'EX', CANDIDATES_CACHE_TTL_SECONDS);
			return [];
		}
		const similarityByUser = new Map(neighbors.map(n => [n.userId, n.similarity]));

		const candidateCutoffId = this.idService.gen(Date.now() - CANDIDATE_REACTIONS_LOOKBACK_MS);
		const rows = await this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.noteId', 'noteId')
			.addSelect('reaction.userId', 'reactorId')
			.addSelect('note.userId', 'authorId')
			.innerJoin('reaction.note', 'note')
			.where('reaction.userId IN (:...neighborIds)', { neighborIds: neighbors.map(n => n.userId) })
			.andWhere('reaction.id > :candidateCutoffId', { candidateCutoffId })
			.andWhere('note.userId != :meId', { meId })
			.andWhere('note.channelId IS NULL')
			.andWhere('note.visibility IN (:...visibilities)', { visibilities: ['public', 'home'] })
			.orderBy('reaction.id', 'DESC')
			.limit(CANDIDATE_REACTIONS_FETCH_LIMIT)
			.getRawMany<{ noteId: string; reactorId: string; authorId: string }>();

		if (rows.length === 0) {
			await this.redisClient.set(cacheKey, '[]', 'EX', CANDIDATES_CACHE_TTL_SECONDS);
			return [];
		}

		// フォロー中作者は除外（この軸は未知との出会い担当。フォロイーは home/catchup の領分）。
		const followings = await this.cacheService.userFollowingsCache.fetch(meId);

		const aggregated = new Map<string, { authorId: string; score: number }>();
		for (const row of rows) {
			if (Object.hasOwn(followings, row.authorId)) continue;
			const sim = similarityByUser.get(row.reactorId) ?? 0;
			if (sim <= 0) continue;
			const cur = aggregated.get(row.noteId);
			if (cur == null) {
				aggregated.set(row.noteId, { authorId: row.authorId, score: sim });
			} else {
				cur.score += sim;
			}
		}
		if (aggregated.size === 0) {
			await this.redisClient.set(cacheKey, '[]', 'EX', CANDIDATES_CACHE_TTL_SECONDS);
			return [];
		}

		// 自分が既にリアクション済みのノートは除外（「もう見て反応した」ものを薦めない）。
		const candidateNoteIds = Array.from(aggregated.keys());
		const myReactedRows = await this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.noteId', 'noteId')
			.where('reaction.userId = :meId', { meId })
			.andWhere('reaction.noteId IN (:...candidateNoteIds)', { candidateNoteIds })
			.getRawMany<{ noteId: string }>();
		const myReacted = new Set(myReactedRows.map(r => r.noteId));

		const now = Date.now();
		const scored: ReactionSimilarNote[] = [];
		for (const [noteId, { authorId, score }] of aggregated) {
			if (myReacted.has(noteId)) continue;
			scored.push({ noteId, userId: authorId, score: score * this.freshnessMultiplier(noteId, now) });
		}
		scored.sort((a, b) => b.score - a.score);

		// 作者ごとの上限（推薦面が同じ人で埋まらないように）。
		const perAuthor = new Map<string, number>();
		const out: ReactionSimilarNote[] = [];
		for (const c of scored) {
			const used = perAuthor.get(c.userId) ?? 0;
			if (used >= CANDIDATE_PER_AUTHOR_CAP) continue;
			perAuthor.set(c.userId, used + 1);
			out.push(c);
		}

		await this.redisClient.set(cacheKey, JSON.stringify(out), 'EX', CANDIDATES_CACHE_TTL_SECONDS);
		return out.slice(0, limit);
	}
}
