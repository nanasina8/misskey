/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiUser } from '@/models/User.js';
import { CacheService } from '@/core/CacheService.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { HanamiUserRecommendationService } from '@/core/hanami/HanamiUserRecommendationService.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import {
	HANAMI_SERVED_KEY_PREFIX as SERVED_KEY_PREFIX,
	HANAMI_SEEN_KEY_PREFIX as SEEN_KEY_PREFIX,
	HANAMI_HOME_SEEN_KEY_PREFIX as HOME_SEEN_KEY_PREFIX,
} from '@/core/hanami/HanamiForYouKeys.js';

// 既出除外（served）: 配信時に短期間だけ再表示を抑制する（短TTL）。長期 dedup は seen（フロント確認後）。
const SERVED_TTL_SECONDS = 60 * 30; // 30分
const SERVED_TTL_MS = SERVED_TTL_SECONDS * 1000;

// 既出除外（seen）: フロントが実表示を確認したら積む長期側。
const SEEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7日
const SEEN_TTL_MS = SEEN_TTL_SECONDS * 1000;

// homeSeen: 互換のため残す seen 報告経路（kind=home）。For You-only では基本未使用（フロントは rec 報告）。
const HOME_SEEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7日

// 新着ストリームへの auto-inject の頻度プリセット（For You feed 自身の realtime 挿入。§14-D5）。
const AUTO_INJECT_PRESET = {
	low: { homeNotesPerInjection: 10, injectCount: 1 },
	normal: { homeNotesPerInjection: 6, injectCount: 1 },
	high: { homeNotesPerInjection: 4, injectCount: 2 },
} as const;

export type HanamiAutoInjectStrength = keyof typeof AUTO_INJECT_PRESET;
export type HanamiAutoInjectPreset = (typeof AUTO_INJECT_PRESET)[HanamiAutoInjectStrength];

/**
 * はなみTL の周辺ユーティリティ（canonical spec）。
 *
 * For You-only 化に伴い、旧 score 混合・home 注入・候補生成・スロット注入は **廃止**（§6）。
 * 配信本体は HanamiForYouService（6軸＋quota interleave＋safety）に移管済。本サービスに残すのは:
 *  - served/seen/homeSeen の Redis 記録（HanamiForYouService と seen endpoint が使う。seen は PG provenance も二重書き）
 *  - auto-inject プリセット解決（stream channel が使う）
 *  - フォロー候補・テキストトレンドの薄いラッパ（各 endpoint が使う）
 */
@Injectable()
export class HanamiRecommendationService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private cacheService: CacheService,
		private hanamiTrendService: HanamiTrendService,
		private hanamiUserRecommendationService: HanamiUserRecommendationService,
		private hanamiForYouProvenanceService: HanamiForYouProvenanceService,
	) {
	}

	// ───────────────────────── auto-inject 設定解決 ─────────────────────────

	private getAutoInjectStrength(strength: string): HanamiAutoInjectStrength {
		return Object.prototype.hasOwnProperty.call(AUTO_INJECT_PRESET, strength) ? strength as HanamiAutoInjectStrength : 'low';
	}

	/** stream channel 用。はなみTL ON/OFF と auto-inject ON/OFF を見てプリセットを返す（off なら null）。 */
	@bindThis
	public async getAutoInjectPreset(meId: MiUser['id']): Promise<HanamiAutoInjectPreset | null> {
		const profile = await this.cacheService.userProfileCache.fetch(meId);
		if (!profile.hanamiRecommendationEnabled || !profile.hanamiRecommendationAutoInjectEnabled) return null;
		return AUTO_INJECT_PRESET[this.getAutoInjectStrength(profile.hanamiRecommendationAutoInjectStrength)];
	}

	// ───────────────────────── served / seen ─────────────────────────

	@bindThis
	private async getZsetMembers(key: string, ttlMs: number): Promise<Set<string>> {
		const cutoff = Date.now() - ttlMs;
		const ids = await this.redisClient.zrangebyscore(key, cutoff, '+inf');
		return new Set(ids);
	}

	/** For You-only サービング（HanamiForYouService）が短期重複排除（served+seen）に使う。 */
	@bindThis
	public async getServedSeenForExclusion(userId: MiUser['id']): Promise<{ served: Set<string>; seen: Set<string> }> {
		const [served, seen] = await Promise.all([
			this.getZsetMembers(`${SERVED_KEY_PREFIX}${userId}`, SERVED_TTL_MS),
			this.getZsetMembers(`${SEEN_KEY_PREFIX}${userId}`, SEEN_TTL_MS),
		]);
		return { served, seen };
	}

	@bindThis
	public async recordServed(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		await this.recordZset(`${SERVED_KEY_PREFIX}${userId}`, noteIds, SERVED_TTL_SECONDS, SERVED_TTL_MS);
	}

	@bindThis
	public async recordSeen(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		await this.recordZset(`${SEEN_KEY_PREFIX}${userId}`, noteIds, SEEN_TTL_SECONDS, SEEN_TTL_MS);
		// PG provenance（§7.2）: seen も best-effort で二重書き（For You では rec として扱う）。
		void this.hanamiForYouProvenanceService.recordSeenEvents(userId, noteIds);
	}

	/** 互換用 seen 報告（kind=home）。For You-only では基本未使用だが endpoint 契約を壊さないため残す。 */
	@bindThis
	public async recordHomeSeen(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		await this.recordZset(`${HOME_SEEN_KEY_PREFIX}${userId}`, noteIds, HOME_SEEN_TTL_SECONDS, SEEN_TTL_MS);
	}

	@bindThis
	private async recordZset(key: string, noteIds: string[], ttlSeconds: number, ttlMs: number): Promise<void> {
		if (noteIds.length === 0) return;
		const now = Date.now();
		const scoreMembers: (string | number)[] = [];
		for (const id of noteIds) scoreMembers.push(now, id);
		const results = await this.redisClient.multi()
			.zadd(key, ...(scoreMembers as [number, string]))
			.zremrangebyscore(key, 0, now - ttlMs)
			.expire(key, ttlSeconds)
			.exec();
		// 既出除外は best-effort だが、黙って欠けると再表示バグに見えるのでログは残す。
		const err = results?.find(r => r[0] != null)?.[0];
		if (results == null || err != null) {
			// eslint-disable-next-line no-console
			console.error(`hanami rec: zset record failed (${key})`, err);
		}
	}

	// ───────────────────────── 薄いラッパ（各 endpoint 用） ─────────────────────────

	/** フォロー候補（users/hanami-recommendations）。 */
	@bindThis
	public async getFollowCandidates(meId: MiUser['id'], limit: number): Promise<{ userId: string; reason: string; mutualCount: number }[]> {
		const cands = await this.hanamiUserRecommendationService.getFollowCandidates(meId, limit);
		return cands.map(c => ({ userId: c.userId, reason: c.reason, mutualCount: c.mutualCount }));
	}

	@bindThis
	public async recordFollowCandidatesShown(meId: MiUser['id'], userIds: MiUser['id'][]): Promise<void> {
		await this.hanamiUserRecommendationService.recordShown(meId, userIds);
	}

	/** テキストトレンド（急上昇用語）。ハッシュタグ集計とは別系統の本文トークン由来トレンド（notes/hanami-trends）。 */
	@bindThis
	public async getTrendingTerms(limit: number): Promise<{ term: string; score: number; distinctAuthors: number }[]> {
		const terms = await this.hanamiTrendService.getTrendingTerms(limit);
		return terms.map(t => ({ term: t.term, score: t.score, distinctAuthors: t.distinctAuthors }));
	}
}
