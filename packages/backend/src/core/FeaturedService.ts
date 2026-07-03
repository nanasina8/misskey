/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiGalleryPost, MiNote, MiUser } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';

// グローバル・パーソナライズランキング: 15分ウィンドウ × 288枠（72時間） 線形減衰
const GLOBAL_NOTES_RANKING_WINDOW_MS = 1000 * 60 * 15; // 15分
const GLOBAL_NOTES_RANKING_WINDOW_SECONDS = GLOBAL_NOTES_RANKING_WINDOW_MS / 1000;
const GLOBAL_NOTES_RANKING_WINDOW_COUNT = 288; // 72時間分
const GLOBAL_NOTES_RANKING_TTL_EXTRA_WINDOW_COUNT = 32; // 32枠（= 8時間）バッファ
const GLOBAL_NOTES_TTL_SECONDS = (GLOBAL_NOTES_RANKING_WINDOW_COUNT + GLOBAL_NOTES_RANKING_TTL_EXTRA_WINDOW_COUNT) * GLOBAL_NOTES_RANKING_WINDOW_SECONDS; // 80時間TTL
const FEATURED_NOTES_RANKING_CACHE_TTL_SECONDS = 60;
const FEATURED_NOTES_EMPTY_RANKING_CACHE_TTL_SECONDS = 5;
const PERSONALIZED_NOTES_RANKING_CACHE_LIMIT = 200;
const GLOBAL_NOTES_SCORES_CACHE_KEY = 'featuredGlobalNotesScoresCache';

// チャンネルランキング: 従来の3日ウィンドウを維持
const CHANNEL_NOTES_RANKING_WINDOW = 1000 * 60 * 60 * 24 * 3;

export const GALLERY_POSTS_RANKING_WINDOW = 1000 * 60 * 60 * 24 * 3; // 3日ごと
const PER_USER_NOTES_RANKING_WINDOW = 1000 * 60 * 60 * 24 * 7; // 1週間ごと
const HASHTAG_RANKING_WINDOW = 1000 * 60 * 60; // 1時間ごと

const featuredEpoc = new Date('2023-01-01T00:00:00Z').getTime();

// RN加点の基準値。リレー連合はRN(Announce)だけ届きリアクションが著者・フォロワー以外に届かないため、
// リモートRNはローカルRNより軽くする（実測: リアクション/RN比 local≈14.5 vs remote≈1.8）。
export const FEATURED_RENOTE_SCORE_LOCAL = 1;
export const FEATURED_RENOTE_SCORE_REMOTE = 0.5;
// 相互RN関係（7日窓・バッチ検出）からのRN加点に掛ける減衰係数
export const FEATURED_RN_RING_FACTOR = 0.3;

const RN_MUTUAL_PAIRS_KEY = 'hanamiRnMutualPairs';
const RN_MUTUAL_PAIRS_TTL_SECONDS = 60 * 60 * 2; // バッチ(1h周期)が止まったら失効させる

// 大量RNユーザーの影響緩和: 1日 FREE 件までは満額、超えた分は 1/√(count/FREE) で減衰（下限FLOOR）。
// 実測(7日窓・bot除外): リノーターのRN数は p50=2/週・p90=28/週だが、週140件超の26人が全加点イベントの57%を占めた。
export const FEATURED_RENOTER_DAILY_FREE = 4;
export const FEATURED_RENOTER_DISCOUNT_FLOOR = 0.1;
const RENOTER_DAILY_COUNT_TTL_SECONDS = 60 * 60 * 48;

export function renoterActivityDiscount(dailyCount: number): number {
	return Math.max(FEATURED_RENOTER_DISCOUNT_FLOOR, 1 / Math.sqrt(Math.max(1, dailyCount / FEATURED_RENOTER_DAILY_FREE)));
}

@Injectable()
export class FeaturedService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis, // TODO: 専用のRedisサーバーを設定できるようにする
	) {
	}

	@bindThis
	private getCurrentWindow(windowRange: number): number {
		const passed = new Date().getTime() - featuredEpoc;
		return Math.floor(passed / windowRange);
	}

	@bindThis
	private async updateRankingOf(name: string, windowRange: number, element: string, score = 1, ttlSeconds?: number): Promise<void> {
		const currentWindow = this.getCurrentWindow(windowRange);
		const ttl = ttlSeconds ?? Math.ceil((windowRange * 3) / 1000);
		const redisTransaction = this.redisClient.multi();
		redisTransaction.zincrby(
			`${name}:${currentWindow}`,
			score,
			element);
		redisTransaction.expire(
			`${name}:${currentWindow}`,
			ttl,
			'NX'); // "NX -- Set expiry only when the key has no expiry" = 有効期限がないときだけ設定
		await redisTransaction.exec();
	}

	// 線形減衰でスコアマップを取得（グローバル・パーソナライズ共通）
	// weight = (windowCount - i) / windowCount で時間経過とともに一定割合ずつ減衰する
	@bindThis
	private async getLinearDecayRankingWithScores(name: string, windowCount: number, maxPerWindow = 500): Promise<Map<string, number>> {
		const currentWindow = this.getCurrentWindow(GLOBAL_NOTES_RANKING_WINDOW_MS);
		const stop = maxPerWindow === -1 ? -1 : maxPerWindow - 1;
		const pipeline = this.redisClient.pipeline();
		for (let i = 0; i < windowCount; i++) {
			pipeline.zrange(`${name}:${currentWindow - i}`, 0, stop, 'REV', 'WITHSCORES');
		}
		const results = await pipeline.exec();

		const scores = new Map<string, number>();
		for (let i = 0; i < windowCount; i++) {
			const windowResults = (results?.[i]?.[1] ?? []) as string[];
			const weight = (windowCount - i) / windowCount; // 線形減衰
			for (let j = 0; j < windowResults.length; j += 2) {
				const id = windowResults[j];
				const rawScore = parseFloat(windowResults[j + 1]);
				scores.set(id, (scores.get(id) ?? 0) + (rawScore * weight));
			}
		}
		return scores;
	}

	@bindThis
	private async getRankingOf(name: string, windowRange: number, threshold: number): Promise<string[]> {
		const currentWindow = this.getCurrentWindow(windowRange);
		const previousWindow = currentWindow - 1;

		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.zrange(
			`${name}:${currentWindow}`, 0, threshold, 'REV', 'WITHSCORES');
		redisPipeline.zrange(
			`${name}:${previousWindow}`, 0, threshold, 'REV', 'WITHSCORES');
		const [currentRankingResult, previousRankingResult] = await redisPipeline.exec().then(result => result ? result.map(r => (r[1] ?? []) as string[]) : [[], []]);

		const ranking = new Map<string, number>();
		for (let i = 0; i < currentRankingResult.length; i += 2) {
			const noteId = currentRankingResult[i];
			const score = parseFloat(currentRankingResult[i + 1]);
			ranking.set(noteId, score);
		}
		for (let i = 0; i < previousRankingResult.length; i += 2) {
			const noteId = previousRankingResult[i];
			const score = parseFloat(previousRankingResult[i + 1]);
			const exist = ranking.get(noteId);
			if (exist != null) {
				// 現在ウィンドウのスコアを維持しつつ、前ウィンドウ分を0.5倍で加算
				ranking.set(noteId, exist + (score * 0.5));
			} else {
				ranking.set(noteId, score);
			}
		}

		return Array.from(ranking.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([id]) => id);
	}

	// はなみTL（trending軸のエンゲージ加重・catchup軸）が任意ノートIDのスコア参照に使うため public。
	@bindThis
	public async getGlobalNotesScoresWithCache(): Promise<Map<string, number>> {
		const cached = await this.redisClient.get(GLOBAL_NOTES_SCORES_CACHE_KEY);
		if (cached != null) {
			return new Map(JSON.parse(cached) as [string, number][]);
		}

		const scores = await this.getLinearDecayRankingWithScores('featuredGlobalNotesRanking', GLOBAL_NOTES_RANKING_WINDOW_COUNT);
		await this.redisClient.set(
			GLOBAL_NOTES_SCORES_CACHE_KEY,
			JSON.stringify(Array.from(scores.entries())),
			'EX',
			scores.size > 0 ? FEATURED_NOTES_RANKING_CACHE_TTL_SECONDS : FEATURED_NOTES_EMPTY_RANKING_CACHE_TTL_SECONDS);
		return scores;
	}

	@bindThis
	private async removeFromRanking(name: string, windowRange: number, element: string): Promise<void> {
		const currentWindow = this.getCurrentWindow(windowRange);
		const previousWindow = currentWindow - 1;

		const redisPipeline = this.redisClient.pipeline();
		redisPipeline.zrem(`${name}:${currentWindow}`, element);
		redisPipeline.zrem(`${name}:${previousWindow}`, element);
		await redisPipeline.exec();
	}

	@bindThis
	public updateGlobalNotesRanking(noteId: MiNote['id'], score = 1): Promise<void> {
		return this.updateRankingOf('featuredGlobalNotesRanking', GLOBAL_NOTES_RANKING_WINDOW_MS, noteId, score, GLOBAL_NOTES_TTL_SECONDS);
	}

	@bindThis
	public updateGalleryPostsRanking(galleryPostId: MiGalleryPost['id'], score = 1): Promise<void> {
		return this.updateRankingOf('featuredGalleryPostsRanking', GALLERY_POSTS_RANKING_WINDOW, galleryPostId, score);
	}

	@bindThis
	public updateInChannelNotesRanking(channelId: MiNote['channelId'], noteId: MiNote['id'], score = 1): Promise<void> {
		return this.updateRankingOf(`featuredInChannelNotesRanking:${channelId}`, CHANNEL_NOTES_RANKING_WINDOW, noteId, score);
	}

	@bindThis
	public updatePerUserNotesRanking(userId: MiUser['id'], noteId: MiNote['id'], score = 1): Promise<void> {
		return this.updateRankingOf(`featuredPerUserNotesRanking:${userId}`, PER_USER_NOTES_RANKING_WINDOW, noteId, score);
	}

	@bindThis
	public updateHashtagsRanking(hashtag: string, score = 1): Promise<void> {
		return this.updateRankingOf('featuredHashtagsRanking', HASHTAG_RANKING_WINDOW, hashtag, score);
	}

	// パーソナライズランキングの更新（ローカルフォロワーへの書き込み）
	@bindThis
	public updatePersonalizedNotesRanking(userId: MiUser['id'], noteId: MiNote['id'], score: number): Promise<void> {
		return this.updateRankingOf(`featuredPersonalizedNotesRanking:${userId}`, GLOBAL_NOTES_RANKING_WINDOW_MS, noteId, score, GLOBAL_NOTES_TTL_SECONDS);
	}

	/**
	 * RN加点の重複防止セットに追加し、このユーザーが何人目のRNかを返す。
	 * 既に加点済みのユーザーなら null（加点しない）。
	 */
	@bindThis
	public async tryAddRenoteBoost(noteId: MiNote['id'], userId: MiUser['id']): Promise<number | null> {
		const key = `featuredRenoteBoostedUsers:${noteId}`;
		const result = await this.redisClient
			.multi()
			.sadd(key, userId)
			.scard(key)
			.expire(key, GLOBAL_NOTES_TTL_SECONDS, 'NX')
			.exec();

		if (Number(result?.[0]?.[1]) !== 1) return null;
		return Math.max(1, Number(result?.[1]?.[1]));
	}

	/** アンリノート減点用: このユーザーが加点済みか＋現在のRN人数を返す。セットからは外さない（RN⇄取り消しの繰り返しで加点を稼げてしまうため）。 */
	@bindThis
	public async getRenoteBoostState(noteId: MiNote['id'], userId: MiUser['id']): Promise<{ boosted: boolean; count: number }> {
		const key = `featuredRenoteBoostedUsers:${noteId}`;
		const result = await this.redisClient
			.multi()
			.sismember(key, userId)
			.scard(key)
			.exec();
		return {
			boosted: Number(result?.[0]?.[1]) === 1,
			count: Math.max(1, Number(result?.[1]?.[1])),
		};
	}

	/** 相互RNペア（"authorId:renoterId"）を全置換する。For You バッチから1h周期で呼ばれる。 */
	@bindThis
	public async setRnMutualPairs(pairs: string[]): Promise<void> {
		const tx = this.redisClient.multi();
		tx.del(RN_MUTUAL_PAIRS_KEY);
		for (let i = 0; i < pairs.length; i += 1000) {
			tx.sadd(RN_MUTUAL_PAIRS_KEY, ...pairs.slice(i, i + 1000));
		}
		if (pairs.length > 0) {
			tx.expire(RN_MUTUAL_PAIRS_KEY, RN_MUTUAL_PAIRS_TTL_SECONDS);
		}
		await tx.exec();
	}

	@bindThis
	public async isRnMutualPair(authorId: MiUser['id'], renoterId: MiUser['id']): Promise<boolean> {
		return await this.redisClient.sismember(RN_MUTUAL_PAIRS_KEY, `${authorId}:${renoterId}`) === 1;
	}

	private renoterDailyCountKey(userId: MiUser['id']): string {
		return `featuredRenoterDailyCount:${userId}:${new Date().toISOString().slice(0, 10)}`;
	}

	/** RN加点時に呼ぶ: 当日の加点対象RN数をカウントアップし、カウント後の値を返す。 */
	@bindThis
	public async incrementRenoterActivity(userId: MiUser['id']): Promise<number> {
		const key = this.renoterDailyCountKey(userId);
		const result = await this.redisClient
			.multi()
			.incr(key)
			.expire(key, RENOTER_DAILY_COUNT_TTL_SECONDS, 'NX')
			.exec();
		return Number(result?.[0]?.[1]) || 1;
	}

	/** アンリノート減点用: 当日のカウントをインクリメントせずに読む。 */
	@bindThis
	public async peekRenoterActivity(userId: MiUser['id']): Promise<number> {
		const value = await this.redisClient.get(this.renoterDailyCountKey(userId));
		return Number(value) || 1;
	}

	// グローバルランキング（線形減衰）
	@bindThis
	public async getGlobalNotesRanking(threshold: number): Promise<MiNote['id'][]> {
		const scores = await this.getGlobalNotesScoresWithCache();
		return Array.from(scores.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, threshold)
			.map(([id]) => id);
	}

	// グローバルランキングをスコア付きで返す（低露出×高反応軸などがエンゲージメント値を必要とするため）
	@bindThis
	public async getGlobalNotesRankingWithScores(threshold: number): Promise<[MiNote['id'], number][]> {
		const scores = await this.getGlobalNotesScoresWithCache();
		return Array.from(scores.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, threshold);
	}

	// パーソナライズランキング（グローバルスコア + フォロー中ユーザーのインタラクションボーナスをマージ）
	@bindThis
	public async getPersonalizedNotesRanking(userId: MiUser['id'], threshold: number): Promise<MiNote['id'][]> {
		const cacheKey = `featuredPersonalizedNotesRankingCache:${userId}`;
		const cached = await this.redisClient.get(cacheKey);
		if (cached != null) {
			return (JSON.parse(cached) as MiNote['id'][]).slice(0, threshold);
		}

		const [globalScores, personalScores] = await Promise.all([
			this.getGlobalNotesScoresWithCache(),
			this.getLinearDecayRankingWithScores(`featuredPersonalizedNotesRanking:${userId}`, GLOBAL_NOTES_RANKING_WINDOW_COUNT, -1),
		]);

		// グローバルスコアにパーソナライズボーナスを加算（グローバル外のノートも含める）
		const merged = new Map<string, number>(globalScores);
		for (const [noteId, bonus] of personalScores) {
			merged.set(noteId, (merged.get(noteId) ?? 0) + bonus);
		}

		const ranking = Array.from(merged.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, PERSONALIZED_NOTES_RANKING_CACHE_LIMIT)
			.map(([id]) => id);

		await this.redisClient.set(
			cacheKey,
			JSON.stringify(ranking),
			'EX',
			ranking.length > 0 ? FEATURED_NOTES_RANKING_CACHE_TTL_SECONDS : FEATURED_NOTES_EMPTY_RANKING_CACHE_TTL_SECONDS);
		return ranking.slice(0, threshold);
	}

	@bindThis
	public getGalleryPostsRanking(threshold: number): Promise<MiGalleryPost['id'][]> {
		return this.getRankingOf('featuredGalleryPostsRanking', GALLERY_POSTS_RANKING_WINDOW, threshold);
	}

	@bindThis
	public getInChannelNotesRanking(channelId: MiNote['channelId'], threshold: number): Promise<MiNote['id'][]> {
		return this.getRankingOf(`featuredInChannelNotesRanking:${channelId}`, CHANNEL_NOTES_RANKING_WINDOW, threshold);
	}

	@bindThis
	public getPerUserNotesRanking(userId: MiUser['id'], threshold: number): Promise<MiNote['id'][]> {
		return this.getRankingOf(`featuredPerUserNotesRanking:${userId}`, PER_USER_NOTES_RANKING_WINDOW, threshold);
	}

	@bindThis
	public getHashtagsRanking(threshold: number): Promise<string[]> {
		return this.getRankingOf('featuredHashtagsRanking', HASHTAG_RANKING_WINDOW, threshold);
	}

	@bindThis
	public removeHashtagsFromRanking(hashtag: string): Promise<void> {
		return this.removeFromRanking('featuredHashtagsRanking', HASHTAG_RANKING_WINDOW, hashtag);
	}
}
