/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const HANAMI_METRICS_DIMENSIONS = ['source', 'relationshipClass', 'contentType', 'media', 'freshness', 'authorLocality', 'trendTerm', 'cluster'] as const;
export type HanamiMetricsDimension = typeof HANAMI_METRICS_DIMENSIONS[number];
export type HanamiMetricsRange = { days: 7 | 14 | 30 | 90 } | { from: string; to: string };
export type HanamiMetricsResolvedRange = { from: string; to: string };
export type HanamiMetricsFilter = Partial<Record<HanamiMetricsDimension, string>>;
export type HanamiMetricsBreakdownRequest = { range?: HanamiMetricsRange; dimension: HanamiMetricsDimension; filter?: HanamiMetricsFilter };
export type Metric = number | null;
export const METRICS_DAY_MS = 86_400_000;

/** An open collector cannot attest completed days past its durable watermark.
 * Current-day ratios are explicitly provisional; known gaps always fail closed.
 */
export const METRICS_COLLECTION_GAP_SQL = `SELECT (
	EXISTS(SELECT 1 FROM hanami_metrics_gap WHERE day BETWEEN $1::date AND $2::date)
	OR EXISTS(SELECT 1 FROM hanami_metrics_collector WHERE "stoppedAt" IS NULL
		AND ("startedAt" AT TIME ZONE 'Asia/Tokyo')::date <= $2::date
		AND "verifiedThrough" < LEAST($2::date,(now() AT TIME ZONE 'Asia/Tokyo')::date-1)
		AND $1::date <= (now() AT TIME ZONE 'Asia/Tokyo')::date-1)
) AS gap`;

/** Dates and SQL boundaries never depend on the process/database timezone. */
export function jstDay(now: Date = new Date()): string {
	return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function assertMetricsDay(day: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < '0001-01-01' || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
		throw new RangeError('Invalid metrics date; expected a real YYYY-MM-DD date');
	}
}

export function shiftMetricsDay(day: string, days: number): string {
	assertMetricsDay(day);
	return new Date(Date.parse(`${day}T00:00:00Z`) + days * METRICS_DAY_MS).toISOString().slice(0, 10);
}

export function resolveRange(range: HanamiMetricsRange = { days: 30 }, now: Date = new Date()): HanamiMetricsResolvedRange {
	const today = jstDay(now);
	let from: string;
	let to: string;
	if ('days' in range) {
		if (!([7, 14, 30, 90] as number[]).includes(range.days) || 'from' in range || 'to' in range) throw new RangeError('Invalid metrics range');
		to = today;
		from = shiftMetricsDay(to, 1 - range.days);
	} else {
		from = range.from;
		to = range.to;
		assertMetricsDay(from);
		assertMetricsDay(to);
	}
	const length = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / METRICS_DAY_MS + 1;
	if (length < 1 || length > 90 || to > today) throw new RangeError('Metrics range must contain 1–90 days and no future dates');
	return { from, to };
}

export function rangeDays(range: HanamiMetricsResolvedRange): string[] {
	const days: string[] = [];
	for (let day = range.from; day <= range.to; day = shiftMetricsDay(day, 1)) days.push(day);
	return days;
}

export function rangeParameters(range: HanamiMetricsResolvedRange): [string, string] {
	return [`${range.from}T00:00:00+09:00`, `${shiftMetricsDay(range.to, 1)}T00:00:00+09:00`];
}

export function metricRatio(numerator: Metric, denominator: Metric): Metric {
	return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
}

export interface HanamiMetricsCoverage {
	status: 'complete' | 'partial' | 'unavailable';
	startedAt: string | null;
	retainedFrom: string;
	completeDays: string[];
	partialDays: string[];
	/** Cohorts after this date can still acquire outcomes. */
	outcomesThrough: string;
	unavailable: string[];
}

export interface HanamiMetricsCounts {
	users: Metric;
	served: Metric;
	seen: Metric;
	reaction: Metric;
	reply: Metric;
	renote: Metric;
}
export interface HanamiMetricsBreakdownRow extends HanamiMetricsCounts {
	key: string;
	share: Metric;
	engagementShare: Metric;
	engagementRate: Metric;
	seenRate: Metric;
	engagementPerSeen: Metric;
	lift: Metric;
}
export interface HanamiMetricsBreakdown {
	range: HanamiMetricsResolvedRange;
	dimension: HanamiMetricsDimension;
	rows: HanamiMetricsBreakdownRow[];
	suppressed: string[];
	denominator: 'visible';
	coverage: HanamiMetricsCoverage;
}

export const HANAMI_METRICS_FAILURE_KINDS = ['emptyResult', 'candidateLimit', 'lockTimeout', 'exception', 'unknown'] as const;
export type HanamiMetricsFailureKind = typeof HANAMI_METRICS_FAILURE_KINDS[number];
export type HanamiMetricsFailureCounts = Record<HanamiMetricsFailureKind, Metric>;
export interface HanamiMetricsGeneration {
	personal: { batches: Metric; failed: Metric; failedRate: Metric; p50Ms: Metric; p95Ms: Metric; failedByKind: HanamiMetricsFailureCounts };
	common: { generations: Metric; failed: Metric; p50Ms: Metric; p95Ms: Metric };
	judge: { runs: Metric; failed: Metric; p50Ms: Metric; p95Ms: Metric; backlog: Metric; secPerNote: Metric; runtime: string | null };
}
export type HanamiMetricsTimelineKind = 'home' | 'local' | 'social' | 'global' | 'hanami';
export interface HanamiMetricsSummary {
	range: HanamiMetricsResolvedRange;
	usage: {
		hanamiUsers: { day: Metric; week: Metric; month: Metric };
		tlShare: Record<HanamiMetricsTimelineKind, Metric>;
		manualRefreshPerUserDay: Metric;
		rateLimited429: Metric;
	};
	engagement: HanamiMetricsCounts & { engagementRate: Metric; seenRate: Metric; normalBaseline: { reaction: Metric; reply: Metric; renote: Metric } };
	generation: HanamiMetricsGeneration;
	series: { day: string[]; hanamiUsers: Metric[]; engagementRate: Metric[]; failedBatches: Metric[] };
	suppressed: string[];
	denominator: 'visible';
	coverage: HanamiMetricsCoverage;
}
export interface HanamiMetricsErrorItem {
	at: string;
	kind: HanamiMetricsFailureKind;
	attempts: number;
	message: string;
	userBucket: string;
}
export interface HanamiMetricsErrors {
	range: HanamiMetricsResolvedRange;
	personal: { byKind: HanamiMetricsFailureCounts; byDay: { day: string; failed: Metric }[]; recent: HanamiMetricsErrorItem[] };
	common: { recent: { at: string; status: 'failed'; message: string }[] };
	judge: { recent: { at: string; status: 'failed'; message: string }[]; backlog: Metric };
	rateLimited: { byDay: { day: string; count: Metric }[] };
	suppressed: string[];
	coverage: HanamiMetricsCoverage;
}
export interface HanamiMetricsStats {
	range: HanamiMetricsResolvedRange;
	usage: Pick<HanamiMetricsSummary['usage'], 'hanamiUsers' | 'tlShare'>;
	engagement: { engagementRate: Metric };
	sources: { key: string; share: Metric; engagementRate: Metric; lift: Metric }[];
	series: { week: string; hanamiUsers: Metric; engagementRate: Metric }[];
	suppressed: string[];
	denominator: 'visible';
	coverage: { status: HanamiMetricsCoverage['status']; unavailable: string[] };
}

/** Internal SQL rows. No identifiers are serialized into API or daily rows. */
export interface MetricsAggregateRow {
	key: string;
	day?: string;
	users: number;
	served: number;
	seen: number;
	reaction: number;
	reply: number;
	renote: number;
}
export interface MetricsNormalRow extends MetricsAggregateRow {
	reactionUsers: number;
	replyUsers: number;
	renoteUsers: number;
}
export interface MetricsGenerationRow {
	key: 'personal' | 'common' | 'judge';
	day?: string;
	users: number;
	total: number;
	failed: number;
	failedUsers: number;
	p50Ms: Metric;
	p95Ms: Metric;
	failures: { kind: HanamiMetricsFailureKind; count: number; users: number }[];
}

/** Historical additive counts only. $1/$2 are inclusive dates, $3 is today (excluded),
 * $4 is the persisted dimension. Range uniques are deliberately NOT summed.
 */
export function metricsDailyEngagementSql(byDay = false): string {
	if (byDay) return `SELECT to_char(day, 'YYYY-MM-DD') AS day, key, users, served, seen, reaction, reply, renote
		FROM hanami_metrics_daily WHERE day >= $1::date AND day <= $2::date AND day < $3::date
		AND scope = 'engagement' AND dimension = $4::text ORDER BY day`;
	return `SELECT key, 0::int AS users, SUM(served)::int AS served, SUM(seen)::int AS seen,
		SUM(reaction)::int AS reaction, SUM(reply)::int AS reply, SUM(renote)::int AS renote
		FROM hanami_metrics_daily WHERE day >= $1::date AND day <= $2::date AND day < $3::date
		AND scope = 'engagement' AND dimension = $4::text GROUP BY key ORDER BY key`;
}

/** Deduplicate before DISTINCT so sorting scales with users, not served rows.
 * Keep COUNT(DISTINCT), rather than COUNT(*), to exclude a nullable userId.
 */
export function metricsRangeUsersSql(dimension = false): string {
	const key = dimension ? 'COALESCE(NULLIF(dimensions ->> $3::text, \'\'), CASE WHEN $3 = \'contentType\' THEN \'unjudged\' ELSE \'unknown\' END)' : '\'total\'';
	return `SELECT ${dimension ? 'key' : '\'total\' AS key'}, COUNT(DISTINCT "userId")::int AS users FROM (
		SELECT ${key} AS key, "userId" FROM hanami_metrics_event
		WHERE "eventType" = 'served' AND "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz
		GROUP BY 1, 2
	) distinct_users${dimension ? ' GROUP BY key ORDER BY key' : ''}`;
}

export type MetricsSummaryUsersRow =
	| { scope: 'total' | 'source'; key: string; users: number; from: null }
	| { scope: 'window'; key: 'day' | 'week' | 'month'; users: number; from: string };

/** One served-only scan for range total/source uniques AND independently anchored
 * day/week/month windows. A short range must not truncate its longer usage windows.
 * The small keyed-user relation is reused; cross-source users are still deduplicated.
 */
export const METRICS_SUMMARY_USERS_SQL = `WITH keyed_users AS (
	SELECT COALESCE(NULLIF(dimensions ->> 'source', ''), 'unknown') AS key, "userId",
		MAX("createdAt") AS max_at, BOOL_OR("createdAt" >= $1::timestamptz) AS in_range
	FROM hanami_metrics_event WHERE "eventType" = 'served'
		AND "createdAt" >= LEAST($1::timestamptz, $2::timestamptz - interval '720 hours')
		AND "createdAt" < $2::timestamptz
	GROUP BY 1, 2
) SELECT 'total' AS scope, 'total' AS key, COUNT(DISTINCT "userId") FILTER (WHERE in_range)::int AS users, NULL::text AS "from"
	FROM keyed_users
UNION ALL SELECT 'source', key, COUNT(DISTINCT "userId")::int, NULL::text
	FROM keyed_users WHERE in_range GROUP BY key
UNION ALL SELECT 'window', w.key,
	COUNT(DISTINCT u."userId") FILTER (WHERE u.max_at >= $2::timestamptz - w.days * interval '24 hours')::int,
	to_char(($2::timestamptz AT TIME ZONE 'Asia/Tokyo') - w.days * interval '1 day', 'YYYY-MM-DD')
	FROM (VALUES ('day',1),('week',7),('month',30)) w(key,days)
	LEFT JOIN keyed_users u ON true GROUP BY w.key, w.days`;

/** Rollup stores personal generation in its own dimension, not a generation total row.
 * Empty-day extras omit failedUsers; the persisted users column is authoritative.
 */
export const METRICS_DAILY_PERSONAL_GENERATION_SQL = `SELECT to_char(day, 'YYYY-MM-DD') AS day, key, users,
	(extra->>'total')::int AS total, (extra->>'failed')::int AS failed,
	COALESCE((extra->>'failedUsers')::int, 0) AS "failedUsers",
	(extra->>'p50Ms')::double precision AS "p50Ms", (extra->>'p95Ms')::double precision AS "p95Ms",
	COALESCE(extra->'failures', '[]'::jsonb) AS failures
	FROM hanami_metrics_daily WHERE day >= $1::date AND day <= $2::date AND day < $3::date
	AND scope = 'generation' AND dimension = 'personal' AND key = 'personal' ORDER BY day`;

/** Immutable served timestamp, NOT occurredAt, defines cohort membership.
 * Each outcome type is separately capped at one per served row (reaction + reply = 2).
 * $1/$2 are inclusive/exclusive JST instants; $3 is captured-dimension containment.
 */
export const METRICS_COHORT_CTE = `WITH cohort AS (
	SELECT s."userId", s."createdAt", s.dimensions,
		COALESCE(o.seen, 0)::int AS seen, COALESCE(o.reaction, 0)::int AS reaction,
		COALESCE(o.reply, 0)::int AS reply, COALESCE(o.renote, 0)::int AS renote
	FROM hanami_metrics_event s
	LEFT JOIN LATERAL (
		SELECT MAX(CASE WHEN e."eventType" = 'seen' THEN 1 ELSE 0 END) AS seen,
			MAX(CASE WHEN e."eventType" = 'reaction' THEN 1 ELSE 0 END) AS reaction,
			MAX(CASE WHEN e."eventType" = 'reply' THEN 1 ELSE 0 END) AS reply,
			MAX(CASE WHEN e."eventType" = 'renote' THEN 1 ELSE 0 END) AS renote
		FROM hanami_metrics_event e
		WHERE e."userId" = s."userId" AND e."noteId" = s."noteId"
			AND e."eventType" IN ('seen', 'reaction', 'reply', 'renote')
			AND COALESCE(e."occurredAt", e."createdAt") >= s."createdAt"
			AND COALESCE(e."occurredAt", e."createdAt") <= s."createdAt" + interval '336 hours'
	) o ON true
	WHERE s."eventType" = 'served' AND s."createdAt" >= $1::timestamptz AND s."createdAt" < $2::timestamptz
		AND s.dimensions @> $3::jsonb
)`;

const aggregateColumns = `COUNT(DISTINCT "userId")::int AS users, COUNT(*)::int AS served,
	COALESCE(SUM(seen), 0)::int AS seen, COALESCE(SUM(reaction), 0)::int AS reaction,
	COALESCE(SUM(reply), 0)::int AS reply, COALESCE(SUM(renote), 0)::int AS renote`;

export function metricsCohortSql(mode: 'total' | 'day' | 'dimension'): string {
	if (mode === 'total') return `${METRICS_COHORT_CTE} SELECT 'total' AS key, ${aggregateColumns} FROM cohort`;
	if (mode === 'day') return `${METRICS_COHORT_CTE} SELECT to_char("createdAt" AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day, 'total' AS key, ${aggregateColumns} FROM cohort GROUP BY day ORDER BY day`;
	// Ranking happens over the whole filtered range, not independently each day.
	return `${METRICS_COHORT_CTE}, keyed AS (
		SELECT *, COALESCE(NULLIF(dimensions ->> $4::text, ''), CASE WHEN $4 = 'contentType' THEN 'unjudged' ELSE 'unknown' END) AS raw_key FROM cohort
	), top_terms AS (
		SELECT raw_key FROM keyed WHERE raw_key NOT IN ('_other', 'unknown') GROUP BY raw_key ORDER BY COUNT(*) DESC, raw_key LIMIT 30
	), bucketed AS (
		SELECT *, CASE WHEN $4 = 'trendTerm' AND raw_key NOT IN (SELECT raw_key FROM top_terms) THEN '_other' ELSE raw_key END AS key FROM keyed
	) SELECT key, ${aggregateColumns} FROM bucketed GROUP BY key ORDER BY key`;
}

/** Normal is not a served cohort. Deduplicate each type/user/note per JST day. */
export const METRICS_NORMAL_SQL = `WITH normal AS (
	SELECT DISTINCT to_char(COALESCE("occurredAt", "createdAt") AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day, "userId", "noteId", "eventType"
	FROM hanami_metrics_event WHERE source = 'normal' AND "eventType" IN ('reaction', 'reply', 'renote')
		AND COALESCE("occurredAt", "createdAt") >= $1::timestamptz AND COALESCE("occurredAt", "createdAt") < $2::timestamptz
) SELECT 'normal' AS key, COUNT(DISTINCT "userId")::int AS users, 0::int AS served, 0::int AS seen,
	COUNT(*) FILTER (WHERE "eventType" = 'reaction')::int AS reaction,
	COUNT(*) FILTER (WHERE "eventType" = 'reply')::int AS reply,
	COUNT(*) FILTER (WHERE "eventType" = 'renote')::int AS renote,
	COUNT(DISTINCT "userId") FILTER (WHERE "eventType" = 'reaction')::int AS "reactionUsers",
	COUNT(DISTINCT "userId") FILTER (WHERE "eventType" = 'reply')::int AS "replyUsers",
	COUNT(DISTINCT "userId") FILTER (WHERE "eventType" = 'renote')::int AS "renoteUsers" FROM normal`;

export function metricsGenerationSql(byDay = false): string {
	const day = byDay ? ', day' : '';
	return `WITH runs AS (
		SELECT 'personal'::text AS key, "userId", status, "createdAt" AS at, "startedAt", "finishedAt",
			CASE WHEN "failureKind" IN ('emptyResult','candidateLimit','lockTimeout','exception') THEN "failureKind" ELSE 'unknown' END AS kind
		FROM hanami_user_feed_batch WHERE "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz
		UNION ALL SELECT 'common', NULL, status, "startedAt", "startedAt", "finishedAt", 'unknown' FROM hanami_common_generation
			WHERE "startedAt" >= $1::timestamptz AND "startedAt" < $2::timestamptz
		UNION ALL SELECT 'judge', NULL, status, "startedAt", "startedAt", "finishedAt", 'unknown' FROM hanami_foryou_model_run
			WHERE kind = 'note-judge' AND "startedAt" >= $1::timestamptz AND "startedAt" < $2::timestamptz
	), dated AS (SELECT *, to_char(at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day FROM runs), kinds AS (
		SELECT key${day}, kind, COUNT(*)::int AS count, COUNT(DISTINCT "userId")::int AS users FROM dated WHERE status = 'failed' GROUP BY key${day}, kind
	), failures AS (
		SELECT key${day}, jsonb_agg(jsonb_build_object('kind',kind,'count',count,'users',users)) AS failures FROM kinds GROUP BY key${day}
	) SELECT r.key${byDay ? ', r.day' : ''}, COUNT(DISTINCT r."userId")::int AS users, COUNT(*)::int AS total,
		COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
		COUNT(DISTINCT r."userId") FILTER (WHERE r.status = 'failed')::int AS "failedUsers",
		percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."finishedAt" - r."startedAt")) * 1000)
			FILTER (WHERE r."finishedAt" >= r."startedAt") AS "p50Ms",
		percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."finishedAt" - r."startedAt")) * 1000)
			FILTER (WHERE r."finishedAt" >= r."startedAt") AS "p95Ms",
		COALESCE(f.failures, '[]'::jsonb) AS failures
	FROM dated r LEFT JOIN failures f ON f.key = r.key${byDay ? ' AND f.day = r.day' : ''}
	GROUP BY r.key${byDay ? ', r.day' : ''}, f.failures`;
}

export const hanamiMetricsRangeSchema = {
	oneOf: [
		{ type: 'object', properties: { days: { type: 'integer', enum: [7, 14, 30, 90] } }, required: ['days'], additionalProperties: false },
		{ type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } }, required: ['from', 'to'], additionalProperties: false },
	],
} as const;
