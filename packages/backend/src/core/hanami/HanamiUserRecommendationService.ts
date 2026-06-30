/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { FollowingsRepository, FollowRequestsRepository, NoteReactionsRepository, NotesRepository, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { HANAMI_FOF_SHOWN_KEY_PREFIX as SHOWN_KEY_PREFIX } from '@/core/hanami/HanamiForYouKeys.js';

const DAY_MS = 1000 * 60 * 60 * 24;

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
// ノート推薦用の候補プール。FoF上位はリモートhub偏重で直近ノートがローカルDBに無いことが多いため、
// 足りない時だけ段階的に広げ、「実際に投稿がある人」を取りこぼしにくくする。
const FOF_NOTE_CANDIDATE_POOL_STEPS = [300, 600, 1000] as const;
// ノートクエリの窓: DBに既にある「過去投稿」も対象に広げる（連合で新規取得はしない。public/home が無ければ諦める）。
// 新鮮さはスコアで優先するが、古い投稿しか無いリモート人気アカも候補に乗せられるようにする。
const FOF_NOTE_QUERY_LOOKBACK_MS = DAY_MS * 365; // 直近365日
const FOF_NOTE_QUERY_LIMIT_MIN = 1200;
const FOF_NOTE_QUERY_LIMIT_MAX = 5000;
const FOF_NOTE_QUERY_LIMIT_MULTIPLIER = 20;
// FoFノートは作者ごとに直近候補を少し広めに見て、そこから人気投稿を選ぶ。
// 最新3件だけだと「新着だが無反応」の投稿に寄るため、人気判定前の候補幅を持たせる。
const FOF_NOTE_PER_AUTHOR_LIMIT = 8;
const FOF_NOTE_MIN_ENGAGEMENT = 1;
// ノート土台スコアに「人気度（フォロワー数）」を混ぜる割合。リモート人気アカを一定割合出すため。
const FOF_POPULAR_NOTE_RATIO = 0.3;
// note単位のservedはFoFではハード除外しない。送っただけのnoteは強く沈め、実表示済み(seen)は呼び出し側で除外する。
const FOF_NOTE_SERVED_PENALTY = 0.05;
// FoFノート候補IDの短TTLキャッシュ。pack前の候補だけを保存し、可視性/mute/served/seenは呼び出し側で毎回反映する。
const FOF_NOTE_CACHE_KEY_PREFIX = 'hanami:fof:notes:v3:';
const FOF_NOTE_CACHE_TTL_SECONDS = 60;
const FOF_NOTE_EMPTY_CACHE_TTL_SECONDS = 10;

// seed 重み（案1）。すべて提案値・ここ一箇所で調整可。
const SEED_BASE_WEIGHT = 1.0;
const SEED_MUTUAL_BOOST = 1.0; // 相互フォローの中継者は親密として重く
const SEED_WITHREPLIES_BONUS = 0.5; // 返信まで見ている相手（より関心が高い）

// 候補スコアの補正（案2）。提案値。
const FOLLOWBACK_BOOST = 1.3; // 候補が自分をフォロー中（フォロバ候補）
const LOCKED_PENALTY = 0.5; // 鍵アカウントは低め（除外まではしない）
// 既出FoFユーザーの再表示抑制。1表示=1メンバーの「露出ログ」zset（member=`userId\ttimestamp\tseq`, score=表示時刻ms）で
// 「最終表示時刻（ハード除外用）」と「窓内の表示回数（ソフト減点用）」の両方を1キーから得る。
	// キー前缀は HanamiForYouKeys に集約。
// 3日以内に見せた人は完全除外（新顔が足りない時だけ古い順フォールバック）。FOF_NOTES_LOOKBACK_MS と一致。
const SHOWN_HARD_MS = DAY_MS * 3;
// 7日窓: この間の表示回数に応じてソフト減点。窓を抜ければ満点に回復（記録の保持上限も兼ねる）。
const SHOWN_SOFT_MS = DAY_MS * 7;
const SHOWN_TTL_SECONDS = 60 * 60 * 24 * 7;
// 7日窓内の表示回数あたりの減衰: score × 1/(1 + K×count)。回数が多いほど強く沈める（要望: 7日単位で強化）。
const SHOWN_SOFT_K = 0.7;

// 最近動いている候補・最近関わったFFを強くする。回数より「何日いた/関わったか」を主に見る。
const ACTIVITY_LOOKBACK_MS = DAY_MS * 14;
const ACTIVITY_RECENT_MS = DAY_MS * 7;
const ACTIVITY_COUNT_CAP = 20;
const CANDIDATE_ACTIVITY_EVENT_FETCH_LIMIT = 8000;
const SEED_INTERACTION_EVENT_FETCH_LIMIT = 5000;
// シード相互作用シグナルのキャッシュ。14日窓の集計なので変化は遅く、
// FoFプール構築（60秒キャッシュ切れ）のたびにDB5クエリを回す価値はない。
const SEED_SIGNALS_CACHE_KEY_PREFIX = 'hanami:fof:seedsig:';
const SEED_SIGNALS_CACHE_TTL_SECONDS = 60 * 15;
const CANDIDATE_ACTIVITY_MULTIPLIER_MIN = 0.35;
const CANDIDATE_ACTIVITY_MULTIPLIER_MAX = 1.45;
const SEED_INTERACTION_BOOST_MAX = 2.0;

// FoFフォロー候補は人気投稿レコメンドと役割を分け、多様性を強めに確保する。
const DIVERSITY_CORE_SHARE = 0.5;
const DIVERSITY_DIVERSE_SHARE = 0.4;
const MAX_PER_SEED = 2;
const MAX_PER_REMOTE_HOST = 3;

// FoF ノートスコア（案3）。提案値。
const FOF_NOTE_REPLY_PENALTY = 0.5; // 返信は半分（決定4）
const FOF_NOTE_RECENCY = [
	{ withinMs: 1000 * 60 * 60 * 12, weight: 1.0 }, // 12h以内
	{ withinMs: 1000 * 60 * 60 * 24, weight: 0.75 }, // 24h以内
	{ withinMs: FOF_NOTES_LOOKBACK_MS, weight: 0.45 }, // 72h以内
	{ withinMs: DAY_MS * 7, weight: 0.25 }, // 〜7日
	{ withinMs: DAY_MS * 30, weight: 0.12 }, // 〜30日
	{ withinMs: DAY_MS * 90, weight: 0.05 }, // 〜90日
	{ withinMs: DAY_MS * 180, weight: 0.025 }, // 〜180日
	{ withinMs: FOF_NOTE_QUERY_LOOKBACK_MS, weight: 0.01 }, // 〜365日（古い投稿のフロア。新しいほど上位だが古くても拾える）
] as const;

export type FollowCandidate = { userId: string; score: number; reason: 'fof' | 'similar'; mutualCount: number };
export type FoFNote = { noteId: string; userId: string; score: number };
export type FoFNoteOptions = {
	hardExcludedNoteIds?: ReadonlySet<string>;
	softPenaltyNoteIds?: ReadonlySet<string>;
	newerThan?: string | null;
	withFiles?: boolean;
};

type ActivitySignal = {
	days7: Set<number>;
	days14: Set<number>;
	lastAt: number | null;
	count14: number;
	passiveLastAt: number | null;
	passiveCount14: number;
};

type RawFoFCandidate = {
	score: number;
	mutualCount: number;
	seedIds: Set<string>;
};

type InternalFollowCandidate = FollowCandidate & {
	host: string | null;
	seedIds: string[];
	// 7日窓内での最終表示時刻。null = 7日以内に見せていない（新顔扱い）。3日以内ならハード除外の判定に使う。
	lastShownAt: number | null;
	activityMultiplier: number;
	// グローバルな人気度（フォロワー数）。ノート土台スコアの人気ブレンドに使う。
	followersCount: number;
};

type FoFNoteRow = {
	id: string;
	userId: string;
	visibility: string;
	replyId: string | null;
	renoteCount: number | string | null;
	reactions: Record<string, number> | null;
	authorNoteRank: number | string;
};

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
	private fofNotePoolInflight = new Map<string, Promise<FoFNote[]>>();

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,

		private cacheService: CacheService,
		private idService: IdService,
	) {
	}

	private clamp(v: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, v));
	}

	private createActivitySignal(): ActivitySignal {
		return {
			days7: new Set(),
			days14: new Set(),
			lastAt: null,
			count14: 0,
			passiveLastAt: null,
			passiveCount14: 0,
		};
	}

	private getSignal(map: Map<string, ActivitySignal>, userId: string): ActivitySignal {
		const current = map.get(userId);
		if (current != null) return current;
		const created = this.createActivitySignal();
		map.set(userId, created);
		return created;
	}

	private addActivity(map: Map<string, ActivitySignal>, userId: string, id: string, now: number): void {
		const at = this.idService.parse(id).date.getTime();
		if (now - at > ACTIVITY_LOOKBACK_MS) return;
		const signal = this.getSignal(map, userId);
		const day = Math.floor(at / DAY_MS);
		signal.days14.add(day);
		if (now - at <= ACTIVITY_RECENT_MS) signal.days7.add(day);
		signal.lastAt = Math.max(signal.lastAt ?? 0, at);
		signal.count14++;
	}

	// 候補本人が受けたリアクションは「本人の活動」ではないため、弱い補助シグナルとしてだけ使う。
	private addPassiveActivity(map: Map<string, ActivitySignal>, userId: string, id: string, now: number): void {
		const at = this.idService.parse(id).date.getTime();
		if (now - at > ACTIVITY_LOOKBACK_MS) return;
		const signal = this.getSignal(map, userId);
		signal.passiveLastAt = Math.max(signal.passiveLastAt ?? 0, at);
		signal.passiveCount14++;
	}

	private getLastHours(at: number | null, now: number): number | null {
		return at == null ? null : (now - at) / (1000 * 60 * 60);
	}

	private getRecencyScore(lastHours: number | null, strong: boolean): number {
		if (lastHours == null) return 0;
		if (lastHours <= 24) return strong ? 0.45 : 0.35;
		if (lastHours <= 72) return strong ? 0.25 : 0.2;
		if (lastHours <= 168) return strong ? 0.1 : 0.08;
		return 0;
	}

	private getCandidateActivityMultiplier(signal: ActivitySignal | undefined, now: number): number {
		if (signal == null) return CANDIDATE_ACTIVITY_MULTIPLIER_MIN;
		const lastHours = this.getLastHours(signal.lastAt, now);
		const passiveLastHours = this.getLastHours(signal.passiveLastAt, now);
		const score =
			(signal.days7.size * 0.12) +
			(signal.days14.size * 0.04) +
			this.getRecencyScore(lastHours, false) +
			(Math.min(signal.count14, ACTIVITY_COUNT_CAP) * 0.015) +
			(this.getRecencyScore(passiveLastHours, false) * 0.25) +
			(Math.min(signal.passiveCount14, ACTIVITY_COUNT_CAP) * 0.004);
		return this.clamp(0.35 + score, CANDIDATE_ACTIVITY_MULTIPLIER_MIN, CANDIDATE_ACTIVITY_MULTIPLIER_MAX);
	}

	private getSeedInteractionBoost(signal: ActivitySignal | undefined, now: number): number {
		if (signal == null) return 0;
		const lastHours = this.getLastHours(signal.lastAt, now);
		const score =
			(signal.days7.size * 0.18) +
			(signal.days14.size * 0.06) +
			this.getRecencyScore(lastHours, true) +
			(Math.min(signal.count14, ACTIVITY_COUNT_CAP) * 0.01);
		return Math.min(score, SEED_INTERACTION_BOOST_MAX);
	}

	private getAuthorNoteRankPenalty(rank: number): number {
		if (rank <= 1) return 1;
		return Math.max(0.25, Math.pow(0.75, rank - 1));
	}

	private getFoFNoteQueryLimit(limit: number): number {
		return this.clamp(limit * FOF_NOTE_QUERY_LIMIT_MULTIPLIER, FOF_NOTE_QUERY_LIMIT_MIN, FOF_NOTE_QUERY_LIMIT_MAX);
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

	@bindThis
	private async getPendingFolloweeIds(meId: MiUser['id']): Promise<Set<string>> {
		const rows = await this.followRequestsRepository.createQueryBuilder('request')
			.select('request.followeeId', 'followeeId')
			.where('request.followerId = :meId', { meId })
			.getRawMany<{ followeeId: string }>();
		return new Set(rows.map(r => r.followeeId));
	}

	// 直近 SHOWN_SOFT_MS（7日）の露出ログから、ユーザーごとに { 表示回数, 最終表示時刻 } を集計する。
	// 古いメンバーは ZRANGEBYSCORE の下限で除外＝7日を抜けた人は満点（新顔）に戻る。
	@bindThis
	private async getShownStats(meId: MiUser['id']): Promise<Map<string, { count: number; lastAt: number }>> {
		const cutoff = Date.now() - SHOWN_SOFT_MS;
		const raw = await this.redisClient.zrangebyscore(`${SHOWN_KEY_PREFIX}${meId}`, cutoff, '+inf', 'WITHSCORES');
		const stats = new Map<string, { count: number; lastAt: number }>();
		for (let i = 0; i < raw.length; i += 2) {
			const member = raw[i];
			const at = Number(raw[i + 1]);
			const userId = member.slice(0, member.indexOf('\t')); // member = `userId\ttimestamp\tseq`
			const cur = stats.get(userId);
			if (cur) {
				cur.count++;
				if (at > cur.lastAt) cur.lastAt = at;
			} else {
				stats.set(userId, { count: 1, lastAt: at });
			}
		}
		return stats;
	}

	@bindThis
	public async recordShown(meId: MiUser['id'], userIds: MiUser['id'][]): Promise<void> {
		const uniqueIds = [...new Set(userIds)];
		if (uniqueIds.length === 0) return;
		const key = `${SHOWN_KEY_PREFIX}${meId}`;
		const now = Date.now();
		// 1表示=1メンバー（同一ユーザーでも別エントリ）。回数と最終表示時刻の両方を後で復元できる。
		const pipeline = this.redisClient.multi();
		let seq = 0;
		for (const userId of uniqueIds) pipeline.zadd(key, now, `${userId}\t${now}\t${seq++}`);
		pipeline.zremrangebyscore(key, 0, now - SHOWN_SOFT_MS);
		pipeline.expire(key, SHOWN_TTL_SECONDS);
		await pipeline.exec();
	}

	private serializeSeedSignals(signals: Map<string, ActivitySignal>): string {
		return JSON.stringify(Array.from(signals, ([userId, s]) => [userId, { ...s, days7: [...s.days7], days14: [...s.days14] }]));
	}

	private reviveSeedSignals(json: string): Map<string, ActivitySignal> {
		type Serialized = Omit<ActivitySignal, 'days7' | 'days14'> & { days7: number[]; days14: number[] };
		const entries = JSON.parse(json) as [string, Serialized][];
		return new Map(entries.map(([userId, s]) => [userId, { ...s, days7: new Set(s.days7), days14: new Set(s.days14) }]));
	}

	@bindThis
	private async getSeedInteractionSignals(meId: MiUser['id'], followeeIds: MiUser['id'][]): Promise<Map<string, ActivitySignal>> {
		if (followeeIds.length === 0) return new Map();

		const cacheKey = `${SEED_SIGNALS_CACHE_KEY_PREFIX}${meId}`;
		const cached = await this.redisClient.get(cacheKey);
		if (cached != null) return this.reviveSeedSignals(cached);

		const followeeSet = new Set(followeeIds);
		const sinceId = this.idService.gen(Date.now() - ACTIVITY_LOOKBACK_MS);
		const now = Date.now();
		const signals = new Map<string, ActivitySignal>();

		// userId/replyUserId/renoteUserId をORで跨ぐとどのインデックスも効かず直近14日の全ノートを
		// PK範囲スキャンするため、インデックスが効く3クエリに分割する
		// （userId=me は (userId,id) 複合、replyUserId/renoteUserId=me は専用の部分インデックス）。
		const noteSelect = () => this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.addSelect('note.userId', 'userId')
			.addSelect('note.replyUserId', 'replyUserId')
			.addSelect('note.renoteUserId', 'renoteUserId')
			.andWhere('note.id > :sinceId', { sinceId })
			.andWhere('note.visibility != \'specified\'')
			.orderBy('note.id', 'DESC')
			.limit(SEED_INTERACTION_EVENT_FETCH_LIMIT);

		const [myEngagementRows, replyToMeRows, renoteOfMeRows] = await Promise.all([
			noteSelect()
				.andWhere('note.userId = :meId', { meId })
				.andWhere(new Brackets(qb => {
					qb.where('note.replyUserId IS NOT NULL').orWhere('note.renoteUserId IS NOT NULL');
				}))
				.getRawMany<{ id: string; userId: string; replyUserId: string | null; renoteUserId: string | null }>(),
			noteSelect()
				.andWhere('note.replyUserId = :meId', { meId })
				.getRawMany<{ id: string; userId: string; replyUserId: string | null; renoteUserId: string | null }>(),
			noteSelect()
				.andWhere('note.renoteUserId = :meId', { meId })
				.getRawMany<{ id: string; userId: string; replyUserId: string | null; renoteUserId: string | null }>(),
		]);

		// 同一ノートが複数クエリに該当し得る（自分への返信かつ自分のノートの引用RN等）ため id で重複排除。
		const seenNoteIds = new Set<string>();
		for (const row of [...myEngagementRows, ...replyToMeRows, ...renoteOfMeRows]) {
			if (seenNoteIds.has(row.id)) continue;
			seenNoteIds.add(row.id);
			const related = new Set<string>();
			if (row.userId === meId) {
				if (row.replyUserId != null && followeeSet.has(row.replyUserId)) related.add(row.replyUserId);
				if (row.renoteUserId != null && followeeSet.has(row.renoteUserId)) related.add(row.renoteUserId);
			} else if (followeeSet.has(row.userId) && (row.replyUserId === meId || row.renoteUserId === meId)) {
				related.add(row.userId);
			}
			for (const userId of related) this.addActivity(signals, userId, row.id, now);
		}

		// リアクションも reaction.userId / note.userId のORを分割
		// （自分が付けた分は note_reaction(userId,id) 複合、自分のノートに付いた分は note(userId,id)→noteId で引ける）。
		const reactionSelect = () => this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.id', 'id')
			.addSelect('reaction.userId', 'reactionUserId')
			.addSelect('note.userId', 'noteUserId')
			.innerJoin('reaction.note', 'note')
			.andWhere('reaction.id > :sinceId', { sinceId })
			.andWhere('note.visibility != \'specified\'')
			.orderBy('reaction.id', 'DESC')
			.limit(SEED_INTERACTION_EVENT_FETCH_LIMIT);

		const [myReactionRows, receivedReactionRows] = await Promise.all([
			reactionSelect()
				.andWhere('reaction.userId = :meId', { meId })
				.getRawMany<{ id: string; reactionUserId: string; noteUserId: string }>(),
			reactionSelect()
				.andWhere('note.userId = :meId', { meId })
				.getRawMany<{ id: string; reactionUserId: string; noteUserId: string }>(),
		]);

		const seenReactionIds = new Set<string>();
		for (const row of [...myReactionRows, ...receivedReactionRows]) {
			if (seenReactionIds.has(row.id)) continue;
			seenReactionIds.add(row.id);
			if (row.reactionUserId === meId && followeeSet.has(row.noteUserId)) {
				this.addActivity(signals, row.noteUserId, row.id, now);
			} else if (row.noteUserId === meId && followeeSet.has(row.reactionUserId)) {
				this.addActivity(signals, row.reactionUserId, row.id, now);
			}
		}

		await this.redisClient.set(cacheKey, this.serializeSeedSignals(signals), 'EX', SEED_SIGNALS_CACHE_TTL_SECONDS);
		return signals;
	}

	@bindThis
	private async getCandidateActivityMultipliers(userIds: MiUser['id'][]): Promise<Map<string, number>> {
		if (userIds.length === 0) return new Map();
		const sinceId = this.idService.gen(Date.now() - ACTIVITY_LOOKBACK_MS);
		const now = Date.now();
		const signals = new Map<string, ActivitySignal>();

		const noteRows = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.addSelect('note.userId', 'userId')
			.where('note.userId IN (:...userIds)', { userIds })
			.andWhere('note.id > :sinceId', { sinceId })
			.andWhere('note.visibility IN (:...visibilities)', { visibilities: ['public', 'home', 'followers'] })
			.orderBy('note.id', 'DESC')
			.limit(CANDIDATE_ACTIVITY_EVENT_FETCH_LIMIT)
			.getRawMany<{ id: string; userId: string }>();
		for (const row of noteRows) this.addActivity(signals, row.userId, row.id, now);

		const reactionRows = await this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.id', 'id')
			.addSelect('reaction.userId', 'userId')
			.innerJoin('reaction.note', 'note')
			.where('reaction.userId IN (:...userIds)', { userIds })
			.andWhere('reaction.id > :sinceId', { sinceId })
			.andWhere('note.visibility IN (:...visibilities)', { visibilities: ['public', 'home', 'followers'] })
			.orderBy('reaction.id', 'DESC')
			.limit(CANDIDATE_ACTIVITY_EVENT_FETCH_LIMIT)
			.getRawMany<{ id: string; userId: string }>();
		for (const row of reactionRows) this.addActivity(signals, row.userId, row.id, now);

		const receivedReactionRows = await this.noteReactionsRepository.createQueryBuilder('reaction')
			.select('reaction.id', 'id')
			.addSelect('note.userId', 'userId')
			.innerJoin('reaction.note', 'note')
			.where('note.userId IN (:...userIds)', { userIds })
			.andWhere('reaction.id > :sinceId', { sinceId })
			.andWhere('note.visibility IN (:...visibilities)', { visibilities: ['public', 'home', 'followers'] })
			.orderBy('reaction.id', 'DESC')
			.limit(CANDIDATE_ACTIVITY_EVENT_FETCH_LIMIT)
			.getRawMany<{ id: string; userId: string }>();
		for (const row of receivedReactionRows) this.addPassiveActivity(signals, row.userId, row.id, now);

		return new Map(userIds.map(id => [id, this.getCandidateActivityMultiplier(signals.get(id), now)]));
	}

	/**
	 * FoF ユーザーをスコア付きで返す（案1-2）。
	 * score = Σ(seed重み for その候補をフォローしている seed) / log10(followers) × フォロバ補正 × 鍵補正。
	 * 既フォロー・自分・mute/block/被block・インスタンスミュート・bot/suspended/deleted/非explorable は除外。
	 */
	@bindThis
	private async getFoFUserCandidates(meId: MiUser['id'], enrichLimit: number = FOF_CANDIDATE_POOL * FOF_USER_OVERFETCH): Promise<Map<string, InternalFollowCandidate>> {
		const followingMap = await this.cacheService.userFollowingsCache.fetch(meId);
		const allFolloweeIds = Object.keys(followingMap);
		if (allFolloweeIds.length === 0) return new Map();

		const [muting, blocking, blocked, profile, followerSet, pendingFolloweeIds, seedInteractionSignals] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(meId),
			this.cacheService.userBlockingCache.fetch(meId),
			this.cacheService.userBlockedCache.fetch(meId),
			this.cacheService.userProfileCache.fetch(meId),
			this.getMyFollowerIds(meId),
			this.getPendingFolloweeIds(meId),
			this.getSeedInteractionSignals(meId, allFolloweeIds),
		]);
		const mutedInstances = new Set(profile.mutedInstances);
		const now = Date.now();

		// seed 重み付け → 上位を採用（slice の偏り解消）。
		const weighted = allFolloweeIds.map(id => {
			const mutual = followerSet.has(id) ? SEED_MUTUAL_BOOST : 0;
			const withReplies = followingMap[id]?.withReplies ? SEED_WITHREPLIES_BONUS : 0;
			const interaction = this.getSeedInteractionBoost(seedInteractionSignals.get(id), now);
			return { id, weight: SEED_BASE_WEIGHT + mutual + withReplies + interaction };
		});
		weighted.sort((a, b) => b.weight - a.weight);
		const seeds = weighted.slice(0, MAX_SEED_FOLLOWEES);
		const seedWeight = new Map(seeds.map(s => [s.id, s.weight]));
		const seedIds = seeds.map(s => s.id);

		// 既フォローは「全数」除外（seed の上限とは独立）。
		const exclude = new Set<string>([meId, ...allFolloweeIds, ...muting, ...blocking, ...blocked, ...pendingFolloweeIds]);

		const rows = await this.followingsRepository.createQueryBuilder('f')
			.select('f.followerId', 'followerId')
			.addSelect('f.followeeId', 'followeeId')
			.where('f.followerId IN (:...seedIds)', { seedIds })
			.limit(MAX_FOF_SCAN)
			.getRawMany<{ followerId: string; followeeId: string }>();

		const raw = new Map<string, RawFoFCandidate>();
		for (const { followerId, followeeId } of rows) {
			if (exclude.has(followeeId)) continue;
			const w = seedWeight.get(followerId) ?? SEED_BASE_WEIGHT;
			const cur = raw.get(followeeId);
			if (cur) {
				cur.score += w;
				cur.mutualCount++;
				cur.seedIds.add(followerId);
			} else {
				raw.set(followeeId, { score: w, mutualCount: 1, seedIds: new Set([followerId]) });
			}
		}
		if (raw.size === 0) return new Map();

		// 上位候補を overfetch して品質フィルタ＋正規化（品質落ち分を見込む）。プール幅は呼び出し側が指定。
		const top = Array.from(raw.entries())
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, enrichLimit);
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

		const [shownStats, activityMultipliers] = await Promise.all([
			this.getShownStats(meId),
			this.getCandidateActivityMultipliers(userRows.map(u => u.id)),
		]);
		const result = new Map<string, InternalFollowCandidate>();
		for (const u of userRows) {
			if (u.host != null && mutedInstances.has(u.host)) continue;
			const r = raw.get(u.id);
			if (r == null) continue;
			// 人気は log で軽く正規化（サークル内で濃い人を上に、グローバル有名人偏重を避ける）。
			const norm = r.score / Math.log10(Number(u.followersCount) + 10);
			const followback = followerSet.has(u.id) ? FOLLOWBACK_BOOST : 1;
			const locked = u.isLocked ? LOCKED_PENALTY : 1;
			const activityMultiplier = activityMultipliers.get(u.id) ?? CANDIDATE_ACTIVITY_MULTIPLIER_MIN;
			// 既出ペナルティ2段構え:
			//  - ハード除外（3日以内）は選抜側の tier 分けで効かせる → ここでは lastShownAt を持たせるだけ。
			//  - ソフト減点（7日窓の表示回数）はスコアに乗算 → 3〜7日のユーザーは回数が多いほど沈む。
			const stat = shownStats.get(u.id);
			const softPenalty = 1 / (1 + (SHOWN_SOFT_K * (stat?.count ?? 0)));
			result.set(u.id, {
				userId: u.id,
				score: norm * followback * locked * activityMultiplier * softPenalty,
				reason: 'fof',
				mutualCount: r.mutualCount,
				host: u.host,
				seedIds: [...r.seedIds],
				lastShownAt: stat?.lastAt ?? null,
				activityMultiplier,
				followersCount: Number(u.followersCount),
			});
		}
		return result;
	}

	@bindThis
	public async getFoFUserScores(meId: MiUser['id']): Promise<Map<string, FollowCandidate>> {
		const candidates = await this.getFoFUserCandidates(meId);
		return new Map([...candidates.entries()].map(([id, c]) => [id, this.toFollowCandidate(c)]));
	}

	private toFollowCandidate(candidate: InternalFollowCandidate): FollowCandidate {
		return {
			userId: candidate.userId,
			score: candidate.score,
			reason: candidate.reason,
			mutualCount: candidate.mutualCount,
		};
	}

	private rememberPicked(candidate: InternalFollowCandidate, usedSeedCounts: Map<string, number>, usedHostCounts: Map<string, number>): void {
		for (const seedId of candidate.seedIds) {
			usedSeedCounts.set(seedId, (usedSeedCounts.get(seedId) ?? 0) + 1);
		}
		if (candidate.host != null) {
			usedHostCounts.set(candidate.host, (usedHostCounts.get(candidate.host) ?? 0) + 1);
		}
	}

	private getSeedNovelty(candidate: InternalFollowCandidate, usedSeedCounts: Map<string, number>): number {
		if (candidate.seedIds.length === 0) return 0;
		const unused = candidate.seedIds.filter(seedId => (usedSeedCounts.get(seedId) ?? 0) === 0).length;
		return unused / candidate.seedIds.length;
	}

	private canPickStrict(candidate: InternalFollowCandidate, usedSeedCounts: Map<string, number>, usedHostCounts: Map<string, number>): boolean {
		const seedsAvailable = candidate.seedIds.length === 0 || candidate.seedIds.some(seedId => (usedSeedCounts.get(seedId) ?? 0) < MAX_PER_SEED);
		if (!seedsAvailable) return false;
		if (candidate.host != null && (usedHostCounts.get(candidate.host) ?? 0) >= MAX_PER_REMOTE_HOST) return false;
		return true;
	}

	private scoreForDiversityPick(candidate: InternalFollowCandidate, usedSeedCounts: Map<string, number>, usedHostCounts: Map<string, number>, mode: 'core' | 'diverse' | 'explore'): number {
		const seedNovelty = this.getSeedNovelty(candidate, usedSeedCounts);
		const maxSeedUse = candidate.seedIds.length === 0 ? 0 : Math.max(...candidate.seedIds.map(seedId => usedSeedCounts.get(seedId) ?? 0));
		const hostUse = candidate.host == null ? 0 : (usedHostCounts.get(candidate.host) ?? 0);
		const hostNovelty = candidate.host == null || hostUse === 0 ? 1 : 0;

		if (mode === 'explore') {
			return (candidate.activityMultiplier * 0.55) + (seedNovelty * 0.35) + (hostNovelty * 0.2) + (candidate.score * 0.12);
		}

		const diversityMultiplier = mode === 'diverse'
			? 0.55 + (seedNovelty * 0.55) + (hostNovelty * 0.18)
			: 1.0 + (seedNovelty * 0.12) + (hostNovelty * 0.06);
		const overusePenalty = 1 + (maxSeedUse * (mode === 'diverse' ? 0.28 : 0.1)) + (hostUse * (mode === 'diverse' ? 0.18 : 0.06));
		return (candidate.score * diversityMultiplier) / overusePenalty;
	}

	private pickCandidates(candidates: InternalFollowCandidate[], count: number, selectedIds: Set<string>, usedSeedCounts: Map<string, number>, usedHostCounts: Map<string, number>, mode: 'core' | 'diverse' | 'explore'): InternalFollowCandidate[] {
		const picked: InternalFollowCandidate[] = [];
		for (let i = 0; i < count; i++) {
			const remaining = candidates.filter(c => !selectedIds.has(c.userId));
			if (remaining.length === 0) break;
			const strict = remaining.filter(c => this.canPickStrict(c, usedSeedCounts, usedHostCounts));
			const pool = strict.length > 0 ? strict : remaining;
			pool.sort((a, b) => this.scoreForDiversityPick(b, usedSeedCounts, usedHostCounts, mode) - this.scoreForDiversityPick(a, usedSeedCounts, usedHostCounts, mode));
			const next = pool[0];
			selectedIds.add(next.userId);
			this.rememberPicked(next, usedSeedCounts, usedHostCounts);
			picked.push(next);
		}
		return picked;
	}

	private selectDiverseCandidates(candidates: InternalFollowCandidate[], limit: number): InternalFollowCandidate[] {
		// 3日以内に見せた人はハード除外。それ以外（新顔＋3〜7日のソフト減点済み）で枠を埋める。
		// ハード除外組は新顔が尽きた時だけ「見せたのが一番昔の人」から戻す（フォールバック）。
		const now = Date.now();
		const isHardExcluded = (c: InternalFollowCandidate): boolean => c.lastShownAt != null && (now - c.lastShownAt) <= SHOWN_HARD_MS;
		// score にはソフト減点（7日窓の表示回数）が既に乗っているので、3〜7日の人はここで自然に下がる。
		const eligible = candidates.filter(c => !isHardExcluded(c)).sort((a, b) => b.score - a.score);
		const hardExcluded = candidates.filter(isHardExcluded)
			.sort((a, b) => (a.lastShownAt ?? 0) - (b.lastShownAt ?? 0));

		const selectedIds = new Set<string>();
		const usedSeedCounts = new Map<string, number>();
		const usedHostCounts = new Map<string, number>();
		const coreCount = Math.min(limit, Math.ceil(limit * DIVERSITY_CORE_SHARE));
		const diverseCount = Math.min(limit - coreCount, Math.floor(limit * DIVERSITY_DIVERSE_SHARE));
		const exploreCount = Math.max(0, limit - coreCount - diverseCount);

		const selected = [
			...this.pickCandidates(eligible, coreCount, selectedIds, usedSeedCounts, usedHostCounts, 'core'),
			...this.pickCandidates(eligible, diverseCount, selectedIds, usedSeedCounts, usedHostCounts, 'diverse'),
			...this.pickCandidates(eligible, exploreCount, selectedIds, usedSeedCounts, usedHostCounts, 'explore'),
		];

		// まだ非除外の候補が残っていればスコア順で埋める。
		this.fillRemaining(selected, eligible, selectedIds, limit);
		// それでも足りなければハード除外組を古い順（見せたのが一番昔）に戻す。
		this.fillRemaining(selected, hardExcluded, selectedIds, limit);

		return selected;
	}

	// 与えた順序のまま、未選択の候補で limit まで埋める。
	private fillRemaining(selected: InternalFollowCandidate[], pool: InternalFollowCandidate[], selectedIds: Set<string>, limit: number): void {
		for (const candidate of pool) {
			if (selected.length >= limit) break;
			if (selectedIds.has(candidate.userId)) continue;
			selectedIds.add(candidate.userId);
			selected.push(candidate);
		}
	}

	/**
	 * フォロー候補（step10 表示用）。スコア順に返す。
	 */
	@bindThis
	public async getFollowCandidates(meId: MiUser['id'], limit: number): Promise<FollowCandidate[]> {
		const scores = await this.getFoFUserCandidates(meId);
		return this.selectDiverseCandidates(Array.from(scores.values()), limit).map(c => this.toFollowCandidate(c));
	}

	private getFoFNoteCacheKey(meId: MiUser['id'], limit: number, withFiles: boolean): string {
		return `${FOF_NOTE_CACHE_KEY_PREFIX}${meId}:${withFiles ? 'files' : 'all'}:${limit}`;
	}

	private isFoFNoteArray(value: unknown): value is FoFNote[] {
		return Array.isArray(value) && value.every(item => {
			if (item == null || typeof item !== 'object') return false;
			const note = item as Partial<FoFNote>;
			return typeof note.noteId === 'string' && typeof note.userId === 'string' && typeof note.score === 'number';
		});
	}

	@bindThis
	private applyFoFNoteRequestOptions(notes: FoFNote[], limit: number, opts: FoFNoteOptions): FoFNote[] {
		const out: FoFNote[] = [];
		for (const note of notes) {
			if (opts.newerThan != null && note.noteId >= opts.newerThan) continue;
			if (opts.hardExcludedNoteIds?.has(note.noteId) === true) continue;
			out.push({
				...note,
				score: opts.softPenaltyNoteIds?.has(note.noteId) === true ? note.score * FOF_NOTE_SERVED_PENALTY : note.score,
			});
		}
		out.sort((a, b) => b.score - a.score);
		return out.slice(0, limit);
	}

	@bindThis
	private async getFoFNotePool(meId: MiUser['id'], limit: number, withFiles: boolean): Promise<FoFNote[]> {
		const cacheKey = this.getFoFNoteCacheKey(meId, limit, withFiles);
		const cached = await this.redisClient.get(cacheKey);
		if (cached != null) {
			try {
				const parsed: unknown = JSON.parse(cached);
				if (this.isFoFNoteArray(parsed)) return parsed;
			} catch {
				// 壊れたキャッシュは無視して作り直す。
			}
		}

		const existing = this.fofNotePoolInflight.get(cacheKey);
		if (existing != null) return existing;

		const promise = this.buildFoFNotePool(meId, limit, withFiles);
		this.fofNotePoolInflight.set(cacheKey, promise);

		try {
			const notes = await promise;
			try {
				await this.redisClient.set(
					cacheKey,
					JSON.stringify(notes),
					'EX',
					notes.length > 0 ? FOF_NOTE_CACHE_TTL_SECONDS : FOF_NOTE_EMPTY_CACHE_TTL_SECONDS);
			} catch {
				// キャッシュ書き込み失敗だけで推薦レスポンスは落とさない。
			}
			return notes;
		} finally {
			this.fofNotePoolInflight.delete(cacheKey);
		}
	}

	/**
	 * FoF ユーザーの直近人気ノート候補プールを作る（案3）。
	 * noteScore = 作者スコア × 新鮮さ × 可視性 × popularity × 返信0.5x。
	 * 反応/リノートが無い新着は FoF では出さない。FoF はユーザー提案由来なので、TLでは「人気投稿」だけに絞る。
	 * チャンネル投稿・純RNは除外、public/home のみ。
	 */
	@bindThis
	private async buildFoFNotePool(meId: MiUser['id'], limit: number, withFiles: boolean): Promise<FoFNote[]> {
		// ノート候補はフォロー推薦の多様性選抜（上位40・リモートhub偏重で直近ノートがローカルDBに無いことが多い）を
		// 通さず、品質フィルタ済みの広いFoF候補プール全体から引く。足りない時だけ候補ユーザー幅を広げ、
		// 「実際に投稿がある人」を取りこぼさない。
		const candidateMap = await this.getFoFUserCandidates(meId, FOF_NOTE_CANDIDATE_POOL_STEPS.at(-1)!);
		if (candidateMap.size === 0) return [];

		// 土台スコア = 「サークル内親密度(c.score)」と「人気度(フォロワー数)」のブレンド。
		// 人気枠(FOF_POPULAR_NOTE_RATIO)を混ぜることで、ローカルに投稿があるリモート人気アカも一定割合出す。
		const allCandidates = [...candidateMap.values()].sort((a, b) => b.score - a.score);
		const cands = allCandidates;
		const maxIntimacy = Math.max(1e-9, ...cands.map(c => c.score));
		const maxPopularity = Math.max(1e-9, ...cands.map(c => Math.log10(c.followersCount + 10)));
		const candBase = new Map<string, number>(cands.map(c => {
			const intimacy = c.score / maxIntimacy;
			const popularity = Math.log10(c.followersCount + 10) / maxPopularity;
			return [c.userId, ((1 - FOF_POPULAR_NOTE_RATIO) * intimacy) + (FOF_POPULAR_NOTE_RATIO * popularity)];
		}));

		// 窓を広げてDBにある過去投稿も対象に（無ければ諦める）。新鮮さはスコアで優先する。
		const sinceId = this.idService.gen(Date.now() - FOF_NOTE_QUERY_LOOKBACK_MS);
		const now = Date.now();
		const queryLimit = this.getFoFNoteQueryLimit(limit);
		let scored: FoFNote[] = [];

		for (const poolSize of FOF_NOTE_CANDIDATE_POOL_STEPS) {
			const userIds = allCandidates.slice(0, poolSize).map(c => c.userId);
			if (userIds.length === 0) break;

			const withFilesFilter = withFiles ? 'AND note."fileIds" != \'{}\'' : '';
			const notes = await this.notesRepository.query(`
				SELECT
					author_notes.id AS id,
					author_notes."userId" AS "userId",
					author_notes.visibility AS visibility,
					author_notes."replyId" AS "replyId",
					author_notes."renoteCount" AS "renoteCount",
					author_notes.reactions AS reactions,
					author_notes."authorNoteRank" AS "authorNoteRank"
				FROM unnest($1::varchar[]) AS candidate("userId")
				JOIN LATERAL (
					SELECT
						picked.id,
						picked."userId",
						picked.visibility,
						picked."replyId",
						picked."renoteCount",
						picked.reactions,
						row_number() OVER (ORDER BY picked.id DESC) AS "authorNoteRank"
					FROM (
						SELECT
							note.id,
							note."userId",
							note.visibility,
							note."replyId",
							note."renoteCount",
							note.reactions
						FROM "note" note
						WHERE note."userId" = candidate."userId"
							AND note.id > $2
							AND note."channelId" IS NULL
							AND (note.visibility = 'public' OR note.visibility = 'home')
							AND (
								note."renoteId" IS NULL
								OR note.text IS NOT NULL
								OR note."fileIds" != '{}'
								OR note."hasPoll" = TRUE
							)
							${withFilesFilter}
						ORDER BY note.id DESC
						LIMIT $3
					) picked
				) author_notes ON TRUE
				ORDER BY author_notes.id DESC
				LIMIT $4
			`, [userIds, sinceId, FOF_NOTE_PER_AUTHOR_LIMIT, queryLimit]) as FoFNoteRow[];

			scored = notes.flatMap(n => {
				const base = candBase.get(n.userId) ?? 0;
				const ageMs = now - this.idService.parse(n.id).date.getTime();
				const recency = FOF_NOTE_RECENCY.find(r => ageMs < r.withinMs)?.weight ?? 0;
				const vis = n.visibility === 'public' ? 1.0 : 0.8;
				const reactionsTotal = n.reactions ? Object.values(n.reactions).reduce((a, b) => a + Number(b), 0) : 0;
				const engagementCount = reactionsTotal + 2 * Number(n.renoteCount ?? 0);
				if (engagementCount < FOF_NOTE_MIN_ENGAGEMENT) return [];
				// 人気は log で圧縮しつつ、直近性も残す。0反応新着は上の閾値で候補外。
				const popularity = Math.log10(1 + engagementCount);
				const replyPenalty = n.replyId != null ? FOF_NOTE_REPLY_PENALTY : 1;
				const authorRankPenalty = this.getAuthorNoteRankPenalty(Number(n.authorNoteRank));
				return [{
					noteId: n.id,
					userId: n.userId,
					score: base * (0.25 + recency) * vis * popularity * replyPenalty * authorRankPenalty,
				}];
			});
			scored.sort((a, b) => b.score - a.score);

			// 取得段階で作者ごとに上限を切っているので、十分な候補数が集まればプール拡張を止める。
			if (scored.length >= limit * 2) break;
		}

		return scored.slice(0, limit * 2);
	}

	/**
	 * FoF ユーザーの直近人気ノートを推薦候補として返す。
	 * 重いFoF探索とノートスコアリングは短TTLキャッシュし、リクエストごとの差分だけ毎回反映する。
	 */
	@bindThis
	public async getFoFNoteIds(meId: MiUser['id'], limit: number, opts: FoFNoteOptions = {}): Promise<FoFNote[]> {
		const notes = await this.getFoFNotePool(meId, limit, opts.withFiles === true);
		return this.applyFoFNoteRequestOptions(notes, limit, opts);
	}
}
