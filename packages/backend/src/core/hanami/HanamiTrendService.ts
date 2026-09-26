/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import Logger from '@/logger.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiNote } from '@/models/Note.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { TASTE_EMBED_MODEL } from './HanamiTasteClusterBatchService.js';
import { HanamiTokenizerService } from './tokenize/HanamiTokenizerService.js';

// トレンド窓: おすすめ(FeaturedService)と同じ 15分グリッド × 288枠(72時間)。
// 現窓“単独”だと毎窓境界でトレンドが消える崖が出るため、スライディング窓にする。
const TREND_WINDOW_MS = 1000 * 60 * 15; // 15分
const TREND_WINDOW_COUNT = 288; // 72時間分（= baseline を測る全期間）
const TREND_TTL_EXTRA_WINDOW_COUNT = 8; // バッファ窓（= 2時間）
const TREND_TTL_SECONDS = Math.ceil((TREND_WINDOW_MS * (TREND_WINDOW_COUNT + TREND_TTL_EXTRA_WINDOW_COUNT)) / 1000);
const AUTHORS_WINDOW_MS = 72 * 60 * 60 * 1000;
const TREND_MIN_SPIKE = 2;
const TREND_CLUSTER_INPUT_MAX = 60;
const TREND_CLUSTER_WINDOW_MS = 6 * 60 * 60 * 1000;
const TREND_CLUSTER_NOTES_PER_TERM = 30;
const TREND_CLUSTER_COS = 0.45;
const SOCIAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_AUTHORS_TTL_SECONDS = 26 * 60 * 60;
const HOURLY_TTL_SECONDS = 8 * 24 * 60 * 60;
const HOURLY_SINCE_KEY = 'hanami:trend:hrank:since';
const WEEK_READY_MS = (7 * 24 + 2) * 60 * 60 * 1000;
const BASELINE_PAD = 4;
const TEMPLATE_FP_LEN = 40;
const TEMPLATE_FP_MIN_LEN = 8;
const TEMPLATE_MIN_AUTHORS = 5;
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
const TREND_NOTE_FRESHNESS_HALF_LIFE_MS = 1000 * 60 * 60 * 12; // 鮮度半減期 12h
const TREND_NOTES_PER_TERM_FETCH = 200; // 用語ごとに評価する最近ノート数
const TREND_NOTES_RESULT_MAX = 200;
const TREND_SNAPSHOT_TERM_MAX = 30;
const TREND_FEED_TERM_MAX = 30;
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
type TrendBase = { base: number; baseKind: 'avg70' | 'day' | 'dayWeek' };
type TrendingTermCandidate = TrendingTerm & { proper: boolean };
type TrendCluster = { head: TrendingTermCandidate; members: TrendingTermCandidate[] };
type RankedTrendNote = { noteId: string; score: number; rank: number };

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
 * - 一次スコアは spike率（普段比の増加率）。recent=直近 R 窓のレート ÷ baseline=同時刻（固有名詞は残り窓）のレート。
 *   定番語/毎日同じ自動投稿は baseline が高く spike しない＝上位から消える
 * - 二次評価で (a) 直近スパンの実 distinct author（独り言/空リプの窓跨ぎを1人と数える）と
 *   (b) 用語の直近ノート群のエンゲージ合算 を floor にし、普段比を最終スコアにする
 * - 用語ごとの全窓横断 distinct author が MIN_DISTINCT_AUTHORS 未満なら採用しない（1アカウント捏造を弾く）
 *
 * インデックスは専用ワーカー想定の fire-and-forget で呼ぶ（リクエスト経路を遅らせない）。
 */
@Injectable()
export class HanamiTrendService {
	private readonly logger = new Logger('hanami');

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private featuredService: FeaturedService,
		private hanamiTokenizerService: HanamiTokenizerService,

		@Inject(DI.db)
		private db: DataSource,
	) {
	}

	@bindThis
	private currentWindow(): number {
		return Math.floor((Date.now() - trendEpoch) / TREND_WINDOW_MS);
	}

	private rankKey(w: number): string { return `hanami:trend:rank:${w}`; }
	private hourlyRankKey(h: number): string { return `hanami:trend:hrank:${h}`; }
	private authorSetKey(w: number, term: string): string { return `hanami:trend:as:${w}:${term}`; }
	private authorsKey(term: string): string { return `hanami:trend:authorsz:${term}`; }
	private recentAuthorsKey(term: string): string { return `hanami:trend:ra:${term}`; }
	private notesKey(term: string): string { return `hanami:trend:notes:${term}`; }
	private properKey(): string { return 'hanami:trend:proper'; } // 固有名詞と判定された用語の集合

	/**
	 * ノート本文を解析してトレンドインデックスに反映する（非同期ワーカーから fire-and-forget で呼ぶ）。
	 * 対象は public/home の本文ありオリジナルノートのみ（呼び出し側で絞る）。
	 */
	@bindThis
	public async indexNote(note: MiNote, at: number = Date.now()): Promise<void> {
		if (note.text == null || note.text.length === 0) return;
		const fingerprint = note.text
			.replace(/https?:\/\/\S+/g, '')
			.replace(/@[\w.-]+(@[\w.-]+)?/g, '')
			.replace(/[0-9０-９]+/g, '0')
			.replace(/\s/g, '')
			.slice(0, TEMPLATE_FP_LEN);
		if (fingerprint.length >= TEMPLATE_FP_MIN_LEN) {
			const key = `hanami:trend:tmpl:${createHash('sha1').update(fingerprint).digest('hex')}`;
			const template = await this.redisClient.multi()
				.sadd(key, note.userId)
				.expire(key, TREND_TTL_SECONDS)
				.scard(key)
				.exec();
			if (Number(template?.[2]?.[1] ?? 0) >= TEMPLATE_MIN_AUTHORS) return;
		}

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
		// at: 通常は現在時刻。開発用の再生（hanami-seed-recent）では複製ノートの時刻で過去窓へ積む
		const w = Math.floor((at - trendEpoch) / TREND_WINDOW_MS);
		const now = at;

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
			if (added === 1) {
				pipe.zincrby(this.rankKey(w), 1, term);
				pipe.zincrby(this.hourlyRankKey(Math.floor(w / 4)), 1, term);
			}
			pipe.expire(this.hourlyRankKey(Math.floor(w / 4)), HOURLY_TTL_SECONDS, 'NX');
			pipe.expire(this.authorSetKey(w, term), TREND_TTL_SECONDS, 'NX');
			pipe.expire(this.rankKey(w), TREND_TTL_SECONDS, 'NX');
			// 直近72時間の実人数。同じ人の複数投稿は最新時刻で1件にまとめる。
			pipe.zadd(aKey, at, note.userId);
			pipe.zremrangebyscore(aKey, '-inf', `(${at - AUTHORS_WINDOW_MS}`);
			pipe.expire(aKey, TREND_TTL_SECONDS);
			// 固有名詞は専用集合に記録（一定割合の固有名詞確保に使う）
			if (proper) { pipe.sadd(this.properKey(), term); pipe.expire(this.properKey(), TREND_TTL_SECONDS); }
			const recentAuthorsKey = this.recentAuthorsKey(term);
			pipe.zadd(recentAuthorsKey, at, note.userId);
			pipe.zremrangebyscore(recentAuthorsKey, '-inf', `(${at - SOCIAL_WINDOW_MS}`);
			pipe.expire(recentAuthorsKey, RECENT_AUTHORS_TTL_SECONDS);
			// 用語→最近ノート（時間順、上限つき）
			pipe.zadd(nKey, now, note.id);
			pipe.zremrangebyrank(nKey, 0, -(NOTES_PER_TERM + 1));
			pipe.expire(nKey, TREND_TTL_SECONDS);
		}
		pipe.set(HOURLY_SINCE_KEY, String(Date.now()), 'NX');
		await pipe.exec();
	}

	@bindThis
	public async countRecentTermAuthors(terms: readonly string[], userIds: readonly string[], sinceMs: number): Promise<Map<string, number>> {
		const uniqueTerms = [...new Set(terms)];
		const uniqueUsers = [...new Set(userIds)];
		const counts = new Map(uniqueTerms.map(term => [term, 0]));
		if (uniqueTerms.length === 0 || uniqueUsers.length === 0) return counts;
		const pipe = this.redisClient.pipeline();
		for (const term of uniqueTerms) pipe.zmscore(this.recentAuthorsKey(term), ...uniqueUsers);
		const results = await pipe.exec();
		for (let i = 0; i < uniqueTerms.length; i++) {
			const scores = (results?.[i]?.[1] ?? []) as (string | null)[];
			counts.set(uniqueTerms[i], scores.filter(score => score != null && Number(score) >= sinceMs).length);
		}
		return counts;
	}

	/**
	 * 急上昇用語の候補。
	 * 一次: spike率（窓別 distinct-author 延べ数ベース）でふるい落とし。
	 * 二次: 直近スパンの実 distinct author / エンゲージ合算で floor をかけ、普段比で順位を決める。
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

		const spikeTerms = [...recentSum].filter(([, recent]) => recent >= TREND_RECENT_MIN_COUNT).map(([term]) => term);
		if (spikeTerms.length === 0) {
			await this.redisClient.set(TRENDING_TERMS_CACHE_KEY, '[]', 'EX', TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS);
			return [];
		}
		const now = Date.now();
		const [properFlags, hourlySince] = await Promise.all([
			this.redisClient.smismember(this.properKey(), ...spikeTerms),
			this.redisClient.get(HOURLY_SINCE_KEY),
		]);
		const weekReady = hourlySince != null && Number.isFinite(Number(hourlySince)) && now - Number(hourlySince) >= WEEK_READY_MS;
		const spanSize = TREND_RECENT_WINDOW_COUNT + 2 * BASELINE_PAD;
		const basePipe = this.redisClient.pipeline();
		for (const lag of [96, 192]) {
			for (let w = cw - lag - TREND_RECENT_WINDOW_COUNT + 1 - BASELINE_PAD; w <= cw - lag + BASELINE_PAD; w++) {
				basePipe.zmscore(this.rankKey(w), ...spikeTerms);
			}
		}
		const weekStart = Math.floor((cw - 672 - TREND_RECENT_WINDOW_COUNT + 1 - BASELINE_PAD) / 4);
		const weekEnd = Math.floor((cw - 672 + BASELINE_PAD) / 4);
		for (let h = weekStart; h <= weekEnd; h++) basePipe.zmscore(this.hourlyRankKey(h), ...spikeTerms);
		const baseRes = await basePipe.exec();
		const baselineWindows = TREND_WINDOW_COUNT - TREND_RECENT_WINDOW_COUNT;
		const bases = new Map<string, TrendBase>();
		const properTerms = new Set(spikeTerms.filter((_, i) => Number(properFlags[i]) === 1));
		const spikes: [string, number][] = spikeTerms.map((term, index) => {
			let daySum = 0;
			let weekSum = 0;
			for (let i = 0; i < 2 * spanSize + weekEnd - weekStart + 1; i++) {
				const values = baseRes?.[i]?.[1] as (string | null)[] | undefined;
				const value = Number(values?.[index] ?? 0);
				if (i < 2 * spanSize) daySum += value;
				else weekSum += value;
			}
			const dayBase = daySum / (2 * spanSize);
			const weekRate = weekSum / (4 * (weekEnd - weekStart + 1));
			const proper = properTerms.has(term);
			const base = proper ? (baselineSum.get(term) ?? 0) / baselineWindows : weekReady ? Math.max(dayBase, weekRate) : dayBase;
			bases.set(term, { base, baseKind: proper ? 'avg70' : weekReady ? 'dayWeek' : 'day' });
			return [term, (recentSum.get(term)! / TREND_RECENT_WINDOW_COUNT) / (base + SPIKE_EPS)];
		});

		// 二次評価: spike 上位ごとに 全窓distinct / 直近スパンdistinct（SUNION） / 直近ノートID を一括取得。
		const candidates = spikes.sort((a, b) => b[1] - a[1]).slice(0, TREND_CANDIDATE_LIMIT);
		const recentNotesSince = now - TREND_RECENT_SPAN_MS;
		const evalPipe = this.redisClient.pipeline();
		for (const [term] of candidates) {
			evalPipe.zcount(this.authorsKey(term), now - AUTHORS_WINDOW_MS, '+inf');
			evalPipe.sunion(...Array.from({ length: TREND_RECENT_WINDOW_COUNT }, (_, i) => this.authorSetKey(cw - i, term)));
			evalPipe.zrangebyscore(this.notesKey(term), recentNotesSince, '+inf');
		}
		const [evalRes, globalScores] = await Promise.all([
			evalPipe.exec(),
			featuredScores ?? this.featuredService.getGlobalNotesScoresWithCache(),
		]);

		type EvaluatedTerm = TrendingTerm & TrendBase & {
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
			if (spike < TREND_MIN_SPIKE) rejected = 'lowSpike';
			else if (distinctAuthors < MIN_DISTINCT_AUTHORS) rejected = 'fewTotalAuthors'; // 全窓で distinct author が少ない（1アカウント捏造）
			else if (recentAuthors.length < TREND_RECENT_MIN_DISTINCT_AUTHORS) rejected = 'fewRecentAuthors'; // 窓を跨ぐ独り言/空リプ
			else if (recentEngagement < TREND_MIN_RECENT_ENGAGEMENT) rejected = 'noEngagement'; // 誰にも反応されない謎単語

			evaluated.push({
				term,
				// 普段比を優先し、反応数は同率の語の順序にだけ使う。
				score: spike,
				distinctAuthors,
				spike,
				...bases.get(term)!,
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
			.sort((a, b) => b.spike - a.spike || b.recentEngagement - a.recentEngagement || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
			.map(e => ({ term: e.term, score: e.score, distinctAuthors: e.distinctAuthors }));

		const terms = out.map(o => ({ ...o, proper: properTerms.has(o.term) }));

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
	private async logTrendSnapshot(at: number, evaluated: (TrendBase & { term: string; spike: number; score: number; recentCount: number; recentDistinctAuthors: number; recentEngagement: number; distinctAuthors: number; rejected: string | null })[]): Promise<void> {
		if (evaluated.length === 0) return;
		const top = evaluated.slice(0, TREND_LOG_CANDIDATE_LIMIT).map(e => ({
			term: e.term,
			base: e.base,
			baseKind: e.baseKind,
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
		return out.filter(term => used.has(term.term)).map(this.asTrendingTerm);
	}

	/**
	 * 急上昇用語。普段比で並べ、distinct author / エンゲージ floor で足切り済み。
	 */
	@bindThis
	public async getTrendingTerms(limit: number): Promise<TrendingTerm[]> {
		const out = await this.getTrendingTermCandidatesWithCache();
		return this.selectTrendingTerms(out, limit);
	}

	private async rankNotesForTerms(terms: readonly TrendingTerm[], globalScores: ReadonlyMap<string, number>, now: number): Promise<Map<string, RankedTrendNote[]>> {
		if (terms.length === 0) return new Map();

		const pipe = this.redisClient.pipeline();
		for (const term of terms) pipe.zrange(this.notesKey(term.term), 0, TREND_NOTES_PER_TERM_FETCH - 1, 'REV', 'WITHSCORES');
		const res = await pipe.exec();

		const out = new Map<string, RankedTrendNote[]>();
		for (let i = 0; i < terms.length; i++) {
			const raw = (res?.[i]?.[1] ?? []) as string[];
			const items: RankedTrendNote[] = [];
			for (let j = 0; j < raw.length; j += 2) {
				const noteId = raw[j];
				const postedAt = Number(raw[j + 1]);
				const engagement = globalScores.get(noteId) ?? 0;
				if (noteId.length === 0 || !Number.isFinite(postedAt) || !Number.isFinite(engagement)) continue;
				if (engagement < TREND_NOTE_MIN_ENGAGEMENT) continue;
				const freshness = Math.pow(0.5, Math.max(0, now - postedAt) / TREND_NOTE_FRESHNESS_HALF_LIFE_MS);
				items.push({ noteId, score: engagement * freshness, rank: j / 2 });
			}
			items.sort((a, b) => b.score - a.score || a.rank - b.rank);
			out.set(terms[i].term, items);
		}
		return out;
	}

	private async clusterTrendingTerms(candidates: readonly TrendingTermCandidate[], now: number): Promise<TrendCluster[]> {
		const input = candidates.slice(0, TREND_CLUSTER_INPUT_MAX);
		const singletons = () => input.map(head => ({ head, members: [head] }));
		if (input.length < 2) return singletons();
		try {
			const pipe = this.redisClient.pipeline();
			for (const term of input) {
				pipe.zrange(this.notesKey(term.term), now, now - TREND_CLUSTER_WINDOW_MS, 'BYSCORE', 'REV', 'LIMIT', 0, TREND_CLUSTER_NOTES_PER_TERM);
			}
			const results = await pipe.exec();
			if (results == null || results.some(([error]) => error != null)) throw new Error('Failed to read trend cluster notes');
			const notesByTerm = results.map(([, ids]) => [...new Set(ids as string[])]);
			const noteIds = [...new Set(notesByTerm.flat())];
			if (noteIds.length === 0) return singletons();
			const [rows, state] = await Promise.all([
				this.db.query<Array<{ noteId: string; embedding: number[] }>>(
					'SELECT "noteId", embedding FROM "hanami_note_embedding" WHERE model = $1 AND "noteId" = ANY($2)',
					[TASTE_EMBED_MODEL, noteIds],
				),
				this.db.query<Array<{ meanVec: number[] }>>(
					'SELECT "meanVec" FROM "hanami_foryou_taste_state" WHERE model = $1',
					[TASTE_EMBED_MODEL],
				),
			]);
			if (rows.length === 0) return singletons();
			const dimensions = rows[0].embedding.length;
			const validVector = (vector: number[]) => Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite);
			if (dimensions === 0 || rows.some(row => !validVector(row.embedding))) throw new Error('Invalid trend embedding');
			const mean = state[0]?.meanVec ?? Array.from({ length: dimensions }, (_, i) => rows.reduce((sum, row) => sum + row.embedding[i], 0) / rows.length);
			if (!validVector(mean)) throw new Error('Invalid trend embedding mean');
			const normalize = (vector: number[]): number[] | null => {
				const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
				if (!Number.isFinite(norm)) throw new Error('Invalid trend vector norm');
				return norm > 0 ? vector.map(value => value / norm) : null;
			};
			const normalizedNotes = new Map(rows.map(row => [row.noteId, normalize(row.embedding.map((value, i) => value - mean[i]))]));
			const vectors = new Map<string, number[]>();
			for (let index = 0; index < input.length; index++) {
				const notes = notesByTerm[index].map(id => normalizedNotes.get(id)).filter((vector): vector is number[] => vector != null);
				if (notes.length < 2) continue;
				const vector = normalize(Array.from({ length: dimensions }, (_, i) => notes.reduce((sum, note) => sum + note[i], 0) / notes.length));
				if (vector != null) vectors.set(input[index].term, vector);
			}
			const clusters: TrendCluster[] = [];
			for (const term of input) {
				const vector = vectors.get(term.term);
				let closest: TrendCluster | undefined;
				let bestCos = -Infinity;
				if (vector != null) {
					for (const cluster of clusters) {
						const head = vectors.get(cluster.head.term);
						if (head == null) continue;
						const cos = vector.reduce((sum, value, i) => sum + value * head[i], 0);
						if (cos >= TREND_CLUSTER_COS && cos > bestCos) { closest = cluster; bestCos = cos; }
					}
				}
				if (closest == null) clusters.push({ head: term, members: [term] });
				else closest.members.push(term);
			}
			for (const cluster of clusters) {
				if (cluster.members.length > 1) this.logger.info(`hanami trend cluster: ${cluster.head.term} <- ${cluster.members.slice(1).map(term => term.term).join(',')}`);
			}
			return clusters;
		} catch (error) {
			this.logger.warn('hanami trend cluster: failed; continuing without clustering', { error: String(error) });
			return singletons();
		}
	}

	/**
	 * 永続snapshotと共通trending候補を、同じ用語集計・Featured観測から一度に作る。
	 */
	@bindThis
	public async computeTrendBundle(featuredScores?: ReadonlyMap<string, number>): Promise<HanamiTrendComputationBundle> {
		const globalScores = featuredScores ?? await this.featuredService.getGlobalNotesScoresWithCache();
		const candidates = await this.getTrendingTermCandidatesWithCache(globalScores);
		const now = Date.now();
		const clusters = await this.clusterTrendingTerms(candidates, now);
		const heads = clusters.map(cluster => cluster.head);
		const snapshotTerms = this.selectTrendingTerms(heads, TREND_SNAPSHOT_TERM_MAX);
		const feedTerms = this.selectTrendingTerms(heads, TREND_FEED_TERM_MAX);
		const selectedHeads = new Set([...snapshotTerms, ...feedTerms].map(term => term.term));
		const selectedClusters = clusters.filter(cluster => selectedHeads.has(cluster.head.term));
		const rankedMembers = await this.rankNotesForTerms(selectedClusters.flatMap(cluster => cluster.members), globalScores, now);
		const rankedByTerm = new Map<string, string[]>();
		for (const cluster of selectedClusters) {
			const ranked = cluster.members.flatMap(term => rankedMembers.get(term.term) ?? []).sort((a, b) => b.score - a.score || a.rank - b.rank);
			rankedByTerm.set(cluster.head.term, [...new Set(ranked.map(note => note.noteId))]);
		}

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
