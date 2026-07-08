/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { NotesRepository } from '@/models/_.js';
import type { MiUser, MiLocalUser } from '@/models/User.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiUserProfile } from '@/models/UserProfile.js';
import type { Packed } from '@/misc/json-schema.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { HanamiUserRecommendationService } from '@/core/hanami/HanamiUserRecommendationService.js';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { TASTE_EMBED_MODEL, TASTE_MATCH_WINDOW_MS } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { HANAMI_TASTE_MATCH_KEY_PREFIX, HANAMI_FORYOU_ACTIVE_KEY_PREFIX, HANAMI_FORYOU_ACTIVE_TTL_SEC } from '@/core/hanami/HanamiForYouKeys.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';
import {
	hanamiInterleave,
	hanamiAxisOrder,
	HANAMI_FOR_YOU_AXES,
	type HanamiAxis,
	type HanamiAxisLevel,
	type HanamiConfidence,
	type ForYouCandidate,
} from '@/core/hanami/HanamiForYouInterleave.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// confidence 閾値（§10）。
const CONFIDENCE_HIGH_ENGAGEMENT = 50;
const CONFIDENCE_LOW_ENGAGEMENT = 5;

// 候補窓（§10）。
const NEIGHBOR_TRENDING_WINDOW_MS = 48 * 60 * 60 * 1000;
const CATCHUP_WINDOW_MS = 7 * DAY_MS; // §14-D8 = 7d 固定

// 候補プールサイズ（§10。safety filter で多く落ちる前提の余裕）。
const GLOBAL_POPULAR_POOL = 200;
const EXPLORATION_POOL = 500;
const TRENDING_POOL = 200;
const FOF_POOL = 200;
const NEIGHBOR_NOTE_POOL = 250;
const CATCHUP_NOTE_POOL = 250;

// reactionSimilar（興味マッチ新着）: バッチ事前計算 zset（24h窓・cos≥τ）の取り出し。
// zset score = cos×鮮度（バッチ側で焼き込み済み・毎10分更新）。人気条件なし＝埋もれた投稿でも内容が興味に合えば出る。
const TASTE_MATCH_POOL = 300;
const TOP_RELATION_OTHERS = 100;
const DB_GLOBAL_FALLBACK_WINDOW_MS = 30 * DAY_MS;
const DB_GLOBAL_FALLBACK_SAMPLE = 5000;

const ALS_RUN_KIND = 'als';

// popular軸のサーブ時パーソナライズ強度: score ×= (1 + β·affinity)。
// β=0.5 で top20 のうち約4件が「自分好みの人気投稿」に入れ替わる（実測シミュレーション）。
// ALS author factor は人気候補作者をほぼ100%被覆する（MiniLM埋め込みの被覆1%と対照的）。
const POPULAR_AFFINITY_BETA = 0.5;

// taste-clustered popular（hanami-taste-cluster-spec v0.2 §2）。
// 候補をユーザーの好みクラスタに割り当て、クラスタ別%枠の重み付き抽選で並べる（スコア/max合成はしない）。
const TASTE_TAU_ASSIGN = 0.25; // これ未満の類似は general 扱い（実測校正: 0.25で人気候補の約56%が割当・7/8クラスタに分散）
const TASTE_GENERAL_SHARE = 0.25; // 非パーソナル枠の固定比率（anti-bubble・全減らし時の保険）
const TASTE_SOFTMAX_TEMP = 0.7; // クラスタ内抽選の温度（上位固定を避ける）

// メディア嗜好のオッズ比較正（2026-07-06 実測）: 配信のメディア比率をユーザーの反応実績
// （aux.mediaReactionRate）へ収束させる。odds = (r/(1-r)) / (p/(1-p))（r=ユーザーのメディア反応率,
// p=候補プールのメディア比率）をメディア候補の抽選重みに乗算する。
// バケツ内抽選とバケツ選択の両段に掛けるのが要点: 片段だけだとメディア過多バケツ（絵のキャプションが
// 文体クラスタに誤マッチして溜まる）が share ごと絵を吐き続け 31% で下げ止まる。両段で 9% まで収束
//（nanasina 実測 r=3.9%・プール p=70% のダンプ再現。メディア好き r=0.9 側は 84% と対称に動く）。
const TASTE_MEDIA_RATE_MIN = 0.02; // r/p のクランプ（0/1 で odds が発散しないように）
const TASTE_MEDIA_RATE_MAX = 0.98;
const TASTE_MEDIA_ODDS_MIN = 0.01;
const TASTE_MEDIA_ODDS_MAX = 50;

// MiniLM taste 再ランク＋aux boost（§5/§6/§14-D7。弱め＝タイブレーク程度）。
const FORYOU_EMBEDDING_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2';
const TASTE_RERANK_WEIGHT_BY_AXIS: Partial<Record<HanamiAxis, number>> = {
	// globalPopular は taste cluster 枠（applyTasteClusterOrdering）が担うため対象外。
	// 単一centroidのスカラー加点は「密クラスタ優遇」の再導入になり、クラスタ別%枠を壊す（§8）。
	trending: 0.3,
	fof: 0.45,
};
const AUX_PEAK_HOURS = 6; // active_hour_hist 上位 N 時間を「夜型ピーク」とみなす
const AUX_HOUR_BOOST = 0.1;
const AUX_MEDIA_DISCOUNT = 0.15;
const AUX_TEXT_HEAVY_THRESHOLD = 0.2; // mediaReactionRate がこれ未満 = text 偏重

// 既出のソフト減点（軸内スコアへ乗算）。除外ではないので必ず再登場する。served=直近ほど深く沈める。
const SERVED_SCORE_PENALTY = 0.5;
const SEEN_SCORE_PENALTY = 0.7;

type ReasonMeta = { source: HanamiAxis; sources: HanamiAxis[]; term?: string; clusterId?: number };

type LegacyHanamiAxis = 'popular';
type HanamiAxisServerConfig = Partial<Record<HanamiAxis | LegacyHanamiAxis, { available?: boolean; default?: boolean }>>;
type HanamiAxisUserConfig = Partial<Record<HanamiAxis | LegacyHanamiAxis, HanamiAxisLevel | boolean>>;

// 旧5軸設定からの互換解決。新キーがあれば新キーを優先し、無ければ旧キーを既定値として読む。
const AXIS_CONFIG_KEYS: Record<HanamiAxis, readonly (HanamiAxis | LegacyHanamiAxis)[]> = {
	globalPopular: ['globalPopular', 'popular'],
	exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'],
	reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'],
	trending: ['trending'],
	fof: ['fof'],
};

// UI 表示用の理由ラベル。provenance と同じ7軸名を返し、設定画面と表示理由を一致させる。
const AXIS_TO_UI_REASON: Record<HanamiAxis, string> = {
	globalPopular: 'globalPopular',
	exploration: 'exploration',
	trending: 'trending',
	reactionSimilar: 'reactionSimilar',
	neighborTrending: 'neighborTrending',
	catchup: 'catchup',
	fof: 'fof',
};

/**
 * はなみTL For You-only サービング（canonical spec §3–§6/§9）。
 *
 * confidence(§10) → 7軸候補生成(§4/§5) → quota interleave(§6.1) → safety pack → served/provenance 記録。
 * ホームTLは混ぜない（§9。home は notes/timeline の責務）。学習・重い計算はバッチ。サーブは事前計算の取り出し＋quota併合のみ。
 *
 * バッチ出力（ALS factor/rec/neighbor・relation）が未生成でも confidence=none で globalPopular/trending/fof/exploration が動く（cold-start）。
 */
@Injectable()
export class HanamiForYouService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private featuredService: FeaturedService,
		private cacheService: CacheService,
		private idService: IdService,
		private hanamiTrendService: HanamiTrendService,
		private hanamiUserRecommendationService: HanamiUserRecommendationService,
		private hanamiForYouBatchService: HanamiForYouBatchService,
		private hanamiForYouProvenanceService: HanamiForYouProvenanceService,
		private hanamiForYouSafetyService: HanamiForYouSafetyService,
		private hanamiRecommendationService: HanamiRecommendationService,
	) {
	}

	// ───────────────────────── エントリポイント ─────────────────────────

	/**
	 * For You ページ（ranked, home を混ぜない）。limit 件返す。
	 * 既出（served/seen）は除外せず軸内スコアを弱く減点（沈むが再登場）。§9
	 */
	@bindThis
	public async getForYouPage(me: MiLocalUser, opts: { limit: number; withFiles: boolean }): Promise<Packed<'Note'>[]> {
		// はなみTL ON/OFF（既存設定を退避操作に使う。For You 独自 kill switch は持たない＝§2）。
		const profile = await this.cacheService.userProfileCache.fetch(me.id);
		if (!profile.hanamiRecommendationEnabled) return [];
		const showReason = profile.hanamiShowRecommendationReason;
		const axisLevels = this.resolveAxisLevels(profile);
		if (axisLevels.size === 0) return [];

		// taste match バッチの対象ゲート用アクティブマーカー（fire-and-forget。served は TTL30分なので流用しない）。
		this.redisClient.set(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + me.id, '1', 'EX', HANAMI_FORYOU_ACTIVE_TTL_SEC).catch(() => { /* 次回ページで再試行 */ });

		const followings = await this.cacheService.userFollowingsCache.fetch(me.id);
		const followeeIds = Object.keys(followings);

		const alsRunId = await this.hanamiForYouBatchService.getLatestReadyRunId(ALS_RUN_KIND);
		const confidence = await this.computeConfidence(me.id, followeeIds.length, alsRunId);

		// 既出（served/seen）は「除外」ではなく軸内スコアの弱い減点＝沈むが再登場（人気は再キュー）。§6/§9
		const { served, seen } = await this.hanamiRecommendationService.getServedSeenForExclusion(me.id);

		const axisCandidates = await this.gatherCandidates(me.id, confidence, alsRunId, followeeIds, opts.withFiles, axisLevels, served, seen);
		await this.resolveAuthors(axisCandidates);
		// 前段除外: noteベースのグローバル安全＋ユーザーのメディア設定を interleave の前で候補から除く。
		// 除外で空いた枠は interleave が他候補で埋め直す＝hideSensitive でもページが痩せない。
		await this.pruneGloballyUnsafe(me, axisCandidates, opts.withFiles);
		// MiniLM taste 再ランク＋aux 弱 boost（§5/§6/§14-D7）。データ（centroid/aux）が無ければ no-op（cold-start）。
		await this.applyTasteAndBoost(me.id, axisCandidates);
		// 既出のソフト減点を軸内スコアへ乗算（tier ゲートは廃止＝決定論・痩せない）。
		this.applyRecencyPenalty(axisCandidates, served, seen);

		const interleaved = hanamiInterleave({ confidence, limit: opts.limit, axisCandidates, axisLevels });
		if (interleaved.length === 0) return [];

		// source=枠を消費した軸 / sources=全寄与軸（§6.1-2）。
		const reasonOf = new Map<string, ReasonMeta>(interleaved.map(c => [c.noteId, { source: c.source, sources: c.sources, term: c.term, clusterId: c.clusterId }]));
		// safety filter（§8 中央化）。interleave 順で取得・安全化し limit まで backfill。
		const notes = await this.hanamiForYouSafetyService.filterAndPack(interleaved.map(c => c.noteId), opts.limit, me, opts.withFiles);
		if (notes.length === 0) return [];

		this.markMeta(notes, reasonOf, showReason);
		await this.recordServed(me.id, notes, reasonOf);

		return notes;
	}

	// ───────────────────────── confidence（§10） ─────────────────────────

	@bindThis
	private async computeConfidence(meId: MiUser['id'], followeeCount: number, alsRunId: string | null): Promise<HanamiConfidence> {
		const reactionRow = await this.db.query(
			`SELECT count(*)::int AS c FROM note_reaction WHERE "userId" = $1`,
			[meId],
		) as { c: number }[];
		const postRow = await this.db.query(
			`SELECT count(*)::int AS c FROM note WHERE "userId" = $1 AND ("replyId" IS NOT NULL OR "renoteId" IS NOT NULL)`,
			[meId],
		) as { c: number }[];
		const engagement = Number(reactionRow[0]?.c ?? 0) + Number(postRow[0]?.c ?? 0);

		const hasFactor = alsRunId != null && await this.exists(
			`SELECT 1 FROM "hanami_foryou_user_factor" WHERE "runId" = $1 AND "userId" = $2 LIMIT 1`,
			[alsRunId, meId],
		);
		const hasCentroid = await this.exists(
			`SELECT 1 FROM "hanami_foryou_user_centroid" WHERE "userId" = $1 LIMIT 1`,
			[meId],
		);
		const hasRelation = await this.exists(
			`SELECT 1 FROM "hanami_foryou_relation" WHERE "userId" = $1 LIMIT 1`,
			[meId],
		);

		if (engagement >= CONFIDENCE_HIGH_ENGAGEMENT && hasFactor && hasCentroid) return 'high';
		if (engagement >= CONFIDENCE_LOW_ENGAGEMENT || followeeCount > 0 || hasRelation) return 'low';
		return 'none';
	}

	private async exists(sql: string, params: unknown[]): Promise<boolean> {
		const rows = await this.db.query(sql, params) as unknown[];
		return rows.length > 0;
	}

	// ───────────────────────── ユーザー別軸量（7軸） ─────────────────────────

	private normalizeAxisLevel(v: unknown, def: boolean): HanamiAxisLevel {
		if (v === 'off' || v === 'low' || v === 'normal' || v === 'high') return v;
		if (v === true) return 'normal';
		if (v === false) return 'off';
		return def ? 'normal' : 'off';
	}

	private axisServerConfig(axis: HanamiAxis, serverCfg: HanamiAxisServerConfig): { available: boolean; default: boolean } {
		const keys = AXIS_CONFIG_KEYS[axis];
		const available = keys.map(k => serverCfg[k]?.available).find(v => v !== undefined) ?? true;
		const def = keys.map(k => serverCfg[k]?.default).find(v => v !== undefined) ?? true;
		return { available, default: def };
	}

	private axisUserValue(axis: HanamiAxis, userCfg: HanamiAxisUserConfig): HanamiAxisLevel | boolean | undefined {
		for (const key of AXIS_CONFIG_KEYS[axis]) {
			const v = userCfg[key];
			if (v !== undefined) return v;
		}
		return undefined;
	}

	private resolveAxisLevels(profile: MiUserProfile): Map<HanamiAxis, HanamiAxisLevel> {
		const serverCfg = (this.meta.hanamiRecommendationAxisConfig ?? {}) as HanamiAxisServerConfig;
		const userCfg = (profile.hanamiRecommendationAxes ?? {}) as HanamiAxisUserConfig;
		const out = new Map<HanamiAxis, HanamiAxisLevel>();
		for (const axis of HANAMI_FOR_YOU_AXES) {
			const server = this.axisServerConfig(axis, serverCfg);
			if (!server.available) continue;
			const level = this.normalizeAxisLevel(this.axisUserValue(axis, userCfg), server.default);
			if (level !== 'off') out.set(axis, level);
		}
		return out;
	}

	// ───────────────────────── 候補生成（§4/§5） ─────────────────────────

	@bindThis
	private async gatherCandidates(meId: MiUser['id'], confidence: HanamiConfidence, alsRunId: string | null, followeeIds: string[], withFiles: boolean, axisLevels: ReadonlyMap<HanamiAxis, HanamiAxisLevel>, served: ReadonlySet<string>, seen: ReadonlySet<string>): Promise<Map<HanamiAxis, ForYouCandidate[]>> {
		const order = hanamiAxisOrder(confidence).filter(axis => axisLevels.has(axis)); // exploration を含む
		const map = new Map<HanamiAxis, ForYouCandidate[]>();
		await Promise.all(order.map(async axis => {
			try {
				map.set(axis, await this.candidatesForAxis(axis, meId, alsRunId, followeeIds, withFiles, served, seen));
			} catch {
				map.set(axis, []); // 1軸が落ちても他軸で配信する
			}
		}));
		return map;
	}

	private async candidatesForAxis(axis: HanamiAxis, meId: MiUser['id'], alsRunId: string | null, followeeIds: string[], withFiles: boolean, served: ReadonlySet<string>, seen: ReadonlySet<string>): Promise<ForYouCandidate[]> {
		switch (axis) {
			case 'globalPopular': return this.globalPopularCandidates(meId, alsRunId, served, seen);
			case 'exploration': return this.explorationCandidates();
			case 'trending': return this.trendingCandidates();
			case 'fof': return this.fofCandidates(meId, withFiles);
			case 'neighborTrending': return this.neighborTrendingCandidates(meId, alsRunId);
			case 'reactionSimilar': return this.reactionSimilarCandidates(meId, followeeIds, served, seen);
			case 'catchup': return this.catchupCandidates(meId, followeeIds);
			default: return [];
		}
	}

	/** globalPopular: グローバル人気（公共圏の発見・§4）。engagement 順 × 作者親和度リランク × taste クラスタ枠。 */
	private async globalPopularCandidates(meId: MiUser['id'], alsRunId: string | null, served: ReadonlySet<string>, seen: ReadonlySet<string>): Promise<ForYouCandidate[]> {
		const ranked = await this.featuredService.getGlobalNotesRankingWithScores(GLOBAL_POPULAR_POOL);
		const candidates = ranked.length === 0
			? await this.dbGlobalPopularFallbackCandidates(GLOBAL_POPULAR_POOL)
			: ranked.map(([noteId, score]) => ({ noteId, score }));
		const reranked = await this.applyAuthorAffinityRerank(meId, alsRunId, candidates);
		return this.applyTasteClusterOrdering(meId, reranked, served, seen);
	}

	/**
	 * taste-clustered popular（spec v0.2 §2）: 候補を好みクラスタに割り当て、
	 * クラスタ別%枠（share ∝ size×userWeight、general は固定25%）の重み付き抽選で並べ替える。
	 * クラスタ未生成・mean_vec 無し・埋め込み欠損は general 縮退（現行挙動と同一）で壊れない。
	 */
	private async applyTasteClusterOrdering(meId: MiUser['id'], candidates: ForYouCandidate[], served: ReadonlySet<string>, seen: ReadonlySet<string>): Promise<ForYouCandidate[]> {
		if (candidates.length === 0) return candidates;

		// 縮退パス（クラスタ未生成・mean_vec 無し）: applyRecencyPenalty が globalPopular をスキップするため、
		// 既出のソフト減点はここで従来どおり適用する（さもないとクラスタの無いユーザーで同じ人気が再登場し続ける）。
		const recencyPenaltyFallback = () => {
			for (const c of candidates) {
				if (served.has(c.noteId)) c.score *= SERVED_SCORE_PENALTY;
				else if (seen.has(c.noteId)) c.score *= SEEN_SCORE_PENALTY;
			}
			return candidates.sort((a, b) => b.score - a.score);
		};

		const clusters = await this.db.query(
			`SELECT "clusterId", centroid, size, "userWeight"
			 FROM "hanami_foryou_user_taste_cluster" WHERE "userId" = $1 AND model = $2`,
			[meId, TASTE_EMBED_MODEL],
		) as { clusterId: number; centroid: number[]; size: number; userWeight: number }[];
		if (clusters.length === 0) return recencyPenaltyFallback();

		const stateRows = await this.db.query(
			`SELECT "meanVec" FROM "hanami_foryou_taste_state" WHERE model = $1`,
			[TASTE_EMBED_MODEL],
		) as { meanVec: number[] }[];
		const meanVec = stateRows[0]?.meanVec;
		if (meanVec == null || meanVec.length === 0) return recencyPenaltyFallback();

		const embRows = await this.db.query(
			`SELECT "noteId", embedding FROM "hanami_note_embedding" WHERE model = $1 AND "noteId" = ANY($2)`,
			[TASTE_EMBED_MODEL, candidates.map(c => c.noteId)],
		) as { noteId: string; embedding: number[] }[];
		const embByNote = new Map(embRows.map(r => [r.noteId, r.embedding]));

		// メディア嗜好の較正材料（aux 未生成・反応実績ゼロなら null = 補正なし）。
		const mediaCal = await this.computeMediaOddsCalibration(meId, candidates.map(c => c.noteId));

		// バケツ分け: 最大類似クラスタ（τ未満・埋め込み無しは general、weight=0 クラスタは除外=「表示しない」）。
		// 各バケツは fresh（未見）と shown（served/seen 済み）の二段。未見から先に抽選し、尽きたら既出が
		// 同じクラスタ抽選で後ろに続く＝ページは空にならず、後段の再ソートも不要（A3）。
		type Item = { cand: ForYouCandidate; clusterId?: number };
		type Bucket = { fresh: Item[]; shown: Item[] };
		const buckets = new Map<number | 'general', Bucket>();
		buckets.set('general', { fresh: [], shown: [] });
		for (const cl of clusters) buckets.set(cl.clusterId, { fresh: [], shown: [] });
		const push = (key: number | 'general', item: Item) => {
			const b = buckets.get(key)!;
			(served.has(item.cand.noteId) || seen.has(item.cand.noteId) ? b.shown : b.fresh).push(item);
		};
		for (const cand of candidates) {
			const emb = embByNote.get(cand.noteId);
			if (emb == null) {
				push('general', { cand });
				continue;
			}
			// 平均中心化＋正規化して各クラスタ centroid と cos。
			let norm = 0;
			const centered = new Array<number>(meanVec.length);
			for (let i = 0; i < meanVec.length; i++) {
				const v = (emb[i] ?? 0) - meanVec[i];
				centered[i] = v;
				norm += v * v;
			}
			norm = Math.sqrt(norm) || 1;
			let bestCos = -1;
			let best: typeof clusters[number] | null = null;
			for (const cl of clusters) {
				let dot = 0;
				const len = Math.min(centered.length, cl.centroid.length);
				for (let i = 0; i < len; i++) dot += centered[i] * cl.centroid[i];
				const cos = dot / norm;
				if (cos > bestCos) { bestCos = cos; best = cl; }
			}
			if (best == null || bestCos < TASTE_TAU_ASSIGN) {
				push('general', { cand });
			} else if (Number(best.userWeight) <= 0) {
				// 「表示しない」クラスタに強く一致する候補は general にも流さない（ユーザー意思の尊重）。
			} else {
				push(best.clusterId, { cand, clusterId: best.clusterId });
			}
		}

		// share ∝ size×weight、general は総 size×固定比率。
		const totalSize = clusters.reduce((a, c) => a + c.size, 0) || 1;
		const shareOf = new Map<number | 'general', number>();
		for (const cl of clusters) shareOf.set(cl.clusterId, cl.size * Number(cl.userWeight));
		shareOf.set('general', totalSize * TASTE_GENERAL_SHARE);

		return this.drawClusterLottery(buckets, shareOf, mediaCal, candidates.length);
	}

	/**
	 * クラスタ別%枠の重み付き抽選（globalPopular と reactionSimilar で共用）。
	 * 重み付き抽選でクラスタ→softmax でクラスタ内の1件。tier='fresh' が尽きるまで未見だけで回し、
	 * その後 tier='shown' を同じ抽選で続ける。
	 * メディア較正は両段に掛ける: ①バケツ選択 share ×= バケツ残り候補のメディア調整後平均重み
	 * （テキストが尽きて絵だけ残ったバケツは枠ごと沈む） ②バケツ内 softmax 重み ×= odds。
	 */
	private drawClusterLottery(
		buckets: Map<number | 'general', { fresh: { cand: ForYouCandidate; clusterId?: number }[]; shown: { cand: ForYouCandidate; clusterId?: number }[] }>,
		shareOf: Map<number | 'general', number>,
		mediaCal: { odds: number; mediaNoteIds: Set<string> } | null,
		total: number,
	): ForYouCandidate[] {
		const itemMediaW = (it: { cand: ForYouCandidate }) =>
			mediaCal != null && mediaCal.mediaNoteIds.has(it.cand.noteId) ? mediaCal.odds : 1;
		const effShare = (key: number | 'general', items: { cand: ForYouCandidate }[]): number => {
			const share = shareOf.get(key) ?? 0;
			if (mediaCal == null || items.length === 0) return share;
			let m = 0;
			for (const it of items) m += itemMediaW(it);
			return share * (m / items.length);
		};
		const out: ForYouCandidate[] = [];
		const drawFrom = (tier: 'fresh' | 'shown') => {
			for (;;) {
				const alive = [...buckets.entries()].filter(([, b]) => b[tier].length > 0);
				if (alive.length === 0) return;
				let sum = 0;
				for (const [key, b] of alive) sum += effShare(key, b[tier]);
				let bucket = alive[alive.length - 1][1][tier];
				if (sum > 0) {
					let r = Math.random() * sum;
					for (const [key, b] of alive) {
						r -= effShare(key, b[tier]);
						if (r <= 0) { bucket = b[tier]; break; }
					}
				} else {
					bucket = alive[Math.floor(Math.random() * alive.length)][1][tier];
				}
				// クラスタ内: スコア正規化の softmax で確率的に1件（上位固定を避けて顔ぶれを回す）。
				const maxScore = bucket.reduce((a, b) => Math.max(a, b.cand.score), 0) || 1;
				const weights = bucket.map(b => Math.exp((b.cand.score / maxScore) / TASTE_SOFTMAX_TEMP) * itemMediaW(b));
				const wsum = weights.reduce((a, b) => a + b, 0);
				let pick = bucket.length - 1;
				let r2 = Math.random() * wsum;
				for (let i = 0; i < bucket.length; i++) {
					r2 -= weights[i];
					if (r2 <= 0) { pick = i; break; }
				}
				const chosen = bucket.splice(pick, 1)[0];
				out.push({ ...chosen.cand, clusterId: chosen.clusterId, score: (total - out.length) / total });
			}
		};
		drawFrom('fresh');
		drawFrom('shown');
		return out;
	}

	/**
	 * メディア嗜好のオッズ比較正の材料を作る。odds = (r/(1-r)) / (p/(1-p))。
	 * テキストしか埋め込めない以上、絵はベクトル照合の土俵に乗らない（テキスト無し→general 直行・
	 * キャプション→文体クラスタに誤マッチ）ため、taste とは独立にユーザーの顕示選好（反応実績）で
	 * メディア比率を較正する。aux 未生成 or 窓内の反応実績ゼロなら null（補正なし）。
	 */
	private async computeMediaOddsCalibration(meId: MiUser['id'], noteIds: string[]): Promise<{ odds: number; mediaNoteIds: Set<string> } | null> {
		if (noteIds.length === 0) return null;
		const auxRows = await this.db.query(
			`SELECT "mediaReactionRate" AS media, "textReactionRate" AS text FROM "hanami_foryou_user_aux" WHERE "userId" = $1`,
			[meId],
		) as { media: number; text: number }[];
		const aux = auxRows[0];
		// media/text とも 0 = 窓内に反応実績なし（嗜好不明）。補正しない。
		if (aux == null || (Number(aux.media) <= 0 && Number(aux.text) <= 0)) return null;

		const rows = await this.db.query(
			`SELECT id FROM note WHERE id = ANY($1) AND "fileIds" <> '{}'`,
			[noteIds],
		) as { id: string }[];
		const mediaNoteIds = new Set(rows.map(r => r.id));

		const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
		const r = clamp(Number(aux.media), TASTE_MEDIA_RATE_MIN, TASTE_MEDIA_RATE_MAX);
		const p = clamp(mediaNoteIds.size / noteIds.length, TASTE_MEDIA_RATE_MIN, TASTE_MEDIA_RATE_MAX);
		const odds = clamp((r / (1 - r)) / (p / (1 - p)), TASTE_MEDIA_ODDS_MIN, TASTE_MEDIA_ODDS_MAX);
		return { odds, mediaNoteIds };
	}

	/**
	 * popular軸のサーブ時パーソナライズ: ALS内積（被覆ほぼ100%）＋関係値（被覆〜20%）の
	 * 大きい方を作者親和度として score ×= (1 + β·aff)。素材が無ければ素通し。
	 */
	private async applyAuthorAffinityRerank(meId: MiUser['id'], alsRunId: string | null, candidates: ForYouCandidate[]): Promise<ForYouCandidate[]> {
		if (candidates.length === 0) return candidates;

		const authorByNote = new Map<string, string>();
		const missing = candidates.filter(c => c.userId == null).map(c => c.noteId);
		if (missing.length > 0) {
			const rows = await this.db.query(
				'SELECT id, "userId" FROM note WHERE id = ANY($1)',
				[missing],
			) as { id: string; userId: string }[];
			for (const r of rows) authorByNote.set(r.id, r.userId);
		}
		const authorOf = (c: ForYouCandidate) => c.userId ?? authorByNote.get(c.noteId);
		const authorIds = [...new Set(candidates.map(authorOf).filter((x): x is string => x != null))];
		if (authorIds.length === 0) return candidates;

		const alsByAuthor = new Map<string, number>();
		if (alsRunId != null) {
			const uf = await this.db.query(
				'SELECT factor FROM "hanami_foryou_user_factor" WHERE "runId" = $1 AND "userId" = $2 LIMIT 1',
				[alsRunId, meId],
			) as { factor: number[] }[];
			const userFactor = uf[0]?.factor;
			if (userFactor != null && userFactor.length > 0) {
				const rows = await this.db.query(
					'SELECT "authorId", factor FROM "hanami_foryou_author_factor" WHERE "runId" = $1 AND "authorId" = ANY($2)',
					[alsRunId, authorIds],
				) as { authorId: string; factor: number[] }[];
				for (const row of rows) {
					let dot = 0;
					const len = Math.min(userFactor.length, row.factor.length);
					for (let i = 0; i < len; i++) dot += userFactor[i] * row.factor[i];
					if (dot > 0) alsByAuthor.set(row.authorId, dot);
				}
			}
		}

		const relByAuthor = new Map<string, number>();
		{
			const rows = await this.db.query(
				'SELECT "otherUserId" AS id, "relScore" FROM "hanami_foryou_relation" WHERE "userId" = $1 AND "otherUserId" = ANY($2) AND "relScore" > 0',
				[meId, authorIds],
			) as { id: string; relScore: number }[];
			for (const r of rows) relByAuthor.set(r.id, Number(r.relScore));
		}

		if (alsByAuthor.size === 0 && relByAuthor.size === 0) return candidates;
		const alsMax = Math.max(...alsByAuthor.values(), 0);
		const relMax = Math.max(...relByAuthor.values(), 0);

		return candidates.map(c => {
			const author = authorOf(c);
			if (author == null) return c;
			const als = alsMax > 0 ? (alsByAuthor.get(author) ?? 0) / alsMax : 0;
			const rel = relMax > 0 ? (relByAuthor.get(author) ?? 0) / relMax : 0;
			const aff = Math.max(als, rel);
			return aff > 0 ? { ...c, score: c.score * (1 + POPULAR_AFFINITY_BETA * aff) } : c;
		});
	}

	/** exploration: globalPopular 母集団からの新鮮候補（§4/§14-D1）。recency 順にして top と差別化、bubble化防止。 */
	private async explorationCandidates(): Promise<ForYouCandidate[]> {
		const ranked = await this.featuredService.getGlobalNotesRankingWithScores(EXPLORATION_POOL);
		if (ranked.length === 0) return this.dbRecentExplorationFallbackCandidates(EXPLORATION_POOL);
		// 新鮮さ重視: noteId（=時刻）降順。interleave の作者dedup と既出統合で多様性を確保する。
		return ranked.map(([noteId]) => noteId).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map((noteId, i) => ({ noteId, score: 1 - i / EXPLORATION_POOL }));
	}

	private async dbGlobalPopularFallbackCandidates(limit: number): Promise<ForYouCandidate[]> {
		const sinceId = this.idService.gen(Date.now() - DB_GLOBAL_FALLBACK_WINDOW_MS);
		const rows = await this.db.query(
			`WITH recent AS (
			   SELECT n.id, n."userId"
			   FROM note n
			   WHERE n.id >= $1
			     AND n.visibility IN ('public','home') AND n."channelId" IS NULL
			     AND (n."renoteId" IS NULL OR n.text IS NOT NULL OR n."hasPoll" = TRUE OR n."fileIds" <> '{}')
			   ORDER BY n.id DESC
			   LIMIT $2
			 )
			 SELECT recent.id AS "noteId", recent."userId" AS "userId", count(r.id)::int AS "reactionCount"
			 FROM recent
			 LEFT JOIN note_reaction r ON r."noteId" = recent.id
			 GROUP BY recent.id, recent."userId"
			 ORDER BY count(r.id) DESC, recent.id DESC
			 LIMIT $3`,
			[sinceId, DB_GLOBAL_FALLBACK_SAMPLE, limit],
		) as { noteId: string; userId: string; reactionCount: number }[];
		const max = Math.max(1, ...rows.map(r => Number(r.reactionCount)));
		return rows.map(r => ({ noteId: r.noteId, userId: r.userId, score: (Number(r.reactionCount) || 0) / max }));
	}

	private async dbRecentExplorationFallbackCandidates(limit: number): Promise<ForYouCandidate[]> {
		const sinceId = this.idService.gen(Date.now() - DB_GLOBAL_FALLBACK_WINDOW_MS);
		const rows = await this.db.query(
			`SELECT n.id AS "noteId", n."userId" AS "userId"
			 FROM note n
			 WHERE n.id >= $1
			   AND n.visibility IN ('public','home') AND n."channelId" IS NULL
			   AND (n."renoteId" IS NULL OR n.text IS NOT NULL OR n."hasPoll" = TRUE OR n."fileIds" <> '{}')
			 ORDER BY n.id DESC
			 LIMIT $2`,
			[sinceId, limit],
		) as { noteId: string; userId: string }[];
		const n = rows.length || 1;
		return rows.map((r, i) => ({ noteId: r.noteId, userId: r.userId, score: (n - i) / n }));
	}

	/** trending: global trend 候補（§4）。taste 再ランクは MiniLM 後段（task #9）で接続。 */
	private async trendingCandidates(): Promise<ForYouCandidate[]> {
		const trending = await this.hanamiTrendService.getTrendingNoteIds(TRENDING_POOL);
		const n = trending.length || 1;
		return trending.map(({ noteId, term }, i) => ({ noteId, score: (n - i) / n, term }));
	}

	/** fof: friends-of-follows（§4）。既存実装が bot/suspended/deleted を除外済。ALS taste 再ランクは後段。 */
	private async fofCandidates(meId: MiUser['id'], withFiles: boolean): Promise<ForYouCandidate[]> {
		const fof = await this.hanamiUserRecommendationService.getFoFNoteIds(meId, FOF_POOL, { withFiles });
		const max = fof[0]?.score || 1;
		return fof.map(({ noteId, userId, score }) => ({ noteId, userId, score: score / max }));
	}

	/** neighborTrending: ALS taste 近傍が"今"反応してる投稿（§4）。48h 窓。ALS run 未生成なら skip。 */
	private async neighborTrendingCandidates(meId: MiUser['id'], alsRunId: string | null): Promise<ForYouCandidate[]> {
		if (alsRunId == null) return [];
		const neighbors = await this.db.query(
			`SELECT "neighborUserId" AS id, "score" FROM "hanami_foryou_neighbor_user" WHERE "runId" = $1 AND "userId" = $2 ORDER BY "rank" ASC`,
			[alsRunId, meId],
		) as { id: string; score: number }[];
		if (neighbors.length === 0) return [];
		const neighborIds = neighbors.map(n => n.id);
		const sinceId = this.idService.gen(Date.now() - NEIGHBOR_TRENDING_WINDOW_MS);
		const rows = await this.db.query(
			`SELECT n.id AS "noteId", n."userId" AS "userId", count(*)::int AS c
			 FROM note_reaction r
			 JOIN note n ON n.id = r."noteId"
			 WHERE r."userId" = ANY($1) AND r.id >= $2
			   AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n."userId" <> $3
			 GROUP BY n.id, n."userId"
			 ORDER BY c DESC
			 LIMIT $4`,
			[neighborIds, sinceId, meId, NEIGHBOR_NOTE_POOL],
		) as { noteId: string; userId: string; c: number }[];
		const max = rows[0]?.c || 1;
		return rows.map(r => ({ noteId: r.noteId, userId: r.userId, score: r.c / max }));
	}

	/**
	 * reactionSimilar: 興味マッチ新着。バッチ（10分スイープ直後）が全新着×taste クラスタ centroid の
	 * 照合結果をユーザー別 zset に事前計算済み。ここは取り出し＋除外＋クラスタ別%枠の抽選のみ。
	 * 人気条件なし＝リアクションゼロの投稿でも内容が興味に合えば出る（旧 ALS 発見作者方式は廃止）。
	 * フォロー中の作者はホームTL/catchup の領分なので除外（この軸は「未知との出会い」担当）。
	 */
	private async reactionSimilarCandidates(meId: MiUser['id'], followeeIds: string[], served: ReadonlySet<string>, seen: ReadonlySet<string>): Promise<ForYouCandidate[]> {
		const raw = await this.redisClient.zrevrange(HANAMI_TASTE_MATCH_KEY_PREFIX + meId, 0, TASTE_MATCH_POOL - 1, 'WITHSCORES');
		if (raw.length === 0) return [];

		// share 計算と userWeight 失効チェック用（クラスタ再構築後〜次スイープ≦10分の間、旧 clusterId が
		// zset に残り得る → 現行クラスタに無い id は捨てる）。
		const clusters = await this.db.query(
			`SELECT "clusterId", size, "userWeight" FROM "hanami_foryou_user_taste_cluster" WHERE "userId" = $1 AND model = $2`,
			[meId, TASTE_EMBED_MODEL],
		) as { clusterId: number; size: number; userWeight: number }[];
		if (clusters.length === 0) return [];
		const clusterOf = new Map(clusters.map(c => [c.clusterId, c]));

		const followees = new Set(followeeIds);
		// 窓外ガード（v0.7 R2-H1）: バッチが止まった/対象から外れたユーザーの zset は最大 TTL48h 残る。
		// 24h 窓より古いノートはここで捨てる（バッチ健在なら no-op）。
		const windowFloor = Date.now() - TASTE_MATCH_WINDOW_MS;

		type Item = { cand: ForYouCandidate; clusterId?: number };
		const buckets = new Map<number | 'general', { fresh: Item[]; shown: Item[] }>();
		let total = 0;
		for (let i = 0; i + 1 < raw.length; i += 2) {
			const [noteId, authorId, cidStr] = raw[i].split(':');
			const clusterId = Number(cidStr);
			const cl = clusterOf.get(clusterId);
			if (cl == null || Number(cl.userWeight) <= 0) continue;
			if (authorId === meId || followees.has(authorId)) continue;
			if (this.idService.parse(noteId).date.getTime() < windowFloor) continue;
			// zset score = cos×鮮度（バッチ側焼き込み）。ここでは再計算しない。
			const item: Item = { cand: { noteId, userId: authorId, score: Number(raw[i + 1]) }, clusterId };
			let b = buckets.get(clusterId);
			if (b == null) { b = { fresh: [], shown: [] }; buckets.set(clusterId, b); }
			(served.has(noteId) || seen.has(noteId) ? b.shown : b.fresh).push(item);
			total++;
		}
		if (total === 0) return [];

		// share ∝ size×userWeight。純粋な興味軸なので general バケツは持たない（anti-bubble は
		// globalPopular の general と exploration が担う）。
		const shareOf = new Map<number | 'general', number>();
		for (const cl of clusters) {
			if (buckets.has(cl.clusterId)) shareOf.set(cl.clusterId, cl.size * Number(cl.userWeight));
		}
		const mediaCal = await this.computeMediaOddsCalibration(meId, [...buckets.values()].flatMap(b => [...b.fresh, ...b.shown].map(it => it.cand.noteId)));
		return this.drawClusterLottery(buckets, shareOf, mediaCal, total);
	}

	/** catchup: フォロー＋高 affinity(関係値) の未読回収（§4）。7d 窓。未読判定は interleave の served/seen 除外に委譲。 */
	private async catchupCandidates(meId: MiUser['id'], followeeIds: string[]): Promise<ForYouCandidate[]> {
		const rel = await this.db.query(
			`SELECT "otherUserId" AS id, "relScore" FROM "hanami_foryou_relation" WHERE "userId" = $1 ORDER BY "relScore" DESC LIMIT $2`,
			[meId, TOP_RELATION_OTHERS],
		) as { id: string; relScore: number }[];
		const relScore = new Map(rel.map(r => [r.id, Number(r.relScore)]));
		const sourceIds = [...new Set([...followeeIds, ...rel.map(r => r.id)])];
		if (sourceIds.length === 0) return [];
		const maxRel = Math.max(1, ...relScore.values());
		const sinceId = this.idService.gen(Date.now() - CATCHUP_WINDOW_MS);
		const rows = await this.db.query(
			`SELECT n.id AS "noteId", n."userId" AS "userId", count(r.id)::int AS "reactionCount"
			 FROM note n
			 JOIN note_reaction r ON r."noteId" = n.id AND r.id >= $2
			 WHERE n."userId" = ANY($1) AND n.id >= $2
			   AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n."userId" <> $3
			   AND (n."replyId" IS NULL OR n."replyUserId" = n."userId")
			   AND (n."renoteId" IS NULL OR n.text IS NOT NULL OR n."hasPoll" = TRUE OR n."fileIds" <> '{}')
			 GROUP BY n.id, n."userId"
			 ORDER BY count(r.id) DESC, n.id DESC
			 LIMIT $4`,
			[sourceIds, sinceId, meId, CATCHUP_NOTE_POOL],
		) as { noteId: string; userId: string; reactionCount: number }[];
		const maxReaction = Math.max(1, ...rows.map(r => Number(r.reactionCount)));
		// 近い人ほど優先（relScore）しつつ、7日以内に実際に反応が伸びた量も見る。
		return rows
			.map(r => {
				const relation = (relScore.get(r.userId) ?? 0) / maxRel + 0.3;
				const growth = Number(r.reactionCount) / maxReaction;
				return { noteId: r.noteId, userId: r.userId, w: relation * (0.5 + growth) };
			})
			.sort((a, b) => b.w - a.w || (a.noteId < b.noteId ? 1 : -1))
			.map(r => ({ noteId: r.noteId, userId: r.userId, score: r.w }));
	}

	/** userId が無い候補（globalPopular/trending/exploration）の作者を一括解決（interleave の作者dedup 用）。 */
	private async resolveAuthors(map: Map<HanamiAxis, ForYouCandidate[]>): Promise<void> {
		const missing = new Set<string>();
		for (const list of map.values()) for (const c of list) if (c.userId == null) missing.add(c.noteId);
		if (missing.size === 0) return;
		const rows = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.addSelect('note.userId', 'userId')
			.where('note.id IN (:...ids)', { ids: [...missing] })
			.getRawMany<{ id: string; userId: string }>();
		const authorOf = new Map(rows.map(r => [r.id, r.userId]));
		for (const list of map.values()) for (const c of list) if (c.userId == null) c.userId = authorOf.get(c.noteId) ?? null;
	}

	/**
	 * 前段除外（interleave の前）: noteベースのグローバル安全＋ユーザーのメディア設定で候補を絞る。
	 * 除外で空いた枠は interleave が残り候補で埋め直す＝hideSensitive/hideMedia でも痩せない。
	 * 失敗時は絞らない（後段 filterAndPack が安全を担保する）。
	 */
	private async pruneGloballyUnsafe(me: MiLocalUser, map: Map<HanamiAxis, ForYouCandidate[]>, withFiles: boolean): Promise<void> {
		const ids = new Set<string>();
		for (const list of map.values()) for (const c of list) ids.add(c.noteId);
		if (ids.size === 0) return;
		try {
			const safe = await this.hanamiForYouSafetyService.filterGloballySafeIds([...ids], me, withFiles);
			for (const [axis, list] of map) map.set(axis, list.filter(c => safe.has(c.noteId)));
		} catch {
			// 絞らない（後段 safety が担保）。
		}
	}

	/** 既出（served/seen）を軸内スコアの弱い減点として反映し再ソートする（除外・tier ゲートは廃止＝決定論）。 */
	private applyRecencyPenalty(map: Map<HanamiAxis, ForYouCandidate[]>, served: Set<string>, seen: Set<string>): void {
		for (const [axis, list] of map.entries()) {
			// globalPopular / reactionSimilar は taste cluster 枠が既出を「未見優先の二段抽選」で内包処理済み。
			// ここで再ソートするとクラスタ別%枠の並びが壊れる（A3）。
			if (axis === 'globalPopular' || axis === 'reactionSimilar') continue;
			for (const c of list) {
				if (served.has(c.noteId)) c.score *= SERVED_SCORE_PENALTY;
				else if (seen.has(c.noteId)) c.score *= SEEN_SCORE_PENALTY;
			}
			list.sort((a, b) => b.score - a.score);
		}
	}

	// ───────────────────────── MiniLM taste 再ランク＋aux boost（§5/§6/§14-D7） ─────────────────────────

	/**
	 * 軸内候補を MiniLM taste（user_centroid との cosine）で再ランクし、aux（活動リズム・メディア嗜好）で弱く補正する。
	 * 主役は quota/軸内score。ここは微補正（タイブレーク程度）＝§14-D7。exploration は多様性枠なので掛けない。
	 * centroid/aux が未生成なら no-op（cold-start。バッチが回れば自然に効き始める）。
	 */
	private async applyTasteAndBoost(meId: MiUser['id'], axisCandidates: Map<HanamiAxis, ForYouCandidate[]>): Promise<void> {
		const auxRows = await this.db.query(
			`SELECT "activeHourHist" AS hist, "mediaReactionRate" AS media FROM "hanami_foryou_user_aux" WHERE "userId" = $1`,
			[meId],
		) as { hist: Record<string, number>; media: number }[];
		const aux = auxRows[0] ?? null;
		const centRows = await this.db.query(
			`SELECT "centroid" FROM "hanami_foryou_user_centroid" WHERE "userId" = $1 AND "model" = $2`,
			[meId, FORYOU_EMBEDDING_MODEL],
		) as { centroid: number[] }[];
		const centroid = centRows[0]?.centroid ?? null;
		if (aux == null && centroid == null) return; // cold-start: 何も持っていない

		const ids = new Set<string>();
		for (const list of axisCandidates.values()) for (const c of list) ids.add(c.noteId);
		if (ids.size === 0) return;
		const idList = [...ids];

		const embMap = new Map<string, number[]>();
		if (centroid != null) {
			const embRows = await this.db.query(
				`SELECT "noteId" AS id, "embedding" AS emb FROM "hanami_note_embedding" WHERE "model" = $1 AND "noteId" = ANY($2)`,
				[FORYOU_EMBEDDING_MODEL, idList],
			) as { id: string; emb: number[] }[];
			for (const r of embRows) embMap.set(r.id, r.emb);
		}

		const noteMeta = new Map<string, { hr: number; hasMedia: boolean; hasText: boolean }>();
		let peakHours = new Set<number>();
		let textHeavy = false;
		if (aux != null) {
			const metaRows = await this.db.query(
				`SELECT n.id AS id,
				        (n."fileIds" <> '{}') AS "hasMedia", (n.text IS NOT NULL) AS "hasText"
				 FROM note n WHERE n.id = ANY($1)`,
				[idList],
			) as { id: string; hasMedia: boolean; hasText: boolean }[];
			for (const r of metaRows) {
				const hr = (this.idService.parse(r.id).date.getUTCHours() + 9) % 24;
				noteMeta.set(r.id, { hr, hasMedia: r.hasMedia, hasText: r.hasText });
			}
			const hist = aux.hist ?? {};
			peakHours = new Set(Object.entries(hist).map(([h, c]) => [Number(h), Number(c)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, AUX_PEAK_HOURS).map(e => e[0]));
			textHeavy = Number(aux.media) < AUX_TEXT_HEAVY_THRESHOLD;
		}

		for (const [axis, list] of axisCandidates) {
			if (axis === 'exploration') continue; // 多様性枠は補正しない
			// globalPopular / reactionSimilar は taste cluster 枠が並びを所有する。aux 補正でも sort が入り
			// クラスタ別%枠と未見優先の二段順が壊れるため、全補正をスキップ（A3）。
			// reactionSimilar は候補自体が taste 照合済みなので二重の taste 補正にもなる。
			if (axis === 'globalPopular' || axis === 'reactionSimilar') continue;
			for (const c of list) {
				let mult = 1;
				const tasteWeight = TASTE_RERANK_WEIGHT_BY_AXIS[axis] ?? 0;
				if (centroid != null && tasteWeight > 0) {
					const emb = embMap.get(c.noteId);
					if (emb != null) mult *= 1 + (tasteWeight * Math.max(0, this.dot(centroid, emb)));
				}
				if (aux != null) {
					const m = noteMeta.get(c.noteId);
					if (m != null) {
						if (peakHours.has(m.hr)) mult *= 1 + AUX_HOUR_BOOST;
						if (textHeavy && m.hasMedia && !m.hasText) mult *= 1 - AUX_MEDIA_DISCOUNT;
					}
				}
				c.score *= mult;
			}
			list.sort((a, b) => b.score - a.score);
		}
	}

	// cosine（centroid/embedding はバッチで正規化済 → 内積で可）。
	private dot(a: number[], b: number[]): number {
		const n = Math.min(a.length, b.length);
		let s = 0;
		for (let i = 0; i < n; i++) s += a[i] * b[i];
		return s;
	}

	// ───────────────────────── meta / served 記録 ─────────────────────────

	private markMeta(notes: Packed<'Note'>[], reasonOf: Map<string, ReasonMeta>, showReason: boolean): void {
		for (const note of notes) {
			const meta = note as Record<string, unknown>;
			meta._hanamiRecommended = true;
			const reason = reasonOf.get(note.id);
			// クライアントに出すのは最小限（sources 等は provenance/測定用）。UI 用に軸を表示語彙へ寄せる。
			// clusterId はインライン「この興味を減らす」（spec §3.2/Phase D）の材料としてクラスタ由来軸のみ添える。
			if (showReason && reason) meta._hanamiReason = { reason: AXIS_TO_UI_REASON[reason.source], term: reason.term, clusterId: reason.clusterId };
		}
	}

	/** served を Redis（短期重複排除）＋ PG provenance（source=枠を消費した軸）＋ fof shown に記録。 */
	@bindThis
	private async recordServed(meId: MiUser['id'], notes: Packed<'Note'>[], reasonOf: Map<string, ReasonMeta>): Promise<void> {
		if (notes.length === 0) return;
		const noteIds = notes.map(n => n.id);
		try {
			await this.hanamiRecommendationService.recordServed(meId, noteIds); // Redis served zset（既存と共有）
			const fofAuthorIds = notes.filter(n => reasonOf.get(n.id)?.source === 'fof').map(n => n.userId);
			if (fofAuthorIds.length > 0) await this.hanamiUserRecommendationService.recordShown(meId, fofAuthorIds);
				await this.hanamiForYouProvenanceService.recordServedEvents(
					meId,
					notes.map(n => {
						const reason = reasonOf.get(n.id);
						if (reason == null) return { noteId: n.id, source: null };
						// taste cluster 経由は source に :c{k} を添える（§6 クラスタ別転換率の計測口）。
						// clusterId は note 単位で merge されるため、クラスタ枠を持つ軸が枠を消費した時だけ付ける
						//（trending 等が枠を消費した pick に :c を付けると軸別統計が汚れる）。
						const source = (reason.source === 'globalPopular' || reason.source === 'reactionSimilar') && reason.clusterId != null
							? `${reason.source}:c${reason.clusterId}`
							: reason.source;
						return { noteId: n.id, source };
					}),
				);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: recordServed failed', err);
		}
	}
}
