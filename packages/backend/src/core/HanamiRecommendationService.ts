/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';
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
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { removeMutedUsersReactions } from '@/misc/reactions-mute.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { HanamiUserRecommendationService, type FoFNoteOptions } from '@/core/hanami/HanamiUserRecommendationService.js';
import { HanamiReactionSimilarService } from '@/core/hanami/HanamiReactionSimilarService.js';
import { HanamiCatchupService, type CatchupOptions } from '@/core/hanami/HanamiCatchupService.js';

// 既出除外（served）: 注入した時点で短期間だけ再表示を抑制する。
const SERVED_KEY_PREFIX = 'hanami:rec:served:';
const SERVED_TTL_SECONDS = 60 * 30; // 30分（仕様: 短TTL, v1）。値はここ一箇所で調整。
const SERVED_TTL_MS = SERVED_TTL_SECONDS * 1000;

// 作者単位の短期ペナルティ: 「もっと読む」で同じ作者の別ノートが続くのを減らす。除外せず30分で通常スコアに戻す。
const AUTHOR_SERVED_KEY_PREFIX = 'hanami:rec:authorServed:';
const AUTHOR_SERVED_TTL_SECONDS = 60 * 30;
const AUTHOR_SERVED_TTL_MS = AUTHOR_SERVED_TTL_SECONDS * 1000;
const AUTHOR_SERVED_MIN_MULTIPLIER = 0.05;

// 既出除外（seen）: フロントが実表示を確認したら記録する長期側。
const SEEN_KEY_PREFIX = 'hanami:rec:seen:';
const SEEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7日
const SEEN_TTL_MS = SEEN_TTL_SECONDS * 1000;

// homeSeen: はなみTLに表示された「ホーム由来」のノート（推薦に限らない）。
// catchup軸の「見逃し」判定の根拠であり、見たものを推薦し直さない一般除外にも使う。
const HOME_SEEN_KEY_PREFIX = 'hanami:rec:homeSeen:';
const HOME_SEEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7日
const HOME_SEEN_TTL_MS = HOME_SEEN_TTL_SECONDS * 1000;

// 効果測定ログ（仕様7）: Postgres 直書きせず Redis Stream に最小限を残す。集計はバッチで後段。
const LOG_STREAM_KEY = 'hanami:rec:log';
const LOG_STREAM_MAXLEN = 50000;
const LOG_SAMPLE_RATE = 1.0; // 小規模なので全件。負荷が増えたら下げる。

// スロット注入は home N件ごとに推薦を挟む。量そのものは REC_RATIO で決める。
const HOME_NOTES_PER_REC = 2;
// 多様性: 同一作者の推薦は削除せず、選択時に強く後回しにする。

// 候補プール/オーバーフェッチ。DBの可視性/ミュートで脱落する分を見込んで多めに取る。
const RANKING_FETCH_SIZE = 200;
const REC_CANDIDATE_OVERFETCH = 5;
const REC_DB_FETCH_OVERFETCH = 2;
const REC_DB_FETCH_EXTRA = 5;

// 通常ロード時に、取得 limit のうち推薦として混ぜる目標比率。
const REC_RATIO = { low: 0.20, normal: 0.35, high: 0.50, veryHigh: 0.70 } as const;

// 新着ストリームへの自動挿入は時間ではなく、実際に流れた home ノート数で制御する。
const AUTO_INJECT_PRESET = {
	low: { homeNotesPerInjection: 10, injectCount: 1 },
	normal: { homeNotesPerInjection: 6, injectCount: 1 },
	high: { homeNotesPerInjection: 4, injectCount: 2 },
} as const;

// 軸の混合重み（同一ノートが複数軸に出たら合算、reason は最大寄与の軸）。FoF は過多を避けるため弱めに扱う。
// trending はノート単体のエンゲージが薄くても乗るため、popular よりやや弱く。
// reactionSimilar/catchup は個人化軸（popularの「サーバー全体の人気」と役割が被らない）。
const AXIS_WEIGHT = {
	popular: 1.0,
	trending: 0.9,
	reactionSimilar: 0.85,
	catchup: 0.75,
	fof: 0.4,
} as const;

// 1軸だけで埋まり切らないよう、候補選抜時点で上限をかける。
const AXIS_MAX_SHARE = {
	popular: 0.55,
	trending: 0.25,
	reactionSimilar: 0.35,
	catchup: 0.30,
	fof: 0.15,
} as const;

const AUTO_AXIS_MAX_SHARE = {
	popular: 0.50,
	trending: 0.25,
	reactionSimilar: 0.35,
	catchup: 0.30,
	fof: 0.10,
} as const;

// ユーザーが軸ごとに選ぶ量（切/少/普通/多）。base の AXIS_MAX_SHARE にこの倍率を掛けて per-user のスロット上限を作る。
export type HanamiAxisLevel = 'off' | 'low' | 'normal' | 'high';
const AXIS_LEVEL_SHARE_MULTIPLIER: Record<Exclude<HanamiAxisLevel, 'off'>, number> = {
	low: 0.55,
	normal: 1.0,
	high: 1.6,
};

export type RecSource = keyof typeof AXIS_WEIGHT;
export type RecReasonCode = RecSource;

export const HANAMI_REC_AXES: RecSource[] = ['popular', 'reactionSimilar', 'catchup', 'trending', 'fof'];

// 鯖管の軸設定: available=サーバーで利用可能か, default=ユーザー未設定時の既定ON/OFF。
export type HanamiAxisServerConfig = Partial<Record<RecSource, { available?: boolean; default?: boolean }>>;
// ユーザーの軸オーバーライド（未設定の軸はサーバー既定に従う）。値は量（off/low/normal/high）。旧booleanも許容。
export type HanamiAxisUserConfig = Partial<Record<RecSource, HanamiAxisLevel | boolean>>;

type ScoredCandidate = {
	noteId: string;
	userId?: MiUser['id'];
	score: number;
	topContribution?: number; // 同一ノートを複数軸で合算するときの最大単独寄与
	source: RecSource;
	reason: RecReasonCode;
	term?: string; // trending のとき該当用語
	sources?: RecSource[]; // 寄与した全軸（効果測定ログ用。軸被りの定量化に使う）
};

export type RecReasonMeta = { source: RecSource; reason: RecReasonCode; term?: string; sources?: RecSource[] };
export type HanamiAutoInjectItem = { note: Packed<'Note'>; reason: RecReasonMeta };
export type HanamiAutoInjectStrength = keyof typeof AUTO_INJECT_PRESET;
export type HanamiAutoInjectPreset = (typeof AUTO_INJECT_PRESET)[HanamiAutoInjectStrength];

type ResolvedSettings = {
	enabled: boolean;
	recRatio: number;
	axes: Set<RecSource>;
	axisLevels: Map<RecSource, HanamiAxisLevel>;
	showReason: boolean;
	autoInjectEnabled: boolean;
	autoInjectStrength: HanamiAutoInjectStrength;
};

export type HanamiRecOptions = {
	homeNotes: Packed<'Note'>[];
	untilId: string | null;
	sinceId: string | null;
	limit: number;
	withFiles: boolean;
};

/**
 * はなみTL おすすめの中央サービス（[[hanami-tl-osusume-redesign]]）。
 *
 * 役割（仕様）:
 *  - 複数軸（人気 / リアクション類似 / 見逃し回収 / 急上昇 / FoF）の候補選定・混合（軸ON/OFF・重み）
 *  - 軸ごとのON/OFF解決（鯖管の利用可否+既定 × ユーザーのオーバーライド）
 *  - 既出除外（served 30分 / seen 7日）
 *  - スロット注入（推薦内はスコア順・連続/上限つき作者多様性・末尾はhome由来=カーソル安定）
 *  - 理由メタの付与（鯖管トグル）と効果測定ログ（Redis Stream）
 *
 * REST（はなみTL）と stream（ChannelsService）はどちらもこのサービスを通り、おすすめの意味を揃える。
 */
@Injectable()
export class HanamiRecommendationService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private featuredService: FeaturedService,
		private queryService: QueryService,
		private cacheService: CacheService,
		private noteEntityService: NoteEntityService,
		private hanamiTrendService: HanamiTrendService,
		private hanamiUserRecommendationService: HanamiUserRecommendationService,
		private hanamiReactionSimilarService: HanamiReactionSimilarService,
		private hanamiCatchupService: HanamiCatchupService,
	) {
	}

	// ───────────────────────── 設定解決（軸ON/OFF・量・理由） ─────────────────────────

	/**
	 * 鯖管の軸設定（available/default）× ユーザーのオーバーライドから、有効な軸集合を解決する。
	 * 仕様: 軸ON/OFFは中央サービスの責務。
	 */
	// 旧boolean / 新stringレベルの両方を量レベルに正規化する。
	private normalizeAxisLevel(v: unknown, def: boolean): HanamiAxisLevel {
		if (v === 'off' || v === 'low' || v === 'normal' || v === 'high') return v;
		if (v === true) return 'normal';
		if (v === false) return 'off';
		return def ? 'normal' : 'off'; // ユーザー未設定はサーバー既定に従う
	}

	/**
	 * 鯖管の軸設定（available/default）× ユーザーの量（off/low/normal/high）から、有効な軸と量を解決する。
	 * 仕様: 軸ON/OFF・量は中央サービスの責務。off の軸は返さない。
	 */
	@bindThis
	private resolveAxisLevels(profile: MiUserProfile): Map<RecSource, HanamiAxisLevel> {
		const serverCfg = (this.meta.hanamiRecommendationAxisConfig ?? {}) as HanamiAxisServerConfig;
		const userCfg = (profile.hanamiRecommendationAxes ?? {}) as HanamiAxisUserConfig;
		const out = new Map<RecSource, HanamiAxisLevel>();
		for (const ax of HANAMI_REC_AXES) {
			const s = serverCfg[ax];
			if (s?.available === false) continue; // 鯖管がサーバー全体で無効化
			const level = this.normalizeAxisLevel(userCfg[ax], s?.default ?? true);
			if (level === 'off') continue;
			out.set(ax, level);
		}
		return out;
	}

	// 軸の量レベルを base のスロット上限に掛けて per-user の axisMaxShare を作る（off は 0）。
	private buildAxisShare(base: Record<RecSource, number>, levels: Map<RecSource, HanamiAxisLevel>): Record<RecSource, number> {
		const out = { popular: 0, trending: 0, reactionSimilar: 0, catchup: 0, fof: 0 } as Record<RecSource, number>;
		for (const [ax, level] of levels) {
			if (level === 'off') continue;
			out[ax] = Math.min(0.9, base[ax] * AXIS_LEVEL_SHARE_MULTIPLIER[level]);
		}
		return out;
	}

	private getRecRatio(strength: string): number {
		return REC_RATIO[strength as keyof typeof REC_RATIO] ?? REC_RATIO.high;
	}

	private getAutoInjectStrength(strength: string): HanamiAutoInjectStrength {
		return Object.prototype.hasOwnProperty.call(AUTO_INJECT_PRESET, strength) ? strength as HanamiAutoInjectStrength : 'low';
	}

	@bindThis
	private async resolveSettings(meId: MiUser['id']): Promise<ResolvedSettings> {
		const profile = await this.cacheService.userProfileCache.fetch(meId);
		const axisLevels = this.resolveAxisLevels(profile);
		return {
			enabled: profile.hanamiRecommendationEnabled,
			recRatio: this.getRecRatio(profile.hanamiRecommendationStrength),
			axes: new Set(axisLevels.keys()),
			axisLevels,
			showReason: profile.hanamiShowRecommendationReason,
			autoInjectEnabled: profile.hanamiRecommendationAutoInjectEnabled,
			autoInjectStrength: this.getAutoInjectStrength(profile.hanamiRecommendationAutoInjectStrength),
		};
	}

	// ───────────────────────── REST: スロット注入 ─────────────────────────

	/**
	 * ホームTL（パック済み）におすすめをスロット注入して返す。末尾は必ず home 由来にしてページングを壊さない。
	 * ユーザー設定（ON/OFF・量・軸）と鯖管設定（理由表示・軸利用可否）はサービス内で解決する。
	 */
	@bindThis
	public async mixRecommendations(me: MiLocalUser, opts: HanamiRecOptions): Promise<Packed<'Note'>[]> {
		const { homeNotes, limit, untilId, sinceId } = opts;

		const settings = await this.resolveSettings(me.id);

		// ユーザーがおすすめOFF / 有効な軸が無いなら素のホームTL
		if (!settings.enabled || settings.axes.size === 0) return homeNotes.slice(0, limit);

		// 新着取得（sinceId のみ）のときは推薦を混ぜない（昇順フェッチに古い人気が紛れる/カーソル破壊を防ぐ）
		if (sinceId != null && untilId == null) return homeNotes.slice(0, limit);

		// 推薦目標数: ユーザー設定の比率。home が少ない cold-start は limit に寄せて埋める。
		const baseTarget = Math.round(limit * Math.max(settings.recRatio, 0));
		const recTarget = Math.max(baseTarget, limit - homeNotes.length);
		if (recTarget <= 0) return homeNotes.slice(0, limit);

		const homeIds = new Set(homeNotes.map(n => n.id));
		const [served, seen, homeSeen] = await Promise.all([
			this.getZsetMembers(`${SERVED_KEY_PREFIX}${me.id}`, SERVED_TTL_MS),
			this.getZsetMembers(`${SEEN_KEY_PREFIX}${me.id}`, SEEN_TTL_MS),
			this.getZsetMembers(`${HOME_SEEN_KEY_PREFIX}${me.id}`, HOME_SEEN_TTL_MS),
		]);

		const hardExcludedFoFNoteIds = new Set([...seen, ...homeIds]);
		// homeSeen はホームTLで実際に見たノート。どの軸由来でも「見たもの」を推薦し直さない。
		const excluded = (candidate: ScoredCandidate) => seen.has(candidate.noteId) || homeSeen.has(candidate.noteId) || homeIds.has(candidate.noteId) || (candidate.source !== 'fof' && served.has(candidate.noteId));
		const newerThan = homeNotes[0]?.id ?? null; // ページ先頭より新しい推薦は割り込ませない

		const candidates = await this.getCandidates(me.id, {
			limit: recTarget * REC_CANDIDATE_OVERFETCH,
			capLimit: recTarget,
			excluded,
			newerThan,
			axes: settings.axes,
			axisMaxShare: this.buildAxisShare(AXIS_MAX_SHARE, settings.axisLevels),
			fofOptions: {
				hardExcludedNoteIds: hardExcludedFoFNoteIds,
				softPenaltyNoteIds: served,
				newerThan,
				withFiles: opts.withFiles,
			},
			catchupOptions: {
				homeSeenNoteIds: homeSeen,
			},
		});
		if (candidates.length === 0) return homeNotes.slice(0, limit);

		const { recNotes, reasonOf } = await this.fetchAndPackSafeRecNotesWithBackfill(candidates, recTarget, me, { withFiles: opts.withFiles });
		if (recNotes.length === 0) return homeNotes.slice(0, limit);

		const { notes, injectedIds } = this.injectIntoSlots(homeNotes, recNotes, recTarget, limit);

		// 内部推薦マーカーは常に付ける。表示用 reason は鯖管トグルON時のみ。
		this.markRecommendationMeta(notes, injectedIds, reasonOf, settings.showReason);

		if (injectedIds.length > 0) {
			const injectedIdSet = new Set(injectedIds);
			const injectedNotes = notes.filter(note => injectedIdSet.has(note.id));
			const injectedAuthorIds = injectedNotes.map(note => note.userId);
			// FoF軸で注入したノートの作者は「見せたFoFユーザー」として記録し、再表示を抑える（フォロー候補UIに依存しない）。
			const fofUserIds = injectedNotes.filter(note => reasonOf.get(note.id)?.source === 'fof').map(note => note.userId);
			this.recordServedWithLog(me.id, injectedIds, reasonOf, injectedAuthorIds, fofUserIds).catch(err => {
				// eslint-disable-next-line no-console
				console.error('hanami rec: recordServed/log failed', err);
			});
		}

		return notes;
	}

	// ───────────────────────── 候補選定（軸の混合） ─────────────────────────

	private markRecommendationMeta(notes: Packed<'Note'>[], noteIds: Iterable<string>, reasonOf: Map<string, RecReasonMeta>, showReason: boolean): void {
		const idSet = new Set(noteIds);
		for (const note of notes) {
			if (!idSet.has(note.id)) continue;
			const meta = note as Record<string, unknown>;
			meta._hanamiRecommended = true;
			const reason = reasonOf.get(note.id);
			// クライアントに出すのは表示に使う最小限のみ（sources 等の内部メタは効果測定ログ専用）。
			if (showReason && reason) meta._hanamiReason = { reason: reason.reason, term: reason.term };
		}
	}

	private applyAxisCaps(candidates: ScoredCandidate[], opts: {
		limit: number;
		capLimit: number;
		axisMaxShare: Record<RecSource, number>;
	}): ScoredCandidate[] {
		const usedByAxis = new Map<RecSource, number>();
		const out: ScoredCandidate[] = [];

		for (const candidate of candidates) {
			if (out.length >= opts.limit) break;

			const used = usedByAxis.get(candidate.source) ?? 0;
			const max = Math.max(1, Math.ceil(opts.capLimit * opts.axisMaxShare[candidate.source]));
			if (used < max) {
				out.push(candidate);
				usedByAxis.set(candidate.source, used + 1);
			}
		}

		return out;
	}

	private mergeCandidates(lists: ScoredCandidate[][]): ScoredCandidate[] {
		const merged = new Map<string, ScoredCandidate>();
		for (const list of lists) {
			for (const c of list) {
				const exist = merged.get(c.noteId);
				if (exist == null) {
					merged.set(c.noteId, { ...c, topContribution: c.score, sources: [c.source] });
				} else {
					exist.score += c.score;
					exist.userId ??= c.userId;
					exist.sources?.push(c.source);
					if (c.score > (exist.topContribution ?? 0)) {
						exist.topContribution = c.score;
						exist.source = c.source;
						exist.reason = c.reason;
						exist.term = c.term;
					}
				}
			}
		}
		return [...merged.values()];
	}

	@bindThis
	private async getCandidates(meId: MiUser['id'], opts: {
		limit: number;
		capLimit: number;
		excluded: (candidate: ScoredCandidate) => boolean;
		newerThan: string | null;
		axes: Set<RecSource>;
		axisMaxShare: Record<RecSource, number>;
		fofOptions?: FoFNoteOptions;
		catchupOptions?: CatchupOptions;
	}): Promise<ScoredCandidate[]> {
		// 有効な軸だけ実行する（無効軸はクエリ自体を投げない）。
		const tasks: Promise<ScoredCandidate[]>[] = [];
		if (opts.axes.has('popular')) tasks.push(this.getPopularCandidates(meId));
		if (opts.axes.has('reactionSimilar')) tasks.push(this.getReactionSimilarCandidates(meId));
		if (opts.axes.has('catchup')) tasks.push(this.getCatchupCandidates(meId, opts.catchupOptions));
		if (opts.axes.has('trending')) tasks.push(this.getTrendingCandidates());
		if (opts.axes.has('fof')) tasks.push(this.getFoFCandidates(meId, opts.fofOptions));
		const lists = await Promise.all(tasks);

		// 軸を合算。同一ノートは weight 付きスコアを足し、最大寄与の軸を reason にする。
		// sources には寄与した全軸を残す（効果測定ログで軸被り率を出すため）。
		const filtered: ScoredCandidate[] = [];
		for (const c of this.mergeCandidates(lists).sort((a, b) => b.score - a.score)) {
			if (opts.excluded(c)) continue;
			if (opts.newerThan != null && c.noteId >= opts.newerThan) continue;
			filtered.push(c);
		}
		const authorPenalized = await this.applyRecentAuthorPenalty(meId, filtered);
		return this.applyAxisCaps(authorPenalized, {
			limit: opts.limit,
			capLimit: opts.capLimit,
			axisMaxShare: opts.axisMaxShare,
		});
	}

	private getAuthorPenaltyMultiplier(servedAt: number, now: number): number {
		const ageMs = now - servedAt;
		if (ageMs <= 0) return AUTHOR_SERVED_MIN_MULTIPLIER;
		if (ageMs >= AUTHOR_SERVED_TTL_MS) return 1;
		return AUTHOR_SERVED_MIN_MULTIPLIER + ((1 - AUTHOR_SERVED_MIN_MULTIPLIER) * (ageMs / AUTHOR_SERVED_TTL_MS));
	}

	@bindThis
	private async applyRecentAuthorPenalty(meId: MiUser['id'], candidates: ScoredCandidate[]): Promise<ScoredCandidate[]> {
		if (candidates.length === 0) return [];

		const now = Date.now();
		const raw = await this.redisClient.zrangebyscore(`${AUTHOR_SERVED_KEY_PREFIX}${meId}`, now - AUTHOR_SERVED_TTL_MS, '+inf', 'WITHSCORES');
		const servedAtByAuthor = new Map<string, number>();
		for (let i = 0; i < raw.length; i += 2) {
			servedAtByAuthor.set(raw[i], Number(raw[i + 1]));
		}
		if (servedAtByAuthor.size === 0) return candidates;

		const authorByNoteId = new Map<string, MiUser['id']>();
		const missingAuthorNoteIds: string[] = [];
		for (const candidate of candidates) {
			if (candidate.userId != null) {
				authorByNoteId.set(candidate.noteId, candidate.userId);
			} else {
				missingAuthorNoteIds.push(candidate.noteId);
			}
		}

		if (missingAuthorNoteIds.length > 0) {
			const rows = await this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id')
				.addSelect('note.userId', 'userId')
				.where('note.id IN (:...noteIds)', { noteIds: missingAuthorNoteIds })
				.getRawMany<{ id: string; userId: string }>();
			for (const row of rows) authorByNoteId.set(row.id, row.userId);
		}

		const out = candidates.map(candidate => {
			const authorId = authorByNoteId.get(candidate.noteId);
			const servedAt = authorId == null ? undefined : servedAtByAuthor.get(authorId);
			if (servedAt == null) return candidate;
			return {
				...candidate,
				score: candidate.score * this.getAuthorPenaltyMultiplier(servedAt, now),
			};
		});
		out.sort((a, b) => b.score - a.score);
		return out;
	}

	/** 人気軸（グローバル人気 + フォロー中ユーザーのインタラクションボーナス）。 */
	@bindThis
	private async getPopularCandidates(meId: MiUser['id']): Promise<ScoredCandidate[]> {
		const ranked = await this.featuredService.getPersonalizedNotesRanking(meId, RANKING_FETCH_SIZE);
		const n = ranked.length || 1;
		return ranked.map((noteId, i) => ({
			noteId,
			score: ((n - i) / n) * AXIS_WEIGHT.popular,
			source: 'popular' as const,
			reason: 'popular' as const,
		}));
	}

	/** リアクション類似軸（趣味の近い人たちが最近反応したノート）。スコアは最大値で正規化。 */
	@bindThis
	private async getReactionSimilarCandidates(meId: MiUser['id']): Promise<ScoredCandidate[]> {
		const list = await this.hanamiReactionSimilarService.getReactionSimilarNoteIds(meId, RANKING_FETCH_SIZE);
		const max = list[0]?.score || 1; // スコア降順で返る
		return list.map(({ noteId, userId, score }) => ({
			noteId,
			userId,
			score: (score / max) * AXIS_WEIGHT.reactionSimilar,
			source: 'reactionSimilar' as const,
			reason: 'reactionSimilar' as const,
		}));
	}

	/** 見逃し回収軸（ホームTLに流れたのに見ていない高反応ノート）。スコアは最大値で正規化。 */
	@bindThis
	private async getCatchupCandidates(meId: MiUser['id'], opts?: CatchupOptions): Promise<ScoredCandidate[]> {
		const list = await this.hanamiCatchupService.getCatchupNoteIds(meId, RANKING_FETCH_SIZE, opts);
		const max = list[0]?.score || 1; // スコア降順で返る
		return list.map(({ noteId, userId, score }) => ({
			noteId,
			userId,
			score: (score / max) * AXIS_WEIGHT.catchup,
			source: 'catchup' as const,
			reason: 'catchup' as const,
		}));
	}

	/** 急上昇軸（Lindera/Builtin トレンド）。 */
	@bindThis
	private async getTrendingCandidates(): Promise<ScoredCandidate[]> {
		const trending = await this.hanamiTrendService.getTrendingNoteIds(RANKING_FETCH_SIZE);
		const n = trending.length || 1;
		return trending.map(({ noteId, term }, i) => ({
			noteId,
			score: ((n - i) / n) * AXIS_WEIGHT.trending,
			source: 'trending' as const,
			reason: 'trending' as const,
			term,
		}));
	}

	/** FoF 軸（友達の友達の最近ノート）。ノートスコア（作者スコア×新鮮さ×可視性×エンゲージ×返信0.5x）を最大値で正規化して使う。 */
	@bindThis
	private async getFoFCandidates(meId: MiUser['id'], opts?: FoFNoteOptions): Promise<ScoredCandidate[]> {
		const fof = await this.hanamiUserRecommendationService.getFoFNoteIds(meId, RANKING_FETCH_SIZE, opts);
		const max = fof[0]?.score || 1; // getFoFNoteIds はスコア降順で返る
		return fof.map(({ noteId, userId, score }) => ({
			noteId,
			userId,
			score: (score / max) * AXIS_WEIGHT.fof,
			source: 'fof' as const,
			reason: 'fof' as const,
		}));
	}

	// ───────────────────────── 取得・パック ─────────────────────────

	/**
	 * 候補IDを DB から取得し可視性/ミュート/ブロック/インスタンスミュート/suspended/blocked-host/純RN を尊重して pack。
	 * public/home のみ・チャンネル除外。スコア順（candidates順）を維持。reason マップも返す。
	 */
	@bindThis
	private async fetchAndPackSafeRecNotes(candidates: ScoredCandidate[], me: MiLocalUser, opts: { withFiles: boolean }): Promise<{ recNotes: Packed<'Note'>[]; reasonOf: Map<string, RecReasonMeta> }> {
		const noteIds = candidates.map(c => c.noteId);
		const reasonOf = new Map(candidates.map(c => [c.noteId, { source: c.source, reason: c.reason, term: c.term, sources: c.sources }]));
		if (noteIds.length === 0) return { recNotes: [], reasonOf };

		const [userIdsWhoMeMuting, userIdsWhoBlockingMe, userIdsWhoMeBlocking, userMutedInstances] = await Promise.all([
			this.cacheService.userMutingsCache.fetch(me.id),
			this.cacheService.userBlockedCache.fetch(me.id),
			this.cacheService.userBlockingCache.fetch(me.id),
			this.cacheService.userProfileCache.fetch(me.id).then(p => new Set(p.mutedInstances)),
		]);

		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id IN (:...noteIds)', { noteIds })
			.andWhere('note.channelId IS NULL')
			.andWhere(new Brackets(qb => {
				qb.where('note.visibility = \'public\'').orWhere('note.visibility = \'home\'');
			}))
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		// 純粋RN除外（引用RN・本文/メディア/投票つきは元ノートとして許可）
		query.andWhere(new Brackets(qb => {
			qb.where('note.renoteId IS NULL')
				.orWhere('note.text IS NOT NULL')
				.orWhere('note.fileIds != \'{}\'')
				.orWhere('note.hasPoll = TRUE');
		}));

		if (opts.withFiles) query.andWhere('note.fileIds != \'{}\'');

		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const notes = (await query.getMany()).filter(note => {
			if (isUserRelated(note, userIdsWhoBlockingMe)) return false;
			if (isUserRelated(note, userIdsWhoMeBlocking)) return false;
			if (isUserRelated(note, userIdsWhoMeMuting)) return false;
			if (isInstanceMuted(note, userMutedInstances)) return false;
			return true;
		});

		const noteMap = new Map(notes.map(n => [n.id, n]));
		const ordered = noteIds.flatMap(id => {
			const n = noteMap.get(id);
			return n ? [n] : [];
		});

		const packed = await this.noteEntityService.packMany(ordered, me, { withReactionAndUserPairCache: true });
		await Promise.all(packed.map(note => removeMutedUsersReactions(note, userIdsWhoMeMuting)));
		return { recNotes: packed, reasonOf };
	}

	@bindThis
	private async fetchAndPackSafeRecNotesWithBackfill(candidates: ScoredCandidate[], target: number, me: MiLocalUser, opts: { withFiles: boolean }): Promise<{ recNotes: Packed<'Note'>[]; reasonOf: Map<string, RecReasonMeta> }> {
		const recNotes: Packed<'Note'>[] = [];
		const reasonOf = new Map<string, RecReasonMeta>();
		const packedIds = new Set<string>();
		const chunkSize = Math.max(target, (target * REC_DB_FETCH_OVERFETCH) + REC_DB_FETCH_EXTRA);

		for (let offset = 0; offset < candidates.length && recNotes.length < target; offset += chunkSize) {
			const chunk = candidates.slice(offset, offset + chunkSize);
			const packed = await this.fetchAndPackSafeRecNotes(chunk, me, opts);
			for (const [noteId, reason] of packed.reasonOf) reasonOf.set(noteId, reason);
			for (const note of packed.recNotes) {
				if (packedIds.has(note.id)) continue;
				packedIds.add(note.id);
				recNotes.push(note);
				if (recNotes.length >= target) break;
			}
		}

		return { recNotes, reasonOf };
	}

	// ───────────────────────── スロット注入 ─────────────────────────

	/**
	 * home を主軸に HOME_NOTES_PER_REC 件ごとに推薦を1件挟む。
	 * - 推薦内はスコア順維持・同一作者は強く後回し（候補不足時は表示可）
	 * - 末尾アンカーは必ず home 由来（untilId カーソル安定）
	 * - home が無い cold-start は推薦だけで limit まで埋める
	 */
	@bindThis
	private injectIntoSlots(homeNotes: Packed<'Note'>[], recNotes: Packed<'Note'>[], recTarget: number, limit: number): { notes: Packed<'Note'>[]; injectedIds: string[] } {
		const authorCount = new Map<string, number>();
		const recPool = recNotes.slice();
		const selectRec = (avoidAuthor: string | null): Packed<'Note'> | null => {
			let bestIdx = -1;
			let bestPenalty = Number.POSITIVE_INFINITY;
			for (let i = 0; i < recPool.length; i++) {
				const r = recPool[i];
				const sameAsLastPenalty = avoidAuthor != null && r.userId === avoidAuthor ? 100 : 0;
				const repeatedAuthorPenalty = (authorCount.get(r.userId) ?? 0) * 1000;
				const penalty = repeatedAuthorPenalty + sameAsLastPenalty;
				if (penalty < bestPenalty) {
					bestPenalty = penalty;
					bestIdx = i;
					if (penalty === 0) break;
				}
			}
			if (bestIdx < 0) return null;
			const rec = recPool.splice(bestIdx, 1)[0];
			authorCount.set(rec.userId, (authorCount.get(rec.userId) ?? 0) + 1);
			return rec;
		};

		// home が無い（フォロー0/新規）なら推薦のみで埋める（cold-start を楽しくする）
		if (homeNotes.length === 0) {
			const notes: Packed<'Note'>[] = [];
			let last: string | null = null;
			while (notes.length < limit) {
				const rec = selectRec(last);
				if (rec == null) break;
				notes.push(rec);
				last = rec.userId;
			}
			return { notes, injectedIds: notes.map(n => n.id) };
		}

		// 先に多様性制御後の実推薦数を確定し、その数に応じて home 枠を戻す。
		const selectedRecs: Packed<'Note'>[] = [];
		let lastSelectedAuthor: string | null = null;
		const maxRecs = Math.min(recTarget, Math.max(0, limit - 1));
		while (selectedRecs.length < maxRecs) {
			const rec = selectRec(lastSelectedAuthor);
			if (rec == null) break;
			selectedRecs.push(rec);
			lastSelectedAuthor = rec.userId;
		}

		// 末尾アンカー用に home を1枠確保する。推薦が多様性で減った場合は home を増やして埋め戻す。
		const recShown = selectedRecs.length;
		const homeShown = Math.min(homeNotes.length, limit - recShown);
		const anchor = homeNotes[homeShown - 1];
		const homeBody = homeNotes.slice(0, homeShown - 1);
		const recQueue = selectedRecs.slice();

		const out: Packed<'Note'>[] = [];
		const injectedIds: string[] = [];
		let bi = 0;
		let recsPlaced = 0;
		let homeSinceRec = 0;
		let lastAuthor: string | null = null;

		const pullSelectedRec = (avoidAuthor: string | null): Packed<'Note'> | null => {
			let fallbackIdx = -1;
			for (let i = 0; i < recQueue.length; i++) {
				const r = recQueue[i];
				if (fallbackIdx < 0) fallbackIdx = i;
				if (avoidAuthor != null && r.userId === avoidAuthor) continue;
				return recQueue.splice(i, 1)[0];
			}
			return fallbackIdx >= 0 ? recQueue.splice(fallbackIdx, 1)[0] : null;
		};

		while (out.length < limit - 1 && (bi < homeBody.length || recsPlaced < recShown)) {
			const homeLeft = bi < homeBody.length;
			const canRec = recsPlaced < recShown && recQueue.length > 0;
			const shouldRec = canRec && (homeSinceRec >= HOME_NOTES_PER_REC || !homeLeft);

			if (shouldRec) {
				const rec = pullSelectedRec(lastAuthor);
				if (rec != null) {
					out.push(rec);
					injectedIds.push(rec.id);
					lastAuthor = rec.userId;
					recsPlaced++;
					homeSinceRec = 0;
					continue;
				}
			}

			if (homeLeft) {
				const h = homeBody[bi++];
				out.push(h);
				lastAuthor = h.userId;
				homeSinceRec++;
				continue;
			}
			break;
		}

		out.push(anchor);
		return { notes: out, injectedIds };
	}

	// ───────────────────────── stream 用 ─────────────────────────

	@bindThis
	public async getAutoInjectPreset(meId: MiUser['id']): Promise<HanamiAutoInjectPreset | null> {
		const settings = await this.resolveSettings(meId);
		if (!settings.enabled || !settings.autoInjectEnabled || settings.axes.size === 0) return null;
		return AUTO_INJECT_PRESET[settings.autoInjectStrength];
	}

	@bindThis
	public async getAutoInjectNotes(me: MiLocalUser, opts: { limit: number; withFiles: boolean; excludedNoteIds?: ReadonlySet<string>; }): Promise<HanamiAutoInjectItem[]> {
		const settings = await this.resolveSettings(me.id);
		if (!settings.enabled || !settings.autoInjectEnabled || settings.axes.size === 0 || opts.limit <= 0) return [];

		const [served, seen, homeSeen] = await Promise.all([
			this.getZsetMembers(`${SERVED_KEY_PREFIX}${me.id}`, SERVED_TTL_MS),
			this.getZsetMembers(`${SEEN_KEY_PREFIX}${me.id}`, SEEN_TTL_MS),
			this.getZsetMembers(`${HOME_SEEN_KEY_PREFIX}${me.id}`, HOME_SEEN_TTL_MS),
		]);
		const hardExcludedFoFNoteIds = new Set([...seen, ...(opts.excludedNoteIds ?? [])]);
		const candidates = await this.getCandidates(me.id, {
			limit: opts.limit * REC_CANDIDATE_OVERFETCH,
			capLimit: opts.limit,
			excluded: (candidate) => seen.has(candidate.noteId) || homeSeen.has(candidate.noteId) || opts.excludedNoteIds?.has(candidate.noteId) === true || (candidate.source !== 'fof' && served.has(candidate.noteId)),
			newerThan: null,
			axes: settings.axes,
			axisMaxShare: this.buildAxisShare(AUTO_AXIS_MAX_SHARE, settings.axisLevels),
			fofOptions: {
				hardExcludedNoteIds: hardExcludedFoFNoteIds,
				softPenaltyNoteIds: served,
				newerThan: null,
				withFiles: opts.withFiles,
			},
			catchupOptions: {
				homeSeenNoteIds: homeSeen,
			},
		});
		// RESTとstreamで同じ安全境界を通す。ここから返るノートにchannel固有の推薦フィルターを重ねない。
		const { recNotes, reasonOf } = await this.fetchAndPackSafeRecNotesWithBackfill(candidates, opts.limit, me, { withFiles: opts.withFiles });
		const notes = recNotes.slice(0, opts.limit);
		this.markRecommendationMeta(notes, notes.map(note => note.id), reasonOf, settings.showReason);

		return notes.flatMap(note => {
			const reason = reasonOf.get(note.id);
			return reason == null ? [] : [{ note, reason }];
		});
	}

	// ───────────────────────── served / seen / ログ ─────────────────────────

	@bindThis
	private async getZsetMembers(key: string, ttlMs: number): Promise<Set<string>> {
		const cutoff = Date.now() - ttlMs;
		const ids = await this.redisClient.zrangebyscore(key, cutoff, '+inf');
		return new Set(ids);
	}

	@bindThis
	public async recordServed(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		await this.recordZset(`${SERVED_KEY_PREFIX}${userId}`, noteIds, SERVED_TTL_SECONDS, SERVED_TTL_MS);
	}

	@bindThis
	public async recordServedWithLog(userId: MiUser['id'], noteIds: string[], reasonOf: Map<string, RecReasonMeta>, authorIds: string[] = [], fofUserIds: string[] = []): Promise<void> {
		await this.recordServed(userId, noteIds);
		await this.recordServedAuthors(userId, authorIds);
		// FoFユーザー単位の既出記録。はなみTL/ストリーム注入経路でも疲労を効かせる（フォロー候補エンドポイント以外でも記録）。
		if (fofUserIds.length > 0) await this.hanamiUserRecommendationService.recordShown(userId, fofUserIds);
		await this.logServed(userId, noteIds, reasonOf);
	}

	@bindThis
	public async recordAutoInjectedServed(userId: MiUser['id'], items: HanamiAutoInjectItem[]): Promise<void> {
		if (items.length === 0) return;
		const reasonOf = new Map(items.map(item => [item.note.id, item.reason]));
		const fofUserIds = items.filter(item => item.reason.source === 'fof').map(item => item.note.userId);
		await this.recordServedWithLog(
			userId,
			items.map(item => item.note.id),
			reasonOf,
			items.map(item => item.note.userId),
			fofUserIds,
		);
	}

	@bindThis
	public async recordSeen(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		await this.recordZset(`${SEEN_KEY_PREFIX}${userId}`, noteIds, SEEN_TTL_SECONDS, SEEN_TTL_MS);
		// 軸別 served→seen 率を後段バッチで出せるよう、seen もストリームに残す（served と userId/noteId で突き合わせる）。
		await this.logEvents('seen', userId, noteIds.map(noteId => ({ noteId })));
	}

	/**
	 * はなみTLに表示されたホーム由来ノートの記録（推薦ではない通常表示分）。
	 * catchup軸の「見逃し」判定と、見たものを推薦し直さない一般除外に使う。
	 */
	@bindThis
	public async recordHomeSeen(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		await this.recordZset(`${HOME_SEEN_KEY_PREFIX}${userId}`, noteIds, HOME_SEEN_TTL_SECONDS, HOME_SEEN_TTL_MS);
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
		// 既出除外は best-effort（失敗しても致命ではない）が、黙って欠けると再表示バグに見えるのでログは残す。
		const err = results?.find(r => r[0] != null)?.[0];
		if (results == null || err != null) {
			// eslint-disable-next-line no-console
			console.error(`hanami rec: zset record failed (${key})`, err);
		}
	}

	@bindThis
	private async recordServedAuthors(userId: MiUser['id'], authorIds: string[]): Promise<void> {
		const uniqueAuthorIds = [...new Set(authorIds)];
		if (uniqueAuthorIds.length === 0) return;
		const now = Date.now();
		const scoreMembers: (string | number)[] = [];
		for (const id of uniqueAuthorIds) scoreMembers.push(now, id);
		await this.redisClient.multi()
			.zadd(`${AUTHOR_SERVED_KEY_PREFIX}${userId}`, ...(scoreMembers as [number, string]))
			.zremrangebyscore(`${AUTHOR_SERVED_KEY_PREFIX}${userId}`, 0, now - AUTHOR_SERVED_TTL_MS)
			.expire(`${AUTHOR_SERVED_KEY_PREFIX}${userId}`, AUTHOR_SERVED_TTL_SECONDS)
			.exec();
	}

	/**
	 * 効果測定ログ（仕様7）: Redis Stream に最小限を残す。集計は後段バッチで Postgres へ。
	 * sources は寄与した全軸（カンマ区切り）。served∩複数軸の被り率を後から定量化できる。
	 */
	@bindThis
	private async logServed(userId: MiUser['id'], noteIds: string[], reasonOf: Map<string, RecReasonMeta>): Promise<void> {
		if (LOG_SAMPLE_RATE < 1 && Math.random() > LOG_SAMPLE_RATE) return;
		await this.logEvents('served', userId, noteIds.map(noteId => {
			const r = reasonOf.get(noteId);
			return {
				noteId,
				source: r?.source ?? 'unknown',
				reasonCode: r?.reason ?? 'unknown',
				sources: r?.sources != null && r.sources.length > 0 ? r.sources.join(',') : undefined,
			};
		}));
	}

	@bindThis
	private async logEvents(event: 'served' | 'seen', userId: MiUser['id'], entries: { noteId: string; source?: string; reasonCode?: string; sources?: string }[]): Promise<void> {
		if (entries.length === 0) return;
		const at = Date.now().toString();
		const pipeline = this.redisClient.pipeline();
		for (const entry of entries) {
			const fields: string[] = [
				'event', event,
				'userId', userId,
				'noteId', entry.noteId,
				'at', at,
			];
			if (entry.source != null) fields.push('source', entry.source);
			if (entry.reasonCode != null) fields.push('reasonCode', entry.reasonCode);
			if (entry.sources != null) fields.push('sources', entry.sources);
			pipeline.call('XADD', LOG_STREAM_KEY, 'MAXLEN', '~', String(LOG_STREAM_MAXLEN), '*', ...fields);
		}
		await pipeline.exec();
	}

	/**
	 * フォロー候補（step10）。エンドポイントから呼ぶ薄いラッパ。
	 */
	@bindThis
	public async getFollowCandidates(meId: MiUser['id'], limit: number): Promise<{ userId: string; reason: string; mutualCount: number }[]> {
		const cands = await this.hanamiUserRecommendationService.getFollowCandidates(meId, limit);
		return cands.map(c => ({ userId: c.userId, reason: c.reason, mutualCount: c.mutualCount }));
	}

	@bindThis
	public async recordFollowCandidatesShown(meId: MiUser['id'], userIds: MiUser['id'][]): Promise<void> {
		await this.hanamiUserRecommendationService.recordShown(meId, userIds);
	}

	/**
	 * テキストトレンド（急上昇用語）一覧。エンドポイントから呼ぶ薄いラッパ。
	 * ハッシュタグ集計（hashtags/trend）とは別系統で、本文をトークナイズした汎用トレンド（trending軸の素）。
	 */
	@bindThis
	public async getTrendingTerms(limit: number): Promise<{ term: string; score: number; distinctAuthors: number }[]> {
		const terms = await this.hanamiTrendService.getTrendingTerms(limit);
		return terms.map(t => ({ term: t.term, score: t.score, distinctAuthors: t.distinctAuthors }));
	}
}
