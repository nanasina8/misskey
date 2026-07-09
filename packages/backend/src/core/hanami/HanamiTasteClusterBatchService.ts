/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { HanamiTokenizerService } from '@/core/hanami/tokenize/HanamiTokenizerService.js';
import * as mfm from 'mfm-js';
import { HANAMI_TASTE_MATCH_KEY_PREFIX, HANAMI_TASTE_MATCH_META_KEY_PREFIX, HANAMI_RECENT_ACT_KEY_PREFIX, HANAMI_FORYOU_ACTIVE_KEY_PREFIX } from '@/core/hanami/HanamiForYouKeys.js';
import { pureRenoteSql } from '@/misc/is-renote.js';
import type Logger from '@/logger.js';

const execFileAsync = promisify(execFile);
const _dirname = Path.dirname(fileURLToPath(import.meta.url));

/**
 * MFM を mfm-js でパースして本文だけ抽出する（v0.7 敵対レビューR2-H2:
 * 旧 clean() の `$\[[^\]]*\]` はネスト MFM で破綻し `<center ]] ]` のような装飾残骸が
 * 高cosで埋め込まれ、装飾クラスタが軸上位を占拠していた。ダンプ実測 top20 の 16/20 が装飾残骸）。
 * text/unicodeEmoji/hashtag のみ本文扱い。url/mention/emojiCode/code/math/search は落とす。
 * パース失敗時は素の text にフォールバック（下段の clean が記号を落とす）。純関数（unit test 用に export）。
 */
export function extractMfmText(text: string): string {
	try {
		const out: string[] = [];
		const walk = (nodes: mfm.MfmNode[]): void => {
			for (const n of nodes) {
				if (n.type === 'text') out.push(n.props.text);
				else if (n.type === 'unicodeEmoji') out.push(n.props.emoji);
				else if (n.type === 'hashtag') out.push(n.props.hashtag); // 話題語として本文扱い
				else if ('children' in n && n.children != null) walk(n.children as mfm.MfmNode[]);
			}
		};
		walk(mfm.parse(text));
		return out.join(' ');
	} catch {
		return text;
	}
}

/** 「内容文字」（Letter/Number）だけを数える。絵文字連打・記号のみは0（v0.7 R3）。純関数（unit test 用に export）。 */
export function contentCharCount(s: string): number {
	return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// taste-clustered popular（hanami-taste-cluster-spec v0.2）。定数チューニングはここ。
export const TASTE_EMBED_MODEL = 'intfloat/multilingual-e5-base';
export const TASTE_EMBED_DIM = 768;
const TASTE_EMBED_TTL_MS = 30 * DAY_MS;
const TASTE_SWEEP_WINDOW_MS = 48 * 60 * 60 * 1000; // 新着スキャン窓（それより古い尻尾はTTL窓に入らないので追わない）
const TASTE_SWEEP_FETCH_LIMIT = 30000; // 時間予算(8分×36件/s≈17k)より広めの取得上限
const TASTE_SWEEP_TIME_BUDGET_SEC = 8 * 60; // 次の10分実行と重ならないことだけ保証
const TASTE_MIN_CHARS = 12; // クリーニング後の最低「内容文字」数（絵文字/URL/MFMのみノートの偽クラスタ汚染対策。v0.7 R3: 単純lengthでなく Letter/Number を数える＝絵文字連打・ゼロ幅のみを弾く）
// evidence は日付でなく「ノート数」で切る（v0.3）: 基準30件/日 × 90日 = 最新2,700件/人。
// ヘビーユーザーは実質90日窓と同等の鮮度、ライトユーザーは何年でも遡って材料を確保できる。
const TASTE_EVIDENCE_BASE_PER_DAY = 30;
const TASTE_EVIDENCE_BASE_DAYS = 90;
const TASTE_EVIDENCE_TARGET = TASTE_EVIDENCE_BASE_PER_DAY * TASTE_EVIDENCE_BASE_DAYS; // 2,700
const TASTE_EVIDENCE_APPEND_WINDOW_MS = 30 * DAY_MS; // 日次追記の走査窓（埋め込みTTLと同じ。過去分はbootstrapが担う）
const TASTE_EVIDENCE_APPEND_LIMIT = 20000; // 日次追記の上限（bootstrap時も数日で追いつく）
const TASTE_MIN_EVIDENCE = 100; // これ未満のユーザーはクラスタを作らない
const TASTE_K = 8;
const TASTE_KMEANS_USER_CHUNK = 30; // python 1回あたりのユーザー数
const TASTE_WEIGHT_CARRY_MIN_COS = 0.7;
const TASTE_EGO_OWNRATE_MAX = 0.05;
const TASTE_LABEL_TERMS = 6;
const TASTE_LABEL_CLUSTER_SAMPLE = 120; // ラベル計算に使うクラスタ内テキスト数
const TASTE_MEANVEC_SAMPLE = 5000;
const TASTE_MEANVEC_PER_USER_CAP = 20; // 1ユーザーの mean_vec への寄与上限（連投で基準点を押されないため）
const TASTE_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;

// reactionSimilar（興味マッチ新着）の事前計算。人気条件なしの全新着×クラスタcentroid照合。
// τ は人気枠（TASTE_TAU_ASSIGN=0.25）より大幅に高め: 母集団が「人気200件」でなく「全新着」なので、
// 低い閾値だと雑談の尻尾が大量に入りノイズ軸になる（2026-07-07 ダンプ実測: 0.35→1,151件/日で
// top-N キャップ側が効いて弱マッチが残る。0.5→162件/日＝日次 p95 相当で軸の量としても十分）。
export const TASTE_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000; // serve 側の窓外ガードと共有
const TASTE_MATCH_TAU = 0.5;
const TASTE_MATCH_TOP_N = 300;
const TASTE_MATCH_KEY_TTL_SEC = 48 * 60 * 60; // バッチ停止時に古い推薦が残り続けない保険
// zset score は cos でなく cos×鮮度（v0.6 敵対レビュー#6）: cos 順だと強マッチが24h上位に居座り、
// TOP_N が効く状況で新着の弱マッチが候補集合に入れない。毎10分フル再計算なので鮮度は自然に更新される。
const TASTE_MATCH_FRESHNESS_BUCKETS: { withinMs: number; weight: number }[] = [
	{ withinMs: 6 * 60 * 60 * 1000, weight: 1.0 },
	{ withinMs: 12 * 60 * 60 * 1000, weight: 0.9 },
];
const TASTE_MATCH_FRESHNESS_FLOOR = 0.75;
// 同一作者の連投/コピペが TOP_N を占領する経路を塞ぐ（v0.6 #12。ページ側の作者cap=2とは別に候補段で切る）。
const TASTE_MATCH_AUTHOR_CAP = 3;
// 短期興味レイヤー（spec §9.8.6）。
const RECENT_WINDOW = 72 * 60 * 60 * 1000;
const RECENT_HALF_LIFE = 24 * 60 * 60 * 1000;
const RECENT_KIND_W = { r: 1.0, n: 1.0, p: 0.8 } as const;
const RECENT_MIN_ACTIONS = 3;
const TAU_RECENT = 0.35;
const TAU_ASSIGN = 0.25;
const HEAT_AUTHOR_CAP = 3.0;
const RECENT_BACKFILL_MAX = 200;
const RECENT_BACKFILL_TIME_BUDGET_SEC = 60;
// 多重実行ガード（v0.6 #3 / v0.7 R3: match だけでなく sweep も含む tick 全体を1ロックで覆う。
// 複数 worker/手動起動で 8分予算の python sweep が並走すると CPU/RAM を二重消費するため）。
// TTL は最悪実行時間（python timeout 30分）＋余裕（v0.7 R4: 10分周期より短い 9.5分だと、実行が
// 周期を跨いだ瞬間に次 tick が NX を通ってしまい重複ガードにならない）。正常/timeout 終了時は
// finally の Lua 解放で即座に空くので、TTL が長くても平常のスループットには影響しない。
// TTL まで塞がるのはプロセス即死時のみ（最大3-4 tick スキップ後に自己回復）。
const TASTE_TICK_LOCK_KEY = 'hanami:taste:tick:lock';
const TASTE_TICK_LOCK_TTL_SEC = 35 * 60;
const TASTE_MATCH_SLOW_WARN_MS = 60 * 1000; // これを超えたらスケール対策（ANN/差分化）検討のサイン
const TASTE_REBUILD_STATUS_KEY = 'hanami:taste:rebuild:status';
const TASTE_REBUILD_STATUS_TTL_SEC = 7 * 24 * 60 * 60;
const TASTE_REBUILD_RUNNING_FRESH_MS = 10 * 60 * 1000;
const TASTE_REBUILD_DELAY_MS = 30 * 1000;
const TASTE_REBUILD_LOCK_RETRY_MS = 60 * 1000;
const TASTE_REBUILD_TIME_BUDGET_SEC = 4 * 60;
const TASTE_REBUILD_EMBED_TIME_BUDGET_SEC = 220;
const TASTE_REBUILD_DEFAULT_CHUNK = 500;

type KmeansOutUser = {
	userId: string;
	k: number;
	centroids: number[][];
	assignment: number[];
	examples: number[][];
};

type RecentActKind = keyof typeof RECENT_KIND_W;

type TasteClusterRow = {
	uid: string;
	cid: number;
	centroid: number[];
	userWeight: number;
};

type TasteClusterForMatch = {
	cid: number;
	userWeight: number;
	centroid: Float32Array;
};

type RecentAction = {
	noteId: string;
	kind: RecentActKind;
	actionMs: number;
	weight: number;
};

type RecentActionsByUser = {
	actionsByUser: Map<string, RecentAction[]>;
	usersWithRecentKey: Set<string>;
};

type RecentUserInterest = {
	recentVec: Float32Array | null;
	totalHeat: number;
	heatByCluster: Map<number, number>;
};

type RecentInterestResult = {
	byUser: Map<string, RecentUserInterest>;
	recentUsers: number;
	recentActions: number;
};

export type HanamiTasteRebuildPhase = 'embeddings' | 'evidence';
export type HanamiTasteRebuildStats = {
	reembedded: number;
	purged: number;
	evidenceUpdated: number;
	evidencePurged: number;
};
export type HanamiTasteRebuildJobData = {
	phase: HanamiTasteRebuildPhase;
	cursor: string | null;
	stats: HanamiTasteRebuildStats;
	startedAt: number;
};
export type HanamiTasteRebuildStatus = {
	state: 'idle' | 'running' | 'done' | 'error';
	phase: HanamiTasteRebuildPhase | null;
	reembedded: number;
	purged: number;
	evidenceUpdated: number;
	evidencePurged: number;
	startedAt: number | null;
	updatedAt: number | null;
	error: string | null;
};
export type HanamiTasteRebuildChunkResult =
	| { action: 'retry'; delayMs: number; data: HanamiTasteRebuildJobData }
	| { action: 'continue'; delayMs: number; data: HanamiTasteRebuildJobData }
	| { action: 'cluster'; data: HanamiTasteRebuildJobData };

export class HanamiTasteRebuildAlreadyRunningError extends Error {
	constructor() {
		super('hanami taste rebuild is already running');
		this.name = 'HanamiTasteRebuildAlreadyRunningError';
	}
}

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
	private loggedTastePythonThreads = false;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private idService: IdService,
		private hanamiTokenizerService: HanamiTokenizerService,
	) {
	}

	/**
	 * 埋め込み対象のクリーニング。
	 * MFM は正規表現でなく mfm-js でパースして本文だけ抽出する（v0.7 敵対レビューR2-H2:
	 * clean() の `$\[[^\]]*\]` はネスト MFM で破綻し `<center ]] ]` のような装飾残骸が
	 * 高cosで埋め込まれ、装飾クラスタが軸上位を占拠していた。ダンプ実測 top20 の 16/20 が装飾残骸）。
	 * パース失敗時は素の text にフォールバック（従来 clean が下段で記号を落とす）。
	 */
	private cleanForEmbedding(text: string): string {
		return this.hanamiTokenizerService.clean(extractMfmText(text))
			.replace(/[\p{Cf}\u{FE00}-\u{FE0F}]/gu, '') // ゼロ幅/結合子/異体字セレクタ（不可視のみ投稿対策。v0.7 R3）
			.replace(/\s+/g, ' ')
			.trim();
	}

	private tasteRebuildChunkLimit(): number {
		const n = Number(process.env.HANAMI_TASTE_REBUILD_CHUNK ?? TASTE_REBUILD_DEFAULT_CHUNK);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : TASTE_REBUILD_DEFAULT_CHUNK;
	}

	private async acquireTasteTickLock(): Promise<string | null> {
		const lockToken = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
		const lock = await this.redisClient.set(TASTE_TICK_LOCK_KEY, lockToken, 'EX', TASTE_TICK_LOCK_TTL_SEC, 'NX');
		return lock == null ? null : lockToken;
	}

	private async releaseTasteTickLock(lockToken: string): Promise<void> {
		await this.redisClient.eval(
			'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
			1, TASTE_TICK_LOCK_KEY, lockToken,
		).catch(() => { /* TTLで解ける */ });
	}

	private tastePythonMaxThreads(): number {
		const configured = Number(process.env.HANAMI_TASTE_MAX_THREADS);
		if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
		return Math.max(1, Math.floor(cpus().length / 2));
	}

	private tastePythonEnv(logger?: Logger): NodeJS.ProcessEnv {
		const maxThreads = String(this.tastePythonMaxThreads());
		const env = { ...process.env };
		for (const name of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) {
			if (env[name] == null || env[name] === '') env[name] = maxThreads;
		}
		if (!this.loggedTastePythonThreads) {
			this.loggedTastePythonThreads = true;
			logger?.info(`hanami taste python threads: ${maxThreads} default (nproc=${cpus().length}, explicit env is respected)`);
		}
		return env;
	}

	private async loadTasteClusterRows(): Promise<TasteClusterRow[]> {
		return await this.db.query(
			`SELECT c."userId" AS uid, c."clusterId" AS cid, c.centroid AS centroid, c."userWeight" AS "userWeight"
			 FROM "hanami_foryou_user_taste_cluster" c
			 JOIN "user_profile" p ON p."userId" = c."userId"
			 WHERE c.model = $1 AND p."hanamiRecommendationEnabled" = TRUE`,
			[TASTE_EMBED_MODEL],
		) as TasteClusterRow[];
	}

	private async filterActiveTasteUserIds(uids: string[]): Promise<Set<string>> {
		const unique = [...new Set(uids)];
		const active = new Set<string>();
		if (unique.length === 0) return active;
		const existsPipeline = this.redisClient.pipeline();
		for (const uid of unique) existsPipeline.exists(HANAMI_FORYOU_ACTIVE_KEY_PREFIX + uid);
		const existsRes = await existsPipeline.exec();
		for (let i = 0; i < unique.length; i++) {
			if (existsRes?.[i]?.[1] === 1) active.add(unique[i]);
		}
		return active;
	}

	private clustersByActiveUser(clusterRows: TasteClusterRow[], activeUids: ReadonlySet<string>): Map<string, TasteClusterForMatch[]> {
		const byUser = new Map<string, TasteClusterForMatch[]>();
		for (const c of clusterRows) {
			if (!activeUids.has(c.uid)) continue;
			let arr = byUser.get(c.uid);
			if (arr == null) { arr = []; byUser.set(c.uid, arr); }
			arr.push({ cid: c.cid, userWeight: Number(c.userWeight), centroid: Float32Array.from(c.centroid) });
		}
		return byUser;
	}

	private parseRecentActionMember(member: string): { noteId: string; kind: RecentActKind } | null {
		const i = member.lastIndexOf(':');
		if (i <= 0) return null;
		const kind = member.slice(i + 1);
		if (kind !== 'r' && kind !== 'n' && kind !== 'p') return null;
		return { noteId: member.slice(0, i), kind };
	}

	private recentActionWeight(kind: RecentActKind, actionMs: number, now: number): number {
		const elapsed = Math.max(0, now - actionMs);
		if (elapsed > RECENT_WINDOW) return 0;
		return RECENT_KIND_W[kind] * Math.pow(0.5, elapsed / RECENT_HALF_LIFE);
	}

	private async loadRecentActionsByUser(activeUids: Iterable<string>, now: number): Promise<RecentActionsByUser> {
		const uids = [...activeUids];
		const usersWithRecentKey = new Set<string>();
		const actionsByUser = new Map<string, RecentAction[]>();
		if (uids.length === 0) return { actionsByUser, usersWithRecentKey };

		const existsPipeline = this.redisClient.pipeline();
		for (const uid of uids) existsPipeline.exists(HANAMI_RECENT_ACT_KEY_PREFIX + uid);
		const existsRes = await existsPipeline.exec();
		const recentUids: string[] = [];
		for (let i = 0; i < uids.length; i++) {
			if (existsRes?.[i]?.[1] === 1) {
				recentUids.push(uids[i]);
				usersWithRecentKey.add(uids[i]);
			}
		}
		if (recentUids.length === 0) return { actionsByUser, usersWithRecentKey };

		const actionPipeline = this.redisClient.pipeline();
		const floor = now - RECENT_WINDOW;
		for (const uid of recentUids) actionPipeline.zrangebyscore(HANAMI_RECENT_ACT_KEY_PREFIX + uid, floor, '+inf', 'WITHSCORES');
		const actionRes = await actionPipeline.exec();
		for (let i = 0; i < recentUids.length; i++) {
			const raw = actionRes?.[i]?.[1] as string[] | undefined;
			const actions: RecentAction[] = [];
			if (Array.isArray(raw)) {
				for (let j = 0; j + 1 < raw.length; j += 2) {
					const parsed = this.parseRecentActionMember(raw[j]);
					if (parsed == null) continue;
					const actionMs = Number(raw[j + 1]);
					if (!Number.isFinite(actionMs)) continue;
					const weight = this.recentActionWeight(parsed.kind, actionMs, now);
					if (weight <= 0) continue;
					actions.push({ noteId: parsed.noteId, kind: parsed.kind, actionMs, weight });
				}
			}
			actionsByUser.set(recentUids[i], actions);
		}
		return { actionsByUser, usersWithRecentKey };
	}

	private async runRecentBackfill(activeUids: ReadonlySet<string>, logger: Logger): Promise<{ processed: number; backlog: number }> {
		const now = Date.now();
		const recent = await this.loadRecentActionsByUser(activeUids, now);
		const noteIds = [...new Set([...recent.actionsByUser.values()].flatMap(actions => actions.map(a => a.noteId)))];
		if (noteIds.length === 0) {
			logger.info('hanami taste recent backfill: recentBackfillProcessed=0 recentBackfillBacklog=0');
			return { processed: 0, backlog: 0 };
		}

		const rows = await this.db.query(
			`SELECT n.id AS id, n.text AS text
			 FROM note n
			 LEFT JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 WHERE n.id = ANY($2)
			   AND n."channelId" IS NULL
			   AND n.visibility IN ('public','home','followers')
			   AND n.text IS NOT NULL
			   AND e."noteId" IS NULL
			 ORDER BY n.id DESC`,
			[TASTE_EMBED_MODEL, noteIds],
		) as { id: string; text: string }[];

		const texts: [string, string][] = [];
		for (const r of rows) {
			const cleaned = this.cleanForEmbedding(r.text);
			if (contentCharCount(cleaned) >= TASTE_MIN_CHARS) texts.push([r.id, cleaned]);
		}
		if (texts.length === 0) {
			logger.info('hanami taste recent backfill: recentBackfillProcessed=0 recentBackfillBacklog=0');
			return { processed: 0, backlog: 0 };
		}

		const slice = texts.slice(0, RECENT_BACKFILL_MAX);
		const processed = await this.embedAndStore(slice, RECENT_BACKFILL_TIME_BUDGET_SEC, logger);
		const backlog = Math.max(0, texts.length - processed);
		logger.info(`hanami taste recent backfill: recentBackfillProcessed=${processed} recentBackfillBacklog=${backlog}`);
		return { processed, backlog };
	}

	private centeredVector(embedding: number[], meanVec: number[]): { raw: Float32Array; normalized: Float32Array } {
		const raw = new Float32Array(meanVec.length);
		const normalized = new Float32Array(meanVec.length);
		let norm = 0;
		for (let i = 0; i < meanVec.length; i++) {
			const v = (embedding[i] ?? 0) - meanVec[i];
			raw[i] = v;
			norm += v * v;
		}
		norm = Math.sqrt(norm) || 1;
		for (let i = 0; i < meanVec.length; i++) normalized[i] = raw[i] / norm;
		return { raw, normalized };
	}

	private dot(a: Float32Array, b: Float32Array, dim: number): number {
		const n = Math.min(dim, a.length, b.length);
		let out = 0;
		for (let i = 0; i < n; i++) out += a[i] * b[i];
		return out;
	}

	private async computeRecentInterest(
		activeUids: ReadonlySet<string>,
		byUser: Map<string, TasteClusterForMatch[]>,
		meanVec: number[],
	): Promise<RecentInterestResult> {
		const now = Date.now();
		const recent = await this.loadRecentActionsByUser(activeUids, now);
		const noteIds = [...new Set([...recent.actionsByUser.values()].flatMap(actions => actions.map(a => a.noteId)))];
		const noteById = new Map<string, { aid: string; emb: number[] | null }>();
		if (noteIds.length > 0) {
			const rows = await this.db.query(
				`SELECT n.id AS nid, n."userId" AS aid, e.embedding AS emb
				 FROM note n
				 LEFT JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
				 WHERE n.id = ANY($2)`,
				[TASTE_EMBED_MODEL, noteIds],
			) as { nid: string; aid: string; emb: number[] | null }[];
			for (const r of rows) noteById.set(r.nid, { aid: r.aid, emb: r.emb });
		}

		const byRecentUser = new Map<string, RecentUserInterest>();
		let recentActions = 0;
		const metaPipeline = this.redisClient.pipeline();
		let metaOps = 0;
		for (const uid of recent.usersWithRecentKey) {
			const actions = recent.actionsByUser.get(uid) ?? [];
			recentActions += actions.length;
			const metaKey = HANAMI_TASTE_MATCH_META_KEY_PREFIX + uid;
			if (actions.length === 0) {
				metaPipeline.del(metaKey);
				metaOps++;
				continue;
			}

			const weighted: { aid: string; weight: number; emb: number[] }[] = [];
			const byAuthorWeight = new Map<string, number>();
			for (const a of actions) {
				const note = noteById.get(a.noteId);
				if (note?.emb == null) continue;
				weighted.push({ aid: note.aid, weight: a.weight, emb: note.emb });
				byAuthorWeight.set(note.aid, (byAuthorWeight.get(note.aid) ?? 0) + a.weight);
			}

			const visibleClusters = (byUser.get(uid) ?? []).filter(c => c.userWeight > 0);
			const heatByCluster = new Map<number, number>();
			const recentSum = new Float32Array(meanVec.length);
			let embeddedActions = 0;
			for (const a of weighted) {
				const authorSum = byAuthorWeight.get(a.aid) ?? 0;
				const scale = authorSum > HEAT_AUTHOR_CAP ? HEAT_AUTHOR_CAP / authorSum : 1;
				const cappedWeight = a.weight * scale;
				embeddedActions++;
				const vec = this.centeredVector(a.emb, meanVec);
				for (let i = 0; i < meanVec.length; i++) recentSum[i] += vec.normalized[i] * cappedWeight;

				let bestCos = -Infinity;
				let bestCid = -1;
				for (const cl of visibleClusters) {
					const cos = this.dot(vec.normalized, cl.centroid, meanVec.length);
					if (cos > bestCos) { bestCos = cos; bestCid = cl.cid; }
				}
				if (bestCid >= 0 && bestCos >= TAU_ASSIGN) {
					heatByCluster.set(bestCid, (heatByCluster.get(bestCid) ?? 0) + cappedWeight);
				}
			}

			let recentVec: Float32Array | null = null;
			if (embeddedActions >= RECENT_MIN_ACTIONS) {
				let norm = 0;
				for (let i = 0; i < recentSum.length; i++) norm += recentSum[i] * recentSum[i];
				norm = Math.sqrt(norm);
				if (norm > 0) {
					recentVec = new Float32Array(recentSum.length);
					for (let i = 0; i < recentSum.length; i++) recentVec[i] = recentSum[i] / norm;
				}
			}
			const totalHeat = [...heatByCluster.values()].reduce((a, b) => a + b, 0);
			byRecentUser.set(uid, { recentVec, totalHeat, heatByCluster });

			const fields: Record<string, string> = {
				totalHeat: String(totalHeat),
				hasRecentVec: recentVec == null ? '0' : '1',
			};
			for (const [cid, heat] of heatByCluster) fields[`heat:${cid}`] = String(heat);
			metaPipeline.del(metaKey);
			metaPipeline.hset(metaKey, fields);
			metaPipeline.expire(metaKey, TASTE_MATCH_KEY_TTL_SEC);
			metaOps += 3;
		}
		if (metaOps > 0) await metaPipeline.exec();

		return {
			byUser: byRecentUser,
			recentUsers: recent.usersWithRecentKey.size,
			recentActions,
		};
	}

	// ───────────────────────── 10分スイープ ─────────────────────────

	@bindThis
	public async runTasteSweep(logger: Logger): Promise<{ processed: number; skipped: number; backlog: number }> {
		const sinceId = this.idService.gen(Date.now() - TASTE_SWEEP_WINDOW_MS);
		// 鍵（followers）も学習対象（specified=ダイレクトは常に対象外）。
		// 埋め込みは学習にのみ使われ、配信候補は public/home のままなので鍵ノートが他人に推薦されることはない。
		const rows = await this.db.query(
			`SELECT n.id AS id, n.text AS text
			 FROM note n
			 LEFT JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 WHERE n.id >= $2 AND n."channelId" IS NULL
			   AND n.visibility IN ('public','home','followers')
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
			if (contentCharCount(cleaned) >= TASTE_MIN_CHARS) texts.push([r.id, cleaned]);
		}
		if (texts.length === 0) return { processed: 0, skipped: rows.length, backlog: 0 };

		const processed = await this.embedAndStore(texts, TASTE_SWEEP_TIME_BUDGET_SEC, logger);
		// backlog = 時間予算で今回埋めきれなかった分（新しい順なので残りは古い尻尾）。
		const backlog = texts.length - processed;
		logger.info(`hanami taste sweep: embedded ${processed}, backlog ${backlog}${rows.length >= TASTE_SWEEP_FETCH_LIMIT ? '+' : ''}`);
		return { processed, skipped: rows.length - texts.length, backlog };
	}

	/** クリーニング済みテキストを python(e5) へ渡し、保存せずベクトル配列だけ返す。sweep/rebuildで同じ入口を使う。 */
	private async embedTexts(texts: [string, string][], timeBudgetSec: number, logger?: Logger): Promise<{ dim: number; processed: number; embeddings: [string, number[]][] }> {
		let tmpDir: string | null = null;
		try {
			tmpDir = await mkdtemp(Path.join(tmpdir(), 'hanami-taste-embed-'));
			const inputPath = Path.join(tmpDir, 'input.json');
			const outputPath = Path.join(tmpDir, 'output.json');
			await writeFile(inputPath, JSON.stringify({ model: TASTE_EMBED_MODEL, timeBudgetSec, texts }), 'utf8');

			const scriptPath = process.env.HANAMI_TASTE_EMBED_SCRIPT
				?? Path.resolve(_dirname, '../../../../../scripts/hanami-foryou/taste_embed_sweep.py');
			const python = process.env.HANAMI_FORYOU_PYTHON ?? 'python3';
			await execFileAsync(python, [scriptPath, inputPath, outputPath], { env: this.tastePythonEnv(logger), timeout: TASTE_PROCESS_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });

			return JSON.parse(await readFile(outputPath, 'utf8')) as { dim: number; processed: number; embeddings: [string, number[]][] };
		} finally {
			if (tmpDir != null) await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	/** クリーニング済みテキストを埋め込み hanami_note_embedding へ保存する。処理件数を返す。 */
	private async embedAndStore(texts: [string, string][], timeBudgetSec: number, logger?: Logger): Promise<number> {
		const out = await this.embedTexts(texts, timeBudgetSec, logger);
		await this.upsertNoteEmbeddings(out.embeddings, out.dim, false);
		return out.processed;
	}

	private async upsertNoteEmbeddings(embeddings: [string, number[]][], dim: number, updateExisting: boolean): Promise<void> {
		const updatedAt = new Date();
		const chunk = 200;
		for (let i = 0; i < embeddings.length; i += chunk) {
			const slice = embeddings.slice(i, i + chunk);
			const values: string[] = [];
			const params: unknown[] = [];
			for (const [noteId, vec] of slice) {
				const base = params.length;
				values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
				params.push(noteId, TASTE_EMBED_MODEL, dim, `{${vec.join(',')}}`, updatedAt);
			}
			await this.db.query(
				`INSERT INTO "hanami_note_embedding" ("noteId", model, dim, embedding, "updatedAt")
				 VALUES ${values.join(',')}
				 ON CONFLICT ("noteId", model) DO ${updateExisting ? 'UPDATE SET dim = EXCLUDED.dim, embedding = EXCLUDED.embedding, "updatedAt" = EXCLUDED."updatedAt"' : 'NOTHING'}`,
				params,
			);
		}
	}

	// ───────────────────────── 興味マッチ新着（reactionSimilar 軸）の事前計算 ─────────────────────────

	/**
	 * 直近24hの埋め込み済み全ノート（人気条件なし）をユーザーの taste クラスタ / recentVec と照合し、
	 * ユーザー別 zset（member=noteId:authorId:{clusterId|r} / score=max(cos_cluster, cos_recent)×鮮度）を全置換する。
	 *
	 * 10分スイープの直後に呼ぶ: 新着はどのみち埋め込まれるまで候補になれないので、鮮度の追加損失ゼロで
	 * 「サーブは事前計算の取り出し」の原則を保てる。毎回フル再計算（ステートレス＝Redis 消失・クラスタ
	 * 再構築・userWeight 変更・窓スライドすべて次回実行≦10分で自己回復）。
	 */
	/**
	 * 10分 tick の本体: recent backfill→埋め込みスイープ→短期量計算→興味マッチ事前計算を1ロックの下で順に実行する。
	 * - ロックは tick 全体を覆う（v0.7 R3: sweep の python 並走も防ぐ）。前回が周期を跨いでいたらスキップ（次回≦10分で追いつく）。
	 * - token 照合つき解放（v0.7 R2-M3: 無条件 DEL だと TTL 超過した旧実行が新実行のロックを消し、
	 *   三つ巴の多重実行を再発させる）。token は tmp キーの衝突回避にも使う。
	 * - backfill/sweep 失敗（python 不在等）でも match は既存の埋め込みだけで実行する。
	 */
	@bindThis
	public async runTasteTick(logger: Logger): Promise<void> {
		const lockToken = await this.acquireTasteTickLock();
		if (lockToken == null) {
			logger.warn('hanami taste tick: previous run still in progress, skip');
			return;
		}
		try {
			const clusterRows = await this.loadTasteClusterRows();
			const activeUids = await this.filterActiveTasteUserIds(clusterRows.map(r => r.uid));
			try {
				await this.runRecentBackfill(activeUids, logger);
			} catch (err) {
				logger.warn(`hanami taste recent backfill failed: ${(err as Error).message}`);
			}
			try {
				await this.runTasteSweep(logger);
			} catch (err) {
				// python 不在などの環境では警告に留めて次回に任せる（serve は general 縮退で壊れない）。
				logger.warn(`hanami taste sweep failed: ${(err as Error).message}`);
			}
			try {
				await this.computeTasteMatches(logger, lockToken, clusterRows, activeUids);
			} catch (err) {
				logger.warn(`hanami taste match failed: ${(err as Error).message}`);
			}
		} finally {
			await this.releaseTasteTickLock(lockToken);
		}
	}

	private emptyRebuildStats(): HanamiTasteRebuildStats {
		return { reembedded: 0, purged: 0, evidenceUpdated: 0, evidencePurged: 0 };
	}

	private async writeTasteRebuildStatus(state: HanamiTasteRebuildStatus['state'], data: HanamiTasteRebuildJobData, error: string | null = null): Promise<void> {
		const fields: Record<string, string> = {
			state,
			phase: data.phase,
			reembedded: String(data.stats.reembedded),
			purged: String(data.stats.purged),
			evidenceUpdated: String(data.stats.evidenceUpdated),
			evidencePurged: String(data.stats.evidencePurged),
			startedAt: String(data.startedAt),
			updatedAt: String(Date.now()),
			error: error ?? '',
		};
		await this.redisClient.hset(TASTE_REBUILD_STATUS_KEY, fields);
		await this.redisClient.expire(TASTE_REBUILD_STATUS_KEY, TASTE_REBUILD_STATUS_TTL_SEC);
	}

	@bindThis
	public async getTasteRebuildStatus(): Promise<HanamiTasteRebuildStatus> {
		const raw = await this.redisClient.hgetall(TASTE_REBUILD_STATUS_KEY);
		if (raw.state == null) {
			return {
				state: 'idle',
				phase: null,
				...this.emptyRebuildStats(),
				startedAt: null,
				updatedAt: null,
				error: null,
			};
		}
		const phase = raw.phase === 'embeddings' || raw.phase === 'evidence' ? raw.phase : null;
		return {
			state: raw.state === 'running' || raw.state === 'done' || raw.state === 'error' ? raw.state : 'idle',
			phase,
			reembedded: Number(raw.reembedded ?? 0),
			purged: Number(raw.purged ?? 0),
			evidenceUpdated: Number(raw.evidenceUpdated ?? 0),
			evidencePurged: Number(raw.evidencePurged ?? 0),
			startedAt: raw.startedAt != null ? Number(raw.startedAt) : null,
			updatedAt: raw.updatedAt != null ? Number(raw.updatedAt) : null,
			error: raw.error ? raw.error : null,
		};
	}

	@bindThis
	public async startTasteRebuild(force: boolean): Promise<HanamiTasteRebuildJobData> {
		const current = await this.getTasteRebuildStatus();
		if (!force && current.state === 'running' && current.updatedAt != null && Date.now() - current.updatedAt < TASTE_REBUILD_RUNNING_FRESH_MS) {
			throw new HanamiTasteRebuildAlreadyRunningError();
		}
		const data: HanamiTasteRebuildJobData = {
			phase: 'embeddings',
			cursor: null,
			stats: this.emptyRebuildStats(),
			startedAt: Date.now(),
		};
		await this.writeTasteRebuildStatus('running', data);
		return data;
	}

	@bindThis
	public async runTasteRebuildChunk(data: HanamiTasteRebuildJobData, logger: Logger): Promise<HanamiTasteRebuildChunkResult> {
		const lockToken = await this.acquireTasteTickLock();
		if (lockToken == null) {
			logger.warn('hanami taste rebuild: taste tick lock busy, retry later');
			return { action: 'retry', delayMs: TASTE_REBUILD_LOCK_RETRY_MS, data };
		}
		try {
			await this.writeTasteRebuildStatus('running', data);
			const next = data.phase === 'embeddings'
				? await this.rebuildEmbeddingChunk(data, logger)
				: await this.rebuildEvidenceChunk(data, logger);
			if (next.action === 'cluster') {
				await this.writeTasteRebuildStatus('done', next.data);
			} else {
				await this.writeTasteRebuildStatus('running', next.data);
			}
			return next;
		} catch (err) {
			await this.writeTasteRebuildStatus('error', data, (err as Error).message);
			throw err;
		} finally {
			await this.releaseTasteTickLock(lockToken);
		}
	}

	private async rebuildEmbeddingChunk(data: HanamiTasteRebuildJobData, logger: Logger): Promise<HanamiTasteRebuildChunkResult> {
		const limit = this.tasteRebuildChunkLimit();
		const rows = await this.db.query(
			`SELECT e."noteId" AS id, n.text AS text
			 FROM "hanami_note_embedding" e
			 LEFT JOIN note n ON n.id = e."noteId"
			 WHERE e.model = $1 AND ($2::text IS NULL OR e."noteId" > $2)
			 ORDER BY e."noteId" ASC
			 LIMIT $3`,
			[TASTE_EMBED_MODEL, data.cursor, limit],
		) as { id: string; text: string | null }[];

		if (rows.length === 0) {
			const next = { ...data, phase: 'evidence' as const, cursor: null };
			logger.info(`hanami taste rebuild: embeddings done reembedded=${next.stats.reembedded} purged=${next.stats.purged}`);
			return { action: 'continue', delayMs: TASTE_REBUILD_DELAY_MS, data: next };
		}

		const purgeIds: string[] = [];
		const texts: [string, string][] = [];
		for (const r of rows) {
			if (r.text == null) {
				purgeIds.push(r.id);
				continue;
			}
			const cleaned = this.cleanForEmbedding(r.text);
			if (contentCharCount(cleaned) >= TASTE_MIN_CHARS) texts.push([r.id, cleaned]);
			else purgeIds.push(r.id);
		}
		if (purgeIds.length > 0) {
			await this.db.query(
				`DELETE FROM "hanami_note_embedding" WHERE model = $1 AND "noteId" = ANY($2)`,
				[TASTE_EMBED_MODEL, purgeIds],
			);
		}

		const out = texts.length === 0
			? { dim: TASTE_EMBED_DIM, processed: 0, embeddings: [] as [string, number[]][] }
			: await this.embedTexts(texts, TASTE_REBUILD_EMBED_TIME_BUDGET_SEC, logger);
		if (out.embeddings.length > 0) await this.upsertNoteEmbeddings(out.embeddings, out.dim, true);

		const partial = texts.length > 0 && out.embeddings.length < texts.length;
		const processedLastId = out.embeddings.at(-1)?.[0] ?? null;
		const cursor = partial && processedLastId != null ? processedLastId : rows.at(-1)!.id;
		const next: HanamiTasteRebuildJobData = {
			...data,
			cursor,
			stats: {
				...data.stats,
				reembedded: data.stats.reembedded + out.embeddings.length,
				purged: data.stats.purged + purgeIds.length,
			},
		};
		if (partial && processedLastId == null) throw new Error('hanami taste rebuild: embedding made no progress');
		if (!partial && rows.length < limit) {
			return { action: 'continue', delayMs: TASTE_REBUILD_DELAY_MS, data: { ...next, phase: 'evidence', cursor: null } };
		}
		return { action: 'continue', delayMs: TASTE_REBUILD_DELAY_MS, data: next };
	}

	private packEvidenceCursor(userId: string, noteId: string): string {
		return `${userId}:${noteId}`;
	}

	private unpackEvidenceCursor(cursor: string | null): { userId: string | null; noteId: string | null } {
		if (cursor == null) return { userId: null, noteId: null };
		const i = cursor.indexOf(':');
		if (i < 0) return { userId: cursor, noteId: null };
		return { userId: cursor.slice(0, i), noteId: cursor.slice(i + 1) };
	}

	private async rebuildEvidenceChunk(data: HanamiTasteRebuildJobData, logger: Logger): Promise<HanamiTasteRebuildChunkResult> {
		const limit = this.tasteRebuildChunkLimit();
		const cursor = this.unpackEvidenceCursor(data.cursor);
		const rows = await this.db.query(
			`SELECT ev."userId" AS uid, ev."noteId" AS nid, n.text AS text
			 FROM "hanami_foryou_taste_evidence" ev
			 LEFT JOIN note n ON n.id = ev."noteId"
			 WHERE ev.model = $1
			   AND ($2::text IS NULL OR ev."userId" > $2 OR (ev."userId" = $2 AND ($3::text IS NULL OR ev."noteId" > $3)))
			 ORDER BY ev."userId" ASC, ev."noteId" ASC
			 LIMIT $4`,
			[TASTE_EMBED_MODEL, cursor.userId, cursor.noteId, limit],
		) as { uid: string; nid: string; text: string | null }[];
		if (rows.length === 0) {
			logger.info(`hanami taste rebuild: evidence done updated=${data.stats.evidenceUpdated} purged=${data.stats.evidencePurged}`);
			return { action: 'cluster', data };
		}

		const purgeRows: { uid: string; nid: string }[] = [];
		const textRows: [string, string][] = [];
		for (const r of rows) {
			if (r.text == null) {
				purgeRows.push(r);
				continue;
			}
			const cleaned = this.cleanForEmbedding(r.text);
			if (contentCharCount(cleaned) >= TASTE_MIN_CHARS) textRows.push([this.packEvidenceCursor(r.uid, r.nid), cleaned]);
			else purgeRows.push(r);
		}
		await this.deleteEvidenceRows(purgeRows);

		const out = textRows.length === 0
			? { dim: TASTE_EMBED_DIM, processed: 0, embeddings: [] as [string, number[]][] }
			: await this.embedTexts(textRows, TASTE_REBUILD_EMBED_TIME_BUDGET_SEC, logger);
		await this.updateEvidenceVectors(out.embeddings);

		const partial = textRows.length > 0 && out.embeddings.length < textRows.length;
		const processedLast = out.embeddings.at(-1)?.[0] ?? null;
		const nextCursor = partial && processedLast != null
			? processedLast
			: this.packEvidenceCursor(rows.at(-1)!.uid, rows.at(-1)!.nid);
		const next: HanamiTasteRebuildJobData = {
			...data,
			cursor: nextCursor,
			stats: {
				...data.stats,
				evidenceUpdated: data.stats.evidenceUpdated + out.embeddings.length,
				evidencePurged: data.stats.evidencePurged + purgeRows.length,
			},
		};
		if (partial && processedLast == null) throw new Error('hanami taste rebuild: evidence embedding made no progress');
		if (!partial && rows.length < limit) return { action: 'cluster', data: next };
		return { action: 'continue', delayMs: TASTE_REBUILD_DELAY_MS, data: next };
	}

	private async deleteEvidenceRows(rows: { uid: string; nid: string }[]): Promise<void> {
		if (rows.length === 0) return;
		const chunk = 500;
		for (let i = 0; i < rows.length; i += chunk) {
			const slice = rows.slice(i, i + chunk);
			const values: string[] = [];
			const params: unknown[] = [TASTE_EMBED_MODEL];
			for (const r of slice) {
				const base = params.length;
				values.push(`($${base + 1}, $${base + 2})`);
				params.push(r.uid, r.nid);
			}
			await this.db.query(
				`DELETE FROM "hanami_foryou_taste_evidence" ev
				 USING (VALUES ${values.join(',')}) AS v(uid, nid)
				 WHERE ev.model = $1 AND ev."userId" = v.uid AND ev."noteId" = v.nid`,
				params,
			);
		}
	}

	private async updateEvidenceVectors(embeddings: [string, number[]][]): Promise<void> {
		if (embeddings.length === 0) return;
		const chunk = 200;
		for (let i = 0; i < embeddings.length; i += chunk) {
			const slice = embeddings.slice(i, i + chunk);
			const values: string[] = [];
			const params: unknown[] = [TASTE_EMBED_MODEL];
			for (const [key, vec] of slice) {
				const { userId, noteId } = this.unpackEvidenceCursor(key);
				if (userId == null || noteId == null) continue;
				const base = params.length;
				values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
				params.push(userId, noteId, encodeFp16(vec));
			}
			if (values.length === 0) continue;
			await this.db.query(
				`UPDATE "hanami_foryou_taste_evidence" ev
				 SET vector = v.vector
				 FROM (VALUES ${values.join(',')}) AS v(uid, nid, vector)
				 WHERE ev.model = $1 AND ev."userId" = v.uid AND ev."noteId" = v.nid`,
				params,
			);
		}
	}

	private async computeTasteMatches(logger: Logger, runToken: string, clusterRows: TasteClusterRow[], activeUids: ReadonlySet<string>): Promise<{ users: number; notes: number }> {
		const startedAt = Date.now();
		if (clusterRows.length === 0) return { users: 0, notes: 0 };

		const byUser = this.clustersByActiveUser(clusterRows, activeUids);
		if (byUser.size === 0) return { users: 0, notes: 0 };

		const stateRows = await this.db.query(
			`SELECT "meanVec" FROM "hanami_foryou_taste_state" WHERE model = $1`,
			[TASTE_EMBED_MODEL],
		) as { meanVec: number[] }[];
		const meanVec = stateRows[0]?.meanVec;
		if (meanVec == null || meanVec.length === 0) return { users: 0, notes: 0 };

		const recent = await this.computeRecentInterest(activeUids, byUser, meanVec);

		// 配信可能な新着だけ（public/home・チャンネル外・リプライ以外・bot以外）。
		// 鍵（followers）ノートは学習専用なのでここには乗せない。
		// isExplorable=FALSE の作者は載せない（v0.6 #5: 低反応投稿を本人の合図なしに広域配信する軸なので、
		// 「発見されたくない」意思表示は fof と同様に尊重する。人気系軸より一段厳しくてよい）。
		const sinceId = this.idService.gen(Date.now() - TASTE_MATCH_WINDOW_MS);
		const noteRows = await this.db.query(
			`SELECT e."noteId" AS nid, e.embedding AS emb, n."userId" AS aid
			 FROM "hanami_note_embedding" e
			 JOIN note n ON n.id = e."noteId"
			 JOIN "user" u ON u.id = n."userId"
			 WHERE e.model = $1 AND e."noteId" >= $2
			   AND n.visibility IN ('public','home') AND n."channelId" IS NULL AND n."replyId" IS NULL
			   AND u."isBot" = FALSE AND u."isSuspended" = FALSE AND u."isExplorable" = TRUE`,
			[TASTE_EMBED_MODEL, sinceId],
		) as { nid: string; emb: number[]; aid: string }[];
		if (noteRows.length === 0) {
			logger.info(`hanami taste recent: recentUsers=${recent.recentUsers} recentActions=${recent.recentActions} cosRecentMs=0`);
			return { users: 0, notes: 0 };
		}

		// 平均中心化＋正規化はユーザー数に依らず1回だけ（クラスタ割当と同じ前処理）。
		const dim = meanVec.length;
		const mat = new Float32Array(noteRows.length * dim);
		for (let r = 0; r < noteRows.length; r++) {
			const emb = noteRows[r].emb;
			const off = r * dim;
			let norm = 0;
			for (let i = 0; i < dim; i++) {
				const v = (emb[i] ?? 0) - meanVec[i];
				mat[off + i] = v;
				norm += v * v;
			}
			norm = Math.sqrt(norm) || 1;
			for (let i = 0; i < dim; i++) mat[off + i] /= norm;
		}

		// 鮮度（cos に乗算して zset score へ焼き込む。毎10分フル再計算なので自然に更新される）。
		const now = Date.now();
		const freshnessOf = (nid: string): number => {
			const age = now - this.idService.parse(nid).date.getTime();
			for (const b of TASTE_MATCH_FRESHNESS_BUCKETS) {
				if (age <= b.withinMs) return b.weight;
			}
			return TASTE_MATCH_FRESHNESS_FLOOR;
		};
		const freshness = noteRows.map(r => freshnessOf(r.nid));

		let users = 0;
		let cosRecentMs = 0;
		const matchCounts: number[] = [];
		for (const [uid, cls] of byUser) {
			const visibleClusters = cls.filter(cl => cl.userWeight > 0);
			const hiddenClusters = cls.filter(cl => cl.userWeight <= 0);
			const recentVec = recent.byUser.get(uid)?.recentVec ?? null;
			const matches: { member: string; aid: string; score: number }[] = [];
			const recentCandidateLoopStartedAt = recentVec == null ? null : Date.now();
			for (let r = 0; r < noteRows.length; r++) {
				if (noteRows[r].aid === uid) continue; // 自分の投稿は推薦しない
				const off = r * dim;
				let bestVisibleCos = -Infinity;
				let bestVisibleCid = -1;
				for (const cl of visibleClusters) {
					const cen = cl.centroid;
					const n = Math.min(dim, cen.length);
					let dot = 0;
					for (let i = 0; i < n; i++) dot += mat[off + i] * cen[i];
					if (dot > bestVisibleCos) { bestVisibleCos = dot; bestVisibleCid = cl.cid; }
				}
				let bestHiddenCos = -Infinity;
				for (const cl of hiddenClusters) {
					const cen = cl.centroid;
					const n = Math.min(dim, cen.length);
					let dot = 0;
					for (let i = 0; i < n; i++) dot += mat[off + i] * cen[i];
					if (dot > bestHiddenCos) bestHiddenCos = dot;
				}
				let cosRecent: number | null = null;
				if (recentVec != null) {
					let dot = 0;
					for (let i = 0; i < dim; i++) dot += mat[off + i] * recentVec[i];
					cosRecent = dot;
				}

				if (bestHiddenCos >= TASTE_MATCH_TAU) continue;
				const clusterAdopted = bestVisibleCid >= 0 && bestVisibleCos >= TASTE_MATCH_TAU;
				const recentAdopted = cosRecent != null && cosRecent >= TAU_RECENT;
				if (!clusterAdopted && !recentAdopted) continue;
				const bucket = clusterAdopted ? String(bestVisibleCid) : 'r';
				const scoreCos = Math.max(clusterAdopted ? bestVisibleCos : -Infinity, cosRecent ?? -Infinity);
				matches.push({
					member: `${noteRows[r].nid}:${noteRows[r].aid}:${bucket}`,
					aid: noteRows[r].aid,
					score: scoreCos * freshness[r],
				});
			}
			if (recentCandidateLoopStartedAt != null) cosRecentMs += Date.now() - recentCandidateLoopStartedAt;
			// score 降順＋作者cap（同一作者の連投/コピペが TOP_N を占領しない）。
			matches.sort((a, b) => b.score - a.score);
			const top: typeof matches = [];
			const perAuthor = new Map<string, number>();
			for (const m of matches) {
				if (top.length >= TASTE_MATCH_TOP_N) break;
				const c = perAuthor.get(m.aid) ?? 0;
				if (c >= TASTE_MATCH_AUTHOR_CAP) continue;
				perAuthor.set(m.aid, c + 1);
				top.push(m);
			}
			matchCounts.push(top.length);

			const key = HANAMI_TASTE_MATCH_KEY_PREFIX + uid;
			const pipeline = this.redisClient.pipeline();
			if (top.length === 0) {
				pipeline.del(key);
			} else {
				// tmp キーへ書いて rename＝サーブ側から見て常に完全な集合（部分書き込みを見せない）。
				// tmp 名に runToken を含め、TTL 超過で並走した旧実行と同じ tmp を触り合わない（v0.7 R2-M3）。
				// 短い expire で孤児 tmp（rename 前クラッシュ）も自然消滅させる。
				const tmp = `${key}:tmp:${runToken}`;
				const args: (string | number)[] = [];
				for (const m of top) args.push(m.score, m.member);
				pipeline.zadd(tmp, ...args);
				pipeline.expire(tmp, 600);
				pipeline.rename(tmp, key);
				pipeline.expire(key, TASTE_MATCH_KEY_TTL_SEC);
			}
			const res = await pipeline.exec();
			const failed = res?.find(([err]) => err != null);
			if (failed?.[0] != null) logger.warn(`hanami taste match: redis write failed for ${uid}: ${failed[0].message}`);
			users++;
		}
		matchCounts.sort((a, b) => a - b);
		const elapsed = Date.now() - startedAt;
		const med = matchCounts[Math.floor(matchCounts.length / 2)] ?? 0;
		logger.info(`hanami taste recent: recentUsers=${recent.recentUsers} recentActions=${recent.recentActions} cosRecentMs=${cosRecentMs}`);
		logger.info(`hanami taste match: ${users} users x ${noteRows.length} notes in ${elapsed}ms (matches min=${matchCounts[0] ?? 0} med=${med} max=${matchCounts.at(-1) ?? 0})`);
		// 実行時間がここを超え始めたら ANN/差分更新化（spec §9.4）を検討する。
		if (elapsed > TASTE_MATCH_SLOW_WARN_MS) logger.warn(`hanami taste match: slow run ${elapsed}ms (users=${users}, notes=${noteRows.length}) — consider ANN/incremental`);
		return { users, notes: noteRows.length };
	}

	// ───────────────────────── 日次クラスタバッチ ─────────────────────────

	@bindThis
	public async runTasteClusterBatch(logger: Logger): Promise<{ users: number }> {
		const now = Date.now();

		// 0) e5 埋め込みの TTL 整理（30日）＋旧モデル行の purge。
		//    evidence の PK は (userId, noteId) なので、旧モデル行が残ると ON CONFLICT で新モデルの
		//    追記が黙って弾かれ、学習素材が欠落する（モデル載せ替え時）。旧空間のベクトルは再利用不能なので消す。
		//    cluster も同様に purge しないと、閾値未満で再クラスタされないユーザーの旧モデル行が
		//    永久に残る（serve/一覧は model 一致行しか読まないのにテーブルには居座る）。
		//    ※モデル載せ替え時の注意: この purge で evidence が一旦空になる。30日窓の append では
		//      軽量ユーザーが TASTE_MIN_EVIDENCE に届かない（管理画面の taste 再構築は既存行の再生成
		//      なので空 evidence は救えない。過去掘りの backfill 手段は必要になった時に別途用意する）。
		await this.db.query(
			`DELETE FROM "hanami_note_embedding" WHERE model = $1 AND "updatedAt" < $2`,
			[TASTE_EMBED_MODEL, new Date(now - TASTE_EMBED_TTL_MS)],
		);
		await this.db.query(
			`DELETE FROM "hanami_foryou_taste_evidence" WHERE model <> $1`,
			[TASTE_EMBED_MODEL],
		);
		await this.db.query(
			`DELETE FROM "hanami_foryou_user_taste_cluster" WHERE model <> $1`,
			[TASTE_EMBED_MODEL],
		);

		// 1) 対象ユーザー = 生涯活動量（リアクション＋text投稿、閾値でcapしたcount）>= 閾値 のローカルユーザー。
		//    日付では切らない（v0.3: ライトユーザーも過去に遡って材料を確保する）。
		const eligible = await this.db.query(
			`SELECT u.id AS id, u.username AS username, u.name AS name
			 FROM "user" u
			 WHERE u.host IS NULL AND u."isSuspended" = FALSE
			   AND (
			     (SELECT count(*) FROM (SELECT 1 FROM note_reaction r WHERE r."userId" = u.id LIMIT $1) cr)
			     + (SELECT count(*) FROM (SELECT 1 FROM note n WHERE n."userId" = u.id AND n.text IS NOT NULL LIMIT $1) cn)
			   ) >= $1`,
			[TASTE_MIN_EVIDENCE],
		) as { id: string; username: string; name: string | null }[];
		if (eligible.length === 0) return { users: 0 };
		const eligibleIds = eligible.map(u => u.id);

		// 2) evidence 追記（R=リアクション先 / W=自投稿。保存済み埋め込みの fp16 コピーのみ）。
		//    走査窓は埋め込みTTLと同じ30日（それより古い分は bootstrap が担う）。
		const sinceAppend = this.idService.gen(now - TASTE_EVIDENCE_APPEND_WINDOW_MS);
		await this.appendEvidence(sinceAppend, eligibleIds, logger);

		// 3) ノート数窓の整理: ユーザーごとに最新 TASTE_EVIDENCE_TARGET 件だけ残す（古い方から落ちる）。
		await this.db.query(
			`DELETE FROM "hanami_foryou_taste_evidence" e
			 USING (
			   SELECT "userId", "noteId" FROM (
			     SELECT "userId", "noteId", row_number() OVER (PARTITION BY "userId" ORDER BY "createdAt" DESC, "noteId" DESC) AS rn
			     FROM "hanami_foryou_taste_evidence"
			   ) t WHERE t.rn > $1
			 ) d
			 WHERE e."userId" = d."userId" AND e."noteId" = d."noteId"`,
			[TASTE_EVIDENCE_TARGET],
		);

		// 4) mean_vec 更新（直近埋め込みの平均。クラスタ学習と serve の候補割当で共有）。
		const meanVec = await this.updateMeanVec();
		if (meanVec == null) {
			logger.warn('hanami taste cluster: no embeddings yet, skip clustering');
			return { users: 0 };
		}

		// 5) evidence が十分なユーザーを k-means（pythonへはユーザー30人ずつ）。
		const targets = await this.db.query(
			`SELECT "userId" AS id, count(*)::int AS c FROM "hanami_foryou_taste_evidence"
			 WHERE "userId" = ANY($1) AND model = $3 GROUP BY 1 HAVING count(*) >= $2`,
			[eligibleIds, TASTE_MIN_EVIDENCE, TASTE_EMBED_MODEL],
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

	private async appendEvidence(sinceId: string, eligibleIds: string[], logger: Logger): Promise<void> {
		// A2: 「古いノートへの新しい反応」を拾う——反応/RN対象なのに埋め込みが無い（TTL切れ or 30日超）ノートを
		// その場で埋め込み対象に足す（少量）。これが無いと過去ログ掘りの嗜好が構造的に学習されない。
		await this.embedMissingEngagedNotes(sinceId, eligibleIds, logger);

		// cap 到達ユーザーは「保持中の最古 createdAt」より古い行動を追記対象から外す。
		// トリムで消した行の行動IDはまだ30日窓内にあるため、これが無いと毎晩 INSERT→トリムを繰り返す。
		const cutRows = await this.db.query(
			`SELECT "userId" AS uid, min("createdAt") AS cut FROM "hanami_foryou_taste_evidence"
			 WHERE "userId" = ANY($1) GROUP BY 1 HAVING count(*) >= $2`,
			[eligibleIds, TASTE_EVIDENCE_TARGET],
		) as { uid: string; cut: Date }[];
		const cutoffOf = new Map(cutRows.map(r => [r.uid, new Date(r.cut).getTime()]));
		const afterCutoff = (rows: { uid: string; nid: string; emb: number[]; actid: string }[]) => rows.filter(r => {
			const cut = cutoffOf.get(r.uid);
			return cut == null || this.idService.parse(r.actid).date.getTime() >= cut;
		});

		// R: リアクション先。evidence の時刻は「リアクションした時刻」（ノート製造日ではない＝活動の新しさで trim される）。
		const rRows = await this.db.query(
			`SELECT r."userId" AS uid, n.id AS nid, e.embedding AS emb, r.id AS actid
			 FROM note_reaction r
			 JOIN note n ON n.id = r."noteId"
			 JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 LEFT JOIN "hanami_foryou_taste_evidence" ev ON ev."userId" = r."userId" AND ev."noteId" = n.id
			 WHERE r.id >= $2 AND r."userId" = ANY($3) AND r."userId" <> n."userId" AND ev."noteId" IS NULL
			 LIMIT $4`,
			[TASTE_EMBED_MODEL, sinceId, eligibleIds, TASTE_EVIDENCE_APPEND_LIMIT],
		) as { uid: string; nid: string; emb: number[]; actid: string }[];
		// N: 純RN先（Misskeyで最も強い支持表明。src は R と同扱い＝消費側の好み）。
		const nRows = await this.db.query(
			`SELECT rn."userId" AS uid, n.id AS nid, e.embedding AS emb, rn.id AS actid
			 FROM note rn
			 JOIN note n ON n.id = rn."renoteId"
			 JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 LEFT JOIN "hanami_foryou_taste_evidence" ev ON ev."userId" = rn."userId" AND ev."noteId" = n.id
			 WHERE rn.id >= $2 AND rn."userId" = ANY($3)
			   AND ${pureRenoteSql('rn')}
			   AND rn."userId" <> n."userId" AND ev."noteId" IS NULL
			 LIMIT $4`,
			[TASTE_EMBED_MODEL, sinceId, eligibleIds, TASTE_EVIDENCE_APPEND_LIMIT],
		) as { uid: string; nid: string; emb: number[]; actid: string }[];
		// W: 自投稿（時刻=ノート時刻）。
		const wRows = await this.db.query(
			`SELECT n."userId" AS uid, n.id AS nid, e.embedding AS emb, n.id AS actid
			 FROM note n
			 JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 LEFT JOIN "hanami_foryou_taste_evidence" ev ON ev."userId" = n."userId" AND ev."noteId" = n.id
			 WHERE n.id >= $2 AND n."userId" = ANY($3) AND ev."noteId" IS NULL
			 LIMIT $4`,
			[TASTE_EMBED_MODEL, sinceId, eligibleIds, TASTE_EVIDENCE_APPEND_LIMIT],
		) as { uid: string; nid: string; emb: number[]; actid: string }[];

		const insert = async (rows: { uid: string; nid: string; emb: number[]; actid: string }[], src: 'R' | 'W') => {
			const chunk = 500;
			for (let i = 0; i < rows.length; i += chunk) {
				const slice = rows.slice(i, i + chunk);
				const values: string[] = [];
				const params: unknown[] = [];
				for (const r of slice) {
					const base = params.length;
					values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
					params.push(r.uid, r.nid, encodeFp16(r.emb), src, this.idService.parse(r.actid).date, TASTE_EMBED_MODEL);
				}
				await this.db.query(
					`INSERT INTO "hanami_foryou_taste_evidence" ("userId", "noteId", vector, src, "createdAt", model)
					 VALUES ${values.join(',')}
					 ON CONFLICT ("userId", "noteId") DO NOTHING`,
					params,
				);
			}
		};
		const r = afterCutoff(rRows);
		const n2 = afterCutoff(nRows);
		const w = afterCutoff(wRows);
		await insert(r, 'R');
		await insert(n2, 'R');
		await insert(w, 'W');
		logger.info(`hanami taste cluster: evidence appended R=${r.length} RN=${n2.length} W=${w.length}`);
	}

	/** 反応/RN したのに埋め込みが無いノート（30日超の過去ノート等）を少量その場で埋め込む（A2）。 */
	private async embedMissingEngagedNotes(sinceId: string, eligibleIds: string[], logger: Logger): Promise<void> {
		const rows = await this.db.query(
			`SELECT DISTINCT n.id AS id, n.text AS text
			 FROM (
			   SELECT r."noteId" AS nid FROM note_reaction r WHERE r.id >= $2 AND r."userId" = ANY($3)
			   UNION
			   SELECT rn."renoteId" FROM note rn
			   WHERE rn.id >= $2 AND rn."userId" = ANY($3) AND ${pureRenoteSql('rn')}
			 ) t
			 JOIN note n ON n.id = t.nid
			 LEFT JOIN "hanami_note_embedding" e ON e."noteId" = n.id AND e.model = $1
			 WHERE n.text IS NOT NULL AND n."channelId" IS NULL
			   AND n.visibility IN ('public','home','followers') AND e."noteId" IS NULL
			 LIMIT 3000`,
			[TASTE_EMBED_MODEL, sinceId, eligibleIds],
		) as { id: string; text: string }[];
		if (rows.length === 0) return;
		const texts: [string, string][] = [];
		for (const r of rows) {
			const cleaned = this.cleanForEmbedding(r.text);
			if (contentCharCount(cleaned) >= TASTE_MIN_CHARS) texts.push([r.id, cleaned]);
		}
		if (texts.length === 0) return;
		const n = await this.embedAndStore(texts, 120, logger);
		logger.info(`hanami taste cluster: embedded ${n} engaged old notes`);
	}

	private async updateMeanVec(): Promise<number[] | null> {
		// 平均中心化の基準点。「最新N件」だと約6時間分になり、当日のバズや連投で全ユーザーの割当基準が回転する。
		// TTL30日の埋め込み全体から md5 で一様サンプルし、1ユーザーの寄与を cap する。
		const rows = await this.db.query(
			`SELECT embedding FROM (
			   SELECT e.embedding, md5(e."noteId") AS h,
			     row_number() OVER (PARTITION BY n."userId" ORDER BY md5(e."noteId")) AS rn
			   FROM "hanami_note_embedding" e
			   JOIN note n ON n.id = e."noteId"
			   WHERE e.model = $1
			 ) t WHERE t.rn <= $2 ORDER BY t.h LIMIT $3`,
			[TASTE_EMBED_MODEL, TASTE_MEANVEC_PER_USER_CAP, TASTE_MEANVEC_SAMPLE],
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
				`SELECT "noteId", vector, src FROM "hanami_foryou_taste_evidence" WHERE "userId" = $1 AND model = $2 ORDER BY "noteId"`,
				[uid, TASTE_EMBED_MODEL],
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
			await execFileAsync(python, [scriptPath, inputPath, binPath, outputPath], { env: this.tastePythonEnv(logger), timeout: TASTE_PROCESS_TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024 });
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
			// 鍵（followers）ノートはベクトルとして学習には使うが、ラベルの語彙には出さない（本人の投稿は除く）。
			// labelTerms は集計値なので endpoint 側で可視性フィルタできず、ブロック/アンフォロー後も
			// 鍵ノート由来の特徴語が見え続けてしまうため、源流で除外する。
			const ids = [...sampleIdx].map(i => evidence.noteIds[i]);
			const chunk = 1000;
			for (let i = 0; i < ids.length; i += chunk) {
				const rows = await this.db.query(
					`SELECT id, text FROM note
					 WHERE id = ANY($1) AND (visibility IN ('public','home') OR "userId" = $2)`,
					[ids.slice(i, i + chunk), res.userId],
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
			`SELECT "clusterId", centroid, "userWeight" FROM "hanami_foryou_user_taste_cluster" WHERE "userId" = $1 AND model = $2`,
			[res.userId, TASTE_EMBED_MODEL],
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
					 ("userId", "clusterId", centroid, size, "ownRate", "labelTerms", "exampleNoteIds", "userWeight", "updatedAt", model)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
					[res.userId, r.clusterId, r.centroid, r.size, r.ownRate, r.labelTerms, r.exampleNoteIds, r.userWeight, updatedAt, TASTE_EMBED_MODEL],
				);
			}
		});
		logger.debug?.(`hanami taste cluster: user ${res.userId} k=${res.k}`);
	}
}
