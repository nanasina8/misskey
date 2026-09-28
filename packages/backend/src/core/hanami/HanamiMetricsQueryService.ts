/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from './HanamiNoteJudgeContracts.js';
import { peekHanamiNoteJudgeRuntime } from './HanamiPythonRuntime.js';
import {
	HANAMI_METRICS_DIMENSIONS, HANAMI_METRICS_FAILURE_KINDS,
	jstDay, shiftMetricsDay, resolveRange, rangeDays, rangeParameters, metricRatio,
	metricsCohortSql, METRICS_NORMAL_SQL, metricsGenerationSql, METRICS_COLLECTION_GAP_SQL,
	metricsDailyEngagementSql, metricsRangeUsersSql, METRICS_DAILY_PERSONAL_GENERATION_SQL,
	METRICS_SUMMARY_USERS_SQL,
} from './HanamiMetricsContracts.js';
import type {
	HanamiMetricsRange, HanamiMetricsResolvedRange, HanamiMetricsCoverage, HanamiMetricsCounts,
	HanamiMetricsBreakdownRequest, HanamiMetricsBreakdown, HanamiMetricsSummary, HanamiMetricsErrors,
	HanamiMetricsStats, HanamiMetricsFailureKind, HanamiMetricsFailureCounts, HanamiMetricsGeneration,
	HanamiMetricsTimelineKind, MetricsAggregateRow, MetricsGenerationRow, MetricsNormalRow, Metric,
	HanamiMetricsDimension,
	MetricsSummaryUsersRow,
} from './HanamiMetricsContracts.js';
import type { DataSource } from 'typeorm';

export { resolveRange } from './HanamiMetricsContracts.js';
export type { HanamiMetricsRange, HanamiMetricsBreakdownRequest, HanamiMetricsSummary, HanamiMetricsBreakdown, HanamiMetricsErrors, HanamiMetricsStats } from './HanamiMetricsContracts.js';

const NULL_COUNTS: HanamiMetricsCounts = { users: null, served: null, seen: null, reaction: null, reply: null, renote: null };
const EMPTY_COUNTS: MetricsAggregateRow = { key: 'total', users: 0, served: 0, seen: 0, reaction: 0, reply: 0, renote: 0 };
const TL_KINDS: HanamiMetricsTimelineKind[] = ['home', 'local', 'social', 'global', 'hanami'];
const MESSAGES: Record<HanamiMetricsFailureKind, string> = {
	emptyResult: 'Generation produced an empty result',
	candidateLimit: 'Generation exceeded the candidate limit',
	lockTimeout: 'Generation lock timed out',
	exception: 'Generation failed',
	unknown: 'Generation failed (reason unavailable)',
};

/** Never echo raw failure messages: SQL/URLs/note text can contain identifiers or credentials. */
export function sanitizeMetricsFailure(kind: string | null): { kind: HanamiMetricsFailureKind; message: string } {
	const safeKind = HANAMI_METRICS_FAILURE_KINDS.find(candidate => candidate === kind) ?? 'unknown';
	return { kind: safeKind, message: MESSAGES[safeKind] };
}

/** No insecure default. A missing secret disables recent personal errors entirely. */
export function metricsUserBucket(userId: string, at: Date, secret: string | undefined): string | null {
	if (!secret?.trim()) return null;
	const dailyKey = createHmac('sha256', secret).update(`hanami-metrics:${jstDay(at)}`).digest();
	return `u#${createHmac('sha256', dailyKey).update(userId).digest('hex').slice(0, 4)}`;
}

function counts(row: MetricsAggregateRow): HanamiMetricsCounts {
	return { users: row.users, served: row.served, seen: row.seen, reaction: row.reaction, reply: row.reply, renote: row.renote };
}

function engaged(row: MetricsAggregateRow): number { return row.reaction + row.reply + row.renote; }

/** Only these five counts are additive; distinct users never are. */
function addEngagementCounts(target: MetricsAggregateRow, row: MetricsAggregateRow): void {
	for (const kind of ['served', 'seen', 'reaction', 'reply', 'renote'] as const) target[kind] += row[kind];
}

function mergeEngagementRows(historical: MetricsAggregateRow[], provisional: MetricsAggregateRow[], users: Pick<MetricsAggregateRow, 'key' | 'users'>[]): MetricsAggregateRow[] {
	const rows = new Map(historical.map(row => [row.key, { ...row }]));
	for (const row of provisional) {
		const merged = rows.get(row.key) ?? { ...EMPTY_COUNTS, key: row.key };
		addEngagementCounts(merged, row);
		rows.set(row.key, merged);
	}
	for (const row of users) rows.set(row.key, { ...(rows.get(row.key) ?? EMPTY_COUNTS), key: row.key, users: row.users });
	return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function nonnegativeMetric(value: unknown): Metric {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Only the device enum is public, never recorded device names, reasons or arbitrary params. */
function runtimeDevice(value: unknown): string | null {
	return value === 'cpu' || value === 'cuda' ? value : null;
}

function complete(coverage: HanamiMetricsCoverage, range: HanamiMetricsResolvedRange): boolean {
	return rangeDays(range).every(day => coverage.completeDays.includes(day));
}

function usable(row: MetricsAggregateRow | undefined, covered: boolean): row is MetricsAggregateRow {
	return row !== undefined && (row.users > 0 || covered);
}

function safeCount(count: number, users: number, covered: boolean): Metric {
	return users === 0 && !covered ? null : count;
}

function failedDay(row: MetricsGenerationRow | undefined, covered: boolean): Metric {
	return safeCount(row?.failed ?? 0, row?.failedUsers ?? 0, covered);
}

/** Admin metrics include every observed cohort, regardless of its user count. */
export function presentMetricsBreakdown(rows: MetricsAggregateRow[]): Pick<HanamiMetricsBreakdown, 'rows' | 'suppressed' | 'denominator'> {
	const visible = rows;
	const served = visible.reduce((sum, row) => sum + row.served, 0);
	const seen = visible.reduce((sum, row) => sum + row.seen, 0);
	const reactions = visible.reduce((sum, row) => sum + engaged(row), 0);
	const overall = metricRatio(reactions, seen);
	return {
		denominator: 'visible',
		suppressed: [],
		rows: visible.map(row => ({
			key: row.key, ...counts(row), share: metricRatio(row.served, served),
			engagementShare: metricRatio(engaged(row), reactions), engagementRate: metricRatio(engaged(row), row.served),
			seenRate: metricRatio(row.seen, row.served), engagementPerSeen: metricRatio(engaged(row), row.seen),
			lift: metricRatio(metricRatio(engaged(row), row.seen), overall),
		})),
	};
}

function presentGeneration(rows: MetricsGenerationRow[], covered: boolean): HanamiMetricsGeneration {
	const personal = rows.find(row => row.key === 'personal');
	const common = rows.find(row => row.key === 'common');
	const judge = rows.find(row => row.key === 'judge');
	const byKind = {} as HanamiMetricsFailureCounts;
	for (const kind of HANAMI_METRICS_FAILURE_KINDS) {
		const failure = personal?.failures.find(row => row.kind === kind);
		byKind[kind] = safeCount(failure?.count ?? 0, failure?.users ?? 0, covered);
	}
	const available = personal !== undefined || covered;
	const failed = available ? safeCount(personal?.failed ?? 0, personal?.failedUsers ?? 0, covered) : null;
	return {
		personal: {
			batches: available ? personal?.total ?? 0 : null,
			failed, failedRate: metricRatio(failed, available ? personal?.total ?? 0 : null),
			p50Ms: available ? personal?.p50Ms ?? null : null, p95Ms: available ? personal?.p95Ms ?? null : null,
			failedByKind: byKind,
		},
		common: { generations: common?.total ?? (covered ? 0 : null), failed: common?.failed ?? (covered ? 0 : null), p50Ms: common?.p50Ms ?? null, p95Ms: common?.p95Ms ?? null },
		judge: { runs: judge?.total ?? (covered ? 0 : null), failed: judge?.failed ?? (covered ? 0 : null), p50Ms: judge?.p50Ms ?? null, p95Ms: judge?.p95Ms ?? null, backlog: null, secPerNote: null, runtime: null },
	};
}

@Injectable()
export class HanamiMetricsQueryService {
	private statsCache: { key: string; expiresAt: number; value: HanamiMetricsStats } | undefined;
	private readonly rawCache = new Map<string, { expiresAt: number; value: HanamiMetricsBreakdown | HanamiMetricsErrors }>();

	constructor(@Inject(DI.db) private readonly db: DataSource) {}

	public async breakdown(request: HanamiMetricsBreakdownRequest): Promise<HanamiMetricsBreakdown> {
		const range = resolveRange(request.range);
		if (!HANAMI_METRICS_DIMENSIONS.includes(request.dimension)) throw new RangeError('Invalid metrics dimension');
		for (const [key, value] of Object.entries(request.filter ?? {})) {
			if (!(HANAMI_METRICS_DIMENSIONS as readonly string[]).includes(key) || key === request.dimension || typeof value !== 'string' || value.length > 128) throw new RangeError('Invalid metrics filter');
		}
		const filter = Object.fromEntries(Object.entries(request.filter ?? {}).sort(([a], [b]) => a.localeCompare(b)));
		const raw = request.dimension === 'trendTerm' || Object.keys(filter).length > 0;
		const load = async (): Promise<HanamiMetricsBreakdown> => {
			const [coverage, rows] = await Promise.all([
				this.coverage(range),
				raw ? this.db.query<MetricsAggregateRow[]>(metricsCohortSql('dimension'), [...rangeParameters(range), JSON.stringify(filter), request.dimension])
				: this.dailyEngagement(range, request.dimension),
			]);
			return { range, dimension: request.dimension, ...presentMetricsBreakdown(rows), coverage };
		};
		return raw ? this.cachedRaw(JSON.stringify(['breakdown', { range, dimension: request.dimension, filter }]), load) : load();
	}

	public async summary(input?: HanamiMetricsRange): Promise<HanamiMetricsSummary> {
		const range = resolveRange(input);
		const bounds = rangeParameters(range);
		const [coverage, engagement, normalRows, generations, dailyGenerations, refreshes, timeline, rateLimited, judgeStatus, diagnosticUnavailable] = await Promise.all([
			this.coverage(range),
			this.summaryEngagement(range),
			this.db.query<MetricsNormalRow[]>(METRICS_NORMAL_SQL, bounds),
			this.db.query<MetricsGenerationRow[]>(metricsGenerationSql(), bounds),
			this.dailyPersonalGeneration(range),
			this.db.query<{ day: string; users: number; refreshes: number }[]>(`SELECT to_char("createdAt" AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day,
				COUNT(DISTINCT "userId")::int AS users, COUNT(*)::int AS refreshes FROM hanami_metrics_refresh
				WHERE "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz GROUP BY day`, bounds),
			this.db.query<{ key: HanamiMetricsTimelineKind; users: number; requests: number }[]>(`SELECT kind AS key, COUNT(DISTINCT "userId")::int AS users, SUM(requests)::int AS requests
				FROM hanami_metrics_timeline WHERE day >= $1::date AND day <= $2::date GROUP BY kind`, [range.from, range.to]),
			this.rateLimited(range),
			this.judgeStatus(),
			this.diagnosticUnavailable(range),
		]);
		const { total, daily, windows } = engagement;
		const covered = complete(coverage, range);
		const suppressed: string[] = [];
		const days = rangeDays(range);
		const dayRows = new Map(daily.map(row => [row.day, row]));
		const generationRows = new Map(dailyGenerations.filter(row => row.key === 'personal').map(row => [row.day, row]));
		const totalVisible = usable(total, covered);
		const normal = normalRows.at(0);
		const baseline = { reaction: null, reply: null, renote: null } as HanamiMetricsSummary['engagement']['normalBaseline'];
		for (const kind of ['reaction', 'reply', 'renote'] as const) {
			const users = normal?.[`${kind}Users`] ?? 0;
			baseline[kind] = safeCount(normal?.[kind] ?? 0, users, covered);
		}
		const hanamiUsers: HanamiMetricsSummary['usage']['hanamiUsers'] = { day: null, week: null, month: null };
		for (const window of windows) {
			const windowCovered = this.windowCovered(coverage, { from: window.from, to: range.to });
			hanamiUsers[window.key] = safeCount(window.users, window.users, windowCovered);
		}
		const tlShare: Record<HanamiMetricsTimelineKind, Metric> = { home: null, local: null, social: null, global: null, hanami: null };
		const [health] = await this.db.query<{ gap: boolean }[]>(METRICS_COLLECTION_GAP_SQL, [range.from, range.to]);
		const visibleTimeline = timeline;
		const requests = visibleTimeline.reduce((sum, row) => sum + row.requests, 0);
		for (const kind of TL_KINDS) {
			const row = timeline.find(item => item.key === kind);
			if (health?.gap) continue;
			tlShare[kind] = row || covered ? metricRatio(row?.requests ?? 0, requests) : null;
		}
		if (health?.gap) coverage.unavailable.push('usage.tlShare.collectionGap');
		if (range.to === jstDay()) coverage.unavailable.push('usage.tlShare.currentDayProvisional');
		const userDays = daily.reduce((sum, row) => sum + row.users, 0); // person-days, NEVER range uniques
		const manualRefresh = covered ? metricRatio(refreshes.reduce((sum, row) => sum + row.refreshes, 0), userDays) : null;
		const generation = presentGeneration(generations, covered);
		Object.assign(generation.judge, judgeStatus);
		const series: HanamiMetricsSummary['series'] = { day: days, hanamiUsers: [], engagementRate: [], failedBatches: [] };
		for (const day of days) {
			const row = dayRows.get(day) ?? EMPTY_COUNTS;
			const dayCovered = coverage.completeDays.includes(day);
			const visible = usable(row, dayCovered);
			series.hanamiUsers.push(visible ? row.users : null);
			series.engagementRate.push(visible ? metricRatio(engaged(row), row.served) : null);
			const failed = generationRows.get(day);
			series.failedBatches.push(failedDay(failed, dayCovered));
		}
		for (const key of ['backlog', 'secPerNote', 'runtime'] as const) {
			if (judgeStatus[key] === null) coverage.unavailable.push(`generation.judge.${key}`);
		}
		coverage.unavailable.push(...diagnosticUnavailable);
		if (rateLimited.some(row => row.count === null)) coverage.unavailable.push('usage.rateLimited429');
		return {
			range, usage: { hanamiUsers, tlShare, manualRefreshPerUserDay: manualRefresh, rateLimited429: rateLimited.every(row => row.count !== null) ? rateLimited.reduce((sum, row) => sum + (row.count ?? 0), 0) : null },
			engagement: { ...(totalVisible ? counts(total) : NULL_COUNTS), engagementRate: totalVisible ? metricRatio(engaged(total), total.served) : null, seenRate: totalVisible ? metricRatio(total.seen, total.served) : null, normalBaseline: baseline },
			generation, series, suppressed: [...new Set(suppressed)], denominator: 'visible', coverage,
		};
	}

	public async errors(input?: HanamiMetricsRange): Promise<HanamiMetricsErrors> {
		const range = resolveRange(input);
		return this.cachedRaw(JSON.stringify(['errors', { range }]), () => this.queryErrors(range));
	}

	private async queryErrors(range: HanamiMetricsResolvedRange): Promise<HanamiMetricsErrors> {
		const bounds = rangeParameters(range);
		const [coverage, generationRows, daily, limited, backlog] = await Promise.all([
			this.coverage(range), this.db.query<MetricsGenerationRow[]>(metricsGenerationSql(), bounds),
			this.db.query<MetricsGenerationRow[]>(metricsGenerationSql(true), bounds), this.rateLimited(range),
			this.judgeBacklog(),
		]);
		const suppressed: string[] = [];
		const generation = presentGeneration(generationRows, complete(coverage, range));
		const personal = generationRows.find(row => row.key === 'personal');
		const secret = process.env.HANAMI_METRICS_SALT;
		const recent: HanamiMetricsErrors['personal']['recent'] = [];
		if (!secret?.trim()) coverage.unavailable.push('personal.recent:HANAMI_METRICS_SALT missing');
		else if (personal) {
			// Keep the sanitized error kinds and daily pseudonyms.
			const allowed = personal.failures.map(row => row.kind);
			if (allowed.length > 0) {
				const rows = await this.db.query<{ at: Date | string; userId: string; kind: string | null; attempts: number }[]>(`SELECT COALESCE("finishedAt", "createdAt") AS at, "userId", "failureKind" AS kind, attempts
					FROM hanami_user_feed_batch WHERE status = 'failed' AND "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz
					AND (CASE WHEN "failureKind" IN ('emptyResult','candidateLimit','lockTimeout','exception') THEN "failureKind" ELSE 'unknown' END) = ANY($3::text[])
					ORDER BY COALESCE("finishedAt", "createdAt") DESC, id DESC LIMIT 20`, [...bounds, allowed]);
				for (const row of rows) {
					const at = new Date(row.at);
					const bucket = metricsUserBucket(row.userId, at, secret);
					if (bucket !== null) recent.push({ at: at.toISOString(), ...sanitizeMetricsFailure(row.kind), attempts: row.attempts, userBucket: bucket });
				}
			}
		}
		const [common, judge] = await Promise.all([
			this.db.query<{ at: Date | string }[]>('SELECT COALESCE("finishedAt", "startedAt") AS at FROM hanami_common_generation WHERE status = \'failed\' AND "startedAt" >= $1::timestamptz AND "startedAt" < $2::timestamptz ORDER BY at DESC LIMIT 20', bounds),
			this.db.query<{ at: Date | string }[]>('SELECT COALESCE("finishedAt", "startedAt") AS at FROM hanami_foryou_model_run WHERE kind = \'note-judge\' AND status = \'failed\' AND "startedAt" >= $1::timestamptz AND "startedAt" < $2::timestamptz ORDER BY at DESC LIMIT 20', bounds),
		]);
		const byDay = rangeDays(range).map(day => {
			const row = daily.find(item => item.key === 'personal' && item.day === day);
			return { day, failed: failedDay(row, coverage.completeDays.includes(day)) };
		});
		if (backlog === null) coverage.unavailable.push('judge.backlog');
		if (limited.some(row => row.count === null)) coverage.unavailable.push('rateLimited');
		return {
			range, personal: { byKind: generation.personal.failedByKind, byDay, recent },
			common: { recent: common.map(row => ({ at: new Date(row.at).toISOString(), status: 'failed', message: 'Common generation failed' })) },
			judge: { recent: judge.map(row => ({ at: new Date(row.at).toISOString(), status: 'failed', message: 'Note judgement failed' })), backlog },
			rateLimited: { byDay: limited }, suppressed: [...new Set(suppressed)], coverage,
		};
	}

	public async stats(input?: HanamiMetricsRange): Promise<HanamiMetricsStats> {
		const range = resolveRange(input);
		const key = `${range.from}:${range.to}`;
		if (this.statsCache?.key === key && this.statsCache.expiresAt > Date.now()) return structuredClone(this.statsCache.value);
		const [summary, breakdown] = await Promise.all([this.summary(range), this.breakdown({ range, dimension: 'source' })]);
		const series: HanamiMetricsStats['series'] = [];
		const suppressed: string[] = [];
		// Weekly chunks, exact range distinct users; never sum daily distinct counts.
		for (let from = range.from; from <= range.to; from = shiftMetricsDay(from, 7)) {
			const to = shiftMetricsDay(from, 6) > range.to ? range.to : shiftMetricsDay(from, 6);
			const [row = EMPTY_COUNTS] = await this.db.query<MetricsAggregateRow[]>(metricsCohortSql('total'), [...rangeParameters({ from, to }), '{}']);
			const visible = usable(row, complete(summary.coverage, { from, to }));
			series.push({ week: from, hanamiUsers: visible ? row.users : null, engagementRate: visible ? metricRatio(engaged(row), row.served) : null });
		}
		const value: HanamiMetricsStats = {
			range, usage: { hanamiUsers: summary.usage.hanamiUsers, tlShare: summary.usage.tlShare },
			engagement: { engagementRate: summary.engagement.engagementRate },
			sources: breakdown.rows.map(row => ({ key: row.key, share: row.share, engagementRate: row.engagementRate, lift: row.lift })),
			series, suppressed, denominator: 'visible',
			coverage: { status: summary.coverage.status, unavailable: summary.coverage.unavailable },
		};
		this.statsCache = { key, expiresAt: Date.now() + 60_000, value: structuredClone(value) };
		return value;
	}

	/** A bounded worker-local cache. Store and return independent objects, never failed loads. */
	private async cachedRaw<T extends HanamiMetricsBreakdown | HanamiMetricsErrors>(key: string, load: () => Promise<T>): Promise<T> {
		this.pruneRawCache();
		const cached = this.rawCache.get(key);
		if (cached) return structuredClone(cached.value) as T;
		const value = await load();
		this.pruneRawCache();
		if (this.rawCache.size >= 256) this.rawCache.delete(this.rawCache.keys().next().value!);
		this.rawCache.set(key, { expiresAt: Date.now() + 60_000, value: structuredClone(value) });
		return value;
	}

	private pruneRawCache(): void {
		for (const [key, entry] of this.rawCache) if (entry.expiresAt <= Date.now()) this.rawCache.delete(key);
	}

	/** Daily counts plus today's cohort, with exact full-range uniques overlaid once.
	 * Even a manually rolled-up today is excluded, so the supplement cannot double count.
	 */
	private async dailyEngagement(range: HanamiMetricsResolvedRange, dimension: HanamiMetricsDimension): Promise<MetricsAggregateRow[]> {
		const today = jstDay();
		const [historical, users, provisional] = await Promise.all([
			this.db.query<MetricsAggregateRow[]>(metricsDailyEngagementSql(), [range.from, range.to, today, dimension]),
			this.db.query<Pick<MetricsAggregateRow, 'key' | 'users'>[]>(metricsRangeUsersSql(true), [...rangeParameters(range), dimension]),
			range.to === today ? this.db.query<MetricsAggregateRow[]>(metricsCohortSql('dimension'),
				[...rangeParameters({ from: today, to: today }), '{}', dimension]) : Promise.resolve([]),
		]);
		return mergeEngagementRows(historical, provisional, users);
	}

	/** Reuse daily totals for range counts and one today source cohort for all counts.
	 * The shared users scan supplies exact range/source/window uniques, including today.
	 */
	private async summaryEngagement(range: HanamiMetricsResolvedRange) {
		const today = jstDay();
		const [historical, historicalSources, users, provisionalSources] = await Promise.all([
			this.db.query<MetricsAggregateRow[]>(metricsDailyEngagementSql(true), [range.from, range.to, today, 'total']),
			this.db.query<MetricsAggregateRow[]>(metricsDailyEngagementSql(), [range.from, range.to, today, 'source']),
			this.db.query<MetricsSummaryUsersRow[]>(METRICS_SUMMARY_USERS_SQL, rangeParameters(range)),
			range.to === today ? this.db.query<MetricsAggregateRow[]>(metricsCohortSql('dimension'),
				[...rangeParameters({ from: today, to: today }), '{}', 'source']) : Promise.resolve([]),
		]);
		const windows = users.filter((row): row is Extract<MetricsSummaryUsersRow, { scope: 'window' }> => row.scope === 'window');
		const daily = [...historical];
		if (range.to === today) {
			const provisional = { ...EMPTY_COUNTS, day: today, users: windows.find(row => row.key === 'day')?.users ?? 0 };
			for (const row of provisionalSources) addEngagementCounts(provisional, row);
			daily.push(provisional);
		}
		const total = { ...EMPTY_COUNTS, users: users.find(row => row.scope === 'total')?.users ?? 0 };
		for (const row of daily) addEngagementCounts(total, row);
		const sources = mergeEngagementRows(historicalSources, provisionalSources, users.filter(row => row.scope === 'source'));
		return { total, daily, sources, windows };
	}

	private async dailyPersonalGeneration(range: HanamiMetricsResolvedRange): Promise<MetricsGenerationRow[]> {
		const today = jstDay();
		const [historical, provisional] = await Promise.all([
			this.db.query<MetricsGenerationRow[]>(METRICS_DAILY_PERSONAL_GENERATION_SQL, [range.from, range.to, today]),
			range.to === today ? this.db.query<MetricsGenerationRow[]>(metricsGenerationSql(true), rangeParameters({ from: today, to: today })) : Promise.resolve([]),
		]);
		return [...historical, ...provisional.filter(row => row.key === 'personal')];
	}

	/** Current inventory, not every historic generation (nor a range sum). */
	private async judgeBacklog(): Promise<Metric> {
		const [meta] = await this.db.query<{ settings: unknown }[]>('SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1');
		const validated = validateHanamiNoteJudgeSettings(meta?.settings);
		const settings = validated.ok ? validated.value : createDefaultHanamiNoteJudgeSettings();
		const [row] = await this.db.query<{ backlog: number }[]>(`WITH latest_ready AS (
			SELECT id, "generationFence" FROM hanami_common_generation WHERE status = 'ready' ORDER BY ordinal DESC LIMIT 1
		) SELECT COUNT(DISTINCT c."noteId") FILTER (WHERE j."noteId" IS NULL)::int AS backlog
			FROM latest_ready g LEFT JOIN hanami_common_candidate c
				ON c."generationId" = g.id AND c."generationFence" = g."generationFence"
			LEFT JOIN hanami_note_judgement j ON j."noteId" = c."noteId" AND j."promptVersion" = $1
			GROUP BY g.id`, [settings.promptVersion]);
		// No ready snapshot is unknown; an existing empty snapshot really has zero backlog.
		return nonnegativeMetric(row?.backlog);
	}

	private async judgeStatus(): Promise<Pick<HanamiMetricsGeneration['judge'], 'backlog' | 'secPerNote' | 'runtime'>> {
		const [backlog, runs] = await Promise.all([
			this.judgeBacklog(),
			this.db.query<{ secondsPerItem: unknown; wallDurationMs: unknown; processedCount: unknown; device: unknown }[]>(`SELECT
				params->'secondsPerItem' AS "secondsPerItem", params->'wallDurationMs' AS "wallDurationMs",
				params->'processedCount' AS "processedCount", params->'runtime'->>'device' AS device
				FROM hanami_foryou_model_run WHERE kind = 'note-judge' AND status = 'ready'
				ORDER BY "startedAt" DESC, id DESC LIMIT 1`),
		]);
		const run = runs.at(0);
		const wallDurationMs = nonnegativeMetric(run?.wallDurationMs);
		const processedCount = nonnegativeMetric(run?.processedCount);
		const secPerNote = nonnegativeMetric(run?.secondsPerItem)
			?? (wallDurationMs !== null && processedCount !== null && processedCount > 0
				? nonnegativeMetric(wallDurationMs / 1000 / processedCount) : null);
		// Peek is cache-only. A cold cache must NEVER trigger an external Python probe.
		const cached = peekHanamiNoteJudgeRuntime();
		const runtime = cached !== null ? (cached.available ? runtimeDevice(cached.device) : null) : runtimeDevice(run?.device);
		return { backlog, secPerNote, runtime };
	}

	private async diagnosticUnavailable(range: HanamiMetricsResolvedRange): Promise<string[]> {
		// Presence only: do not load diagnostic payloads, small-cohort counts or identifiers.
		const rows = await this.db.query<{ day: string; scope: 'dropped' | 'tuning' }[]>(`SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day, scope
			FROM hanami_metrics_diagnostic WHERE day >= $1::date AND day <= $2::date
			AND ((scope = 'dropped' AND key = 'exploration') OR scope = 'tuning')`, [range.from, range.to]);
		const days = rangeDays(range);
		// A field is incomplete only if a requested date lacks its snapshot. The tuning
		// sentinel also records capture of an empty cohort; it is not a fabricated zero.
		return (['dropped', 'tuning'] as const).flatMap(scope => {
			const captured = new Set(rows.filter(row => row.scope === scope).map(row => row.day));
			return days.some(day => !captured.has(day)) ? [scope === 'dropped' ? 'dropped.exploration' : 'tuning.historical'] : [];
		});
	}

	private async coverage(range: HanamiMetricsResolvedRange): Promise<HanamiMetricsCoverage> {
		const state = (await this.db.query<{ startedAt: Date | string }[]>('SELECT "startedAt" FROM hanami_metrics_state WHERE id = 1')).at(0);
		const now = new Date();
		const today = jstDay(now);
		const retainedFrom = shiftMetricsDay(today, -104);
		const startedAt = state ? new Date(state.startedAt).toISOString() : null;
		const completeDays = rangeDays(range).filter(day => startedAt !== null && day >= retainedFrom && day < today && Date.parse(`${day}T00:00:00+09:00`) >= Date.parse(startedAt));
		return {
			status: completeDays.length === rangeDays(range).length ? 'complete' : startedAt ? 'partial' : 'unavailable',
			startedAt, retainedFrom, completeDays, partialDays: rangeDays(range).filter(day => !completeDays.includes(day)),
			outcomesThrough: shiftMetricsDay(today, -15), unavailable: [],
		};
	}

	private windowCovered(coverage: HanamiMetricsCoverage, range: HanamiMetricsResolvedRange): boolean {
		return coverage.startedAt !== null && range.from >= coverage.retainedFrom && range.to < jstDay() && Date.parse(`${range.from}T00:00:00+09:00`) >= Date.parse(coverage.startedAt);
	}

	private async rateLimited(range: HanamiMetricsResolvedRange): Promise<{ day: string; count: Metric }[]> {
		const rows = await this.db.query<{ day: string; count: number | null }[]>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, (extra->>'rateLimited')::int AS count FROM hanami_metrics_daily
			WHERE day >= $1::date AND day <= $2::date AND scope = 'usage' AND dimension = 'total' AND key = 'total'`, [range.from, range.to]);
		return rangeDays(range).map(day => ({ day, count: rows.find(row => row.day === day)?.count ?? null }));
	}
}
