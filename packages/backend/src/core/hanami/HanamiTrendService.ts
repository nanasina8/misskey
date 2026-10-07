/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import Logger from '@/logger.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiNote } from '@/models/Note.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { IdService } from '@/core/IdService.js';
import { prepareHanamiPythonCommand, resolveHanamiTrendTopicsScript } from './HanamiPythonRuntime.js';
import { encodeFp16, TASTE_EMBED_MODEL } from './HanamiTasteClusterBatchService.js';
import { HanamiTokenizerService } from './tokenize/HanamiTokenizerService.js';

// トレンド窓: おすすめ(FeaturedService)と同じ 15分グリッド × 288枠(72時間)。
// 現窓“単独”だと毎窓境界でトレンドが消える崖が出るため、スライディング窓にする。
const TREND_WINDOW_MS = 1000 * 60 * 15; // 15分
const TREND_WINDOW_COUNT = 288; // 72時間分（= baseline を測る全期間）
const TREND_TTL_EXTRA_WINDOW_COUNT = 8; // バッファ窓（= 2時間）
const TREND_TTL_SECONDS = Math.ceil((TREND_WINDOW_MS * (TREND_WINDOW_COUNT + TREND_TTL_EXTRA_WINDOW_COUNT)) / 1000);
const AUTHORS_WINDOW_MS = 72 * 60 * 60 * 1000;
const TREND_MIN_SPIKE = 2;
const TREND_TOPIC_TERM_MAX = 150;
const TREND_STAY_WINDOW_COUNT = 24;
const TREND_STAY_MIN_SPIKE = 1.3;
const TREND_ACTIVE_KEY = 'hanami:trend:active';
const TREND_TOPIC_WINDOW_MS = 6 * 60 * 60 * 1000;
const TREND_TOPIC_NOTES_PER_TERM = 200;
const TREND_TOPIC_NOTES_MAX = 4000;
const TREND_EXPAND_COS = 0.6;
const TREND_EXPAND_MIN_SEEDS = 2;
const TREND_EXPAND_MIN_LENGTH = 15;
const TREND_EXPAND_MAX = 8000;
const TREND_EXPAND_CLEAN_PATTERN = String.raw`https?://\S+|@[\w.-]+(@[\w.-]+)?|:[a-zA-Z0-9_+-]+:|\$\[[^\]]*\]|#[^\s#]+|\s`;
const TAG_GAMES = new Set(['shindanmaker', 'fediqb', 'クイズメーカー', 'mewk', 'marshmallow', 'peing', 'odaibako']);

const SOCIAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_AUTHORS_TTL_SECONDS = 26 * 60 * 60;
const HOURLY_TTL_SECONDS = 8 * 24 * 60 * 60;
const HOURLY_SINCE_KEY = 'hanami:trend:hrank:since';
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
// 1ノートから採用する最大 distinct 用語数（珍語爆発の最小対策）。
const MAX_TERMS_PER_NOTE = 16;
// 用語ごとに保持する最近ノート数。
const NOTES_PER_TERM = 200;
// トレンド用語として成立する最小 distinct author 数（全窓横断・操作耐性の near-free guard）。
const MIN_DISTINCT_AUTHORS = 3;
// トレンド結果のうち固有名詞（人名/地名/組織/作品/製品名 等）に確保する最低割合。
// 普通名詞（値上げ/突破 等）にフィードが埋め尽くされるのを防ぎ、固有名詞の話題を一定数surfaceさせる。
const TREND_PROPER_NOUN_MIN_SHARE = 0.4;
const TRENDING_TERMS_CACHE_KEY = 'hanami:trend:terms';
const TRENDING_TERMS_CACHE_TTL_SECONDS = 60;
const TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS = 5;

// 注入候補ノートの選定（getTrendingNoteIds）:
// 「用語を含む最新ノートを機械的に」ではなく、エンゲージ×新しさのハイブリッド順にする。
const TREND_NOTE_FRESHNESS_HALF_LIFE_MS = 1000 * 60 * 60 * 12; // 鮮度半減期 12h
const TREND_NOTES_RESULT_MAX = 200;
const TREND_SNAPSHOT_TERM_MAX = 30;
const TREND_FEED_NOTES_PER_TOPIC = 20;
const TREND_REPRESENTATIVE_NOTE_MAX = 20;
const TREND_TOPIC_PREV_KEY = 'hanami:trend:topics:prev';
const execFileAsync = promisify(execFile);
const TRENDING_NOTES_CACHE_KEY = 'hanami:trend:noteIds';
const TRENDING_NOTES_CACHE_TTL_SECONDS = 30 * 60;

// 効果測定スナップショット: 候補用語の判定材料を再計算ごとに1エントリで Redis Stream に残す。
// 閾値（floor/集中度ガード）の調整は当て勘でなくこのログで行う。
const TREND_LOG_STREAM_KEY = 'hanami:trend:log';
const TREND_LOG_STREAM_MAXLEN = 2000;
const TREND_LOG_CANDIDATE_LIMIT = 50;

const trendEpoch = new Date('2023-01-01T00:00:00Z').getTime();

export type TrendingTerm = { term: string; score: number; distinctAuthors: number };
type TrendBase = { base: number; baseKind: 'avg72' | 'median7'; baseDays: number };
type TrendingTermCandidate = TrendingTerm & { proper: boolean };
export type HanamiTrendTopicFields = {
	readonly topicId?: string | null;
	readonly relatedTerms?: readonly string[];
	readonly startedAt?: string | null;
	readonly daily?: boolean;
	readonly recentAuthors?: number;
	readonly topicNoteIds?: readonly string[];
};
type TopicNote = { id: string; userId: string; replyId: string | null; renoteId: string | null; text: string | null; tags?: string[]; createdAt: number; terms: string[]; embeddingIndex: number | null; source?: 'seed' | 'link' | 'embedding'; embeddingCandidate?: boolean };
type RawTopic = { terms: string[]; noteIds: string[]; authors6h: number; authors2h: number; center: number[] | null };
type Topic = RawTopic & { topicId: string; startedAt: string; daily: boolean; dailyJudged?: boolean; tagGame?: boolean };
export type HanamiTrendPreviousTopics = { computedAt: number; topics: Omit<Topic, 'center'>[] };
type TrendNoteCandidate = { noteId: string; term: string };
type TrendNoteCache = { computedAt: number; candidates: TrendNoteCandidate[] };
const SAVE_COMPUTED_CACHE = `
local previous = redis.call('GET', KEYS[1])
if previous then
  local decoded = cjson.decode(previous)
  if decoded.computedAt and decoded.computedAt >= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;
export function trendDailyKey(id: string): string { return `hanami:trend:llm:daily:${id}`; }
export function trendSameKey(a: string, b: string): string { return `hanami:trend:llm:same:${[a, b].sort().join(':')}`; }
export function trendSameSetKey(id: string): string { return `hanami:trend:llm:sameset:${id}`; }

export function trendTopicTagGame(members: readonly { tags?: readonly string[] }[]): boolean {
	const counts = new Map<string, number>();
	for (const note of members) for (const tag of new Set(note.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	const max = [...counts.values()].reduce((max, count) => Math.max(max, count), 0);
	return members.length > 0 && max / members.length >= 0.6 && [...counts].some(([tag, count]) => count === max
		&& (TAG_GAMES.has(tag) || (tag.match(/\p{Script=Hiragana}/gu)?.length ?? 0) >= 3));
}

export type HanamiTrendComputationBundle = {
	readonly computedAt: string;
	readonly terms: readonly (TrendingTerm & HanamiTrendTopicFields & {
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
 * - 本文を HanamiTokenizerService で解析し、正規化済みハッシュタグも語として数える
 * - distinct author 数を窓ごとに数える（同一人物の連投で釣り上がらない）
 * - 一次スコアは spike率（普段比の増加率）。recent=直近 R 窓のレート ÷ baseline=過去7日の同時刻の中央値。
 *   定番語/毎日同じ自動投稿は baseline が高く spike しない＝上位から消える
 * - 直近スパンの実 distinct author（独り言/空リプの窓跨ぎを1人と数える）を下限にする
 * - 前回の語は6時間の普段比で保持し、返信・URL・埋め込みから投稿単位の話題を作る
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

		@Optional()
		private idService?: IdService,
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
		const tagged = (note.tags ?? []).map(tag => ({ term: `#${tag}`, proper: true }));

		// 1ノート内では distinct 用語のみ（連呼で釣り上げない）。固有名詞フラグを保持。
		const seen = new Set<string>();
		const terms: { term: string; proper: boolean }[] = [];
		for (const tk of [...tagged, ...tokens]) {
			if (seen.has(tk.term)) continue;
			seen.add(tk.term);
			terms.push(tk);
			if (terms.length >= MAX_TERMS_PER_NOTE) break;
		}
		if (terms.length === 0) return;
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
	 * 二次: 直近スパンの実 distinct author で下限をかけ、普段比で順位を決める。
	 */
	@bindThis
	private async getTrendingTermCandidatesWithCache(featuredScores?: ReadonlyMap<string, number>): Promise<TrendingTermCandidate[]> {
		const cached = await this.redisClient.get(TRENDING_TERMS_CACHE_KEY);
		if (cached != null) {
			return JSON.parse(cached) as TrendingTermCandidate[];
		}

		const cw = this.currentWindow();
		const now = Date.now();
		const active = new Set(await this.redisClient.smembers(TREND_ACTIVE_KEY));
		const pipe = this.redisClient.pipeline();
		for (let i = 0; i < TREND_WINDOW_COUNT; i++) pipe.zrange(this.rankKey(cw - i), 0, 200, 'REV', 'WITHSCORES');
		const res = await pipe.exec();
		const sums = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
		for (let i = 0; i < TREND_WINDOW_COUNT; i++) {
			const raw = (res?.[i]?.[1] ?? []) as string[];
			for (let j = 0; j < raw.length; j += 2) {
				const term = raw[j];
				const value = Number(raw[j + 1]);
				if (i < TREND_RECENT_WINDOW_COUNT) sums[0].set(term, (sums[0].get(term) ?? 0) + value);
				else sums[2].set(term, (sums[2].get(term) ?? 0) + value);
				if (i < TREND_STAY_WINDOW_COUNT) sums[1].set(term, (sums[1].get(term) ?? 0) + value);
			}
		}
		const missingPipe = this.redisClient.pipeline();
		const missingWindows: { window: number; terms: string[] }[] = [];
		for (let i = 0; i < TREND_STAY_WINDOW_COUNT; i++) {
			const raw = (res?.[i]?.[1] ?? []) as string[];
			const present = new Set(raw.filter((_, index) => index % 2 === 0));
			const missing = [...active].filter(term => !present.has(term));
			if (missing.length === 0) continue;
			missingPipe.zmscore(this.rankKey(cw - i), ...missing);
			missingWindows.push({ window: i, terms: missing });
		}
		const missingResults = await missingPipe.exec();
		missingWindows.forEach(({ window, terms }, index) => {
			const counts = (missingResults?.[index]?.[1] ?? []) as (string | null)[];
			terms.forEach((term, j) => {
				const count = Number(counts[j] ?? 0);
				if (window < TREND_RECENT_WINDOW_COUNT) sums[0].set(term, (sums[0].get(term) ?? 0) + count);
				else sums[2].set(term, (sums[2].get(term) ?? 0) + count);
				sums[1].set(term, (sums[1].get(term) ?? 0) + count);
			});
		});
		const spikeTerms = [...new Set([...sums[0].entries()].filter(([, count]) => count >= TREND_RECENT_MIN_COUNT).map(([term]) => term).concat([...active]))];
		const hourlySince = await this.redisClient.get(HOURLY_SINCE_KEY);
		const since = hourlySince == null ? Infinity : Number(hourlySince);
		const basePipe = this.redisClient.pipeline();
		let baseOffset = 0;
		const spans = [TREND_RECENT_WINDOW_COUNT, TREND_STAY_WINDOW_COUNT].map(count => {
			const days: { offset: number; hours: number }[] = [];
			for (let d = 1; d <= 7; d++) {
				const startWindow = cw - d * 96 - count + 1 - BASELINE_PAD;
				const start = Math.floor(startWindow / 4);
				if (!Number.isFinite(since) || trendEpoch + start * 4 * TREND_WINDOW_MS < since) continue;
				const end = Math.floor((cw - d * 96 + BASELINE_PAD) / 4);
				days.push({ offset: baseOffset, hours: end - start + 1 });
				for (let h = start; h <= end; h++) {
					if (spikeTerms.length > 0) basePipe.zmscore(this.hourlyRankKey(h), ...spikeTerms);
					baseOffset++;
				}
			}
			return days;
		});
		const baseRes = await basePipe.exec();
		const baseline = (index: number, span: number): TrendBase => {
			const days = spans[span];
			const term = spikeTerms[index];
			if (days.length === 0) return { base: ((sums[2].get(term) ?? 0) + (sums[0].get(term) ?? 0) - (sums[span].get(term) ?? 0)) / (TREND_WINDOW_COUNT - (span === 0 ? TREND_RECENT_WINDOW_COUNT : TREND_STAY_WINDOW_COUNT)), baseKind: 'avg72', baseDays: 0 };
			const rates = days.map(day => {
				let total = 0;
				for (let i = 0; i < day.hours; i++) total += Number((baseRes?.[day.offset + i]?.[1] as (string | null)[] | undefined)?.[index] ?? 0);
				return total / (4 * day.hours);
			}).sort((a, b) => a - b);
			const middle = Math.floor(rates.length / 2);
			return { base: rates.length % 2 ? rates[middle] : (rates[middle - 1] + rates[middle]) / 2, baseKind: 'median7', baseDays: days.length };
		};
		const evalPipe = this.redisClient.pipeline();
		for (const term of spikeTerms) {
			evalPipe.zcount(this.authorsKey(term), now - AUTHORS_WINDOW_MS, '+inf');
			evalPipe.sunion(...Array.from({ length: TREND_RECENT_WINDOW_COUNT }, (_, i) => this.authorSetKey(cw - i, term)));
			evalPipe.zrangebyscore(this.notesKey(term), now - TREND_RECENT_SPAN_MS, '+inf');
		}
		const [evalRes, globalScores, properFlags] = await Promise.all([
			evalPipe.exec(),
			featuredScores ?? this.featuredService.getGlobalNotesScoresWithCache(),
			spikeTerms.length > 0 ? this.redisClient.smismember(this.properKey(), ...spikeTerms) : [],
		]);
		const evaluated = spikeTerms.map((term, i) => {
			const base = baseline(i, 0);
			const base6h = baseline(i, 1);
			const recentCount = sums[0].get(term) ?? 0;
			const spike = (recentCount / TREND_RECENT_WINDOW_COUNT) / (base.base + SPIKE_EPS);
			const spike6h = ((sums[1].get(term) ?? 0) / TREND_STAY_WINDOW_COUNT) / (base6h.base + SPIKE_EPS);
			const distinctAuthors = Number(evalRes?.[i * 3]?.[1] ?? 0);
			const recentAuthors = (evalRes?.[i * 3 + 1]?.[1] ?? []) as string[];
			const noteIds = (evalRes?.[i * 3 + 2]?.[1] ?? []) as string[];
			const enters = spike >= TREND_MIN_SPIKE && recentCount >= TREND_RECENT_MIN_COUNT && recentAuthors.length >= TREND_RECENT_MIN_DISTINCT_AUTHORS && distinctAuthors >= MIN_DISTINCT_AUTHORS;
			return {
				term, ...base, spike, spike6h, stay: false, enters, distinctAuthors,
				score: Math.max(spike, spike6h), recentCount, recentDistinctAuthors: recentAuthors.length,
				recentEngagement: noteIds.reduce((sum, id) => sum + (globalScores.get(id) ?? 0), 0),
				rejected: enters ? null : distinctAuthors < MIN_DISTINCT_AUTHORS ? 'fewTotalAuthors' : spike < TREND_MIN_SPIKE ? 'lowSpike' : 'fewRecentAuthors',
				proper: Number(properFlags[i]) === 1,
			};
		});
		const staying = evaluated.filter(term => !term.enters && active.has(term.term));
		const stayPipe = this.redisClient.pipeline();
		for (const term of staying) stayPipe.sunion(...Array.from({ length: TREND_STAY_WINDOW_COUNT }, (_, i) => this.authorSetKey(cw - i, term.term)));
		const stayResults = await stayPipe.exec();
		staying.forEach((term, i) => {
			const authors = (stayResults?.[i]?.[1] ?? []) as string[];
			term.stay = term.spike6h >= TREND_STAY_MIN_SPIKE && authors.length >= MIN_DISTINCT_AUTHORS && term.distinctAuthors >= MIN_DISTINCT_AUTHORS;
			if (term.stay) term.rejected = null;
		});
		evaluated.sort((a, b) => b.score - a.score || b.recentEngagement - a.recentEngagement || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
		await this.logTrendSnapshot(now, evaluated).catch(error => this.logger.warn('hanami trend: snapshot log failed', { error: String(error) }));
		const terms = evaluated.filter(e => e.rejected == null)
			.slice(0, TREND_TOPIC_TERM_MAX)
			.map(e => ({ term: e.term, score: e.score, distinctAuthors: e.distinctAuthors, proper: e.proper }));
		const activePipe = this.redisClient.multi().del(TREND_ACTIVE_KEY);
		if (terms.length > 0) activePipe.sadd(TREND_ACTIVE_KEY, ...terms.map(term => term.term)).expire(TREND_ACTIVE_KEY, 3600);
		await activePipe.exec();

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
	private async logTrendSnapshot(at: number, evaluated: (TrendBase & { term: string; spike: number; spike6h: number; stay: boolean; score: number; recentCount: number; recentDistinctAuthors: number; recentEngagement: number; distinctAuthors: number; rejected: string | null })[]): Promise<void> {
		if (evaluated.length === 0) return;
		const top = evaluated.slice(0, TREND_LOG_CANDIDATE_LIMIT).map(e => ({
			term: e.term,
			base: e.base,
			baseKind: e.baseKind,
			baseDays: e.baseDays,
			stay: e.stay,
			spike6h: e.spike6h,
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
	 * 急上昇用語。普段比で並べ、distinct author の下限を満たすもの。
	 */
	@bindThis
	public async getTrendingTerms(limit: number): Promise<TrendingTerm[]> {
		const out = await this.getTrendingTermCandidatesWithCache();
		return this.selectTrendingTerms(out, limit);
	}

	private async collectTopicInput(candidates: readonly TrendingTermCandidate[], now: number): Promise<{ notes: TopicNote[]; parents: TopicNote[] }> {
		const pipe = this.redisClient.pipeline();
		for (const term of candidates) pipe.zrange(this.notesKey(term.term), now, now - TREND_TOPIC_WINDOW_MS, 'BYSCORE', 'REV', 'LIMIT', 0, TREND_TOPIC_NOTES_PER_TERM, 'WITHSCORES');
		const results = await pipe.exec();
		if (results == null || results.some(([error]) => error != null)) throw new Error('Failed to read trend topic notes');
		const indexed = new Map<string, { at: number; terms: string[] }>();
		results.forEach(([, result], i) => {
			const raw = result as string[];
			for (let j = 0; j < raw.length; j += 2) {
				const item = indexed.get(raw[j]) ?? { at: Number(raw[j + 1]), terms: [] };
				item.terms.push(candidates[i].term);
				indexed.set(raw[j], item);
			}
		});
		const ids = [...indexed].sort((a, b) => b[1].at - a[1].at).slice(0, TREND_TOPIC_NOTES_MAX).map(([id]) => id);
		if (ids.length === 0) return { notes: [], parents: [] };
		type Row = Pick<TopicNote, 'id' | 'userId' | 'replyId' | 'renoteId' | 'text' | 'tags'>;
		const rows = await this.db.query<Row[]>(`SELECT n.id, n."userId", n."replyId", n."renoteId", n.text, n.tags FROM note n
			JOIN "user" author ON author.id = n."userId"
			WHERE n.id = ANY($1::varchar[]) AND n.visibility IN ('public', 'home') AND n."channelId" IS NULL AND NOT author."isBot"`, [ids]);
		const byId = new Map(rows.map(row => [row.id, row]));
		const notes: TopicNote[] = ids.flatMap(id => {
			const row = byId.get(id);
			return row == null ? [] : [{ ...row, createdAt: this.idService?.parse(id).date.getTime() ?? indexed.get(id)!.at, terms: indexed.get(id)!.terms, embeddingIndex: null, source: 'seed' as const }];
		});
		if (notes.length > 0 && this.idService != null) {
			const bounds = [this.idService.gen(now - TREND_TOPIC_WINDOW_MS), this.idService.gen(now), notes.map(note => note.id)];
			const eligible = `n.id >= $1 AND n.id <= $2 AND n.visibility IN ('public', 'home')
				AND n."channelId" IS NULL AND NOT author."isBot" AND NOT (n.id = ANY($3::varchar[]))`;
			const [linked, embedded] = await Promise.all([
				this.db.query<Row[]>(`SELECT n.id, n."userId", n."replyId", n."renoteId", n.text, n.tags FROM "note" n
					JOIN "user" author ON author.id = n."userId" WHERE ${eligible}
					AND (n."replyId" = ANY($3::varchar[]) OR (n."renoteId" = ANY($3::varchar[]) AND n.text IS NOT NULL AND n.text <> ''))`, bounds),
				this.db.query<Row[]>(`SELECT n.id, n."userId", n."replyId", n."renoteId", n.text, n.tags FROM "note" n
					JOIN "user" author ON author.id = n."userId" WHERE ${eligible}
					AND EXISTS (SELECT 1 FROM "hanami_note_embedding" embedding WHERE embedding."noteId" = n.id AND embedding.model = $4)
					AND char_length(regexp_replace(COALESCE(n.text, ''), $5, '', 'g')) >= $6
					ORDER BY n.id DESC LIMIT $7`, [...bounds, TASTE_EMBED_MODEL, TREND_EXPAND_CLEAN_PATTERN, TREND_EXPAND_MIN_LENGTH, TREND_EXPAND_MAX]),
			]);
			const extra = new Map<string, TopicNote>();
			for (const row of linked) extra.set(row.id, { ...row, createdAt: this.idService.parse(row.id).date.getTime(), terms: [], embeddingIndex: null, source: 'link' });
			for (const row of embedded) extra.set(row.id, { ...extra.get(row.id), ...row, createdAt: this.idService.parse(row.id).date.getTime(), terms: [], embeddingIndex: null, source: extra.has(row.id) ? 'link' : 'embedding', embeddingCandidate: true });
			notes.push(...extra.values());
		}
		const parentIds = [...new Set(notes.flatMap(note => [note.replyId, note.text ? note.renoteId : null]).filter((id): id is string => id != null))];
		const parents = parentIds.length === 0 ? [] : await this.db.query<Row[]>('SELECT id, "userId", "replyId", "renoteId", text FROM note WHERE id = ANY($1::varchar[])', [parentIds]);
		return { notes, parents: parents.map(row => ({ ...row, createdAt: 0, terms: [], embeddingIndex: null })) };
	}

	private async buildTopics(candidates: readonly TrendingTermCandidate[], notes: TopicNote[], parents: TopicNote[], now: number): Promise<RawTopic[]> {
		if (notes.length === 0) return [];
		let dir: string | null = null;
		try {
			const [rows, state] = await Promise.all([
				this.db.query<Array<{ noteId: string; embedding: number[] }>>('SELECT "noteId", embedding FROM "hanami_note_embedding" WHERE model = $1 AND "noteId" = ANY($2)', [TASTE_EMBED_MODEL, notes.filter(note => note.source !== 'link' || note.embeddingCandidate).map(note => note.id)]),
				this.db.query<Array<{ meanVec: number[] }>>('SELECT "meanVec" FROM "hanami_foryou_taste_state" WHERE model = $1', [TASTE_EMBED_MODEL]),
			]);
			const dim = rows[0]?.embedding.length ?? 0;
			if ((rows.length > 0 && dim === 0) || rows.some(row => row.embedding.length !== dim || !row.embedding.every(Number.isFinite))) throw new Error('Invalid trend embedding');
			const meanVec = state[0]?.meanVec ?? null;
			if (dim > 0 && meanVec != null && (meanVec.length !== dim || !meanVec.every(Number.isFinite))) throw new Error('Invalid trend embedding mean');
			const indices = new Map(rows.map((row, i) => [row.noteId, i]));
			for (const note of notes) note.embeddingIndex = indices.get(note.id) ?? null;
			dir = await mkdtemp(join(tmpdir(), 'hanami-trend-topics-'));
			await writeFile(join(dir, 'input.json'), JSON.stringify({
				now, dim, meanVec, notes, parents, terms: candidates,
				constants: { k: 5, cos: 0.5, resolution: 0.3, share: 0.35, minTermAuthors: 2, minTopicAuthors: 3,
					expandCos: TREND_EXPAND_COS, expandMinSeeds: TREND_EXPAND_MIN_SEEDS, expandMinLength: TREND_EXPAND_MIN_LENGTH, expandMax: TREND_EXPAND_MAX },
			}));
			await writeFile(join(dir, 'embeddings.bin'), Buffer.concat(rows.map(row => encodeFp16(row.embedding))));
			const command = prepareHanamiPythonCommand([resolveHanamiTrendTopicsScript(), join(dir, 'input.json'), join(dir, 'embeddings.bin'), join(dir, 'output.json')]);
			await execFileAsync(command.file, command.args, { env: command.env, timeout: 15000, maxBuffer: 1024 * 1024 });
			const output = JSON.parse(await readFile(join(dir, 'output.json'), 'utf8')) as { topics: RawTopic[] };
			const validIds = new Set(notes.map(note => note.id));
			const validTerms = new Set(candidates.map(term => term.term));
			if (!Array.isArray(output.topics) || output.topics.some(topic => !Array.isArray(topic.terms) || topic.terms.length === 0 || topic.terms.some(term => !validTerms.has(term)) || !Array.isArray(topic.noteIds) || topic.noteIds.some(id => !validIds.has(id)))) throw new Error('Invalid trend topics output');
			return output.topics;
		} catch (error) {
			this.logger.warn('hanami trend topics: failed; continuing with one topic per term', { error: String(error) });
			return candidates.map(candidate => {
				const members = notes.filter(note => note.terms.includes(candidate.term));
				return { terms: [candidate.term], noteIds: members.map(note => note.id), authors6h: new Set(members.map(note => note.userId)).size, authors2h: new Set(members.filter(note => note.createdAt >= now - TREND_RECENT_SPAN_MS).map(note => note.userId)).size, center: null };
			}).filter(topic => topic.authors6h >= MIN_DISTINCT_AUTHORS);
		} finally {
			if (dir != null) await rm(dir, { recursive: true, force: true });
		}
	}

	private assignTopicIds(raw: readonly RawTopic[], previous: readonly Omit<Topic, 'center'>[], now: number): Topic[] {
		const matches = raw.map((topic, index) => previous.map((prev, prevIndex) => {
			const ids = new Set(prev.noteIds);
			const intersection = topic.noteIds.filter(id => ids.has(id)).length;
			return { index, prevIndex, jaccard: intersection / Math.max(1, new Set([...topic.noteIds, ...prev.noteIds]).size) };
		}).sort((a, b) => b.jaccard - a.jaccard)[0]).filter((match): match is { index: number; prevIndex: number; jaccard: number } => match != null && match.jaccard >= 0.2)
			.sort((a, b) => b.jaccard - a.jaccard);
		const proposed = new Set(matches.map(match => match.index));
		const inherited = new Map<number, Omit<Topic, 'center'>>();
		const used = new Set<string>();
		for (const match of matches) {
			const prev = previous[match.prevIndex];
			if (inherited.has(match.index) || used.has(prev.topicId)) continue;
			inherited.set(match.index, prev); used.add(prev.topicId);
		}
		return raw.map((topic, index) => {
			let prev = inherited.get(index);
			if (prev == null && !proposed.has(index)) prev = previous.find(p => p.terms[0] === topic.terms[0] && !used.has(p.topicId));
			if (prev != null) used.add(prev.topicId);
			if (prev == null && this.idService == null) throw new Error('IdService is required to allocate trend topic IDs');
			return { ...topic, topicId: prev?.topicId ?? this.idService!.gen(), startedAt: prev?.startedAt ?? new Date(now).toISOString(), daily: false };
		});
	}

	private async applyTopicJudgements(topics: Topic[], notes: readonly TopicNote[], now: number): Promise<Topic[]> {
		const pipe = this.redisClient.pipeline();
		for (const topic of topics) pipe.smembers(trendSameSetKey(topic.topicId));
		const same = await pipe.exec();
		const indices = new Map(topics.map((topic, index) => [topic.topicId, index]));
		const pairs = new Map<string, readonly [number, number]>();
		for (let i = 0; i < topics.length; i++) {
			for (const partner of (same?.[i]?.[1] ?? []) as string[]) {
				const j = indices.get(partner);
				if (j == null || i === j) continue;
				pairs.set(trendSameKey(topics[i].topicId, partner), [i, j]);
			}
		}
		// Sets are only an index: expired or negative pair verdicts do not form edges.
		const verdicts = pairs.size === 0 ? [] : await this.redisClient.mget(...pairs.keys());
		const parents = topics.map((_, index) => index);
		const root = (index: number): number => {
			while (parents[index] !== index) {
				parents[index] = parents[parents[index]];
				index = parents[index];
			}
			return index;
		};
		[...pairs.values()].forEach(([a, b], index) => {
			if (verdicts[index] === '1') parents[root(b)] = root(a);
		});
		const components = new Map<number, Topic[]>();
		topics.forEach((topic, index) => {
			const key = root(index);
			const members = components.get(key) ?? [];
			members.push(topic); components.set(key, members);
		});
		return [...components.values()].map(component => {
			// Components retain the pre-merge ranking, which also breaks author-count ties.
			const keep = component.reduce((leader, topic) => topic.authors6h > leader.authors6h ? topic : leader);
			const ordered = [keep, ...component.filter(topic => topic !== keep)];
			const noteIds = [...new Set(ordered.flatMap(topic => topic.noteIds))];
			const ids = new Set(noteIds);
			const members = notes.filter(note => ids.has(note.id));
			return {
				...keep, noteIds, terms: [...new Set(ordered.flatMap(topic => topic.terms))],
				authors6h: new Set(members.map(note => note.userId)).size,
				authors2h: new Set(members.filter(note => note.createdAt >= now - TREND_RECENT_SPAN_MS).map(note => note.userId)).size,
			};
		});
	}

	/** Compute topic snapshots and the common candidate pool from one observation. */
	@bindThis
	public async computeTrendBundle(featuredScores?: ReadonlyMap<string, number>): Promise<HanamiTrendComputationBundle> {
		const now = Date.now();
		const globalScores = featuredScores ?? await this.featuredService.getGlobalNotesScoresWithCache();
		const candidates = await this.getTrendingTermCandidatesWithCache(globalScores);
		const { notes, parents } = await this.collectTopicInput(candidates, now);
		const raw = await this.buildTopics(candidates, notes, parents, now);
		const previousJson = await this.redisClient.get(TREND_TOPIC_PREV_KEY);
		const previous = previousJson == null ? [] : (JSON.parse(previousJson) as HanamiTrendPreviousTopics | Topic[]);
		const unmerged = this.assignTopicIds(raw, Array.isArray(previous) ? previous : previous.topics, now);
		const daily = unmerged.length === 0 ? [] : await this.redisClient.mget(...unmerged.map(topic => trendDailyKey(topic.topicId)));
		const byId = new Map(notes.map(note => [note.id, note]));
		const rankReason = (topic: Topic) => {
			topic.tagGame = trendTopicTagGame(topic.noteIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []));
			topic.daily = topic.dailyJudged === true || topic.tagGame;
		};
		unmerged.forEach((topic, i) => { topic.dailyJudged = daily[i] === '1'; rankReason(topic); });
		const scores = new Map(candidates.map(term => [term.term, term.score]));
		const score = (topic: Topic) => Math.max(...topic.terms.map(term => scores.get(term) ?? 0));
		const compare = (a: Topic, b: Topic) => b.authors2h * (b.daily ? 0.3 : 1) - a.authors2h * (a.daily ? 0.3 : 1) || b.authors6h - a.authors6h || score(b) - score(a);
		unmerged.sort(compare);
		const prev: HanamiTrendPreviousTopics = { computedAt: now, topics: unmerged.map(({ center: _center, ...topic }) => topic) };
		await this.redisClient.eval(SAVE_COMPUTED_CACHE, 1, TREND_TOPIC_PREV_KEY, now, JSON.stringify(prev), 3600);
		const topics = await this.applyTopicJudgements(unmerged, notes, now);
		topics.forEach(rankReason);
		const ranked = new Map(topics.map(topic => [topic.topicId, notes.filter(note => topic.noteIds.includes(note.id))
			.sort((a, b) => {
				const rank = (note: TopicNote) => (globalScores.get(note.id) ?? 0) * Math.pow(0.5, Math.max(0, now - note.createdAt) / TREND_NOTE_FRESHNESS_HALF_LIFE_MS);
				return rank(b) - rank(a) || b.createdAt - a.createdAt;
			}).map(note => note.id)]));
		const originals = new Map(topics.map(topic => [topic.topicId, ranked.get(topic.topicId)!.filter(id => byId.get(id)!.replyId == null)]));
		const visible = topics.filter(topic => (ranked.get(topic.topicId)?.length ?? 0) > 0)
			.sort(compare);
		const selected = visible.slice(0, TREND_SNAPSHOT_TERM_MAX);
		const terms = selected.map(topic => ({
			term: topic.terms[0], relatedTerms: topic.terms.slice(1, 6), score: score(topic), distinctAuthors: topic.authors6h,
			topicId: topic.topicId, startedAt: topic.startedAt, daily: topic.daily,
			recentAuthors: topic.authors2h,
			topicNoteIds: ranked.get(topic.topicId)!.slice(0, 500),
			representativeNoteIds: originals.get(topic.topicId)!.slice(0, TREND_REPRESENTATIVE_NOTE_MAX),
		}));
		const noteCandidates: { noteId: string; term: string }[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < TREND_FEED_NOTES_PER_TOPIC; i++) for (const topic of selected) {
			const noteId = originals.get(topic.topicId)?.[i];
			if (noteId == null || seen.has(noteId)) continue;
			seen.add(noteId); noteCandidates.push({ noteId, term: topic.terms[0] });
		}
		const noteCache: TrendNoteCache = { computedAt: now, candidates: noteCandidates };
		await this.redisClient.eval(SAVE_COMPUTED_CACHE, 1, TRENDING_NOTES_CACHE_KEY, now, JSON.stringify(noteCache), TRENDING_NOTES_CACHE_TTL_SECONDS);
		this.logger.info('hanami trend topics', { topics: selected.map(topic => ({ topicId: topic.topicId, terms: topic.terms, center: topic.center, authors2h: topic.authors2h, authors6h: topic.authors6h, daily: topic.daily,
			reasons: [...(topic.dailyJudged ? ['daily'] : []), ...(topic.tagGame ? ['tagGame'] : [])] })) });
		return { computedAt: new Date(now).toISOString(), terms, noteCandidates };
	}

	/**
	 * 急上昇用語に紐づく注入候補ノートID。用語間でラウンドロビンして多様性を出す。
	 * ノートは「時刻順」ではなく エンゲージ×鮮度 のハイブリッド順。
	 * 共通生成が保存した候補を読み、リクエスト経路では再計算しない。
	 * 返り値は {noteId, term} 配列（term は理由表示に使える）。
	 */
	@bindThis
	public async getTrendingNoteIds(limit: number): Promise<{ noteId: string; term: string }[]> {
		const legacyLimit = Math.max(0, Math.min(limit, TREND_NOTES_RESULT_MAX));
		const cached = await this.redisClient.get(TRENDING_NOTES_CACHE_KEY);
		if (cached != null) {
			const parsed = JSON.parse(cached) as TrendNoteCache | TrendNoteCandidate[];
			return (Array.isArray(parsed) ? parsed : parsed.candidates).slice(0, legacyLimit);
		}

		return [];
	}
}
