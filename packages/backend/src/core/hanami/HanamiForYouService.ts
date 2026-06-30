/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
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
const REACTION_SIMILAR_WINDOW_MS = 7 * DAY_MS;
const CATCHUP_WINDOW_MS = 7 * DAY_MS; // §14-D8 = 7d 固定

// 候補プールサイズ（§10。safety filter で多く落ちる前提の余裕）。
const GLOBAL_POPULAR_POOL = 200;
const EXPLORATION_POOL = 500;
const TRENDING_POOL = 200;
const FOF_POOL = 200;
const NEIGHBOR_NOTE_POOL = 250;
const REACTION_SIMILAR_NOTE_POOL = 250;
const CATCHUP_NOTE_POOL = 250;
const TOP_RELATION_OTHERS = 100;

const ALS_RUN_KIND = 'als';

// MiniLM taste 再ランク＋aux boost（§5/§6/§14-D7。弱め＝タイブレーク程度）。
const FORYOU_EMBEDDING_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2';
const TASTE_RERANK_WEIGHT_BY_AXIS: Partial<Record<HanamiAxis, number>> = {
	globalPopular: 0.3,
	trending: 0.3,
	fof: 0.45,
};
const AUX_PEAK_HOURS = 6; // active_hour_hist 上位 N 時間を「夜型ピーク」とみなす
const AUX_HOUR_BOOST = 0.1;
const AUX_MEDIA_DISCOUNT = 0.15;
const AUX_TEXT_HEAVY_THRESHOLD = 0.2; // mediaReactionRate がこれ未満 = text 偏重

type ReasonMeta = { source: HanamiAxis; sources: HanamiAxis[]; term?: string };

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
	 * untilId は互換入力（次ページ要求トリガ）としてのみ扱い、重複排除は served/seen で行う（§9）。
	 */
	@bindThis
	public async getForYouPage(me: MiLocalUser, opts: { limit: number; withFiles: boolean }): Promise<Packed<'Note'>[]> {
		// はなみTL ON/OFF（既存設定を退避操作に使う。For You 独自 kill switch は持たない＝§2）。
		const profile = await this.cacheService.userProfileCache.fetch(me.id);
		if (!profile.hanamiRecommendationEnabled) return [];
		const showReason = profile.hanamiShowRecommendationReason;
		const axisLevels = this.resolveAxisLevels(profile);
		if (axisLevels.size === 0) return [];

		const followings = await this.cacheService.userFollowingsCache.fetch(me.id);
		const followeeIds = Object.keys(followings);

		const alsRunId = await this.hanamiForYouBatchService.getLatestReadyRunId(ALS_RUN_KIND);
		const confidence = await this.computeConfidence(me.id, followeeIds.length, alsRunId);

		// served/seen はソフト除外（降格）。0=新規 / 1=seen(再表示可) / 2=served(直近・最後の手段)。
		// 新規優先で並べ、新規が尽きたら下方に再表示する（空にしない＝§6/§9）。served は seen より直近なので深く降格。
		const { served, seen } = await this.hanamiRecommendationService.getServedSeenForExclusion(me.id);
		const demote = (noteId: string) => (served.has(noteId) ? 2 : seen.has(noteId) ? 1 : 0);

		const axisCandidates = await this.gatherCandidates(me.id, confidence, alsRunId, followeeIds, opts.withFiles, axisLevels);
		await this.resolveAuthors(axisCandidates);
		// MiniLM taste 再ランク＋aux 弱 boost（§5/§6/§14-D7）。データ（centroid/aux）が無ければ no-op（cold-start）。
		await this.applyTasteAndBoost(me.id, axisCandidates);

		const interleaved = hanamiInterleave({ confidence, limit: opts.limit, axisCandidates, demote, axisLevels });
		if (interleaved.length === 0) return [];

		// source=枠を消費した軸 / sources=全寄与軸（§6.1-2）。
		const reasonOf = new Map<string, ReasonMeta>(interleaved.map(c => [c.noteId, { source: c.source, sources: c.sources, term: c.term }]));
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
	private async gatherCandidates(meId: MiUser['id'], confidence: HanamiConfidence, alsRunId: string | null, followeeIds: string[], withFiles: boolean, axisLevels: ReadonlyMap<HanamiAxis, HanamiAxisLevel>): Promise<Map<HanamiAxis, ForYouCandidate[]>> {
		const order = hanamiAxisOrder(confidence).filter(axis => axisLevels.has(axis)); // exploration を含む
		const map = new Map<HanamiAxis, ForYouCandidate[]>();
		await Promise.all(order.map(async axis => {
			try {
				map.set(axis, await this.candidatesForAxis(axis, meId, alsRunId, followeeIds, withFiles));
			} catch {
				map.set(axis, []); // 1軸が落ちても他軸で配信する
			}
		}));
		return map;
	}

	private async candidatesForAxis(axis: HanamiAxis, meId: MiUser['id'], alsRunId: string | null, followeeIds: string[], withFiles: boolean): Promise<ForYouCandidate[]> {
		switch (axis) {
			case 'globalPopular': return this.globalPopularCandidates();
			case 'exploration': return this.explorationCandidates();
			case 'trending': return this.trendingCandidates();
			case 'fof': return this.fofCandidates(meId, withFiles);
			case 'neighborTrending': return this.neighborTrendingCandidates(meId, alsRunId);
			case 'reactionSimilar': return this.reactionSimilarCandidates(meId, alsRunId);
			case 'catchup': return this.catchupCandidates(meId, followeeIds);
			default: return [];
		}
	}

	/** globalPopular: グローバル人気（公共圏の発見・§4）。engagement 順。 */
	private async globalPopularCandidates(): Promise<ForYouCandidate[]> {
		const ranked = await this.featuredService.getGlobalNotesRankingWithScores(GLOBAL_POPULAR_POOL);
		return ranked.map(([noteId, score]) => ({ noteId, score }));
	}

	/** exploration: globalPopular 母集団からの新鮮候補（§4/§14-D1）。recency 順にして top と差別化、bubble化防止。 */
	private async explorationCandidates(): Promise<ForYouCandidate[]> {
		const ranked = await this.featuredService.getGlobalNotesRankingWithScores(EXPLORATION_POOL);
		// 新鮮さ重視: noteId（=時刻）降順。interleave の作者dedup と既出統合で多様性を確保する。
		return ranked.map(([noteId]) => noteId).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map((noteId, i) => ({ noteId, score: 1 - i / EXPLORATION_POOL }));
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

	/** reactionSimilar: ALS 発見作者→新着（§4）。7d 窓。ALS run 未生成なら skip。 */
	private async reactionSimilarCandidates(meId: MiUser['id'], alsRunId: string | null): Promise<ForYouCandidate[]> {
		if (alsRunId == null) return [];
		const authors = await this.db.query(
			`SELECT "authorId" AS id FROM "hanami_foryou_author_rec" WHERE "runId" = $1 AND "userId" = $2 ORDER BY "rank" ASC`,
			[alsRunId, meId],
		) as { id: string }[];
		if (authors.length === 0) return [];
		const authorIds = authors.map(a => a.id);
		const rank = new Map(authorIds.map((id, i) => [id, i]));
		const sinceId = this.idService.gen(Date.now() - REACTION_SIMILAR_WINDOW_MS);
		const rows = await this.db.query(
			`SELECT n.id AS "noteId", n."userId" AS "userId"
			 FROM note n
			 WHERE n."userId" = ANY($1) AND n.id >= $2
			   AND n.visibility IN ('public','home') AND n."channelId" IS NULL
			   AND (n."renoteId" IS NULL OR n.text IS NOT NULL OR n."hasPoll" = TRUE OR n."fileIds" <> '{}')
			 ORDER BY n.id DESC
			 LIMIT $3`,
			[authorIds, sinceId, REACTION_SIMILAR_NOTE_POOL],
		) as { noteId: string; userId: string }[];
		// 発見作者の rank が高い順を優先しつつ、新着を上に。
		return rows
			.map(r => ({ noteId: r.noteId, userId: r.userId, authorRank: rank.get(r.userId) ?? 9999 }))
			.sort((a, b) => a.authorRank - b.authorRank || (a.noteId < b.noteId ? 1 : -1))
			.map((r, i) => ({ noteId: r.noteId, userId: r.userId, score: 1 - i / REACTION_SIMILAR_NOTE_POOL }));
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
				`SELECT n.id AS id, EXTRACT(HOUR FROM (n."createdAt" AT TIME ZONE 'Asia/Tokyo'))::int AS hr,
				        (n."fileIds" <> '{}') AS "hasMedia", (n.text IS NOT NULL) AS "hasText"
				 FROM note n WHERE n.id = ANY($1)`,
				[idList],
			) as { id: string; hr: number; hasMedia: boolean; hasText: boolean }[];
			for (const r of metaRows) noteMeta.set(r.id, { hr: Number(r.hr), hasMedia: r.hasMedia, hasText: r.hasText });
			const hist = aux.hist ?? {};
			peakHours = new Set(Object.entries(hist).map(([h, c]) => [Number(h), Number(c)] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, AUX_PEAK_HOURS).map(e => e[0]));
			textHeavy = Number(aux.media) < AUX_TEXT_HEAVY_THRESHOLD;
		}

		for (const [axis, list] of axisCandidates) {
			if (axis === 'exploration') continue; // 多様性枠は補正しない
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
			if (showReason && reason) meta._hanamiReason = { reason: AXIS_TO_UI_REASON[reason.source], term: reason.term };
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
					notes.map(n => ({ noteId: n.id, source: reasonOf.get(n.id)?.source ?? null })),
				);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: recordServed failed', err);
		}
	}
}
