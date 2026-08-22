/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiNote } from '@/models/Note.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { HanamiTokenizerService } from './tokenize/HanamiTokenizerService.js';

// トレンド窓: おすすめ(FeaturedService)と同じ 15分グリッド × 288枠(72時間)。
// 現窓“単独”だと毎窓境界でトレンドが消える崖が出るため、スライディング窓にする。
const TREND_WINDOW_MS = 1000 * 60 * 15; // 15分
const TREND_WINDOW_COUNT = 288; // 72時間分（= baseline を測る全期間）
const TREND_TTL_EXTRA_WINDOW_COUNT = 8; // バッファ窓（= 2時間）
const TREND_TTL_SECONDS = Math.ceil((TREND_WINDOW_MS * (TREND_WINDOW_COUNT + TREND_TTL_EXTRA_WINDOW_COUNT)) / 1000);
// 急上昇(spike)を測る「直近(=今)」の窓数。recent = 直近 R 窓、baseline = 残り窓。R=8 → 2時間。
// 投稿数が少ない環境では窓ごとのカウントが薄いため、R を広めに取り spike のブレを抑える。
const TREND_RECENT_WINDOW_COUNT = 8;
const TREND_RECENT_SPAN_MS = TREND_WINDOW_MS * TREND_RECENT_WINDOW_COUNT;
// spike = 直近レート ÷ (普段レート + EPS)。EPS は 0除算防止＋新出の極小語が増加率だけで暴れるのを抑える事前分布。
const SPIKE_EPS = 0.1;
// 直近 R 窓での distinct-author 出現延べ数の下限（増加率だけで上位化する極小ノイズ語の安価な一次足切り。
// 窓単位カウントなので1人の連投でも増える。実人数の floor は TREND_RECENT_MIN_DISTINCT_AUTHORS で別に効かせる）。
const TREND_RECENT_MIN_COUNT = 3;
// 直近スパン(2時間)全体で見た実 distinct author 数の下限。
// 窓ごとの重複排除は15分でリセットされるため、1人が窓を跨いで話し続けるだけで延べ数は増える（独り言/空リプ漏れ）。
// SUNION で「2時間に本当に何人が言ったか」を数え、ここで弾く。
const TREND_RECENT_MIN_DISTINCT_AUTHORS = 3;
// 用語の直近ノート群のエンゲージ合算 floor。誰にも反応されない語（形態素解析の断片等の謎単語）はここで沈む。
const TREND_MIN_RECENT_ENGAGEMENT = 1;
// 1ノートから採用する最大 distinct 用語数（珍語爆発の最小対策）。
const MAX_TERMS_PER_NOTE = 16;
// 用語ごとに保持する最近ノート数。
const NOTES_PER_TERM = 200;
// トレンド用語として成立する最小 distinct author 数（全窓横断・操作耐性の near-free guard）。
const MIN_DISTINCT_AUTHORS = 3;
// spike 一次候補の上限（この件数だけエンゲージ/distinct の二次評価を行う）。
const TREND_CANDIDATE_LIMIT = 200;
// トレンド結果のうち固有名詞（人名/地名/組織/作品/製品名 等）に確保する最低割合。
// 普通名詞（値上げ/突破 等）にフィードが埋め尽くされるのを防ぎ、固有名詞の話題を一定数surfaceさせる。
const TREND_PROPER_NOUN_MIN_SHARE = 0.4;
const TRENDING_TERMS_CACHE_KEY = 'hanami:trend:terms';
const TRENDING_TERMS_CACHE_TTL_SECONDS = 60;
const TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS = 5;

// 注入候補ノートの選定（getTrendingNoteIds）:
// 「用語を含む最新ノートを機械的に」ではなく、エンゲージ×新しさのハイブリッド順にする。
const TREND_NOTE_MIN_ENGAGEMENT = 1; // ノート単体の floor（リアクション1相当）。0反応ノートはトレンドに乗らない
const TREND_NOTE_POPULAR_EXCLUDE_TOP = 100; // グローバル人気上位は popular 軸の領分なので trending からは出さない（バンドパス上限）
const TREND_NOTE_FRESHNESS_HALF_LIFE_MS = 1000 * 60 * 60 * 12; // 鮮度半減期 12h
const TREND_NOTES_PER_TERM_FETCH = 40; // 用語ごとに評価する最近ノート数
const TREND_NOTES_RESULT_MAX = 200;
const TREND_SNAPSHOT_TERM_MAX = 30;
const TREND_FEED_TERM_MAX = 8;
const TRENDING_NOTES_CACHE_KEY = 'hanami:trend:noteIds';
const TRENDING_NOTES_CACHE_TTL_SECONDS = 30;
const TRENDING_NOTES_EMPTY_CACHE_TTL_SECONDS = 5;

// 効果測定スナップショット: 候補用語の判定材料を再計算ごとに1エントリで Redis Stream に残す。
// 閾値（floor/集中度ガード）の調整は当て勘でなくこのログで行う。
const TREND_LOG_STREAM_KEY = 'hanami:trend:log';
const TREND_LOG_STREAM_MAXLEN = 2000;
const TREND_LOG_CANDIDATE_LIMIT = 50;

const trendEpoch = new Date('2023-01-01T00:00:00Z').getTime();

export type TrendingTerm = { term: string; score: number; distinctAuthors: number };
type TrendingTermCandidate = TrendingTerm & { proper: boolean };

export type HanamiTrendComputationBundle = {
	readonly computedAt: string;
	readonly terms: readonly (TrendingTerm & {
		readonly representativeNoteIds: readonly string[];
	})[];
	readonly noteCandidates: readonly {
		readonly noteId: string;
		readonly term: string;
	}[];
};

/**
 * 急上昇トレンド（[[hanami-tl-osusume-redesign]] step7/8）。
 *
 * - 本文のみを HanamiTokenizerService で解析（URL/タグ/絵文字/メディアは見ない）
 * - distinct author 数を窓ごとに数える（同一人物の連投で釣り上がらない）
 * - 一次スコアは spike率（普段比の増加率）。recent=直近 R 窓のレート ÷ baseline=残り窓のレート。
 *   定番語/毎日同じ自動投稿は baseline が高く spike しない＝上位から消える
 * - 二次評価で (a) 直近スパンの実 distinct author（独り言/空リプの窓跨ぎを1人と数える）と
 *   (b) 用語の直近ノート群のエンゲージ合算 を floor にし、最終スコアを spike×エンゲージ加重にする
 * - 用語ごとの全窓横断 distinct author が MIN_DISTINCT_AUTHORS 未満なら採用しない（1アカウント捏造を弾く）
 *
 * インデックスは専用ワーカー想定の fire-and-forget で呼ぶ（リクエスト経路を遅らせない）。
 */
@Injectable()
export class HanamiTrendService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private featuredService: FeaturedService,
		private hanamiTokenizerService: HanamiTokenizerService,
	) {
	}

	@bindThis
	private currentWindow(): number {
		return Math.floor((Date.now() - trendEpoch) / TREND_WINDOW_MS);
	}

	private rankKey(w: number): string { return `hanami:trend:rank:${w}`; }
	private authorSetKey(w: number, term: string): string { return `hanami:trend:as:${w}:${term}`; }
	private authorsKey(term: string): string { return `hanami:trend:authors:${term}`; }
	private notesKey(term: string): string { return `hanami:trend:notes:${term}`; }
	private properKey(): string { return 'hanami:trend:proper'; } // 固有名詞と判定された用語の集合

	/**
	 * ノート本文を解析してトレンドインデックスに反映する（非同期ワーカーから fire-and-forget で呼ぶ）。
	 * 対象は public/home の本文ありオリジナルノートのみ（呼び出し側で絞る）。
	 */
	@bindThis
	public async indexNote(note: MiNote): Promise<void> {
		if (note.text == null || note.text.length === 0) return;

		const tokens = await this.hanamiTokenizerService.tokenizeWithKind(note.text);
		if (tokens.length === 0) return;

		// 1ノート内では distinct 用語のみ（連呼で釣り上げない）。固有名詞フラグを保持。
		const seen = new Set<string>();
		const terms: { term: string; proper: boolean }[] = [];
		for (const tk of tokens) {
			if (seen.has(tk.term)) continue;
			seen.add(tk.term);
			terms.push(tk);
			if (terms.length >= MAX_TERMS_PER_NOTE) break;
		}
		const w = this.currentWindow();
		const now = Date.now();

		// distinct author 判定（SADD の戻り値が要る）を1パス目で全用語まとめて実行し、
		// 残りの書き込みを2パス目に集約する（用語ごとの逐次 await を避ける: 2往復で済む）。
		const saddPipe = this.redisClient.pipeline();
		for (const { term } of terms) saddPipe.sadd(this.authorSetKey(w, term), note.userId);
		const saddRes = await saddPipe.exec();

		const pipe = this.redisClient.pipeline();
		for (let i = 0; i < terms.length; i++) {
			const { term, proper } = terms[i];
			const added = Number(saddRes?.[i]?.[1] ?? 0);
			const nKey = this.notesKey(term);
			const aKey = this.authorsKey(term);
			// 新規 author のときだけランキングを加点。
			if (added === 1) pipe.zincrby(this.rankKey(w), 1, term);
			pipe.expire(this.authorSetKey(w, term), TREND_TTL_SECONDS, 'NX');
			pipe.expire(this.rankKey(w), TREND_TTL_SECONDS, 'NX');
			// 用語の全窓横断 distinct author（スライディング合算時の操作耐性 floor 用）
			pipe.sadd(aKey, note.userId);
			pipe.expire(aKey, TREND_TTL_SECONDS);
			// 固有名詞は専用集合に記録（一定割合の固有名詞確保に使う）
			if (proper) { pipe.sadd(this.properKey(), term); pipe.expire(this.properKey(), TREND_TTL_SECONDS); }
			// 用語→最近ノート（時間順、上限つき）
			pipe.zadd(nKey, now, note.id);
			pipe.zremrangebyrank(nKey, 0, -(NOTES_PER_TERM + 1));
			pipe.expire(nKey, TREND_TTL_SECONDS);
		}
		await pipe.exec();
	}

	/**
	 * 急上昇用語の候補。
	 * 一次: spike率（窓別 distinct-author 延べ数ベース）でふるい落とし。
	 * 二次: 直近スパンの実 distinct author / エンゲージ合算で floor をかけ、spike×エンゲージ加重で最終スコア化。
	 */
	@bindThis
	private async getTrendingTermCandidatesWithCache(featuredScores?: ReadonlyMap<string, number>): Promise<TrendingTermCandidate[]> {
		const cached = await this.redisClient.get(TRENDING_TERMS_CACHE_KEY);
		if (cached != null) {
			return JSON.parse(cached) as TrendingTermCandidate[];
		}

		const cw = this.currentWindow();

		// 全 TREND_WINDOW_COUNT 窓の窓別 distinct-author カウントを取得し、
		// 直近 R 窓(recent=今) と 残り窓(baseline=普段) に分けて spike率を出す。
		const pipe = this.redisClient.pipeline();
		for (let i = 0; i < TREND_WINDOW_COUNT; i++) pipe.zrange(this.rankKey(cw - i), 0, 200, 'REV', 'WITHSCORES');
		const res = await pipe.exec();

		// term ごとに recent合計 / baseline合計 を貯める（i=0 が現窓、i が大きいほど過去）。
		const recentSum = new Map<string, number>();
		const baselineSum = new Map<string, number>();
		for (let i = 0; i < TREND_WINDOW_COUNT; i++) {
			const raw = (res?.[i]?.[1] ?? []) as string[];
			if (raw.length === 0) continue;
			const target = i < TREND_RECENT_WINDOW_COUNT ? recentSum : baselineSum;
			for (let j = 0; j < raw.length; j += 2) {
				target.set(raw[j], (target.get(raw[j]) ?? 0) + parseFloat(raw[j + 1]));
			}
		}
		if (recentSum.size === 0) {
			// 直近に動きが無ければ「急上昇」は存在しない。
			await this.redisClient.set(TRENDING_TERMS_CACHE_KEY, '[]', 'EX', TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS);
			return [];
		}

		// spike = 直近1窓あたりレート ÷ (普段1窓あたりレート + EPS)。
		// 定番語は baseline が高く spike≒1、新出/話題化した語ほど spike が大きい。
		const baselineWindows = TREND_WINDOW_COUNT - TREND_RECENT_WINDOW_COUNT;
		const spikes: [string, number][] = [];
		for (const [term, recent] of recentSum) {
			if (recent < TREND_RECENT_MIN_COUNT) continue; // 直近の出現が薄すぎる極小ノイズ語を除外
			const recentRate = recent / TREND_RECENT_WINDOW_COUNT;
			const baselineRate = (baselineSum.get(term) ?? 0) / baselineWindows;
			spikes.push([term, recentRate / (baselineRate + SPIKE_EPS)]);
		}
		if (spikes.length === 0) {
			await this.redisClient.set(TRENDING_TERMS_CACHE_KEY, '[]', 'EX', TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS);
			return [];
		}

		// 二次評価: spike 上位ごとに 全窓distinct / 直近スパンdistinct（SUNION） / 直近ノートID を一括取得。
		const candidates = spikes.sort((a, b) => b[1] - a[1]).slice(0, TREND_CANDIDATE_LIMIT);
		const now = Date.now();
		const recentNotesSince = now - TREND_RECENT_SPAN_MS;
		const evalPipe = this.redisClient.pipeline();
		for (const [term] of candidates) {
			evalPipe.scard(this.authorsKey(term));
			evalPipe.sunion(...Array.from({ length: TREND_RECENT_WINDOW_COUNT }, (_, i) => this.authorSetKey(cw - i, term)));
			evalPipe.zrangebyscore(this.notesKey(term), recentNotesSince, '+inf');
		}
		const [evalRes, globalScores] = await Promise.all([
			evalPipe.exec(),
			featuredScores ?? this.featuredService.getGlobalNotesScoresWithCache(),
		]);

		type EvaluatedTerm = TrendingTerm & {
			spike: number;
			recentCount: number;
			recentDistinctAuthors: number;
			recentEngagement: number;
			rejected: string | null;
		};
		const evaluated: EvaluatedTerm[] = [];
		for (let i = 0; i < candidates.length; i++) {
			const [term, spike] = candidates[i];
			const distinctAuthors = Number(evalRes?.[i * 3]?.[1] ?? 0);
			const recentAuthors = (evalRes?.[(i * 3) + 1]?.[1] ?? []) as string[];
			const recentNoteIds = (evalRes?.[(i * 3) + 2]?.[1] ?? []) as string[];
			let recentEngagement = 0;
			for (const noteId of recentNoteIds) recentEngagement += globalScores.get(noteId) ?? 0;

			let rejected: string | null = null;
			if (distinctAuthors < MIN_DISTINCT_AUTHORS) rejected = 'fewTotalAuthors'; // 全窓で distinct author が少ない（1アカウント捏造）
			else if (recentAuthors.length < TREND_RECENT_MIN_DISTINCT_AUTHORS) rejected = 'fewRecentAuthors'; // 窓を跨ぐ独り言/空リプ
			else if (recentEngagement < TREND_MIN_RECENT_ENGAGEMENT) rejected = 'noEngagement'; // 誰にも反応されない謎単語

			evaluated.push({
				term,
				// 最終スコア: spike にエンゲージ加重を掛ける。反応の集まる話題ほど上、桁は log で潰す。
				score: spike * (1 + Math.log10(1 + recentEngagement)),
				distinctAuthors,
				spike,
				recentCount: recentSum.get(term) ?? 0,
				recentDistinctAuthors: recentAuthors.length,
				recentEngagement,
				rejected,
			});
		}

		this.logTrendSnapshot(now, evaluated).catch(err => {
			// eslint-disable-next-line no-console
			console.error('hanami trend: snapshot log failed', err);
		});

		const out: TrendingTerm[] = evaluated
			.filter(e => e.rejected == null)
			.map(e => ({ term: e.term, score: e.score, distinctAuthors: e.distinctAuthors }))
			.sort((a, b) => b.score - a.score);

		const flags = out.length > 0 ? await this.redisClient.smismember(this.properKey(), ...out.map(o => o.term)) : [];
		const terms = out.map((o, i) => ({ ...o, proper: Number(flags[i]) === 1 }));

		await this.redisClient.set(
			TRENDING_TERMS_CACHE_KEY,
			JSON.stringify(terms),
			'EX',
			terms.length > 0 ? TRENDING_TERMS_CACHE_TTL_SECONDS : TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS);

		return terms;
	}

	/**
	 * 候補用語の判定材料スナップショット（閾値チューニング用）。再計算ごとに1エントリ。
	 * avgWindowsPerAuthor が高い語は少人数が窓を跨いで話し続けている（集中度ガード導入判断の材料）。
	 */
	@bindThis
	private async logTrendSnapshot(at: number, evaluated: { term: string; spike: number; score: number; recentCount: number; recentDistinctAuthors: number; recentEngagement: number; distinctAuthors: number; rejected: string | null }[]): Promise<void> {
		if (evaluated.length === 0) return;
		const top = evaluated.slice(0, TREND_LOG_CANDIDATE_LIMIT).map(e => ({
			term: e.term,
			spike: Math.round(e.spike * 100) / 100,
			score: Math.round(e.score * 100) / 100,
			recentCount: e.recentCount,
			recentAuthors: e.recentDistinctAuthors,
			avgWindowsPerAuthor: e.recentDistinctAuthors > 0 ? Math.round((e.recentCount / e.recentDistinctAuthors) * 100) / 100 : 0,
			recentEng: Math.round(e.recentEngagement * 100) / 100,
			totalAuthors: e.distinctAuthors,
			rejected: e.rejected,
		}));
		await this.redisClient.call(
			'XADD', TREND_LOG_STREAM_KEY, 'MAXLEN', '~', String(TREND_LOG_STREAM_MAXLEN), '*',
			'at', String(at),
			'candidates', JSON.stringify(top),
		);
	}

	@bindThis
	private asTrendingTerm(term: TrendingTermCandidate): TrendingTerm {
		return {
			term: term.term,
			score: term.score,
			distinctAuthors: term.distinctAuthors,
		};
	}

	private selectTrendingTerms(out: readonly TrendingTermCandidate[], limit: number): TrendingTerm[] {
		if (out.length <= limit) return out.map(this.asTrendingTerm);

		// 固有名詞を一定割合確保する（値上げ/突破 等の普通名詞でフィードが埋め尽くされるのを防ぐ）。
		const reserved = Math.min(limit, Math.ceil(limit * TREND_PROPER_NOUN_MIN_SHARE));
		const picked: TrendingTermCandidate[] = [];
		const used = new Set<string>();
		// まず固有名詞をスコア順に reserved 件まで確保（足りなければある分だけ）
		for (const o of out) {
			if (picked.length >= reserved) break;
			if (o.proper) { picked.push(o); used.add(o.term); }
		}
		// 残り枠はスコア順で埋める（固有名詞含む・重複除外）
		for (const o of out) {
			if (picked.length >= limit) break;
			if (used.has(o.term)) continue;
			picked.push(o); used.add(o.term);
		}
		picked.sort((a, b) => b.score - a.score);
		return picked.map(this.asTrendingTerm);
	}

	/**
	 * 急上昇用語。spike×エンゲージ加重スコアで並べ、distinct author / エンゲージ floor で足切り済み。
	 */
	@bindThis
	public async getTrendingTerms(limit: number): Promise<TrendingTerm[]> {
		const out = await this.getTrendingTermCandidatesWithCache();
		return this.selectTrendingTerms(out, limit);
	}

	private async rankNotesForTerms(terms: readonly TrendingTerm[], globalScores: ReadonlyMap<string, number>, now: number): Promise<Map<string, string[]>> {
		if (terms.length === 0) return new Map();

		const pipe = this.redisClient.pipeline();
		for (const term of terms) pipe.zrange(this.notesKey(term.term), 0, TREND_NOTES_PER_TERM_FETCH, 'REV', 'WITHSCORES');
		const res = await pipe.exec();

		// バンドパス上限: グローバル人気上位（popular軸が拾う範囲）を除外する。
		const popularTop = new Set(
			Array.from(globalScores.entries())
				.filter(([noteId, score]) => noteId.length > 0 && Number.isFinite(score))
				.sort((a, b) => b[1] - a[1])
				.slice(0, TREND_NOTE_POPULAR_EXCLUDE_TOP)
				.map(([id]) => id));

		const out = new Map<string, string[]>();
		for (let i = 0; i < terms.length; i++) {
			const raw = (res?.[i]?.[1] ?? []) as string[];
			const items: { noteId: string; score: number; rank: number }[] = [];
			for (let j = 0; j < raw.length; j += 2) {
				const noteId = raw[j];
				const postedAt = Number(raw[j + 1]);
				const engagement = globalScores.get(noteId) ?? 0;
				if (noteId.length === 0 || !Number.isFinite(postedAt) || !Number.isFinite(engagement)) continue;
				if (engagement < TREND_NOTE_MIN_ENGAGEMENT) continue;
				if (popularTop.has(noteId)) continue;
				const freshness = Math.pow(0.5, Math.max(0, now - postedAt) / TREND_NOTE_FRESHNESS_HALF_LIFE_MS);
				items.push({ noteId, score: engagement * freshness, rank: j / 2 });
			}
			items.sort((a, b) => b.score - a.score || a.rank - b.rank);
			out.set(terms[i].term, items.map(item => item.noteId));
		}
		return out;
	}

	/**
	 * 永続snapshotと共通trending候補を、同じ用語集計・Featured観測から一度に作る。
	 */
	@bindThis
	public async computeTrendBundle(featuredScores?: ReadonlyMap<string, number>): Promise<HanamiTrendComputationBundle> {
		const globalScores = featuredScores ?? await this.featuredService.getGlobalNotesScoresWithCache();
		const candidates = await this.getTrendingTermCandidatesWithCache(globalScores);
		const snapshotTerms = this.selectTrendingTerms(candidates, TREND_SNAPSHOT_TERM_MAX);
		const feedTerms = this.selectTrendingTerms(candidates, TREND_FEED_TERM_MAX);
		const termsToFetch = [...snapshotTerms];
		const fetchedTerms = new Set(termsToFetch.map(term => term.term));
		for (const term of feedTerms) {
			if (fetchedTerms.has(term.term)) continue;
			fetchedTerms.add(term.term);
			termsToFetch.push(term);
		}

		const now = Date.now();
		const rankedByTerm = await this.rankNotesForTerms(termsToFetch, globalScores, now);

		const terms = snapshotTerms.map(term => ({
			...term,
			representativeNoteIds: rankedByTerm.get(term.term) ?? [],
		}));

		const noteCandidates: { noteId: string; term: string }[] = [];
		const seen = new Set<string>();
		let index = 0;
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const term of feedTerms) {
				const noteId = rankedByTerm.get(term.term)?.[index];
				if (noteId == null) continue;
				progressed = true;
				if (seen.has(noteId)) continue;
				seen.add(noteId);
				noteCandidates.push({ noteId, term: term.term });
			}
			index++;
		}

		return {
			computedAt: new Date(now).toISOString(),
			terms,
			noteCandidates,
		};
	}

	/**
	 * 急上昇用語に紐づく注入候補ノートID。用語間でラウンドロビンして多様性を出す。
	 * ノートは「時刻順」ではなく エンゲージ×鮮度 のハイブリッド順。
	 * - floor: エンゲージ < TREND_NOTE_MIN_ENGAGEMENT のノートは出さない（単語を含むだけの不人気投稿を機械的に乗せない）
	 * - バンドパス: グローバル人気上位 TREND_NOTE_POPULAR_EXCLUDE_TOP は popular 軸の領分なので出さない
	 * 選定はユーザー非依存なので短TTLでキャッシュする（毎リクエストのスコアマップ取得を避ける）。
	 * 返り値は {noteId, term} 配列（term は理由表示に使える）。
	 */
	@bindThis
	public async getTrendingNoteIds(limit: number): Promise<{ noteId: string; term: string }[]> {
		const legacyLimit = Math.max(0, Math.min(limit, TREND_NOTES_RESULT_MAX));
		const cached = await this.redisClient.get(TRENDING_NOTES_CACHE_KEY);
		if (cached != null) {
			return (JSON.parse(cached) as { noteId: string; term: string }[]).slice(0, legacyLimit);
		}

		const bundle = await this.computeTrendBundle();
		const out = bundle.noteCandidates.slice(0, TREND_NOTES_RESULT_MAX).map(candidate => ({ ...candidate }));

		await this.redisClient.set(
			TRENDING_NOTES_CACHE_KEY,
			JSON.stringify(out),
			'EX',
			out.length > 0 ? TRENDING_NOTES_CACHE_TTL_SECONDS : TRENDING_NOTES_EMPTY_CACHE_TTL_SECONDS);

		return out.slice(0, legacyLimit);
	}
}
