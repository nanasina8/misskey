/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import Logger from '@/logger.js';
import { IdService } from '@/core/IdService.js';
import { HanamiGpuQueueService, type HanamiGpuQueueTakenItem } from '@/core/hanami/HanamiGpuQueueService.js';
import { HanamiGpuDispatcherService } from '@/core/hanami/HanamiGpuDispatcherService.js';
import {
	HANAMI_RANK_BACKTEST_CHOICES,
	HANAMI_RANK_BACKTEST_GPU_VARIANTS,
	HANAMI_RANK_BACKTEST_HISTORY_MAX,
	HANAMI_RANK_BACKTEST_PRIOR_DAYS,
	HANAMI_RANK_BACKTEST_STORED_VARIANTS,
	HANAMI_RANK_BACKTEST_SUBSETS,
	HANAMI_RANK_BACKTEST_VERSION,
	buildHanamiRankBacktestPrompt,
	evaluateHanamiRankBacktestModel,
	hanamiRankBacktestInSubset,
	hanamiRankBacktestItemId,
	hanamiRankBacktestStoredScore,
	parseHanamiRankBacktestItemId,
	summarizeHanamiRankBacktest,
	type HanamiRankBacktestGpuVariant,
	type HanamiRankBacktestModelEvaluation,
	type HanamiRankBacktestSample,
	type HanamiRankBacktestScored,
	type HanamiRankBacktestSubset,
	type HanamiRankBacktestSummary,
	type HanamiRankBacktestVariant,
} from '@/core/hanami/HanamiRankBacktest.js';

/**
 * 並べ替えの物差しの進行係。
 * 1 回の実行 = 過去 N 日の「はなみTL で見た」記録から新しい順に最大 M 件を取り、付け方ごとに点数を付け直す。
 * 記録と DB の値を使う付け方は、始めるときにその場で値を調べる（GPU は使わない）。
 * GPU を使う付け方は、常駐の判定係の順番待ち（種類 rankBacktest、いちばん低い重要度）に少しずつ入れる。
 * 入れるのは配り役が「ほかの仕事が何も無い」ときに呼ぶ補充（refill）だけなので、ふだんの判定は待たせない。
 * 途中の状態と点数は Redis に置き（14 日で消える）、DB には何も書かない。
 */
const PREFIX = 'hanami:rankbt:v1:';
const LATEST_KEY = `${PREFIX}latest`;
const ACTIVE_KEY = `${PREFIX}active`;
const REFILL_LOCK_KEY = `${PREFIX}refillLock`;
const AUTO_CHECK_KEY = `${PREFIX}autoChecked`;
const runKey = (id: string) => `${PREFIX}run:${id}`;
const samplesKey = (id: string) => `${PREFIX}samples:${id}`;
const countsKey = (id: string) => `${PREFIX}counts:${id}`;
const pendingKey = (id: string, variant: HanamiRankBacktestGpuVariant) => `${PREFIX}pending:${id}:${variant}`;
const scoresKey = (id: string, variant: HanamiRankBacktestGpuVariant) => `${PREFIX}scores:${id}:${variant}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_SECONDS = 14 * 24 * 60 * 60;
const STATEMENT_TIMEOUT_MS = 30_000;
/** 補充 1 回で、付け方ごとに順番待ちへ入れる件数 */
const REFILL_CHUNK = 16;
/** 補充 1 回で読む回数の上限（対象外ばかりの区間を早く抜けるため） */
const REFILL_ROUNDS = 8;
/** 1 人ぶんの「投稿に付いた反応」を読む行数の上限（多すぎる人は、その人の値を付けない） */
const REACTION_ROW_LIMIT = 300_000;
const HOUR_MS = 60 * 60 * 1000;
/** 自動で始めるかを確かめる間隔 */
const AUTO_CHECK_SECONDS = 6 * 60 * 60;
/** 前の実行からこれだけたったら、空いているときに自動で始める */
const AUTO_INTERVAL_MS = 7 * DAY_MS;

export const HANAMI_RANK_BACKTEST_DEFAULT_DAYS = 60;
export const HANAMI_RANK_BACKTEST_DEFAULT_LIMIT = 4000;
export const HANAMI_RANK_BACKTEST_MAX_DAYS = 90;
export const HANAMI_RANK_BACKTEST_MAX_LIMIT = 10000;

export class HanamiRankBacktestAlreadyRunningError extends Error {
	constructor() {
		super('A Hanami rank backtest is already running');
		this.name = 'HanamiRankBacktestAlreadyRunningError';
	}
}

export type HanamiRankBacktestRun = {
	id: string;
	/** 付け方・集計の版（HANAMI_RANK_BACKTEST_VERSION）。古い実行には無い */
	version?: number;
	createdAt: number;
	finishedAt: number | null;
	startedBy: 'auto' | 'manual';
	days: number;
	limit: number;
	variants: HanamiRankBacktestGpuVariant[];
	samples: number;
};

export type HanamiRankBacktestStatus = {
	/** 採点が進んでいる途中か */
	active: boolean;
	run: null | {
		id: string;
		createdAt: string;
		finishedAt: string | null;
		startedBy: 'auto' | 'manual';
		days: number;
		limit: number;
		samples: number;
		/** 比べる土台 = GPU で採点する付け方のすべてで点数が付いた記録の数 */
		compared: number;
		progress: Array<{ variant: HanamiRankBacktestGpuVariant; scored: number; pending: number; skipped: number; errors: number }>;
		results: Array<{ variant: HanamiRankBacktestVariant; subset: HanamiRankBacktestSubset } & HanamiRankBacktestSummary>;
		/** 記録と DB の値を組み合わせた点数の検証。記録が足りないときは null */
		model: HanamiRankBacktestModelEvaluation | null;
	};
};

type SampleRow = {
	uid: string;
	nid: string;
	author: string;
	cluster: string;
	at: Date | string;
	source: string;
	relationship: string;
	engaged: boolean;
	interest: number | string | null;
};

/**
 * はなみTL で見た記録（利用者と投稿の組ごとに、初めて見たとき）を新しい順に取る。
 * 文の無い投稿（画像だけなど）と本人の投稿は、文面で判定できないので外す。
 * 反応したかは、TL の外での反応も含めて見る（STRANGER_INTEREST_SQL と同じ数え方）。
 */
const SAMPLES_SQL = `
	WITH seen AS (
		SELECT DISTINCT ON (e."userId", e."noteId") e."userId" AS uid, e."noteId" AS nid,
			COALESCE(e."occurredAt", e."createdAt") AS at,
			COALESCE(NULLIF(e.dimensions ->> 'source', ''), 'unknown') AS source,
			COALESCE(NULLIF(e.dimensions ->> 'relationshipClass', ''), 'unknown') AS relationship,
			COALESCE(NULLIF(e.dimensions ->> 'cluster', ''), 'none') AS cluster
		FROM "hanami_metrics_event" e
		WHERE e."eventType" = 'seen' AND e."createdAt" >= $1
		ORDER BY e."userId", e."noteId", COALESCE(e."occurredAt", e."createdAt") ASC
	)
	SELECT s.uid, s.nid, s.at, s.source, s.relationship, s.cluster, n."userId" AS author,
		EXISTS (SELECT 1 FROM "hanami_recommendation_event" e2
			WHERE e2."userId" = s.uid AND e2."noteId" = s.nid
				AND e2."eventType" IN ('reaction', 'reply', 'renote')) AS engaged,
		(SELECT max(j.interest) FROM "hanami_note_judgement" j WHERE j."noteId" = s.nid AND j.model NOT LIKE 'rule:%') AS interest
	FROM seen s
	JOIN note n ON n.id = s.nid
	WHERE n.text IS NOT NULL AND n.text <> '' AND n."userId" <> s.uid
	ORDER BY s.at DESC, s.uid, s.nid
	LIMIT $2
`;

/** 見た時刻より前に本人が反応した投稿の文（新しい順）。採点する投稿そのものは入れない。 */
const HISTORY_SQL = `
	SELECT n.text
	FROM note_reaction r
	JOIN note n ON n.id = r."noteId"
	WHERE r."userId" = $1 AND r.id < $2 AND r."noteId" <> $3
		AND n.text IS NOT NULL AND n.text <> '' AND n."userId" <> $1
	ORDER BY r.id DESC
	LIMIT $4
`;

/** 本人が、対象の作者たちの投稿に付けた反応（prior を数える材料）。反応の時刻は ID から読む。 */
const PRIOR_SQL = `
	SELECT r.id, r."noteId" AS "noteId", n."userId" AS author
	FROM note_reaction r
	JOIN note n ON n.id = r."noteId"
	WHERE r."userId" = $1 AND r.id >= $2 AND r.id < $3 AND n."userId" = ANY($4::varchar[])
`;

/** 対象の投稿に、本人以外が付けた反応（social・reactions を数える材料）。followed = 反応した人を本人がフォローしているか。 */
const NOTE_REACTIONS_SQL = `
	SELECT r."noteId" AS "noteId", r.id,
		EXISTS (SELECT 1 FROM following f WHERE f."followerId" = $1 AND f."followeeId" = r."userId") AS followed
	FROM note_reaction r
	WHERE r."noteId" = ANY($2::varchar[]) AND r."userId" <> $1
	LIMIT $3
`;

function parseJson<T>(raw: string | null | undefined): T | null {
	if (raw == null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

@Injectable()
export class HanamiRankBacktestService implements OnModuleInit {
	private readonly logger = new Logger('hanami');

	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		@Inject(DI.db)
		private db: DataSource,

		private idService: IdService,
		private hanamiGpuQueueService: HanamiGpuQueueService,
		private hanamiGpuDispatcherService: HanamiGpuDispatcherService,
	) {
	}

	/** 配り役に受け取り係と補充係を登録する */
	@bindThis
	public onModuleInit(): void {
		this.hanamiGpuDispatcherService.registerHandler<{ probabilities?: unknown }>('rankBacktest', async (items, results, errors) => {
			await this.handleScored(items, results, errors);
		});
		this.hanamiGpuDispatcherService.registerRefill('rankBacktest', async () => {
			await this.refill();
		});
	}

	/** 実行を始める。対象の記録を決めて Redis に置くだけで、採点は補充が少しずつ進める。 */
	@bindThis
	public async start(params: { days: number; limit: number; variants?: readonly HanamiRankBacktestGpuVariant[]; force?: boolean }, startedBy: 'auto' | 'manual', now = Date.now()): Promise<HanamiRankBacktestRun> {
		const active = await this.activeRun();
		if (active != null) {
			if (params.force !== true) throw new HanamiRankBacktestAlreadyRunningError();
			await this.cancel(active);
		}
		const variants = HANAMI_RANK_BACKTEST_GPU_VARIANTS.filter(variant => params.variants == null || params.variants.includes(variant));
		const rows = await this.query<SampleRow>(SAMPLES_SQL, [new Date(now - params.days * DAY_MS), params.limit]);
		const samples: HanamiRankBacktestSample[] = rows.map((row, index) => ({
			id: String(index),
			userId: row.uid,
			noteId: row.nid,
			seenAt: new Date(row.at).getTime(),
			source: row.source,
			relationship: row.relationship,
			engaged: row.engaged === true,
			interest: row.interest == null ? null : Number(row.interest),
			authorId: row.author,
			clustered: row.cluster === 'clustered',
		}));
		await this.attachFeatures(samples);
		const pending = samples.length > 0 && variants.length > 0;
		const run: HanamiRankBacktestRun = {
			id: this.idService.gen(now),
			version: HANAMI_RANK_BACKTEST_VERSION,
			createdAt: now,
			finishedAt: pending ? null : now,
			startedBy,
			days: params.days,
			limit: params.limit,
			variants: [...variants],
			samples: samples.length,
		};
		const pipe = this.redis.pipeline();
		pipe.set(runKey(run.id), JSON.stringify(run), 'EX', TTL_SECONDS);
		for (let i = 0; i < samples.length; i += 500) {
			pipe.hset(samplesKey(run.id), Object.fromEntries(samples.slice(i, i + 500).map(sample => [sample.id, JSON.stringify(sample)])));
		}
		if (samples.length > 0) pipe.expire(samplesKey(run.id), TTL_SECONDS);
		if (pending) {
			for (const variant of variants) {
				for (let i = 0; i < samples.length; i += 500) pipe.rpush(pendingKey(run.id, variant), ...samples.slice(i, i + 500).map(sample => sample.id));
				pipe.expire(pendingKey(run.id, variant), TTL_SECONDS);
			}
			pipe.set(ACTIVE_KEY, run.id, 'EX', TTL_SECONDS);
		}
		pipe.set(LATEST_KEY, run.id, 'EX', TTL_SECONDS);
		await pipe.exec();
		this.logger.info('hanami rank backtest: started', { runId: run.id, startedBy, samples: samples.length, variants });
		return run;
	}

	/**
	 * 補充。配り役が「ほかの仕事が何も無い」ときに呼ぶ。
	 * 実行中のものがあれば、順番待ちが空のときだけ次の数件を入れる。無ければ、前の実行から日がたっていれば自動で始める。
	 */
	@bindThis
	public async refill(): Promise<void> {
		const got = await this.redis.set(REFILL_LOCK_KEY, String(process.pid), 'EX', 120, 'NX');
		if (got == null) return;
		try {
			const run = await this.activeRun();
			if (run == null) {
				await this.maybeAutoStart();
				return;
			}
			// 前に入れた分がまだ残っていれば足さない（順番待ちをためない）
			if (await this.hanamiGpuQueueService.pending('rankBacktest') > 0) return;
			let enqueued = 0;
			let remaining = 0;
			for (let round = 0; round < REFILL_ROUNDS && enqueued === 0; round++) {
				remaining = 0;
				for (const variant of run.variants) {
					const ids = await this.redis.lpop(pendingKey(run.id, variant), REFILL_CHUNK) ?? [];
					if (ids.length > 0) enqueued += await this.enqueueSamples(run, variant, ids);
					remaining += await this.redis.llen(pendingKey(run.id, variant));
				}
				if (remaining === 0) break;
			}
			if (enqueued === 0 && remaining === 0) await this.finish(run);
		} finally {
			await this.redis.del(REFILL_LOCK_KEY);
		}
	}

	/** 受け取り係。判定係が返した確率（1 つめ = 「はい」）を点数として残す。 */
	@bindThis
	public async handleScored(items: readonly HanamiGpuQueueTakenItem[], results: ReadonlyMap<string, { probabilities?: unknown }>, errors: ReadonlyMap<string, string>): Promise<void> {
		const pipe = this.redis.pipeline();
		const touched = new Set<string>();
		for (const item of items) {
			const parsed = parseHanamiRankBacktestItemId(item.itemId);
			if (parsed == null) continue;
			const output = results.get(item.itemId);
			const probability = Array.isArray(output?.probabilities) ? Number(output.probabilities[0]) : Number.NaN;
			if (Number.isFinite(probability) && probability >= 0 && probability <= 1) {
				pipe.hset(scoresKey(parsed.runId, parsed.variant), parsed.sampleId, probability.toFixed(6));
				touched.add(scoresKey(parsed.runId, parsed.variant));
			} else {
				pipe.hincrby(countsKey(parsed.runId), `${parsed.variant}:errors`, 1);
				touched.add(countsKey(parsed.runId));
				if (!errors.has(item.itemId)) this.logger.warn('hanami rank backtest: unexpected worker output', { itemId: item.itemId });
			}
		}
		for (const key of touched) pipe.expire(key, TTL_SECONDS);
		if (touched.size > 0) await pipe.exec();
	}

	/** いちばん新しい実行の進み具合と、付け方ごとの結果。件数と割合だけを返す（だれの記録かは返さない）。 */
	@bindThis
	public async status(): Promise<HanamiRankBacktestStatus> {
		const latestId = await this.redis.get(LATEST_KEY);
		const run = latestId == null ? null : parseJson<HanamiRankBacktestRun>(await this.redis.get(runKey(latestId)));
		if (run == null) return { active: false, run: null };

		const samples = Object.values(await this.redis.hgetall(samplesKey(run.id)))
			.flatMap(raw => { const sample = parseJson<HanamiRankBacktestSample>(raw); return sample == null ? [] : [sample]; });
		const counts = await this.redis.hgetall(countsKey(run.id));
		const scores = new Map<HanamiRankBacktestGpuVariant, Map<string, number>>();
		const progress: NonNullable<HanamiRankBacktestStatus['run']>['progress'] = [];
		for (const variant of run.variants) {
			const raw = await this.redis.hgetall(scoresKey(run.id, variant));
			const byId = new Map(Object.entries(raw).flatMap(([id, value]) => Number.isFinite(Number(value)) ? [[id, Number(value)] as const] : []));
			scores.set(variant, byId);
			progress.push({
				variant,
				scored: byId.size,
				pending: await this.redis.llen(pendingKey(run.id, variant)),
				skipped: Number(counts[`${variant}:skipped`] ?? 0),
				errors: Number(counts[`${variant}:errors`] ?? 0),
			});
		}

		// 付け方によって点数の付く記録が違う（personal は反応の少ない人を外す）。比べるのは、全部の付け方で点数が付いた記録だけ。
		const compared = samples.filter(sample => run.variants.every(variant => scores.get(variant)?.has(sample.id) === true));
		const results: NonNullable<HanamiRankBacktestStatus['run']>['results'] = [];
		const scoreOf = (variant: HanamiRankBacktestVariant, sample: HanamiRankBacktestSample): number | null => {
			if ((HANAMI_RANK_BACKTEST_STORED_VARIANTS as readonly string[]).includes(variant)) {
				return hanamiRankBacktestStoredScore(variant as typeof HANAMI_RANK_BACKTEST_STORED_VARIANTS[number], sample);
			}
			return scores.get(variant as HanamiRankBacktestGpuVariant)?.get(sample.id) ?? null;
		};
		for (const variant of [...run.variants, ...HANAMI_RANK_BACKTEST_STORED_VARIANTS] as HanamiRankBacktestVariant[]) {
			for (const subset of HANAMI_RANK_BACKTEST_SUBSETS) {
				const rows: HanamiRankBacktestScored[] = compared.filter(sample => hanamiRankBacktestInSubset(subset, sample)).flatMap(sample => {
					const score = scoreOf(variant, sample);
					return score == null ? [] : [{ score, engaged: sample.engaged, userId: sample.userId }];
				});
				results.push({ variant, subset, ...summarizeHanamiRankBacktest(rows) });
			}
		}

		return {
			active: run.finishedAt == null,
			run: {
				id: run.id,
				createdAt: new Date(run.createdAt).toISOString(),
				finishedAt: run.finishedAt == null ? null : new Date(run.finishedAt).toISOString(),
				startedBy: run.startedBy,
				days: run.days,
				limit: run.limit,
				samples: run.samples,
				compared: compared.length,
				progress,
				results,
				model: evaluateHanamiRankBacktestModel(compared),
			},
		};
	}

	private async activeRun(): Promise<HanamiRankBacktestRun | null> {
		const id = await this.redis.get(ACTIVE_KEY);
		if (id == null) return null;
		const run = parseJson<HanamiRankBacktestRun>(await this.redis.get(runKey(id)));
		if (run == null || run.finishedAt != null) {
			await this.redis.del(ACTIVE_KEY);
			return null;
		}
		return run;
	}

	/**
	 * 自動の実行は GPU を使わない（記録と DB の値を使う付け方と、組み合わせた点数の検証だけ）。
	 * LLM に聞く付け方は 1 回目で効かないと分かったので、試したいときに手で始める。
	 */
	private async maybeAutoStart(): Promise<void> {
		// 配り役は数秒おきに補充を呼ぶ。確かめるのは数時間に 1 回だけにする
		if (await this.redis.set(AUTO_CHECK_KEY, '1', 'EX', AUTO_CHECK_SECONDS, 'NX') == null) return;
		const latestId = await this.redis.get(LATEST_KEY);
		const latest = latestId == null ? null : parseJson<HanamiRankBacktestRun>(await this.redis.get(runKey(latestId)));
		// 付け方や集計を変えたあと（版が違う）は、7 日を待たずに取り直す
		if (latest != null && latest.version === HANAMI_RANK_BACKTEST_VERSION && Date.now() - latest.createdAt < AUTO_INTERVAL_MS) return;
		try {
			await this.start({ days: HANAMI_RANK_BACKTEST_DEFAULT_DAYS, limit: HANAMI_RANK_BACKTEST_DEFAULT_LIMIT, variants: [] }, 'auto');
		} catch (error) {
			this.logger.warn('hanami rank backtest: failed to start automatically', { error: String(error) });
		}
	}

	/**
	 * 記録ごとに、見た時点までに分かっていた値を付ける（prior・social・reactions・投稿からの時間）。
	 * 利用者ごとに 2 回の問い合わせでまとめて読み、時刻の前後は ID から読んだ時刻で判定する。
	 * ある人の分が読めなかったとき（時間切れ・多すぎる）は、その人の記録には値を付けない。
	 */
	private async attachFeatures(samples: HanamiRankBacktestSample[]): Promise<void> {
		const byUser = new Map<string, HanamiRankBacktestSample[]>();
		for (const sample of samples) {
			const list = byUser.get(sample.userId) ?? [];
			list.push(sample);
			byUser.set(sample.userId, list);
		}
		const timeOf = (id: string): number => {
			try {
				return this.idService.parse(id).date.getTime();
			} catch {
				return Number.NaN;
			}
		};
		const priorWindowMs = HANAMI_RANK_BACKTEST_PRIOR_DAYS * DAY_MS;
		for (const [userId, list] of byUser) {
			try {
				const authors = [...new Set(list.flatMap(sample => sample.authorId == null ? [] : [sample.authorId]))];
				const noteIds = [...new Set(list.map(sample => sample.noteId))];
				const earliest = Math.min(...list.map(sample => sample.seenAt));
				const latest = Math.max(...list.map(sample => sample.seenAt));
				const priorRows = authors.length === 0 ? [] : await this.query<{ id: string; noteId: string; author: string }>(
					PRIOR_SQL, [userId, this.idService.gen(earliest - priorWindowMs), this.idService.gen(latest), authors]);
				const reactionRows = await this.query<{ noteId: string; id: string; followed: boolean }>(NOTE_REACTIONS_SQL, [userId, noteIds, REACTION_ROW_LIMIT]);
				if (reactionRows.length >= REACTION_ROW_LIMIT) throw new Error('too many reactions to read');

				const priorByAuthor = new Map<string, Array<{ at: number; noteId: string }>>();
				for (const row of priorRows) {
					const entries = priorByAuthor.get(row.author) ?? [];
					entries.push({ at: timeOf(row.id), noteId: row.noteId });
					priorByAuthor.set(row.author, entries);
				}
				const reactionsByNote = new Map<string, Array<{ at: number; followed: boolean }>>();
				for (const row of reactionRows) {
					const entries = reactionsByNote.get(row.noteId) ?? [];
					entries.push({ at: timeOf(row.id), followed: row.followed === true });
					reactionsByNote.set(row.noteId, entries);
				}
				for (const sample of list) {
					const postedAt = timeOf(sample.noteId);
					if (!Number.isFinite(postedAt)) continue;
					const before = (reactionsByNote.get(sample.noteId) ?? []).filter(entry => entry.at < sample.seenAt);
					sample.features = {
						prior: (sample.authorId == null ? [] : priorByAuthor.get(sample.authorId) ?? [])
							.filter(entry => entry.noteId !== sample.noteId && entry.at < sample.seenAt && entry.at >= sample.seenAt - priorWindowMs).length,
						social: before.filter(entry => entry.followed).length,
						reactions: before.length,
						ageHours: Math.max(0, (sample.seenAt - postedAt) / HOUR_MS),
					};
				}
			} catch (error) {
				this.logger.warn('hanami rank backtest: failed to read features for one user', { error: String(error), samples: list.length });
			}
		}
	}

	/** 対象の記録の文面を作って順番待ちに入れる。文面を作れない記録（消えた投稿・材料の足りない人）は数えて飛ばす。 */
	private async enqueueSamples(run: HanamiRankBacktestRun, variant: HanamiRankBacktestGpuVariant, ids: readonly string[]): Promise<number> {
		const raw = await this.redis.hmget(samplesKey(run.id), ...ids);
		const samples = raw.flatMap(value => { const sample = parseJson<HanamiRankBacktestSample>(value); return sample == null ? [] : [sample]; });
		const notes = samples.length === 0 ? [] : await this.query<{ id: string; text: string }>(
			'SELECT id, text FROM note WHERE id = ANY($1::varchar[]) AND text IS NOT NULL',
			[[...new Set(samples.map(sample => sample.noteId))]],
		);
		const textOf = new Map(notes.map(note => [note.id, note.text]));
		let enqueued = 0;
		for (const sample of samples) {
			const text = textOf.get(sample.noteId);
			const history = text == null || variant !== 'personal' ? [] : (await this.query<{ text: string }>(
				HISTORY_SQL,
				[sample.userId, this.idService.gen(sample.seenAt), sample.noteId, HANAMI_RANK_BACKTEST_HISTORY_MAX],
			)).map(row => row.text);
			const prompt = text == null ? null : buildHanamiRankBacktestPrompt(variant, text, history);
			if (prompt == null) continue;
			// runId は、実行を打ち切るときに順番待ちから取り除く目印（判定係には渡さない）
			await this.hanamiGpuQueueService.enqueue('rankBacktest', hanamiRankBacktestItemId(run.id, variant, sample.id), { prompt, choices: [...HANAMI_RANK_BACKTEST_CHOICES], runId: run.id });
			enqueued++;
		}
		const skipped = ids.length - enqueued;
		if (skipped > 0) {
			await this.redis.pipeline().hincrby(countsKey(run.id), `${variant}:skipped`, skipped).expire(countsKey(run.id), TTL_SECONDS).exec();
		}
		return enqueued;
	}

	/**
	 * 実行中のものを打ち切る（GPU が使えなくなって進まないときなど）。
	 * まだ順番待ちにある分と、これから入れる分を捨てる。そこまでに付いた点数は残るので、結果は途中までの分で見られる。
	 */
	private async cancel(run: HanamiRankBacktestRun): Promise<void> {
		const removed = await this.hanamiGpuQueueService.removeWhere('rankBacktest', payload => (payload as { runId?: unknown } | null)?.runId === run.id);
		const pipe = this.redis.pipeline();
		for (const variant of run.variants) pipe.del(pendingKey(run.id, variant));
		await pipe.exec();
		await this.finish(run);
		this.logger.info('hanami rank backtest: cancelled', { runId: run.id, removed });
	}

	private async finish(run: HanamiRankBacktestRun): Promise<void> {
		const finished: HanamiRankBacktestRun = { ...run, finishedAt: Date.now() };
		await this.redis.pipeline().set(runKey(run.id), JSON.stringify(finished), 'EX', TTL_SECONDS).del(ACTIVE_KEY).exec();
		this.logger.info('hanami rank backtest: finished', { runId: run.id, samples: run.samples });
	}

	/** 読み取り専用・時間制限つきで 1 文だけ流す。 */
	private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
		return await this.db.transaction(async manager => {
			await manager.query('SET TRANSACTION READ ONLY');
			await manager.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
			return await manager.query(sql, params) as T[];
		});
	}
}
