/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { pureRenoteSql } from '@/misc/is-renote.js';
import type Logger from '@/logger.js';
import { MiHanamiForYouRelation } from '@/models/HanamiForYouRelation.js';
import { MiHanamiForYouUserFactor } from '@/models/HanamiForYouUserFactor.js';
import { MiHanamiForYouAuthorFactor } from '@/models/HanamiForYouAuthorFactor.js';
import { MiHanamiForYouAuthorRec } from '@/models/HanamiForYouAuthorRec.js';
import { MiHanamiForYouNeighborUser } from '@/models/HanamiForYouNeighborUser.js';
import type { HanamiForYouModelRunsRepository } from '@/models/_.js';
import {
	HANAMI_EVENT_TTL_SERVED_SEEN_MS,
	HANAMI_EVENT_TTL_PERSONAL_MS,
} from './HanamiForYouKeys.js';
import { HANAMI_PYTHON_THREAD_ENV, prepareHanamiPythonCommand, resolveHanamiRepoRoot } from './HanamiPythonRuntime.js';

const execFileAsync = promisify(execFile);

// canonical spec §10 の初期値。重みは実データから引き直す使い捨て。
const RELATION_LOOKBACK_MS = 240 * 24 * 60 * 60 * 1000; // 関係値の集計窓（半減期120dに対し十分長く）
const RELATION_WEIGHT = { reaction: 1.0, reply: 2.5, renote: 1.5 } as const;
const RELATION_INBOUND_COEF = 0.8;
const RELATION_MUTUAL_COEF = 1.5;
const RELATION_INSERT_CHUNK = 1000;
const INTERACTION_ROLLUP_DAYS = 240;
const INTERACTION_ROLLUP_RECENT_DAYS = 7;
const INTERACTION_ROLLUP_LOCK = 'hanami_foryou_interaction_daily_refresh_v1';

// 相互RNペア検出（リング減衰）の集計窓
const RN_RING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// ALS（§10）。実行は Python（implicit/scipy）。本番に python3+venv 前提。
const ALS_FACTORS = 128;
const ALS_ITERATIONS = 25;
const ALS_BM25_K1 = 100;
const ALS_BM25_B = 0.8;
const ALS_TOP_AUTHOR_RECS = 150; // §14-D2
const ALS_TOP_NEIGHBORS = 150; // §14-D2
const ALS_REACTION_LOOKBACK_MS = 240 * 24 * 60 * 60 * 1000;
const ALS_MIN_USER_EVIDENCE = 5; // evidence が薄い user の factor は作らない（§7.3）
const ALS_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_RUN_KEEP = 2; // 直近2世代保持（§7.3）

// aux 集計（§5/§7.3/§10）。
const AUX_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

// MiniLM 埋め込み＋taste-centroid（§5/§7.4。CPU・増分・後段）。
const EMBEDDING_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2';
const EMBED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 候補窓（globalPopular/trending と同じ 3d）
const EMBED_NOTE_LIMIT = 2000; // 1 run あたりの増分上限
const CENTROID_TASTE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const CENTROID_TASTE_PER_USER = 200;
const CENTROID_MIN_EVIDENCE = 5; // evidence が薄いユーザの centroid は作らない（§7.3）
const CENTROID_USER_LIMIT = 2000;
const COLD_CENTROID_MAX_REACTIONS = 4;
const COLD_CENTROID_PER_SOURCE = 3;
const EMBEDDING_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const E5_SHADOW_MODEL = 'intfloat/multilingual-e5-small';
const E5_SHADOW_VERSION = 'multilingual-e5-small/query-prefix-v1';

type RelationAccumKey = string; // `${me}\t${other}`
type RelationAccum = { out: number; in: number };
type InteractionSignal = keyof typeof RELATION_WEIGHT;

function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
	const date = new Date(`${day}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return utcDay(date);
}

/** UTC日rollupのため、rolling境界はraw集計と最大1日ずれる。 */
export function hanamiRelationDecayForUtcDay(day: string, now: Date): number {
	const today = utcDay(now);
	if (day >= addUtcDays(today, -30)) return 0.9;
	if (day >= addUtcDays(today, -90)) return 0.65;
	if (day >= addUtcDays(today, -180)) return 0.45;
	return 0.28;
}

type AlsOutput = {
	userFactors: { userId: string; factor: number[]; evidenceCount: number }[];
	authorFactors: { authorId: string; factor: number[]; reactionCount: number }[];
	authorRecs: { userId: string; authorId: string; score: number; rank: number }[];
	neighbors: { userId: string; neighborUserId: string; score: number; rank: number }[];
};

/**
 * はなみ For You オフラインバッチ（canonical spec §3/§5/§7.3）。
 *
 * - **関係値（双方向）** = 純 SQL/TypeORM。reaction/reply/renote の out/in を集計→ log1p→ 相互ボーナス→ `hanami_foryou_relation` を全置換。
 * - **ALS 行列分解** = Python（`scripts/hanami-foryou/rec_als.py`）を child_process で実行。
 *   Node が run を作り行列を export → Python が factor/rec/neighbor を計算 → Node が取り込み ready swap。
 * - **event cleanup** = served/seen 14日・個人 180日（§7.2）。
 * - MiniLM 埋め込み / aux 集計は後段フェーズ（§5/§13-9,10）。
 *
 * 各ステップは独立 guard。1つ失敗しても他は走る。serve は status='ready' の最新 run だけを読む。
 */
@Injectable()
export class HanamiForYouBatchService {
	private interactionRollupReady = false;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.hanamiForYouModelRunsRepository)
		private hanamiForYouModelRunsRepository: HanamiForYouModelRunsRepository,

		private idService: IdService,
		private featuredService: FeaturedService,
	) {
	}

	// ───────────────────────── エントリポイント ─────────────────────────

	@bindThis
	public async runAll(logger: Logger): Promise<void> {
		try {
			this.interactionRollupReady = await this.refreshInteractionRollup();
			logger.succ(`hanami foryou: interaction daily rollup ${this.interactionRollupReady ? 'ready' : 'not ready; using raw fallback'}`);
		} catch (err) {
			this.interactionRollupReady = false;
			logger.warn(`hanami foryou: interaction daily rollup failed; using raw fallback: ${(err as Error).message}`);
		}

		// 関係値（純SQL・検証可能）。
		try {
			const n = await this.runRelationBatch();
			logger.succ(`hanami foryou: relation batch wrote ${n} relations`);
		} catch (err) {
			logger.error('hanami foryou: relation batch failed', { e: err });
		}

		// ALS（Python orchestration）。python/script が無い環境では run を failed にして握りつぶす。
		try {
			const res = await this.runAlsBatch(logger);
			logger.succ(`hanami foryou: ALS batch ${res.status} (run ${res.runId})`);
		} catch (err) {
			logger.error('hanami foryou: ALS batch failed', { e: err });
		}

		// aux 集計（活動リズム・メディア嗜好）。
		try {
			const n = await this.runAuxBatch();
			logger.succ(`hanami foryou: aux batch wrote ${n} rows`);
		} catch (err) {
			logger.error('hanami foryou: aux batch failed', { e: err });
		}

		// MiniLM 埋め込み＋taste-centroid（Python orchestration・後段）。python 不在なら run failed で握りつぶす。
		try {
			const res = await this.runEmbeddingBatch(logger);
			logger.succ(`hanami foryou: embedding batch ${res.status} (run ${res.runId})`);
		} catch (err) {
			logger.error('hanami foryou: embedding batch failed', { e: err });
		}

		// 相互RNペア検出（人気スコアのリング減衰用）。
		try {
			const n = await this.runRnRingBatch();
			logger.succ(`hanami foryou: rn-ring batch wrote ${n} mutual pairs`);
		} catch (err) {
			logger.error('hanami foryou: rn-ring batch failed', { e: err });
		}

		// event cleanup（TTL）。
		try {
			await this.cleanupEvents();
			logger.succ('hanami foryou: event cleanup done');
		} catch (err) {
			logger.error('hanami foryou: event cleanup failed', { e: err });
		}
	}

	// ───────────────────────── 相互RNペア（リング減衰） ─────────────────────────

	/**
	 * 直近7日で「AがBをRN かつ BがAをRN」した有向ペアを抽出し、Redis set を全置換する。
	 * NoteCreateService の RN 加点時に参照され、リング内RNの加点が減額される。
	 */
	@bindThis
	public async runRnRingBatch(): Promise<number> {
		const minId = this.idService.gen(Date.now() - RN_RING_LOOKBACK_MS);
		const rows = await this.db.query(
			`WITH rn AS (
				SELECT DISTINCT n."userId" AS renoter, n."renoteUserId" AS author
				FROM note n
				WHERE n.id > $1
				  AND ${pureRenoteSql('n')}
				  AND n."renoteUserId" IS NOT NULL
				  AND n."userId" <> n."renoteUserId"
			)
			SELECT a.author AS author, a.renoter AS renoter
			FROM rn a JOIN rn b ON a.renoter = b.author AND a.author = b.renoter`,
			[minId],
		) as { author: string; renoter: string }[];

		await this.featuredService.setRnMutualPairs(rows.map(r => `${r.author}:${r.renoter}`));
		return rows.length;
	}

	// ───────────────────────── 関係値バッチ（純SQL） ─────────────────────────

	/**
	 * 双方向関係値を全ローカルユーザー分まとめて再計算し `hanami_foryou_relation` を全置換する（§5/§7.3）。
	 * out = me→other（reaction/reply/renote）, in = other→me（×inbound係数）, mutual = coef*sqrt(out*in)。
	 * reaction/reply/renote は createdAt 列に頼らず、id 窓のバケットで時間減衰する。
	 */
	@bindThis
	public async runRelationBatch(): Promise<number> {
		const now = Date.now();
		const minReactionId = this.idService.gen(now - RELATION_LOOKBACK_MS);
		const minNoteId = this.idService.gen(now - RELATION_LOOKBACK_MS);
		const decayT30 = this.idService.gen(now - 30 * 24 * 60 * 60 * 1000);
		const decayT90 = this.idService.gen(now - 90 * 24 * 60 * 60 * 1000);
		const decayT180 = this.idService.gen(now - 180 * 24 * 60 * 60 * 1000);
		const reactionDecayCase = `CASE WHEN r.id >= $2 THEN 0.9 WHEN r.id >= $3 THEN 0.65 WHEN r.id >= $4 THEN 0.45 ELSE 0.28 END`;
		const noteDecayCase = `CASE WHEN n.id >= $2 THEN 0.9 WHEN n.id >= $3 THEN 0.65 WHEN n.id >= $4 THEN 0.45 ELSE 0.28 END`;

		const accum = new Map<RelationAccumKey, RelationAccum>();
		const bump = (me: string, other: string, dir: 'out' | 'in', w: number) => {
			if (me === other || w <= 0) return;
			const key = `${me}\t${other}`;
			let a = accum.get(key);
			if (a == null) { a = { out: 0, in: 0 }; accum.set(key, a); }
			a[dir] += w;
		};

		if (!this.interactionRollupReady) {
			this.interactionRollupReady = await this.refreshInteractionRollup().catch(() => false);
		}
		if (this.interactionRollupReady) {
			try {
				const today = utcDay(new Date(now));
				const rows = await this.db.query(
					`WITH weighted AS (
						SELECT "actorUserId" AS me, "targetUserId" AS other, 'out' AS dir, signal,
						       sum(count * CASE WHEN day >= $2::date THEN 0.9 WHEN day >= $3::date THEN 0.65 WHEN day >= $4::date THEN 0.45 ELSE 0.28 END) AS w
						FROM "hanami_foryou_interaction_daily" d JOIN "user" u ON u.id = d."actorUserId"
						WHERE day >= $1::date AND u.host IS NULL GROUP BY "actorUserId", "targetUserId", signal
						UNION ALL
						SELECT "targetUserId" AS me, "actorUserId" AS other, 'in' AS dir, signal,
						       sum(count * CASE WHEN day >= $2::date THEN 0.9 WHEN day >= $3::date THEN 0.65 WHEN day >= $4::date THEN 0.45 ELSE 0.28 END) AS w
						FROM "hanami_foryou_interaction_daily" d JOIN "user" u ON u.id = d."targetUserId"
						WHERE day >= $1::date AND u.host IS NULL GROUP BY "targetUserId", "actorUserId", signal
					) SELECT me, other, dir, signal, w FROM weighted`,
					[addUtcDays(today, -INTERACTION_ROLLUP_DAYS), addUtcDays(today, -30), addUtcDays(today, -90), addUtcDays(today, -180)],
				) as { me: string; other: string; dir: 'out' | 'in'; signal: InteractionSignal; w: string }[];
				for (const row of rows) bump(row.me, row.other, row.dir, Number(row.w) * RELATION_WEIGHT[row.signal]);
			} catch {
				this.interactionRollupReady = false;
			}
		}

		if (!this.interactionRollupReady) {
			// OUT reactions: me が other のノートに反応。reaction には createdAt 列が無いので id 窓＋バケット減衰。
			const rows = await this.db.query(
				`SELECT r."userId" AS me, n."userId" AS other, SUM(${reactionDecayCase}) AS w
				 FROM note_reaction r
				 JOIN note n ON n.id = r."noteId"
				 JOIN "user" u ON u.id = r."userId"
				 WHERE r.id >= $1 AND u.host IS NULL AND r."userId" <> n."userId"
				 GROUP BY r."userId", n."userId"`,
				[minReactionId, decayT30, decayT90, decayT180],
			) as { me: string; other: string; w: string }[];
			for (const row of rows) bump(row.me, row.other, 'out', Number(row.w) * RELATION_WEIGHT.reaction);

		// IN reactions: other が me のノートに反応。
		{
			const rows = await this.db.query(
				`SELECT n."userId" AS me, r."userId" AS other, SUM(${reactionDecayCase}) AS w
				 FROM note_reaction r
				 JOIN note n ON n.id = r."noteId"
				 JOIN "user" u ON u.id = n."userId"
				 WHERE r.id >= $1 AND u.host IS NULL AND r."userId" <> n."userId"
				 GROUP BY n."userId", r."userId"`,
				[minReactionId, decayT30, decayT90, decayT180],
			) as { me: string; other: string; w: string }[];
			for (const row of rows) bump(row.me, row.other, 'in', Number(row.w) * RELATION_WEIGHT.reaction);
		}
		// OUT replies: me が other に返信。
		await this.accumulateNoteSignal(accum, bump, 'out', 'replyUserId', noteDecayCase, minNoteId, decayT30, decayT90, decayT180, RELATION_WEIGHT.reply);
		// IN replies: other が me に返信。
		await this.accumulateNoteSignal(accum, bump, 'in', 'replyUserId', noteDecayCase, minNoteId, decayT30, decayT90, decayT180, RELATION_WEIGHT.reply);
		// OUT renotes: me が other をリノート。
		await this.accumulateNoteSignal(accum, bump, 'out', 'renoteUserId', noteDecayCase, minNoteId, decayT30, decayT90, decayT180, RELATION_WEIGHT.renote);
		// IN renotes: other が me をリノート。
		await this.accumulateNoteSignal(accum, bump, 'in', 'renoteUserId', noteDecayCase, minNoteId, decayT30, decayT90, decayT180, RELATION_WEIGHT.renote);
		}

		// 合成 → 行に。
		const updatedAt = new Date();
		const relationRows: MiHanamiForYouRelation[] = [];
		for (const [key, a] of accum) {
			const [me, other] = key.split('\t');
			const o = Math.log1p(a.out);
			const i = Math.log1p(a.in) * RELATION_INBOUND_COEF;
			if (o <= 0 && i <= 0) continue;
			const mutual = RELATION_MUTUAL_COEF * Math.sqrt(Math.max(0, o) * Math.max(0, i));
			const rel = o + i + mutual;
			if (rel <= 0) continue;
			relationRows.push({
				userId: me,
				otherUserId: other,
				relScore: rel,
				outScore: o,
				inScore: i,
				mutualScore: mutual,
				updatedAt,
			} as MiHanamiForYouRelation);
		}

		// 空集合のときは破壊的 swap をしない（transient な無シグナル/上流失敗で既存の関係値を全消ししない）。
		// 実インスタンスでは 240d 窓に必ず何らかの相互作用があるため、空はほぼ異常を意味する。
		if (relationRows.length === 0) return 0;

		// 全置換（rolling window なので毎回作り直す）。トランザクション内なので serve は古い行を見続ける。
		await this.db.transaction(async (em) => {
			await em.query(`DELETE FROM "hanami_foryou_relation"`);
			for (let i = 0; i < relationRows.length; i += RELATION_INSERT_CHUNK) {
				await em.insert(MiHanamiForYouRelation, relationRows.slice(i, i + RELATION_INSERT_CHUNK));
			}
		});

		return relationRows.length;
	}

	/** 初回/UTC日初回は240日、それ以外は直近7日をDELETEして再集計する。 */
	@bindThis
	public async refreshInteractionRollup(now = new Date()): Promise<boolean> {
		let stats: { c: number; latest: Date | string | null };
		try {
			const rows = await this.db.query(
				`SELECT count(*)::int AS c, max("updatedAt") AS latest FROM "hanami_foryou_interaction_daily"`,
			) as { c: number; latest: Date | string | null }[];
			stats = rows[0] ?? { c: 0, latest: null };
		} catch {
			return false;
		}

		const today = utcDay(now);
		const latest = stats.latest == null ? null : new Date(stats.latest);
		const full = Number(stats.c) === 0 || latest == null || latest < new Date(`${today}T00:00:00.000Z`);
		const days = full ? INTERACTION_ROLLUP_DAYS : INTERACTION_ROLLUP_RECENT_DAYS;
		// Rolling N日をUTC日集計で安全側に覆うため、境界日を含むN+1暦日を再集計する。
		const startDay = addUtcDays(today, -days);
		const runner = this.db.createQueryRunner();
		try {
			await runner.connect();
			await runner.startTransaction();
			const lockRows = await runner.query(
				`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
				[INTERACTION_ROLLUP_LOCK],
			) as { locked: boolean }[];
			if (lockRows[0]?.locked !== true) {
				await runner.rollbackTransaction();
				return Number(stats.c) > 0;
			}

			await runner.query(
				full
					? `DELETE FROM "hanami_foryou_interaction_daily"`
					: `DELETE FROM "hanami_foryou_interaction_daily" WHERE day >= $1::date`,
				full ? [] : [startDay],
			);
			const ranges = this.createUtcIdRanges(startDay, today, now);
			await this.insertInteractionRollup(runner, 'reaction', ranges, now);
			await this.insertInteractionRollup(runner, 'reply', ranges, now);
			await this.insertInteractionRollup(runner, 'renote', ranges, now);
			await runner.commitTransaction();
			const readyRows = await this.db.query(`SELECT EXISTS (SELECT 1 FROM "hanami_foryou_interaction_daily") AS ready`) as { ready: boolean }[];
			return readyRows[0]?.ready === true;
		} catch {
			if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
			return false;
		} finally {
			await runner.release();
		}
	}

	private createUtcIdRanges(startDay: string, today: string, now: Date): { day: string; minId: string; maxId: string }[] {
		const ranges = [];
		for (let day = startDay; day <= today; day = addUtcDays(day, 1)) {
			const start = new Date(`${day}T00:00:00.000Z`).getTime();
			const next = new Date(`${addUtcDays(day, 1)}T00:00:00.000Z`).getTime();
			ranges.push({ day, minId: this.idService.gen(start), maxId: this.idService.gen(Math.min(next, now.getTime())) });
		}
		return ranges;
	}

	private async insertInteractionRollup(runner: QueryRunner, signal: InteractionSignal, ranges: { day: string; minId: string; maxId: string }[], updatedAt: Date): Promise<void> {
		const params: unknown[] = [];
		const values = ranges.map(range => {
			const p = params.length;
			params.push(range.day, range.minId, range.maxId);
			return `($${p + 1}::date,$${p + 2}::varchar,$${p + 3}::varchar)`;
		}).join(',');
		params.push(updatedAt);
		const joins = signal === 'reaction'
			? `JOIN note_reaction x ON x.id >= d."minId" AND x.id < d."maxId" JOIN note n ON n.id = x."noteId"`
			: `JOIN note x ON x.id >= d."minId" AND x.id < d."maxId"`;
		const actor = `x."userId"`;
		const target = signal === 'reaction' ? `n."userId"` : `x."${signal === 'reply' ? 'replyUserId' : 'renoteUserId'}"`;
		await runner.query(
			`INSERT INTO "hanami_foryou_interaction_daily" (day, signal, "actorUserId", "targetUserId", count, "updatedAt")
			 SELECT d.day, '${signal}', ${actor}, ${target}, count(*)::int, $${params.length}
			 FROM (VALUES ${values}) AS d(day, "minId", "maxId")
			 ${joins}
			 WHERE ${target} IS NOT NULL AND ${actor} <> ${target}
			 GROUP BY d.day, ${actor}, ${target}`,
			params,
		);
	}

	/** reply/renote の note 由来シグナルを集計する。 */
	private async accumulateNoteSignal(
		accum: Map<RelationAccumKey, RelationAccum>,
		bump: (me: string, other: string, dir: 'out' | 'in', w: number) => void,
		dir: 'out' | 'in',
		targetCol: 'replyUserId' | 'renoteUserId',
		noteDecayCase: string,
		sinceId: string,
		decayT30: string,
		decayT90: string,
		decayT180: string,
		typeWeight: number,
	): Promise<void> {
		// dir=out: me=投稿者(n.userId) / other=対象(targetCol)。dir=in: me=対象(targetCol) / other=投稿者(n.userId)。
		const meExpr = dir === 'out' ? 'n."userId"' : `n."${targetCol}"`;
		const otherExpr = dir === 'out' ? `n."${targetCol}"` : 'n."userId"';
		const rows = await this.db.query(
			`SELECT ${meExpr} AS me, ${otherExpr} AS other, SUM(${noteDecayCase}) AS w
			 FROM note n
			 JOIN "user" mu ON mu.id = ${meExpr}
			 WHERE n."${targetCol}" IS NOT NULL
			   AND n."${targetCol}" <> n."userId"
			   AND mu.host IS NULL
			   AND n.id >= $1
			 GROUP BY ${meExpr}, ${otherExpr}`,
			[sinceId, decayT30, decayT90, decayT180],
		) as { me: string; other: string; w: string }[];
		for (const row of rows) bump(row.me, row.other, dir, Number(row.w) * typeWeight);
	}

	// ───────────────────────── ALS バッチ（Python orchestration） ─────────────────────────

	@bindThis
	public async runAlsBatch(logger: Logger): Promise<{ runId: string; status: 'ready' | 'failed' }> {
		const startedAt = Date.now();
		const startedCpu = process.cpuUsage();
		const runId = await this.createRun('als', { factors: ALS_FACTORS, iterations: ALS_ITERATIONS, threadSettings: HANAMI_PYTHON_THREAD_ENV });
		let tmpDir: string | null = null;
		try {
			// 1) user×author 反応行列を export。
			const minId = this.idService.gen(Date.now() - ALS_REACTION_LOOKBACK_MS);
			if (!this.interactionRollupReady) {
				this.interactionRollupReady = await this.refreshInteractionRollup().catch(() => false);
			}
			let matrixRows: { u: string; a: string; c: number }[];
			let localUserRows: { id: string }[];
			if (this.interactionRollupReady) {
				try {
					const sinceDay = addUtcDays(utcDay(new Date()), -INTERACTION_ROLLUP_DAYS);
					matrixRows = await this.db.query(
						`SELECT "actorUserId" AS u, "targetUserId" AS a, sum(count)::int AS c
						 FROM "hanami_foryou_interaction_daily"
						 WHERE signal = 'reaction' AND day >= $1::date
						 GROUP BY "actorUserId", "targetUserId"`,
						[sinceDay],
					) as { u: string; a: string; c: number }[];
					localUserRows = await this.db.query(
						`SELECT DISTINCT d."actorUserId" AS id
						 FROM "hanami_foryou_interaction_daily" d JOIN "user" u ON u.id = d."actorUserId"
						 WHERE d.signal = 'reaction' AND d.day >= $1::date AND u.host IS NULL`,
						[sinceDay],
					) as { id: string }[];
				} catch {
					this.interactionRollupReady = false;
					matrixRows = [];
					localUserRows = [];
				}
			} else {
				matrixRows = [];
				localUserRows = [];
			}
			if (!this.interactionRollupReady) {
				matrixRows = await this.db.query(
					`SELECT r."userId" AS u, n."userId" AS a, count(*)::int AS c
					 FROM note_reaction r
					 JOIN note n ON n.id = r."noteId"
					 WHERE r.id >= $1 AND r."userId" <> n."userId"
					 GROUP BY r."userId", n."userId"`,
					[minId],
				) as { u: string; a: string; c: number }[];
				localUserRows = await this.db.query(
					`SELECT DISTINCT r."userId" AS id
					 FROM note_reaction r
					 JOIN "user" u ON u.id = r."userId"
					 WHERE r.id >= $1 AND u.host IS NULL`,
					[minId],
				) as { id: string }[];
			}
			if (matrixRows.length === 0) {
				await this.markRun(runId, 'failed', this.runMetrics(startedAt, startedCpu, { factors: ALS_FACTORS, iterations: ALS_ITERATIONS, processedCount: 0, backlog: 0 }));
				return { runId, status: 'failed' };
			}

			const input = {
				matrix: matrixRows.map(r => [r.u, r.a, r.c]),
				targetUsers: localUserRows.map(r => r.id),
				factors: ALS_FACTORS,
				iterations: ALS_ITERATIONS,
				bm25K1: ALS_BM25_K1,
				bm25B: ALS_BM25_B,
				topAuthorRecs: ALS_TOP_AUTHOR_RECS,
				topNeighbors: ALS_TOP_NEIGHBORS,
				minUserEvidence: ALS_MIN_USER_EVIDENCE,
			};

			// 2) Python 実行。
			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-als-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(inputPath, JSON.stringify(input), 'utf8');

			const scriptPath = process.env.HANAMI_FORYOU_ALS_SCRIPT
				?? Path.join(resolveHanamiRepoRoot(), 'scripts/hanami-foryou/rec_als.py');
			const command = prepareHanamiPythonCommand([scriptPath, inputPath, outputPath]);
			await execFileAsync(command.file, command.args, { env: command.env, timeout: ALS_PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });

			// 3) 取り込み。
			const out = JSON.parse(await readFile(outputPath, 'utf8')) as AlsOutput;
			await this.ingestAlsOutput(runId, out);

			// 4) ready swap ＋ 世代落とし。
			await this.markRun(runId, 'ready', this.runMetrics(startedAt, startedCpu, { factors: ALS_FACTORS, iterations: ALS_ITERATIONS, processedCount: matrixRows.length, backlog: 0 }));
			await this.pruneOldRuns('als');
			return { runId, status: 'ready' };
		} catch (err) {
			logger.warn(`hanami foryou: ALS python unavailable/failed, marking run failed: ${(err as Error).message}`);
			await this.markRun(runId, 'failed', this.runMetrics(startedAt, startedCpu, { factors: ALS_FACTORS, iterations: ALS_ITERATIONS, processedCount: 0 })).catch(() => { /* ignore */ });
			return { runId, status: 'failed' };
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	private async ingestAlsOutput(runId: string, out: AlsOutput): Promise<void> {
			const chunk = 1000;

			const userFactorRows = out.userFactors.map(f => ({
				runId, userId: f.userId, factor: f.factor, evidenceCount: f.evidenceCount,
			}));
		for (let i = 0; i < userFactorRows.length; i += chunk) {
			await this.db.getRepository(MiHanamiForYouUserFactor).insert(userFactorRows.slice(i, i + chunk));
		}

		const authorFactorRows = out.authorFactors.map(f => ({ runId, authorId: f.authorId, factor: f.factor, reactionCount: f.reactionCount }));
		for (let i = 0; i < authorFactorRows.length; i += chunk) {
			await this.db.getRepository(MiHanamiForYouAuthorFactor).insert(authorFactorRows.slice(i, i + chunk));
		}

			const authorRecRows = out.authorRecs.map(r => ({ runId, userId: r.userId, authorId: r.authorId, score: r.score, rank: r.rank }));
			for (let i = 0; i < authorRecRows.length; i += chunk) {
				await this.db.getRepository(MiHanamiForYouAuthorRec).insert(authorRecRows.slice(i, i + chunk));
			}

			const neighborRows = out.neighbors.map(n => ({ runId, userId: n.userId, neighborUserId: n.neighborUserId, score: n.score, rank: n.rank }));
			for (let i = 0; i < neighborRows.length; i += chunk) {
				await this.db.getRepository(MiHanamiForYouNeighborUser).insert(neighborRows.slice(i, i + chunk));
		}
	}

	// ───────────────────────── model_run ヘルパ ─────────────────────────

	@bindThis
	public async createRun(kind: string, params: Record<string, unknown>): Promise<string> {
		const id = this.idService.gen();
		// params は jsonb。TypeORM の QueryDeepPartialEntity が jsonb object を deep-partial 展開して誤判定するため局所 cast。
		await this.hanamiForYouModelRunsRepository.insert({ id, kind, params: params as never, status: 'pending', startedAt: new Date(), finishedAt: null });
		return id;
	}

	@bindThis
	public async markRun(runId: string, status: 'ready' | 'failed', params?: Record<string, unknown>): Promise<void> {
		await this.hanamiForYouModelRunsRepository.update({ id: runId }, {
			status,
			finishedAt: new Date(),
			...(params == null ? {} : { params: params as never }),
		});
	}

	private runMetrics(startedAt: number, startedCpu: NodeJS.CpuUsage, values: Record<string, unknown> = {}): Record<string, unknown> {
		const cpu = process.cpuUsage(startedCpu);
		return {
			...values,
			threadSettings: HANAMI_PYTHON_THREAD_ENV,
			wallDurationMs: Date.now() - startedAt,
			cpuDurationMicros: cpu.user + cpu.system,
		};
	}

	/** kind ごとに status='ready' の最新 run id（serve 用）。 */
	@bindThis
	public async getLatestReadyRunId(kind: string): Promise<string | null> {
		const row = await this.hanamiForYouModelRunsRepository.createQueryBuilder('run')
			.select('run.id', 'id')
			.where('run.kind = :kind', { kind })
			.andWhere('run.status = :status', { status: 'ready' })
			.orderBy('run.startedAt', 'DESC')
			.limit(1)
			.getRawOne<{ id: string }>();
		return row?.id ?? null;
	}

	/**
	 * 直近 MODEL_RUN_KEEP 世代の **ready** run を残し、それより古い run（status 問わず）を削除する（§7.3）。
	 * ready 以外（failed/pending）を keep 枠に数えると前世代の ready が CASCADE 削除され得るので ready だけで順位付けする。
	 * 古い run 削除で FK CASCADE で factor/rec/neighbor も消える。新しい in-progress run は cutoff より新しいので残る。
	 */
	@bindThis
	public async pruneOldRuns(kind: string): Promise<void> {
		const readyRuns = await this.hanamiForYouModelRunsRepository.find({
			where: { kind, status: 'ready' },
			order: { startedAt: 'DESC' },
		});
		if (readyRuns.length <= MODEL_RUN_KEEP) return;
		const cutoff = readyRuns[MODEL_RUN_KEEP - 1].startedAt; // 残す中で最古の ready run の開始時刻
		await this.hanamiForYouModelRunsRepository.createQueryBuilder()
			.delete()
			.where('kind = :kind', { kind })
			.andWhere('"startedAt" < :cutoff', { cutoff })
			.execute();
	}

	// ───────────────────────── aux 集計 ─────────────────────────

	/**
	 * 活動リズム（active_hour_hist・JST）とメディア/テキスト反応率を全ローカルユーザー分集計し upsert（§5/§7.3）。
	 * 最終段の弱い boost/filter（夜型 boost・text 偏重なら画像割引）のタイブレーク用（§14-D7）。
	 * active_hour_hist は本人の投稿時刻、media/text rate は反応先ノートの種別から。
	 */
	@bindThis
	public async runAuxBatch(): Promise<number> {
		const now = Date.now();
		const minNoteId = this.idService.gen(now - AUX_LOOKBACK_MS);
		const minReactionId = this.idService.gen(now - AUX_LOOKBACK_MS);

		const histRows = await this.db.query(
			`SELECT n.id AS id, n."userId" AS uid
			 FROM note n JOIN "user" u ON u.id = n."userId"
			 WHERE u.host IS NULL AND n.id >= $1`,
			[minNoteId],
		) as { id: string; uid: string }[];
		const rateRows = await this.db.query(
			`SELECT r."userId" AS uid, count(*)::int AS total,
			        count(*) FILTER (WHERE n."fileIds" <> '{}')::int AS media,
			        count(*) FILTER (WHERE n.text IS NOT NULL)::int AS txt
			 FROM note_reaction r JOIN note n ON n.id = r."noteId" JOIN "user" u ON u.id = r."userId"
			 WHERE u.host IS NULL AND r.id >= $1
			 GROUP BY r."userId"`,
			[minReactionId],
		) as { uid: string; total: number; media: number; txt: number }[];

		const byUser = new Map<string, { hist: Record<string, number>; media: number; text: number }>();
		const get = (uid: string) => {
			let e = byUser.get(uid);
			if (e == null) { e = { hist: {}, media: 0, text: 0 }; byUser.set(uid, e); }
			return e;
		};
		for (const h of histRows) {
			const hr = (this.idService.parse(h.id).date.getUTCHours() + 9) % 24;
			const hist = get(h.uid).hist;
			hist[String(hr)] = (hist[String(hr)] ?? 0) + 1;
		}
		for (const r of rateRows) {
			const e = get(r.uid);
			const total = Number(r.total) || 0;
			e.media = total > 0 ? Number(r.media) / total : 0;
			e.text = total > 0 ? Number(r.txt) / total : 0;
		}

		const updatedAt = new Date();
		let written = 0;
		for (const [uid, e] of byUser) {
			await this.db.query(
				`INSERT INTO "hanami_foryou_user_aux" ("userId","activeHourHist","mediaReactionRate","textReactionRate","updatedAt")
				 VALUES ($1,$2::jsonb,$3,$4,$5)
				 ON CONFLICT ("userId") DO UPDATE SET
				   "activeHourHist"=EXCLUDED."activeHourHist",
				   "mediaReactionRate"=EXCLUDED."mediaReactionRate","textReactionRate"=EXCLUDED."textReactionRate","updatedAt"=EXCLUDED."updatedAt"`,
				[uid, JSON.stringify(e.hist), e.media, e.text, updatedAt],
			);
			written++;
		}
		return written;
	}

	// ───────────────────────── MiniLM 埋め込み（Python orchestration・後段） ─────────────────────────

	@bindThis
	public async runEmbeddingBatch(logger: Logger): Promise<{ runId: string; status: 'ready' | 'failed' }> {
		const startedAt = Date.now();
		const startedCpu = process.cpuUsage();
		const runId = await this.createRun('embedding', { model: EMBEDDING_MODEL, threadSettings: HANAMI_PYTHON_THREAD_ENV });
		let tmpDir: string | null = null;
		let primaryReady = false;
		try {
			const now = Date.now();
			// 増分: 埋め込み未生成の候補窓ノート。
			const sinceId = this.idService.gen(now - EMBED_WINDOW_MS);
			const noteRows = await this.db.query(
				`SELECT n.id AS id, n.text AS text
				 FROM note n
				 LEFT JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
				 WHERE n.id >= $2 AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL AND e."noteId" IS NULL
				 ORDER BY n.id DESC
				 LIMIT $3`,
				[EMBEDDING_MODEL, sinceId, EMBED_NOTE_LIMIT],
			) as { id: string; text: string }[];

			// taste（反応先テキスト）をローカルユーザーごとに収集（上限付き）。
			const tasteMinId = this.idService.gen(now - CENTROID_TASTE_WINDOW_MS);
			const tasteRows = await this.db.query(
				`SELECT r."userId" AS uid, n.text AS text
				 FROM note_reaction r JOIN note n ON n.id = r."noteId" JOIN "user" u ON u.id = r."userId"
				 WHERE u.host IS NULL AND r.id >= $1 AND n.text IS NOT NULL
				 ORDER BY r.id DESC`,
				[tasteMinId],
			) as { uid: string; text: string }[];
			const tasteByUser = new Map<string, string[]>();
			for (const t of tasteRows) {
				let arr = tasteByUser.get(t.uid);
				if (arr == null) { arr = []; tasteByUser.set(t.uid, arr); }
				if (arr.length < CENTROID_TASTE_PER_USER) arr.push(t.text);
			}
			const tasteList = [...tasteByUser.entries()].filter(([, texts]) => texts.length >= CENTROID_MIN_EVIDENCE).slice(0, CENTROID_USER_LIMIT);
			const coldRows = await this.collectColdCentroidSources(now);
			const coldByUser = new Map<string, Map<string, { texts: string[]; fallback: boolean }>>();
			for (const row of coldRows) {
				let sources = coldByUser.get(row.uid);
				if (sources == null) { sources = new Map(); coldByUser.set(row.uid, sources); }
				let source = sources.get(row.source);
				if (source == null) { source = { texts: [], fallback: row.source !== 'reaction' }; sources.set(row.source, source); }
				if (source.texts.length < COLD_CENTROID_PER_SOURCE) source.texts.push(row.text);
			}
			const coldSourceCentroids = [...coldByUser].map(([uid, sources]) => [uid, [...sources.entries()].map(([name, source]) => [name, source.texts, source.fallback])]);

			if (noteRows.length === 0 && tasteList.length === 0 && coldSourceCentroids.length === 0) {
				await this.markRun(runId, 'ready', this.runMetrics(startedAt, startedCpu, { model: EMBEDDING_MODEL, processedCount: 0, backlog: 0 }));
				return { runId, status: 'ready' };
			}

			const input = {
				model: EMBEDDING_MODEL,
				notes: noteRows.map(r => [r.id, r.text]),
				tasteByUser: tasteList.map(([uid, texts]) => [uid, texts]),
				coldSourceCentroids,
			};

			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-embed-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(inputPath, JSON.stringify(input), 'utf8');

			const scriptPath = process.env.HANAMI_FORYOU_CONTENT_SCRIPT
				?? Path.join(resolveHanamiRepoRoot(), 'scripts/hanami-foryou/rec_content_cpu.py');
			const command = prepareHanamiPythonCommand([scriptPath, inputPath, outputPath]);
			await execFileAsync(command.file, command.args, { env: command.env, timeout: EMBEDDING_PROCESS_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });

			const out = JSON.parse(await readFile(outputPath, 'utf8')) as {
				model: string; dim: number; status?: string; error?: string;
				embeddings: { noteId: string; vector: number[] }[];
				centroids: { userId: string; vector: number[]; evidenceCount: number }[];
			};
			if (out.status === 'unavailable') throw new Error(`MiniLM unavailable: ${out.error ?? 'unknown error'}`);
			await this.ingestEmbeddingOutput(out);
			await this.markRun(runId, 'ready', this.runMetrics(startedAt, startedCpu, { model: out.model, modelVersion: out.model, processedCount: out.embeddings.length + out.centroids.length, backlog: Math.max(0, noteRows.length - out.embeddings.length), coldCentroidUsers: coldSourceCentroids.length }));
			primaryReady = true;
			await this.pruneOldRuns('embedding').catch(() => undefined);
			// Shadow diagnostics are strictly best-effort; an already-ready MiniLM run
			// must never be reclassified because shadow setup or cleanup failed.
			await this.runQualityShadow(noteRows, logger).catch(() => undefined);
			return { runId, status: 'ready' };
		} catch (err) {
			if (primaryReady) return { runId, status: 'ready' };
			logger.warn(`hanami foryou: MiniLM python unavailable/failed, marking run failed: ${(err as Error).message}`);
			await this.markRun(runId, 'failed', this.runMetrics(startedAt, startedCpu, { model: EMBEDDING_MODEL, processedCount: 0 })).catch(() => { /* ignore */ });
			return { runId, status: 'failed' };
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	/**
	 * Cold users get at most three texts per bounded source in one set-based query.
	 * Followed-post evidence first chooses one recent post per author, then caps the
	 * author-diverse set; non-public, followers-only, specified and channel notes
	 * never enter any source.
	 */
	private async collectColdCentroidSources(now: number): Promise<{ uid: string; source: string; text: string }[]> {
		const sinceId = this.idService.gen(now - CENTROID_TASTE_WINDOW_MS);
		return await this.db.query(
			`WITH cold_users AS (
				SELECT u.id
				FROM "user" u
				LEFT JOIN "hanami_foryou_user_centroid" c ON c."userId" = u.id AND c.model = $5
				LEFT JOIN note_reaction r ON r."userId" = u.id AND r.id >= $2
				WHERE u.host IS NULL AND u."isDeleted" = false AND u."isSuspended" = false
				  AND (EXISTS (
					SELECT 1 FROM note n WHERE n."userId" = u.id AND n.id >= $2
					AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL
				  ) OR EXISTS (
					SELECT 1 FROM following f JOIN note n ON n."userId" = f."followeeId" AND n.id >= $2
					WHERE f."followerId" = u.id AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL
				  ) OR EXISTS (
					SELECT 1 FROM note_reaction rr JOIN note n ON n.id = rr."noteId"
					WHERE rr."userId" = u.id AND rr.id >= $2 AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL
				  ))
				GROUP BY u.id
				HAVING count(r.id) <= $3
				-- Oldest/no centroid first makes zero-reaction users eligible rather than
				-- permanently trailing high-volume recent-reaction accounts.
				ORDER BY min(c."updatedAt") ASC NULLS FIRST, max(r.id) DESC NULLS LAST, u.id ASC
				LIMIT $1
			),
			reaction_ranked AS (
				SELECT r."userId" AS uid, n.text, row_number() OVER (PARTITION BY r."userId" ORDER BY r.id DESC) AS rank
				FROM cold_users cu JOIN note_reaction r ON r."userId" = cu.id AND r.id >= $2
				JOIN note n ON n.id = r."noteId"
				WHERE n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL
			),
			own_ranked AS (
				SELECT n."userId" AS uid, n.text, row_number() OVER (PARTITION BY n."userId" ORDER BY n.id DESC) AS rank
				FROM cold_users cu JOIN note n ON n."userId" = cu.id AND n.id >= $2
				WHERE n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL
			),
			followed_one_per_author AS (
				SELECT DISTINCT ON (f."followerId", n."userId") f."followerId" AS uid, n."userId" AS author, n.text, n.id
				FROM cold_users cu JOIN following f ON f."followerId" = cu.id
				JOIN note n ON n."userId" = f."followeeId" AND n.id >= $2
				WHERE n.visibility IN ('public','home') AND n."channelId" IS NULL AND n.text IS NOT NULL
				ORDER BY f."followerId", n."userId", n.id DESC
			),
			followed_ranked AS (
				SELECT uid, text, row_number() OVER (PARTITION BY uid ORDER BY id DESC) AS rank FROM followed_one_per_author
			)
			SELECT uid, 'reaction' AS source, text FROM reaction_ranked WHERE rank <= $4
			UNION ALL SELECT uid, 'own' AS source, text FROM own_ranked WHERE rank <= $4
			UNION ALL SELECT uid, 'followed' AS source, text FROM followed_ranked WHERE rank <= $4`,
			[CENTROID_USER_LIMIT, sinceId, COLD_CENTROID_MAX_REACTIONS, COLD_CENTROID_PER_SOURCE, EMBEDDING_MODEL],
		) as { uid: string; source: string; text: string }[];
	}

	/** E5 is diagnostic-only: it writes no embedding table and is never read by ranking code. */
	private async runQualityShadow(notes: { id: string; text: string }[], logger: Logger): Promise<void> {
		const startedAt = Date.now();
		const startedCpu = process.cpuUsage();
		let runId: string | null = null;
		let tmpDir: string | null = null;
		try {
			runId = await this.createRun('embedding-e5-shadow', { model: E5_SHADOW_MODEL, modelVersion: E5_SHADOW_VERSION, threadSettings: HANAMI_PYTHON_THREAD_ENV });
			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-e5-shadow-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(inputPath, JSON.stringify({ notes: notes.map(note => [note.id, note.text]) }), 'utf8');
			const scriptPath = Path.join(resolveHanamiRepoRoot(), 'scripts/hanami-foryou/rec_quality_shadow_cpu.py');
			const command = prepareHanamiPythonCommand([scriptPath, inputPath, outputPath]);
			await execFileAsync(command.file, command.args, { env: command.env, timeout: EMBEDDING_PROCESS_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
			const out = JSON.parse(await readFile(outputPath, 'utf8')) as { status?: string; error?: string; model: string; version: string; dim: number; embeddings: unknown[] };
			const status = out.status === 'unavailable' ? 'failed' : 'ready';
			await this.markRun(runId, status, this.runMetrics(startedAt, startedCpu, { model: out.model, modelVersion: out.version, modelOutputDimension: out.dim, processedCount: out.embeddings.length, backlog: Math.max(0, notes.length - out.embeddings.length), shadowStatus: out.status ?? 'ok', shadowErrorCategory: out.status === 'unavailable' ? 'unavailable' : undefined }));
		} catch (err) {
			const category = this.shadowErrorCategory(err);
			// Shadow diagnostics are optional, including their own logger/repository path.
			try { logger.warn(`hanami foryou: E5 quality shadow unavailable: ${category}`); } catch { /* ignore */ }
			if (runId != null) await this.markRun(runId, 'failed', this.runMetrics(startedAt, startedCpu, { model: E5_SHADOW_MODEL, modelVersion: E5_SHADOW_VERSION, processedCount: 0, shadowStatus: 'unavailable', shadowErrorCategory: category })).catch(() => undefined);
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
			await this.pruneOldRuns('embedding-e5-shadow').catch(() => undefined);
		}
	}

	private shadowErrorCategory(err: unknown): 'Error' | 'TypeError' | 'SyntaxError' | 'AbortError' | 'unavailable' {
		const name = err instanceof Error ? err.name : '';
		return name === 'TypeError' || name === 'SyntaxError' || name === 'AbortError' ? name : 'Error';
	}

	private async ingestEmbeddingOutput(out: { model: string; dim: number; embeddings: { noteId: string; vector: number[] }[]; centroids: { userId: string; vector: number[]; evidenceCount: number }[] }): Promise<void> {
		const updatedAt = new Date();
		for (const e of out.embeddings) {
			await this.db.query(
				`INSERT INTO "hanami_note_embedding" ("noteId","model","dim","embedding","updatedAt")
				 VALUES ($1,$2,$3,$4::real[],$5)
				 ON CONFLICT ("noteId","model") DO UPDATE SET "dim"=EXCLUDED."dim","embedding"=EXCLUDED."embedding","updatedAt"=EXCLUDED."updatedAt"`,
				[e.noteId, out.model, out.dim, e.vector, updatedAt],
			);
		}
			for (const c of out.centroids) {
				await this.db.query(
					`INSERT INTO "hanami_foryou_user_centroid" ("userId","model","centroid","evidenceCount","updatedAt")
					 VALUES ($1,$2,$3::real[],$4,$5)
					 ON CONFLICT ("userId","model") DO UPDATE SET
					   "centroid"=EXCLUDED."centroid","evidenceCount"=EXCLUDED."evidenceCount","updatedAt"=EXCLUDED."updatedAt"`,
					[c.userId, out.model, c.vector, c.evidenceCount, updatedAt],
				);
			}
		}

	// ───────────────────────── event cleanup（§7.2 TTL） ─────────────────────────

	@bindThis
	public async cleanupEvents(): Promise<void> {
		const servedSeenCutoff = new Date(Date.now() - HANAMI_EVENT_TTL_SERVED_SEEN_MS);
		const personalCutoff = new Date(Date.now() - HANAMI_EVENT_TTL_PERSONAL_MS);
		await this.db.query(
			`DELETE FROM "hanami_recommendation_event" WHERE "eventType" IN ('served','seen') AND "occurredAt" < $1`,
			[servedSeenCutoff],
		);
			await this.db.query(
				`DELETE FROM "hanami_recommendation_event" WHERE "eventType" IN ('reaction','reply','renote') AND "createdAt" < $1`,
				[personalCutoff],
			);
	}
}
