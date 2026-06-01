/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiNote } from '@/models/Note.js';
import { HanamiTokenizerService } from './tokenize/HanamiTokenizerService.js';

// トレンド窓: おすすめ(FeaturedService)と同じ 15分グリッド × 288枠(72時間) を線形減衰で合算する。
// 現窓“単独”だと毎窓境界でトレンドが消える崖が出るため、スライディング窓にする。
const TREND_WINDOW_MS = 1000 * 60 * 15; // 15分
const TREND_WINDOW_COUNT = 288; // 72時間分（おすすめと同じ窓数）を線形減衰合算
const TREND_TTL_EXTRA_WINDOW_COUNT = 8; // バッファ窓（= 2時間）
const TREND_TTL_SECONDS = Math.ceil((TREND_WINDOW_MS * (TREND_WINDOW_COUNT + TREND_TTL_EXTRA_WINDOW_COUNT)) / 1000);
// 1ノートから採用する最大 distinct 用語数（珍語爆発の最小対策）。
const MAX_TERMS_PER_NOTE = 16;
// 用語ごとに保持する最近ノート数。
const NOTES_PER_TERM = 200;
// トレンド用語として成立する最小 distinct author 数（操作耐性の near-free guard）。
const MIN_DISTINCT_AUTHORS = 2;
// getTrendingTerms で distinct author を数える候補上限（合算スコア上位だけ SCARD する）。
const TREND_CANDIDATE_LIMIT = 200;
// トレンド結果のうち固有名詞（人名/地名/組織/作品/製品名 等）に確保する最低割合。
// 普通名詞（値上げ/突破 等）にフィードが埋め尽くされるのを防ぎ、固有名詞の話題を一定数surfaceさせる。
const TREND_PROPER_NOUN_MIN_SHARE = 0.4;
const TRENDING_TERMS_CACHE_KEY = 'hanami:trend:terms';
const TRENDING_TERMS_CACHE_TTL_SECONDS = 60;
const TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS = 5;

const trendEpoch = new Date('2023-01-01T00:00:00Z').getTime();

export type TrendingTerm = { term: string; score: number; distinctAuthors: number };
type TrendingTermCandidate = TrendingTerm & { proper: boolean };

/**
 * 急上昇トレンド（[[hanami-tl-osusume-redesign]] step7/8）。
 *
 * - 本文のみを HanamiTokenizerService で解析（URL/タグ/絵文字/メディアは見ない）
 * - distinct author 数を窓ごとに数える（同一人物の連投で釣り上がらない）
 * - スコアは直近 TREND_WINDOW_COUNT 窓の線形減衰合算（おすすめと同じ窓数）。境界の崖を解消する
 * - 用語ごとの全窓横断 distinct author が MIN_DISTINCT_AUTHORS 未満なら採用しない（1アカウント捏造を弾く）
 *
 * インデックスは専用ワーカー想定の fire-and-forget で呼ぶ（リクエスト経路を遅らせない）。
 */
@Injectable()
export class HanamiTrendService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

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

		for (const { term, proper } of terms) {
			const asKey = this.authorSetKey(w, term);
			// distinct author を数える。新規 author のときだけランキングを加点。
			const added = await this.redisClient.sadd(asKey, note.userId);

			const nKey = this.notesKey(term);
			const aKey = this.authorsKey(term);
			const pipe = this.redisClient.pipeline();
			if (added === 1) pipe.zincrby(this.rankKey(w), 1, term);
			pipe.expire(asKey, TREND_TTL_SECONDS, 'NX');
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
			await pipe.exec();
		}
	}

	/**
	 * 急上昇用語。current/historical の近似スコアで並べ、distinct author floor で足切りする。
	 */
	@bindThis
	private async getTrendingTermCandidatesWithCache(): Promise<TrendingTermCandidate[]> {
		const cached = await this.redisClient.get(TRENDING_TERMS_CACHE_KEY);
		if (cached != null) {
			return JSON.parse(cached) as TrendingTermCandidate[];
		}

		const cw = this.currentWindow();

		// おすすめ(FeaturedService)と同じく直近 TREND_WINDOW_COUNT 窓を線形減衰で合算する。
		// 現窓が空でも前の窓が（ほぼ満重みで）効くので、窓境界でトレンドが消えない。
		const pipe = this.redisClient.pipeline();
		for (let i = 0; i < TREND_WINDOW_COUNT; i++) pipe.zrange(this.rankKey(cw - i), 0, 200, 'REV', 'WITHSCORES');
		const res = await pipe.exec();

		const summed = new Map<string, number>();
		for (let i = 0; i < TREND_WINDOW_COUNT; i++) {
			const raw = (res?.[i]?.[1] ?? []) as string[];
			if (raw.length === 0) continue;
			const weight = (TREND_WINDOW_COUNT - i) / TREND_WINDOW_COUNT; // 線形減衰（新しい窓ほど重い）
			for (let j = 0; j < raw.length; j += 2) {
				summed.set(raw[j], (summed.get(raw[j]) ?? 0) + parseFloat(raw[j + 1]) * weight);
			}
		}
		if (summed.size === 0) {
			await this.redisClient.set(TRENDING_TERMS_CACHE_KEY, '[]', 'EX', TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS);
			return [];
		}

		// 合算スコア上位を候補にして、用語ごとの全窓横断 distinct author で足切り（1アカウントの連投を弾く）。
		const candidates = [...summed.entries()].sort((a, b) => b[1] - a[1]).slice(0, TREND_CANDIDATE_LIMIT);
		const cntPipe = this.redisClient.pipeline();
		for (const [term] of candidates) cntPipe.scard(this.authorsKey(term));
		const cntRes = await cntPipe.exec();

		const out: TrendingTerm[] = [];
		for (let i = 0; i < candidates.length; i++) {
			const distinctAuthors = Number(cntRes?.[i]?.[1] ?? 0);
			if (distinctAuthors < MIN_DISTINCT_AUTHORS) continue; // floor: 全窓で distinct author < 2 の語は除外
			out.push({ term: candidates[i][0], score: candidates[i][1], distinctAuthors });
		}
		out.sort((a, b) => b.score - a.score);

		const flags = out.length > 0 ? await this.redisClient.smismember(this.properKey(), ...out.map(o => o.term)) : [];
		const terms = out.map((o, i) => ({ ...o, proper: Number(flags[i]) === 1 }));

		await this.redisClient.set(
			TRENDING_TERMS_CACHE_KEY,
			JSON.stringify(terms),
			'EX',
			terms.length > 0 ? TRENDING_TERMS_CACHE_TTL_SECONDS : TRENDING_TERMS_EMPTY_CACHE_TTL_SECONDS);

		return terms;
	}

	@bindThis
	private asTrendingTerm(term: TrendingTermCandidate): TrendingTerm {
		return {
			term: term.term,
			score: term.score,
			distinctAuthors: term.distinctAuthors,
		};
	}

	/**
	 * 急上昇用語。current/historical の近似スコアで並べ、distinct author floor で足切りする。
	 */
	@bindThis
	public async getTrendingTerms(limit: number): Promise<TrendingTerm[]> {
		const out = await this.getTrendingTermCandidatesWithCache();
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
	 * 急上昇用語に紐づく最近ノートID。用語間でラウンドロビンして多様性を出す。
	 * 返り値は {noteId, term} 配列（term は理由表示に使える）。
	 */
	@bindThis
	public async getTrendingNoteIds(limit: number): Promise<{ noteId: string; term: string }[]> {
		const terms = await this.getTrendingTerms(8);
		if (terms.length === 0) return [];

		const pipe = this.redisClient.pipeline();
		for (const t of terms) pipe.zrange(this.notesKey(t.term), 0, 40, 'REV');
		const res = await pipe.exec();
		const perTerm = terms.map((t, i) => ({ term: t.term, ids: (res?.[i]?.[1] ?? []) as string[] }));

		const out: { noteId: string; term: string }[] = [];
		const seen = new Set<string>();
		let idx = 0;
		let progressed = true;
		while (out.length < limit && progressed) {
			progressed = false;
			for (const { term, ids } of perTerm) {
				const id = ids[idx];
				if (id == null) continue;
				progressed = true;
				if (seen.has(id)) continue;
				seen.add(id);
				out.push({ noteId: id, term });
				if (out.length >= limit) break;
			}
			idx++;
		}
		return out;
	}
}
