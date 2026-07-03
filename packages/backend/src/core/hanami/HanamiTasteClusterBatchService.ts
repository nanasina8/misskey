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
import { HanamiTokenizerService } from '@/core/hanami/tokenize/HanamiTokenizerService.js';
import type Logger from '@/logger.js';

const execFileAsync = promisify(execFile);
const _dirname = Path.dirname(fileURLToPath(import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

// taste-clustered popular（hanami-taste-cluster-spec v0.2）。定数チューニングはここ。
export const TASTE_EMBED_MODEL = 'intfloat/multilingual-e5-base';
export const TASTE_EMBED_DIM = 768;
const TASTE_EMBED_TTL_MS = 30 * DAY_MS;
const TASTE_SWEEP_WINDOW_MS = 48 * 60 * 60 * 1000; // 新着スキャン窓（それより古い尻尾はTTL窓に入らないので追わない）
const TASTE_SWEEP_FETCH_LIMIT = 30000; // 時間予算(8分×36件/s≈17k)より広めの取得上限
const TASTE_SWEEP_TIME_BUDGET_SEC = 8 * 60; // 次の10分実行と重ならないことだけ保証
const TASTE_MIN_CHARS = 12; // クリーニング後の最低文字数（絵文字/URL/MFMのみノートの偽クラスタ汚染対策）
const TASTE_EVIDENCE_WINDOW_MS = 90 * DAY_MS;
const TASTE_EVIDENCE_CAP = 8000; // 超過はランダム間引き（reservoir近似）
const TASTE_EVIDENCE_APPEND_LIMIT = 20000; // 日次追記の上限（bootstrap時も数日で追いつく）
const TASTE_MIN_EVIDENCE = 100; // これ未満のユーザーはクラスタを作らない
const TASTE_K = 8;
const TASTE_KMEANS_USER_CHUNK = 30; // python 1回あたりのユーザー数
const TASTE_WEIGHT_CARRY_MIN_COS = 0.7;
const TASTE_EGO_OWNRATE_MAX = 0.05;
const TASTE_LABEL_TERMS = 6;
const TASTE_LABEL_CLUSTER_SAMPLE = 120; // ラベル計算に使うクラスタ内テキスト数
const TASTE_MEANVEC_SAMPLE = 5000;
const TASTE_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;

type KmeansOutUser = {
	userId: string;
	k: number;
	centroids: number[][];
	assignment: number[];
	examples: number[][];
};

/** float32 → IEEE754 half(fp16) bits。埋め込みは正規化済み[-1,1]なので丸め誤差は無視できる。 */
function float32ToFloat16Bits(val: number): number {
	f32[0] = val;
	const x = u32[0];
	const sign = (x >>> 16) & 0x8000;
	const exp = (x >>> 23) & 0xff;
	let frac = x & 0x7fffff;
	if (exp === 0xff) return sign | 0x7c00 | (frac ? 0x200 : 0);
	const e = exp - 127 + 15;
	if (e >= 0x1f) return sign | 0x7c00;
	if (e <= 0) {
		if (e < -10) return sign;
		frac |= 0x800000;
		return sign | (frac >> (14 - e));
	}
	return sign | (e << 10) | (frac >> 13);
}
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function encodeFp16(vec: number[]): Buffer {
	const buf = Buffer.allocUnsafe(vec.length * 2);
	for (let i = 0; i < vec.length; i++) buf.writeUInt16LE(float32ToFloat16Bits(vec[i]), i * 2);
	return buf;
}

/**
 * taste-clustered popular のオフラインバッチ（spec v0.2 §1）。
 *
 * - **runTasteSweep（10分間隔）**: 未埋め込みノートを新しい順に e5 で埋め込む。件数上限なし・時間予算のみ。
 *   バースト時も直近ノートが常に先に埋まり、溢れた古い尻尾は次回実行が拾う（リアルタイム優先）。
 * - **runTasteClusterBatch（日次）**: evidence 追記（保存済み埋め込みのコピーのみ・再埋め込みゼロ）→
 *   TTL/cap 整理 → mean_vec 更新 → ユーザーごと k-means → ラベル/代表例/ownRate → 全置換（weight引き継ぎ）。
 */
@Injectable()
export class HanamiTasteClusterBatchService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		private idService: IdService,
		private hanamiTokenizerService: HanamiTokenizerService,
	) {
	}

	/** 埋め込み対象のクリーニング（トークナイザ共通cleanを流用し空白を潰す）。 */
	private cleanForEmbedding(text: string): string {
		return this.hanamiTokenizerService.clean(text).replace(/\s+/g, ' ').trim();
	}

	// ───────────────────────── 10分スイープ ─────────────────────────

	@bindThis
	public async runTasteSweep(logger: Logger): Promise<{ processed: number; skipped: number; backlog: number }> {
		const sinceId = this.idService.gen(Date.now() - TASTE_SWEEP_WINDOW_MS);
		const rows = await this.db.query(
			`SELECT n.id AS id, n.text AS text
			 FROM note n
			 LEFT JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 WHERE n.id >= $2 AND n.visibility IN ('public','home') AND n."channelId" IS NULL
			   AND n.text IS NOT NULL AND e."noteId" IS NULL
			 ORDER BY n.id DESC
			 LIMIT $3`,
			[TASTE_EMBED_MODEL, sinceId, TASTE_SWEEP_FETCH_LIMIT],
		) as { id: string; text: string }[];

		// クリーニング後に短すぎるノートは埋め込まない。ただし再スキャンで毎回引っかからないよう
		// 空ベクトルのプレースホルダは持たず、単に対象外として捨てる（LEFT JOIN で再抽出されるが件数は小さい）。
		const texts: [string, string][] = [];
		for (const r of rows) {
			const cleaned = this.cleanForEmbedding(r.text);
			if (cleaned.length >= TASTE_MIN_CHARS) texts.push([r.id, cleaned]);
		}
		if (texts.length === 0) return { processed: 0, skipped: rows.length, backlog: 0 };

		let tmpDir: string | null = null;
		try {
			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-taste-embed-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(inputPath, JSON.stringify({ model: TASTE_EMBED_MODEL, timeBudgetSec: TASTE_SWEEP_TIME_BUDGET_SEC, texts }), 'utf8');

			const scriptPath = process.env.HANAMI_TASTE_EMBED_SCRIPT
				?? Path.resolve(_dirname, '../../../../../scripts/hanami-foryou/taste_embed_sweep.py');
			const python = process.env.HANAMI_FORYOU_PYTHON ?? 'python3';
			await execFileAsync(python, [scriptPath, inputPath, outputPath], { timeout: TASTE_PROCESS_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });

			const out = JSON.parse(await readFile(outputPath, 'utf8')) as { dim: number; processed: number; embeddings: [string, number[]][] };
			const updatedAt = new Date();
			const chunk = 200;
			for (let i = 0; i < out.embeddings.length; i += chunk) {
				const slice = out.embeddings.slice(i, i + chunk);
				const values: string[] = [];
				const params: unknown[] = [];
				for (const [noteId, vec] of slice) {
					const base = params.length;
					values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
					params.push(noteId, TASTE_EMBED_MODEL, out.dim, `{${vec.join(',')}}`, updatedAt);
				}
				await this.db.query(
					`INSERT INTO "hanami_note_embedding" ("noteId", model, dim, embedding, "updatedAt")
					 VALUES ${values.join(',')}
					 ON CONFLICT ("noteId", model) DO NOTHING`,
					params,
				);
			}

			// backlog = 時間予算で今回埋めきれなかった分（新しい順なので残りは古い尻尾）。
			const backlog = texts.length - out.processed;
			logger.info(`hanami taste sweep: embedded ${out.processed}, backlog ${backlog}${rows.length >= TASTE_SWEEP_FETCH_LIMIT ? '+' : ''}`);
			return { processed: out.processed, skipped: rows.length - texts.length, backlog };
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	// ───────────────────────── 日次クラスタバッチ ─────────────────────────

	@bindThis
	public async runTasteClusterBatch(logger: Logger): Promise<{ users: number }> {
		const now = Date.now();

		// 0) e5 埋め込みの TTL 整理（30日）。
		await this.db.query(
			`DELETE FROM "hanami_note_embedding" WHERE model = $1 AND "updatedAt" < $2`,
			[TASTE_EMBED_MODEL, new Date(now - TASTE_EMBED_TTL_MS)],
		);

		// 1) 対象ユーザー = 90日活動量（リアクション＋text投稿）>= 閾値 のローカルユーザー。
		const since90 = this.idService.gen(now - TASTE_EVIDENCE_WINDOW_MS);
		const eligible = await this.db.query(
			`SELECT u.id AS id, u.username AS username, u.name AS name
			 FROM "user" u
			 WHERE u.host IS NULL AND u."isSuspended" = FALSE
			   AND (
			     (SELECT count(*) FROM note_reaction r WHERE r."userId" = u.id AND r.id >= $1)
			     + (SELECT count(*) FROM note n WHERE n."userId" = u.id AND n.id >= $1 AND n.text IS NOT NULL)
			   ) >= $2`,
			[since90, TASTE_MIN_EVIDENCE],
		) as { id: string; username: string; name: string | null }[];
		if (eligible.length === 0) return { users: 0 };
		const eligibleIds = eligible.map(u => u.id);

		// 2) evidence 追記（R=リアクション先 / W=自投稿。保存済み埋め込みの fp16 コピーのみ）。
		await this.appendEvidence(since90, eligibleIds, logger);

		// 3) TTL・cap 整理。
		await this.db.query(`DELETE FROM "hanami_foryou_taste_evidence" WHERE "createdAt" < $1`, [new Date(now - TASTE_EVIDENCE_WINDOW_MS)]);
		const over = await this.db.query(
			`SELECT "userId" AS id, count(*)::int AS c FROM "hanami_foryou_taste_evidence" GROUP BY 1 HAVING count(*) > $1`,
			[TASTE_EVIDENCE_CAP],
		) as { id: string; c: number }[];
		for (const o of over) {
			await this.db.query(
				`DELETE FROM "hanami_foryou_taste_evidence"
				 WHERE ("userId", "noteId") IN (
				   SELECT "userId", "noteId" FROM "hanami_foryou_taste_evidence" WHERE "userId" = $1 ORDER BY random() LIMIT $2
				 )`,
				[o.id, o.c - TASTE_EVIDENCE_CAP],
			);
		}

		// 4) mean_vec 更新（直近埋め込みの平均。クラスタ学習と serve の候補割当で共有）。
		const meanVec = await this.updateMeanVec();
		if (meanVec == null) {
			logger.warn('hanami taste cluster: no embeddings yet, skip clustering');
			return { users: 0 };
		}

		// 5) evidence が十分なユーザーを k-means（pythonへはユーザー30人ずつ）。
		const targets = await this.db.query(
			`SELECT "userId" AS id, count(*)::int AS c FROM "hanami_foryou_taste_evidence"
			 WHERE "userId" = ANY($1) GROUP BY 1 HAVING count(*) >= $2`,
			[eligibleIds, TASTE_MIN_EVIDENCE],
		) as { id: string; c: number }[];
		const userMeta = new Map(eligible.map(u => [u.id, u]));

		let done = 0;
		for (let i = 0; i < targets.length; i += TASTE_KMEANS_USER_CHUNK) {
			const chunkUsers = targets.slice(i, i + TASTE_KMEANS_USER_CHUNK).map(t => t.id);
			try {
				done += await this.clusterUserChunk(chunkUsers, meanVec, userMeta, logger);
			} catch (err) {
				logger.warn(`hanami taste cluster: chunk failed: ${(err as Error).message}`);
			}
		}
		logger.info(`hanami taste cluster: rebuilt clusters for ${done}/${targets.length} users`);
		return { users: done };
	}

	private async appendEvidence(since90: string, eligibleIds: string[], logger: Logger): Promise<void> {
		// R: リアクション先。
		const rRows = await this.db.query(
			`SELECT r."userId" AS uid, n.id AS nid, e.embedding AS emb
			 FROM note_reaction r
			 JOIN note n ON n.id = r."noteId"
			 JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 LEFT JOIN "hanami_foryou_taste_evidence" ev ON ev."userId" = r."userId" AND ev."noteId" = n.id
			 WHERE r.id >= $2 AND r."userId" = ANY($3) AND r."userId" <> n."userId" AND ev."noteId" IS NULL
			 LIMIT $4`,
			[TASTE_EMBED_MODEL, since90, eligibleIds, TASTE_EVIDENCE_APPEND_LIMIT],
		) as { uid: string; nid: string; emb: number[] }[];
		// W: 自投稿。
		const wRows = await this.db.query(
			`SELECT n."userId" AS uid, n.id AS nid, e.embedding AS emb
			 FROM note n
			 JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 LEFT JOIN "hanami_foryou_taste_evidence" ev ON ev."userId" = n."userId" AND ev."noteId" = n.id
			 WHERE n.id >= $2 AND n."userId" = ANY($3) AND ev."noteId" IS NULL
			 LIMIT $4`,
			[TASTE_EMBED_MODEL, since90, eligibleIds, TASTE_EVIDENCE_APPEND_LIMIT],
		) as { uid: string; nid: string; emb: number[] }[];

		const insert = async (rows: { uid: string; nid: string; emb: number[] }[], src: 'R' | 'W') => {
			const chunk = 500;
			for (let i = 0; i < rows.length; i += chunk) {
				const slice = rows.slice(i, i + chunk);
				const values: string[] = [];
				const params: unknown[] = [];
				for (const r of slice) {
					const base = params.length;
					values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
					params.push(r.uid, r.nid, encodeFp16(r.emb), src, this.idService.parse(r.nid).date);
				}
				await this.db.query(
					`INSERT INTO "hanami_foryou_taste_evidence" ("userId", "noteId", vector, src, "createdAt")
					 VALUES ${values.join(',')}
					 ON CONFLICT ("userId", "noteId") DO NOTHING`,
					params,
				);
			}
		};
		await insert(rRows, 'R');
		await insert(wRows, 'W');
		logger.info(`hanami taste cluster: evidence appended R=${rRows.length} W=${wRows.length}`);
	}

	private async updateMeanVec(): Promise<number[] | null> {
		const rows = await this.db.query(
			`SELECT embedding FROM "hanami_note_embedding" WHERE model = $1 ORDER BY "noteId" DESC LIMIT $2`,
			[TASTE_EMBED_MODEL, TASTE_MEANVEC_SAMPLE],
		) as { embedding: number[] }[];
		if (rows.length < 100) return null;
		const mean = new Array<number>(TASTE_EMBED_DIM).fill(0);
		for (const r of rows) {
			for (let i = 0; i < TASTE_EMBED_DIM; i++) mean[i] += r.embedding[i] ?? 0;
		}
		for (let i = 0; i < TASTE_EMBED_DIM; i++) mean[i] /= rows.length;
		await this.db.query(
			`INSERT INTO "hanami_foryou_taste_state" (model, "meanVec", "updatedAt") VALUES ($1, $2, $3)
			 ON CONFLICT (model) DO UPDATE SET "meanVec" = EXCLUDED."meanVec", "updatedAt" = EXCLUDED."updatedAt"`,
			[TASTE_EMBED_MODEL, `{${mean.map(v => v.toFixed(7)).join(',')}}`, new Date()],
		);
		return mean;
	}

	private async clusterUserChunk(userIds: string[], meanVec: number[], userMeta: Map<string, { username: string; name: string | null }>, logger: Logger): Promise<number> {
		// evidence をユーザーごとに読み、fp16 のまま1本のバイナリへ連結。
		const users: { userId: string; offset: number; count: number; noteIds: string[]; srcs: string[] }[] = [];
		const buffers: Buffer[] = [];
		let offset = 0;
		for (const uid of userIds) {
			const rows = await this.db.query(
				`SELECT "noteId", vector, src FROM "hanami_foryou_taste_evidence" WHERE "userId" = $1 ORDER BY "noteId"`,
				[uid],
			) as { noteId: string; vector: Buffer; src: string }[];
			if (rows.length < TASTE_MIN_EVIDENCE) continue;
			for (const r of rows) buffers.push(r.vector);
			users.push({ userId: uid, offset, count: rows.length, noteIds: rows.map(r => r.noteId), srcs: rows.map(r => r.src) });
			offset += rows.length;
		}
		if (users.length === 0) return 0;

		let tmpDir: string | null = null;
		let out: { users: KmeansOutUser[] };
		try {
			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-taste-kmeans-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const binPath = Path.join(tmpDir, 'vectors.bin');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(binPath, Buffer.concat(buffers));
			await writeFile(inputPath, JSON.stringify({
				k: TASTE_K, dim: TASTE_EMBED_DIM, meanVec,
				users: users.map(u => ({ userId: u.userId, offset: u.offset, count: u.count })),
			}), 'utf8');

			const scriptPath = process.env.HANAMI_TASTE_KMEANS_SCRIPT
				?? Path.resolve(_dirname, '../../../../../scripts/hanami-foryou/taste_kmeans.py');
			const python = process.env.HANAMI_FORYOU_PYTHON ?? 'python3';
			await execFileAsync(python, [scriptPath, inputPath, binPath, outputPath], { timeout: TASTE_PROCESS_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
			out = JSON.parse(await readFile(outputPath, 'utf8')) as { users: KmeansOutUser[] };
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}

		const byUser = new Map(users.map(u => [u.userId, u]));
		let done = 0;
		for (const res of out.users) {
			const u = byUser.get(res.userId);
			if (u == null) continue;
			try {
				await this.ingestUserClusters(res, u, userMeta.get(res.userId), logger);
				done++;
			} catch (err) {
				logger.warn(`hanami taste cluster: ingest failed for ${res.userId}: ${(err as Error).message}`);
			}
		}
		return done;
	}

	private async ingestUserClusters(
		res: KmeansOutUser,
		evidence: { noteIds: string[]; srcs: string[] },
		meta: { username: string; name: string | null } | undefined,
		logger: Logger,
	): Promise<void> {
		// クラスタごとの所属 index。
		const members: number[][] = Array.from({ length: res.k }, () => []);
		for (let i = 0; i < res.assignment.length; i++) members[res.assignment[i]]?.push(i);

		// ラベル: クラスタ内サンプル vs ユーザー全体の log-odds（既存 Lindera トークナイザの topic 名詞）。
		const sampleIdx = new Set<number>();
		for (const m of members) for (const i of m.slice(0, TASTE_LABEL_CLUSTER_SAMPLE)) sampleIdx.add(i);
		const idToText = new Map<string, string>();
		{
			const ids = [...sampleIdx].map(i => evidence.noteIds[i]);
			const chunk = 1000;
			for (let i = 0; i < ids.length; i += chunk) {
				const rows = await this.db.query(
					'SELECT id, text FROM note WHERE id = ANY($1)',
					[ids.slice(i, i + chunk)],
				) as { id: string; text: string | null }[];
				for (const r of rows) if (r.text != null) idToText.set(r.id, r.text);
			}
		}
		const tokensByIdx = new Map<number, Set<string>>();
		for (const i of sampleIdx) {
			const text = idToText.get(evidence.noteIds[i]);
			if (text == null) continue;
			tokensByIdx.set(i, new Set(await this.hanamiTokenizerService.tokenize(text)));
		}
		const bgCounts = new Map<string, number>();
		for (const toks of tokensByIdx.values()) {
			for (const t of toks) bgCounts.set(t, (bgCounts.get(t) ?? 0) + 1);
		}
		const nBg = tokensByIdx.size || 1;

		const labelsOf = (idxs: number[]): string[] => {
			const counts = new Map<string, number>();
			let n = 0;
			for (const i of idxs.slice(0, TASTE_LABEL_CLUSTER_SAMPLE)) {
				const toks = tokensByIdx.get(i);
				if (toks == null) continue;
				n++;
				for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
			}
			if (n === 0) return [];
			const minDf = Math.max(3, Math.floor(n / 50));
			const scored: [number, string][] = [];
			for (const [t, f] of counts) {
				if (f < minDf) continue;
				const b = bgCounts.get(t) ?? 0;
				const lo = Math.log((f + 0.5) / (n - f + 0.5)) - Math.log((b + 0.5) / (nBg - b + 0.5));
				scored.push([lo, t]);
			}
			scored.sort((a, b) => b[0] - a[0]);
			return scored.slice(0, TASTE_LABEL_TERMS).map(([, t]) => t);
		};

		// 旧クラスタ（weight 引き継ぎ用）。
		const oldRows = await this.db.query(
			`SELECT "clusterId", centroid, "userWeight" FROM "hanami_foryou_user_taste_cluster" WHERE "userId" = $1`,
			[res.userId],
		) as { clusterId: number; centroid: number[]; userWeight: number }[];
		const carryWeight = (centroid: number[]): number | null => {
			let best = TASTE_WEIGHT_CARRY_MIN_COS;
			let weight: number | null = null;
			for (const old of oldRows) {
				let dot = 0;
				const len = Math.min(centroid.length, old.centroid.length);
				for (let i = 0; i < len; i++) dot += centroid[i] * old.centroid[i];
				if (dot >= best) { best = dot; weight = Number(old.userWeight); }
			}
			return weight;
		};

		const usernameLower = meta?.username?.toLowerCase() ?? '';
		const nameLower = meta?.name?.toLowerCase() ?? '';
		const updatedAt = new Date();
		const rows: { clusterId: number; centroid: string; size: number; ownRate: number; labelTerms: string[]; exampleNoteIds: string[]; userWeight: number }[] = [];
		for (let k = 0; k < res.k; k++) {
			const idxs = members[k];
			if (idxs.length === 0) continue;
			const ownRate = idxs.filter(i => evidence.srcs[i] === 'W').length / idxs.length;
			const labelTerms = labelsOf(idxs);
			const carried = carryWeight(res.centroids[k]);
			// エゴサクラスタ（自分への言及）は好みではないので既定で非表示（§1.3-5）。ユーザー操作は最優先。
			const isEgo = ownRate < TASTE_EGO_OWNRATE_MAX && usernameLower !== '' && labelTerms.some(t => {
				const tl = t.toLowerCase();
				return tl.includes(usernameLower) || (nameLower !== '' && tl.includes(nameLower));
			});
			rows.push({
				clusterId: k,
				centroid: `{${res.centroids[k].join(',')}}`,
				size: idxs.length,
				ownRate,
				labelTerms,
				exampleNoteIds: res.examples[k]?.map(i => evidence.noteIds[i]) ?? [],
				userWeight: carried ?? (isEgo ? 0 : 1),
			});
		}

		await this.db.transaction(async em => {
			await em.query(`DELETE FROM "hanami_foryou_user_taste_cluster" WHERE "userId" = $1`, [res.userId]);
			for (const r of rows) {
				await em.query(
					`INSERT INTO "hanami_foryou_user_taste_cluster"
					 ("userId", "clusterId", centroid, size, "ownRate", "labelTerms", "exampleNoteIds", "userWeight", "updatedAt")
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[res.userId, r.clusterId, r.centroid, r.size, r.ownRate, r.labelTerms, r.exampleNoteIds, r.userWeight, updatedAt],
				);
			}
		});
		logger.debug?.(`hanami taste cluster: user ${res.userId} k=${res.k}`);
	}
}
