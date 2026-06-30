/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
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

const execFileAsync = promisify(execFile);

const _dirname = Path.dirname(fileURLToPath(import.meta.url));

// canonical spec §10 の初期値。重みは実データから引き直す使い捨て。
const RELATION_LOOKBACK_MS = 240 * 24 * 60 * 60 * 1000; // 関係値の集計窓（半減期120dに対し十分長く）
const RELATION_WEIGHT = { reaction: 1.0, reply: 2.5, renote: 1.5 } as const;
const RELATION_INBOUND_COEF = 0.8;
const RELATION_MUTUAL_COEF = 1.5;
const RELATION_INSERT_CHUNK = 1000;

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
const EMBEDDING_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;

type RelationAccumKey = string; // `${me}\t${other}`
type RelationAccum = { out: number; in: number };

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
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.hanamiForYouModelRunsRepository)
		private hanamiForYouModelRunsRepository: HanamiForYouModelRunsRepository,

		private idService: IdService,
	) {
	}

	// ───────────────────────── エントリポイント ─────────────────────────

	@bindThis
	public async runAll(logger: Logger): Promise<void> {
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

		// aux 集計（活動リズム・メディア嗜好。純SQL）。
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

		// event cleanup（TTL）。
		try {
			await this.cleanupEvents();
			logger.succ('hanami foryou: event cleanup done');
		} catch (err) {
			logger.error('hanami foryou: event cleanup failed', { e: err });
		}
	}

	// ───────────────────────── 関係値バッチ（純SQL） ─────────────────────────

	/**
	 * 双方向関係値を全ローカルユーザー分まとめて再計算し `hanami_foryou_relation` を全置換する（§5/§7.3）。
	 * out = me→other（reaction/reply/renote）, in = other→me（×inbound係数）, mutual = coef*sqrt(out*in)。
		 * reaction は createdAt 列が無い（1697420555911 で削除済）ため id 窓のバケットで時間減衰する。
	 */
	@bindThis
	public async runRelationBatch(): Promise<number> {
		const now = Date.now();
		const since = new Date(now - RELATION_LOOKBACK_MS);
		const minReactionId = this.idService.gen(now - RELATION_LOOKBACK_MS);
		// reaction の時間減衰（半減期120d近似）を id 窓のバケットで。
		const t30 = this.idService.gen(now - 30 * 24 * 60 * 60 * 1000);
		const t90 = this.idService.gen(now - 90 * 24 * 60 * 60 * 1000);
		const t180 = this.idService.gen(now - 180 * 24 * 60 * 60 * 1000);
		const reactionDecayCase = `CASE WHEN r.id >= $2 THEN 0.9 WHEN r.id >= $3 THEN 0.65 WHEN r.id >= $4 THEN 0.45 ELSE 0.28 END`;
		// note の時間減衰（連続・半減期120d）。
		const noteDecay = `power(0.5, EXTRACT(EPOCH FROM (now() - n."createdAt")) / ${120 * 86400}.0)`;

		const accum = new Map<RelationAccumKey, RelationAccum>();
		const bump = (me: string, other: string, dir: 'out' | 'in', w: number) => {
			if (me === other || w <= 0) return;
			const key = `${me}\t${other}`;
			let a = accum.get(key);
			if (a == null) { a = { out: 0, in: 0 }; accum.set(key, a); }
			a[dir] += w;
		};

		// OUT reactions: me が other のノートに反応。reaction には createdAt 列が無いので id 窓＋バケット減衰。
		{
			const rows = await this.db.query(
				`SELECT r."userId" AS me, n."userId" AS other, SUM(${reactionDecayCase}) AS w
				 FROM note_reaction r
				 JOIN note n ON n.id = r."noteId"
				 JOIN "user" u ON u.id = r."userId"
				 WHERE r.id >= $1 AND u.host IS NULL AND r."userId" <> n."userId"
				 GROUP BY r."userId", n."userId"`,
				[minReactionId, t30, t90, t180],
			) as { me: string; other: string; w: string }[];
			for (const row of rows) bump(row.me, row.other, 'out', Number(row.w) * RELATION_WEIGHT.reaction);
		}
		// IN reactions: other が me のノートに反応。
		{
			const rows = await this.db.query(
				`SELECT n."userId" AS me, r."userId" AS other, SUM(${reactionDecayCase}) AS w
				 FROM note_reaction r
				 JOIN note n ON n.id = r."noteId"
				 JOIN "user" u ON u.id = n."userId"
				 WHERE r.id >= $1 AND u.host IS NULL AND r."userId" <> n."userId"
				 GROUP BY n."userId", r."userId"`,
				[minReactionId, t30, t90, t180],
			) as { me: string; other: string; w: string }[];
			for (const row of rows) bump(row.me, row.other, 'in', Number(row.w) * RELATION_WEIGHT.reaction);
		}
			// OUT replies: me が other に返信。
			await this.accumulateNoteSignal(accum, bump, 'out', 'replyUserId', noteDecay, since, RELATION_WEIGHT.reply);
		// IN replies: other が me に返信。
		await this.accumulateNoteSignal(accum, bump, 'in', 'replyUserId', noteDecay, since, RELATION_WEIGHT.reply);
		// OUT renotes: me が other をリノート。
		await this.accumulateNoteSignal(accum, bump, 'out', 'renoteUserId', noteDecay, since, RELATION_WEIGHT.renote);
		// IN renotes: other が me をリノート。
		await this.accumulateNoteSignal(accum, bump, 'in', 'renoteUserId', noteDecay, since, RELATION_WEIGHT.renote);

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

		/** reply/renote の note 由来シグナルを集計する。 */
	private async accumulateNoteSignal(
		accum: Map<RelationAccumKey, RelationAccum>,
		bump: (me: string, other: string, dir: 'out' | 'in', w: number) => void,
		dir: 'out' | 'in',
		targetCol: 'replyUserId' | 'renoteUserId',
		noteDecay: string,
		since: Date,
		typeWeight: number,
	): Promise<void> {
		// dir=out: me=投稿者(n.userId) / other=対象(targetCol)。dir=in: me=対象(targetCol) / other=投稿者(n.userId)。
			const meExpr = dir === 'out' ? 'n."userId"' : `n."${targetCol}"`;
			const otherExpr = dir === 'out' ? `n."${targetCol}"` : 'n."userId"';
			const rows = await this.db.query(
				`SELECT ${meExpr} AS me, ${otherExpr} AS other, SUM(${noteDecay}) AS w
				 FROM note n
				 JOIN "user" mu ON mu.id = ${meExpr}
				 WHERE n."${targetCol}" IS NOT NULL
				   AND n."${targetCol}" <> n."userId"
				   AND mu.host IS NULL
				   AND n."createdAt" >= $1
				 GROUP BY ${meExpr}, ${otherExpr}`,
				[since],
		) as { me: string; other: string; w: string }[];
		for (const row of rows) bump(row.me, row.other, dir, Number(row.w) * typeWeight);
	}

	// ───────────────────────── ALS バッチ（Python orchestration） ─────────────────────────

	@bindThis
	public async runAlsBatch(logger: Logger): Promise<{ runId: string; status: 'ready' | 'failed' }> {
		const runId = await this.createRun('als', { factors: ALS_FACTORS, iterations: ALS_ITERATIONS });
		let tmpDir: string | null = null;
		try {
			// 1) user×author 反応行列を export。
			const minId = this.idService.gen(Date.now() - ALS_REACTION_LOOKBACK_MS);
			const matrixRows = await this.db.query(
				`SELECT r."userId" AS u, n."userId" AS a, count(*)::int AS c
				 FROM note_reaction r
				 JOIN note n ON n.id = r."noteId"
				 WHERE r.id >= $1 AND r."userId" <> n."userId"
				 GROUP BY r."userId", n."userId"`,
				[minId],
			) as { u: string; a: string; c: number }[];
			if (matrixRows.length === 0) {
				await this.markRun(runId, 'failed');
				return { runId, status: 'failed' };
			}

			// recommend/neighbor を計算する対象 = ローカルユーザー（行列に存在する分）。
			const localUserRows = await this.db.query(
				`SELECT DISTINCT r."userId" AS id
				 FROM note_reaction r
				 JOIN "user" u ON u.id = r."userId"
				 WHERE r.id >= $1 AND u.host IS NULL`,
				[minId],
			) as { id: string }[];

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
				?? Path.resolve(_dirname, '../../../../../scripts/hanami-foryou/rec_als.py');
			const python = process.env.HANAMI_FORYOU_PYTHON ?? 'python3';
			await execFileAsync(python, [scriptPath, inputPath, outputPath], { timeout: ALS_PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });

			// 3) 取り込み。
			const out = JSON.parse(await readFile(outputPath, 'utf8')) as AlsOutput;
			await this.ingestAlsOutput(runId, out);

			// 4) ready swap ＋ 世代落とし。
			await this.markRun(runId, 'ready');
			await this.pruneOldRuns('als');
			return { runId, status: 'ready' };
		} catch (err) {
			logger.warn(`hanami foryou: ALS python unavailable/failed, marking run failed: ${(err as Error).message}`);
			await this.markRun(runId, 'failed').catch(() => { /* ignore */ });
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
	public async markRun(runId: string, status: 'ready' | 'failed'): Promise<void> {
		await this.hanamiForYouModelRunsRepository.update({ id: runId }, { status, finishedAt: new Date() });
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

	// ───────────────────────── aux 集計（純SQL） ─────────────────────────

	/**
	 * 活動リズム（active_hour_hist・JST）とメディア/テキスト反応率を全ローカルユーザー分集計し upsert（§5/§7.3）。
	 * 最終段の弱い boost/filter（夜型 boost・text 偏重なら画像割引）のタイブレーク用（§14-D7）。
	 * active_hour_hist は本人の投稿時刻、media/text rate は反応先ノートの種別から。
	 */
	@bindThis
	public async runAuxBatch(): Promise<number> {
		const now = Date.now();
		const since = new Date(now - AUX_LOOKBACK_MS);
		const minReactionId = this.idService.gen(now - AUX_LOOKBACK_MS);

		const histRows = await this.db.query(
			`SELECT n."userId" AS uid, EXTRACT(HOUR FROM (n."createdAt" AT TIME ZONE 'Asia/Tokyo'))::int AS hr, count(*)::int AS c
			 FROM note n JOIN "user" u ON u.id = n."userId"
			 WHERE u.host IS NULL AND n."createdAt" >= $1
			 GROUP BY n."userId", hr`,
			[since],
		) as { uid: string; hr: number; c: number }[];
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
		for (const h of histRows) get(h.uid).hist[String(h.hr)] = Number(h.c);
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
		const runId = await this.createRun('embedding', { model: EMBEDDING_MODEL });
		let tmpDir: string | null = null;
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

			if (noteRows.length === 0 && tasteList.length === 0) {
				await this.markRun(runId, 'ready');
				return { runId, status: 'ready' };
			}

			const input = {
				model: EMBEDDING_MODEL,
				notes: noteRows.map(r => [r.id, r.text]),
				tasteByUser: tasteList.map(([uid, texts]) => [uid, texts]),
			};

			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-embed-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(inputPath, JSON.stringify(input), 'utf8');

			const scriptPath = process.env.HANAMI_FORYOU_CONTENT_SCRIPT
				?? Path.resolve(_dirname, '../../../../../scripts/hanami-foryou/rec_content_cpu.py');
			const python = process.env.HANAMI_FORYOU_PYTHON ?? 'python3';
			await execFileAsync(python, [scriptPath, inputPath, outputPath], { timeout: EMBEDDING_PROCESS_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });

			const out = JSON.parse(await readFile(outputPath, 'utf8')) as {
				model: string; dim: number;
				embeddings: { noteId: string; vector: number[] }[];
				centroids: { userId: string; vector: number[]; evidenceCount: number }[];
			};
			await this.ingestEmbeddingOutput(out);
			await this.markRun(runId, 'ready');
			await this.pruneOldRuns('embedding');
			return { runId, status: 'ready' };
		} catch (err) {
			logger.warn(`hanami foryou: MiniLM python unavailable/failed, marking run failed: ${(err as Error).message}`);
			await this.markRun(runId, 'failed').catch(() => { /* ignore */ });
			return { runId, status: 'failed' };
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
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
			`DELETE FROM "hanami_recommendation_event" WHERE "eventType" IN ('served','seen') AND "createdAt" < $1`,
			[servedSeenCutoff],
		);
			await this.db.query(
				`DELETE FROM "hanami_recommendation_event" WHERE "eventType" IN ('reaction','reply','renote') AND "createdAt" < $1`,
				[personalCutoff],
			);
	}
}
