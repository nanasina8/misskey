/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { SchemaType } from '@/misc/json-schema.js';
import {
	HANAMI_FEED_DAILY_KEY_PREFIX,
	HANAMI_FEED_EVENTS_KEY,
	HANAMI_FEED_EVENTS_MAX,
	HANAMI_FEED_SEEN_KEY_PREFIX,
	HANAMI_FEED_PREWARM_KEY_PREFIX,
	type HanamiFeedEvent,
} from '@/core/hanami/HanamiFeedStockEvents.js';
import { jstDay, shiftMetricsDay } from '@/core/hanami/HanamiMetricsContracts.js';

const count = (description: string) => ({ type: 'integer', optional: false, nullable: false, description } as const);
const text = (description: string) => ({ type: 'string', optional: false, nullable: false, description } as const);
const date = (description: string) => ({ ...text(description), format: 'date-time' } as const);
const numberOrNull = (description: string) => ({ type: 'number', optional: false, nullable: true, description } as const);

const latencyStats = (description: string) => ({ type: 'object', optional: false, nullable: false, description, properties: {
	count: count('Number of recorded events in this group.'),
	p50: numberOrNull('50th percentile of durationMs; null when absent.'),
	p95: numberOrNull('95th percentile of durationMs; null when absent.'),
	max: numberOrNull('Maximum durationMs; null when absent.'),
} } as const);

const rate = (description: string) => ({ type: 'object', optional: false, nullable: false, description, properties: {
	counts: { type: 'object', optional: false, nullable: false, description: 'Recorded kind.outcome counts summed over the window.', additionalProperties: count('Count for one kind.outcome field.') },
	stockHitRate: numberOrNull('(open.stock + refresh.stock) / (open.stock + open.pending + refresh.stock + refresh.pending); null when the denominator is 0.'),
	pendingRate: numberOrNull('(refresh.pending + tuning.pending + open.pending) / (those + refresh.stock + tuning.stock + open.stock); rate-limited, expired and repeated tokens are excluded; null when the denominator is 0.'),
} } as const);

const percentiles = (description: string) => ({ type: 'object', optional: false, nullable: false, description, properties: {
	p50: numberOrNull('p50 in ms.'), p95: numberOrNull('p95 in ms.'),
} } as const);

const batchWindow = (description: string) => ({ type: 'object', optional: false, nullable: false, description, properties: {
	byTriggerReasonStatus: { type: 'array', optional: false, nullable: false, description: 'Count of batches grouped by trigger, reason and status.', items: { type: 'object', optional: false, nullable: false, description: 'One group.', properties: {
		trigger: { ...text('Batch trigger.'), nullable: true }, reason: { ...text('Batch reason.'), nullable: true }, status: text('Batch status.'), count: count('Number of batches.'),
	} } },
	failedByKind: { type: 'array', optional: false, nullable: false, description: 'Failed batches grouped by failureKind.', items: { type: 'object', optional: false, nullable: false, description: 'One group.', properties: {
		failureKind: { ...text('Failure kind.'), nullable: true }, count: count('Number of failed batches.'),
	} } },
	prefetch: { type: 'object', optional: false, nullable: false, description: 'Prefetch batch disposition.', properties: {
		used: count('Prefetch batches promoted (promotedAt set).'),
		discarded: { type: 'object', optional: false, nullable: false, description: 'Discarded prefetch batches grouped by discardReason.', additionalProperties: count('Count for one discardReason.') },
		pending: count('Ready prefetch batches not yet used and not discarded.'),
		prewarmUsedRate: numberOrNull('Share of prewarm batches that were used; null when fewer than 20 prewarm batches exist.'),
	} },
	queueWaitMs: { type: 'object', optional: false, nullable: false, description: 'startedAt - createdAt percentiles by trigger.', additionalProperties: percentiles('Percentiles for one trigger.') },
	generateMs: { type: 'object', optional: false, nullable: false, description: 'finishedAt - startedAt percentiles by trigger.', additionalProperties: percentiles('Percentiles for one trigger.') },
	stockAgeAtUseMs: percentiles('promotedAt - finishedAt percentiles.'),
} } as const);

const checkSchema = { type: 'object', optional: false, nullable: false, description: 'One invariant self-check.', properties: {
	code: text('Stable check code.'),
	ok: { type: 'boolean', optional: false, nullable: false, description: 'True when no violations were found.' },
	count: count('Total number of violating rows (not capped by samples).'),
	error: { ...text('Why this check could not run; null when it ran. A failed check is never reported as ok.'), nullable: true },
	samples: { type: 'array', optional: false, nullable: false, description: 'Up to five violating rows.', items: {
		type: 'object', optional: false, nullable: false, description: 'One violating row.', properties: {
			userId: text('Owner user id.'), batchId: { ...text('Related batch id.'), nullable: true }, detail: { ...text('Short explanation.'), nullable: true },
		},
	} },
} } as const;

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue',
	description: 'Inspect whether the Hanami feed stock is working, where it is made to wait, and whether its invariants hold, without reading logs or the database directly. All timestamps are UTC ISO 8601.',
	res: {
		type: 'object', optional: false, nullable: false, description: 'Hanami feed stock diagnostics.',
		properties: {
			generatedAt: date('UTC time this report was generated.'),
			config: { type: 'object', optional: false, nullable: false, description: 'Stock configuration in effect.', properties: {
				stockMaxAgeMinutes: count('Age after which a served stock is considered stale.'),
				stockRefreshAfterMinutes: count('Age after which a stock is rebuilt in the background.'),
				sessionGapMinutes: count('Gap after which opening serves the stock (seen-key TTL).'),
				prewarmIntervalMinutes: count('Throttle window for prewarming from other timelines.'),
				activeDays: count('Active-user window for stock maintenance.'),
				initialSyncWaitMs: count('Configured hanamiGenerationSyncWaitMs.'),
			} },
			requests: { type: 'object', optional: false, nullable: false, description: 'Recorded request outcomes aggregated from the Redis daily counts.', properties: {
				day: rate('Today (JST) window.'),
				week: rate('Today plus the previous six days (JST).'),
			} },
			latency: { type: 'object', optional: false, nullable: false, description: 'Server-side processing time (durationMs) percentiles grouped by kind and outcome, from the retained event list.', additionalProperties: latencyStats('Latency for one kind.outcome group.') },
			batches: { type: 'object', optional: false, nullable: false, description: 'Batch counts and timings from the database, over 24h and 7d windows.', properties: {
				last24h: batchWindow('Last 24 hours.'),
				last7d: batchWindow('Last 7 days.'),
			} },
			current: { type: 'object', optional: false, nullable: false, description: 'Current state snapshot.', properties: {
				personalizedUsers: count('Users in personalized mode.'),
				commonUsers: count('Users in common mode.'),
				withStock: count('Personalized users with a stock batch.'),
				stockAgeBuckets: { type: 'object', optional: false, nullable: false, description: 'Stock age distribution.', properties: {
					under1h: count('Stocks newer than one hour.'),
					from1hTo3h: count('Stocks between one and three hours old.'),
					over3h: count('Stocks older than three hours.'),
				} },
				activeBatchByTriggerStatus: { type: 'array', optional: false, nullable: false, description: 'Active batches grouped by trigger and status.', items: { type: 'object', optional: false, nullable: false, description: 'One group.', properties: {
					trigger: text('Batch trigger.'), status: text('Batch status.'), count: count('Number of batches.'),
				} } },
				oldestPendingWaitMs: { ...count('Age of the oldest pending batch in ms.'), nullable: true },
				expiredGeneratingLeases: count('Generating batches whose lease has expired.'),
			} },
			checks: { type: 'array', optional: false, nullable: false, description: 'Invariant self-checks.', items: checkSchema },
			issues: { type: 'array', optional: false, nullable: false, description: 'Derived issues for humans.', items: { type: 'object', optional: false, nullable: false, description: 'One issue.', properties: {
				level: { ...text('Severity.'), enum: ['error', 'warning', 'info'] },
				code: text('Stable issue code.'),
				message: text('One-sentence Japanese explanation.'),
				count: { ...count('Violation count when known.'), nullable: true },
			} } },
			events: { type: 'array', optional: false, nullable: false, description: 'Newest recorded stock events.', items: { type: 'object', optional: false, nullable: false, description: 'One event.', properties: {
				at: date('UTC recording time.'), userId: text('Owner user id.'), kind: text('Event kind.'), outcome: text('Event outcome.'),
				durationMs: { ...count('Elapsed milliseconds when recorded.'), optional: true },
				stockAgeMs: { ...count('Stock age in ms when recorded.'), optional: true },
				batchId: { ...text('Related batch id.'), optional: true },
				reason: { ...text('Related reason.'), optional: true },
			} } },
			user: { type: 'object', optional: false, nullable: true, description: 'Detail for the requested user; null when userId is absent or unknown.', properties: {
				state: { type: 'object', optional: false, nullable: true, description: 'User feed state; null when absent.', properties: {
					mode: text('Feed mode.'), initialGenerationState: text('Initial generation state.'), epochId: text('Feed epoch id.'),
					latestReadyBatchId: { ...text('Latest ready batch id.'), nullable: true }, latestSequence: { ...text('Latest sequence.'), nullable: true },
					generatingBatchId: { ...text('Generating batch id.'), nullable: true },
					stockBatchId: { ...text('Stock batch id.'), nullable: true }, stockSequence: { ...text('Stock sequence.'), nullable: true },
					updatedAt: { ...date('State update time.'), nullable: true },
				} },
				head: { type: 'object', optional: false, nullable: true, description: 'Head batch info; null when absent.', properties: {
					batchId: text('Head batch id.'), finishedAt: { ...date('Head finish time.'), nullable: true }, itemCount: count('Head item count.'), ageMs: { ...count('Age of the head in ms.'), nullable: true },
				} },
				stock: { type: 'object', optional: false, nullable: true, description: 'Stock batch info; null when absent.', properties: {
					batchId: text('Stock batch id.'), finishedAt: { ...date('Stock finish time.'), nullable: true }, itemCount: count('Stock item count.'), ageMs: { ...count('Age of the stock in ms.'), nullable: true },
				} },
				inSession: { ...count('Remaining seconds of the seen key; null when absent.'), nullable: true },
				prewarmThrottleSeconds: { ...count('Remaining seconds of the prewarm key; null when absent.'), nullable: true },
				recentBatches: { type: 'array', optional: false, nullable: false, description: 'Twenty most recent batches.', items: { type: 'object', optional: false, nullable: false, description: 'One batch.', properties: {
					id: text('Batch id.'), trigger: text('Batch trigger.'), reason: { ...text('Batch reason.'), nullable: true }, status: text('Batch status.'),
					attempts: count('Attempts.'), createdAt: date('Created time.'), startedAt: { ...date('Started time.'), nullable: true },
					finishedAt: { ...date('Finished time.'), nullable: true }, promotedAt: { ...date('Promoted time.'), nullable: true },
					discardReason: { ...text('Discard reason.'), nullable: true }, failureKind: { ...text('Failure kind.'), nullable: true }, itemCount: count('Item count.'),
				} } },
			} },
		},
	},
} as const;

export const paramDef = { type: 'object', properties: {
	userId: { type: 'string', format: 'misskey:id', description: 'Restrict detail and events to this user.' },
	eventsLimit: { type: 'integer', minimum: 0, maximum: 200, default: 50, description: 'Maximum number of newest events to return.' },
}, required: [] } as const;

type DbRow = Record<string, unknown>;
type CheckResult = { code: string; ok: boolean; count: number; error: string | null; samples: Array<{ userId: string; batchId: string | null; detail: string | null }> };
const asRow = <T extends DbRow = DbRow>(rows: T[]): T[] => rows;

const percentile = (values: number[], p: number): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return Math.round(sorted[lower]!);
	return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower));
};

function mergeDailyCounts(days: string[], rows: Array<{ day: string; fields: Record<string, string> }>): Record<string, number> {
	const merged: Record<string, number> = {};
	for (const row of rows) {
		if (!days.includes(row.day)) continue;
		for (const [field, value] of Object.entries(row.fields)) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) merged[field] = (merged[field] ?? 0) + parsed;
		}
	}
	return merged;
}

function computeRates(counts: Record<string, number>) {
	const openStock = counts['open.stock'] ?? 0;
	const openPending = counts['open.pending'] ?? 0;
	const refreshStock = counts['refresh.stock'] ?? 0;
	const refreshPending = counts['refresh.pending'] ?? 0;
	const stockDenom = openStock + openPending + refreshStock + refreshPending;
	const stockHitRate = stockDenom === 0 ? null : (openStock + refreshStock) / stockDenom;

	// 待たせた割合 = pending ÷（すぐ出した + pending）。回数制限・token 切れ・繰り返しは分母に入れない。
	const pendingTotal = refreshPending + (counts['tuning.pending'] ?? 0) + openPending;
	const pendingDenom = pendingTotal + refreshStock + (counts['tuning.stock'] ?? 0) + openStock;
	const pendingRate = pendingDenom === 0 ? null : pendingTotal / pendingDenom;
	return { stockHitRate, pendingRate };
}

function eventGroups(events: HanamiFeedEvent[], userId?: string): { latency: Record<string, { count: number; p50: number | null; p95: number | null; max: number | null }>; filtered: HanamiFeedEvent[] } {
	const byKey = new Map<string, number[]>();
	const filtered: HanamiFeedEvent[] = [];
	for (const event of events) {
		if (!Number.isFinite(Date.parse(event.at))) continue;
		if (userId != null && event.userId !== userId) continue;
		filtered.push(event);
		if (event.durationMs == null) continue;
		const key = `${event.kind}.${event.outcome}`;
		const list = byKey.get(key) ?? [];
		list.push(event.durationMs);
		byKey.set(key, list);
	}
	const latency: Record<string, { count: number; p50: number | null; p95: number | null; max: number | null }> = {};
	for (const [key, list] of byKey) {
		latency[key] = { count: list.length, p50: percentile(list, 50), p95: percentile(list, 95), max: Math.round(Math.max(...list)) };
	}
	return { latency, filtered };
}

type Percentiles = { p50: number | null; p95: number | null };

type BatchWindow = {
	byTriggerReasonStatus: Array<{ trigger: string | null; reason: string | null; status: string; count: number }>;
	failedByKind: Array<{ failureKind: string | null; count: number }>;
	prefetch: { used: number; discarded: Record<string, number>; pending: number; prewarmUsedRate: number | null };
	queueWaitMs: Record<string, Percentiles>;
	generateMs: Record<string, Percentiles>;
	stockAgeAtUseMs: Percentiles;
};

type CurrentSnapshot = Record<string, unknown>;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redisClient: Redis.Redis,
		@Inject(DI.config) private config: Config,
	) {
		super(meta, paramDef, async (ps) => {
			const today = jstDay();
			const weekDays = Array.from({ length: 7 }, (_, i) => shiftMetricsDay(today, -i));
			const [dayDaily, weekDaily, rawEvents, userDetail] = await Promise.all([
				this.readDaily(today),
				this.readDailyRange(weekDays),
				this.redisClient.lrange(HANAMI_FEED_EVENTS_KEY, 0, HANAMI_FEED_EVENTS_MAX - 1).catch(() => [] as string[]),
				ps.userId != null ? this.readUserDetail(ps.userId) : Promise.resolve(null),
			]);
			const dayCounts = mergeDailyCounts([today], dayDaily);
			const weekCounts = mergeDailyCounts(weekDays, weekDaily);
			const parsedEvents = rawEvents.flatMap((raw) => {
				try {
					const event = JSON.parse(raw) as HanamiFeedEvent;
					return typeof event.userId === 'string' && typeof event.kind === 'string' && typeof event.outcome === 'string' ? [event] : [];
				} catch { return []; }
			});
			const { latency, filtered } = eventGroups(parsedEvents, ps.userId ?? undefined);

			const [batches24h, batches7d, current, checks] = await Promise.all([
				this.readBatches(24),
				this.readBatches(7 * 24),
				this.readCurrent(),
				this.runChecks(),
			]);

			const issues: Array<{ level: 'error' | 'warning' | 'info'; code: string; message: string; count: number | null }> = [];
			for (const check of checks) {
				if (check.error != null) {
					issues.push({ level: 'error', code: 'checkFailed', message: `点検 ${check.code} を実行できませんでした: ${check.error}`, count: null });
					continue;
				}
				if (check.count === 0) continue;
				if (check.code === 'expiredLease' || check.code === 'stalePending' || check.code === 'activeUserWithoutStock') {
					issues.push({ level: 'warning', code: check.code, message: issueMessage(check.code), count: check.count });
				} else {
					issues.push({ level: 'error', code: check.code, message: issueMessage(check.code), count: check.count });
				}
			}
			const weekRate = computeRates(weekCounts);
			if (weekRate.stockHitRate != null && weekRate.stockHitRate < 0.8 && (weekCounts['open.stock'] ?? 0) + (weekCounts['open.pending'] ?? 0) + (weekCounts['refresh.stock'] ?? 0) + (weekCounts['refresh.pending'] ?? 0) >= 10) {
				issues.push({ level: 'warning', code: 'lowStockHitRate', message: 'ストックのヒット率が 8 割を下回っています。', count: null });
			}
			const failed = generationFailedRate(weekCounts);
			if (failed.rate != null && failed.total >= 10 && failed.rate > 0.1) {
				issues.push({ level: 'warning', code: 'generationFailures', message: '個人の生成（ストック・先頭とも）の失敗率が 7 日で 1 割を超えています。', count: failed.failed });
			}
			if (batches7d.prefetch.prewarmUsedRate != null && batches7d.prefetch.prewarmUsedRate < 0.2) {
				issues.push({ level: 'info', code: 'prewarmOverproducing', message: 'prewarm で作ったストックの利用率が 2 割未満です（作りすぎの可能性）。', count: null });
			}

			return {
				generatedAt: new Date().toISOString(),
				config: {
					stockMaxAgeMinutes: 180,
					stockRefreshAfterMinutes: 60,
					sessionGapMinutes: 30,
					prewarmIntervalMinutes: 30,
					activeDays: 7,
					initialSyncWaitMs: this.config.hanamiGenerationSyncWaitMs,
				},
				requests: {
					day: { counts: dayCounts, ...computeRates(dayCounts) },
					week: { counts: weekCounts, ...computeRates(weekCounts) },
				},
				latency,
				batches: { last24h: batches24h, last7d: batches7d },
				current,
				checks,
				issues,
				events: filtered.slice(0, ps.eventsLimit).map((event) => ({
					at: event.at,
					userId: event.userId,
					kind: event.kind,
					outcome: event.outcome,
					...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
					...(event.stockAgeMs != null ? { stockAgeMs: event.stockAgeMs } : {}),
					...(event.batchId != null ? { batchId: event.batchId } : {}),
					...(event.reason != null ? { reason: event.reason } : {}),
				})),
				user: userDetail,
			} as unknown as SchemaType<typeof meta.res>;
		});
	}

	private async readDaily(day: string): Promise<Array<{ day: string; fields: Record<string, string> }>> {
		try {
			const fields = await this.redisClient.hgetall(HANAMI_FEED_DAILY_KEY_PREFIX + day);
			return [{ day, fields }];
		} catch { return []; }
	}

	private async readDailyRange(days: string[]): Promise<Array<{ day: string; fields: Record<string, string> }>> {
		const rows: Array<{ day: string; fields: Record<string, string> }> = [];
		for (const day of days) {
			try {
				const fields = await this.redisClient.hgetall(HANAMI_FEED_DAILY_KEY_PREFIX + day);
				rows.push({ day, fields });
			} catch { /* その日の記録が無いだけ */ }
		}
		return rows;
	}

	private async readBatches(hours: number): Promise<BatchWindow> {
		const since = `clock_timestamp() - INTERVAL '${hours} hours'`;
		const [byTriggerReasonStatus, failedByKind, prefetchUsed, prefetchDiscarded, prefetchPending, queueWait, generateMs, stockAge, prewarmTotal] = await Promise.all([
			this.db.query(`SELECT b."trigger" AS trigger, b."reason" AS reason, b."status" AS status, COUNT(*)::int AS count
				FROM "hanami_user_feed_batch" b WHERE b."createdAt" >= ${since} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
			this.db.query(`SELECT b."failureKind" AS failure_kind, COUNT(*)::int AS count
				FROM "hanami_user_feed_batch" b WHERE b."createdAt" >= ${since} AND b."status" = 'failed' GROUP BY 1 ORDER BY 1`),
			this.db.query(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_batch" b
				WHERE b."trigger" = 'prefetch' AND b."promotedAt" IS NOT NULL AND b."createdAt" >= ${since}`),
			this.db.query(`SELECT b."discardReason" AS reason, COUNT(*)::int AS count FROM "hanami_user_feed_batch" b
				WHERE b."trigger" = 'prefetch' AND b."discardReason" IS NOT NULL AND b."createdAt" >= ${since} GROUP BY 1 ORDER BY 1`),
			this.db.query(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_batch" b
				WHERE b."trigger" = 'prefetch' AND b."status" = 'ready' AND b."promotedAt" IS NULL AND b."discardReason" IS NULL AND b."createdAt" >= ${since}`),
			this.db.query(`SELECT b."trigger" AS trigger, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b."startedAt" - b."createdAt")) * 1000)::double precision AS p50,
				percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b."startedAt" - b."createdAt")) * 1000)::double precision AS p95
				FROM "hanami_user_feed_batch" b WHERE b."createdAt" >= ${since} AND b."startedAt" IS NOT NULL GROUP BY 1`),
			this.db.query(`SELECT b."trigger" AS trigger, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b."finishedAt" - b."startedAt")) * 1000)::double precision AS p50,
				percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b."finishedAt" - b."startedAt")) * 1000)::double precision AS p95
				FROM "hanami_user_feed_batch" b WHERE b."createdAt" >= ${since} AND b."startedAt" IS NOT NULL AND b."finishedAt" IS NOT NULL GROUP BY 1`),
			this.db.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b."promotedAt" - b."finishedAt")) * 1000)::double precision AS p50,
				percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b."promotedAt" - b."finishedAt")) * 1000)::double precision AS p95
				FROM "hanami_user_feed_batch" b WHERE b."promotedAt" IS NOT NULL AND b."finishedAt" IS NOT NULL AND b."createdAt" >= ${since}`),
			this.db.query(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_batch" b WHERE b."trigger" = 'prefetch' AND b."reason" = 'prewarm' AND b."createdAt" >= ${since}`),
		]);
		const toPercentiles = (rows: Array<{ trigger: string | null; p50: number | null; p95: number | null }>) => {
			const out: Record<string, { p50: number | null; p95: number | null }> = {};
			for (const row of rows) out[row.trigger ?? 'null'] = { p50: roundNullable(row.p50), p95: roundNullable(row.p95) };
			return out;
		};
		const triggerRows = byTriggerReasonStatus as Array<{ trigger: string | null; reason: string | null; status: string; count: number }>;
		const failedRows = failedByKind as Array<{ failure_kind: string | null; count: number }>;
		const discardedRows = prefetchDiscarded as Array<{ reason: string | null; count: number }>;
		const usedCount = Number((prefetchUsed as Array<{ count: string }>).at(0)?.count ?? 0);
		const pendingCount = Number((prefetchPending as Array<{ count: string }>).at(0)?.count ?? 0);
		const prewarmTotalNum = Number((prewarmTotal as Array<{ count: string }>).at(0)?.count ?? 0);
		const prewarmUsedRate = prewarmTotalNum >= 20 ? usedCount / prewarmTotalNum : null;
		const discarded: Record<string, number> = {};
		for (const row of discardedRows) discarded[row.reason ?? 'null'] = row.count;
		const stockAgeRow = (stockAge as Array<{ p50: number | null; p95: number | null }>).at(0);
		return {
			byTriggerReasonStatus: triggerRows.map((row) => ({ trigger: row.trigger, reason: row.reason, status: row.status, count: row.count })),
			failedByKind: failedRows.map((row) => ({ failureKind: row.failure_kind, count: row.count })),
			prefetch: {
				used: usedCount,
				discarded,
				pending: pendingCount,
				prewarmUsedRate,
			},
			queueWaitMs: toPercentiles(queueWait as Array<{ trigger: string | null; p50: number | null; p95: number | null }>),
			generateMs: toPercentiles(generateMs as Array<{ trigger: string | null; p50: number | null; p95: number | null }>),
			stockAgeAtUseMs: { p50: roundNullable(stockAgeRow?.p50 ?? null), p95: roundNullable(stockAgeRow?.p95 ?? null) },
		};
	}

	private async readCurrent(): Promise<CurrentSnapshot> {
		const [modes, withStock, stockAge, activeBatch, oldestPending, expiredLeases] = await Promise.all([
			this.db.query(`SELECT s."mode" AS mode, COUNT(*)::int AS count FROM "hanami_user_feed_state" s GROUP BY 1`),
			this.db.query(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_state" s WHERE s."mode" = 'personalized' AND s."stockBatchId" IS NOT NULL`),
			this.db.query(`SELECT
				COUNT(*) FILTER (WHERE b."finishedAt" > clock_timestamp() - INTERVAL '1 hour')::int AS under_1h,
				COUNT(*) FILTER (WHERE b."finishedAt" <= clock_timestamp() - INTERVAL '1 hour' AND b."finishedAt" > clock_timestamp() - INTERVAL '3 hours')::int AS from_1h_to_3h,
				COUNT(*) FILTER (WHERE b."finishedAt" <= clock_timestamp() - INTERVAL '3 hours')::int AS over_3h
				FROM "hanami_user_feed_batch" b
				JOIN "hanami_user_feed_state" s ON s."stockBatchId" = b."id" AND s."userId" = b."userId"
				WHERE b."status" = 'ready'`),
			this.db.query(`SELECT b."trigger" AS trigger, b."status" AS status, COUNT(*)::int AS count
				FROM "hanami_user_feed_batch" b WHERE b."status" IN ('pending', 'generating') GROUP BY 1, 2 ORDER BY 1, 2`),
			this.db.query(`SELECT EXTRACT(EPOCH FROM (clock_timestamp() - MIN(b."createdAt"))) * 1000 AS wait_ms
				FROM "hanami_user_feed_batch" b WHERE b."status" = 'pending'`),
			this.db.query(`SELECT COUNT(*)::text AS count FROM "hanami_user_feed_batch" b
				WHERE b."status" = 'generating' AND b."leaseExpiresAt" <= clock_timestamp()`),
		]);
		const modeMap = { personalized: 0, common: 0 };
		for (const row of asRow<{ mode: string; count: number }>(modes)) {
			if (row.mode === 'personalized' || row.mode === 'common') modeMap[row.mode] = row.count;
		}
		const stockAgeRow = asRow<{ under_1h: number; from_1h_to_3h: number; over_3h: number }>(stockAge).at(0);
		const oldestWait = asRow<{ wait_ms: number | null }>(oldestPending).at(0)?.wait_ms;
		return {
			personalizedUsers: modeMap.personalized,
			commonUsers: modeMap.common,
			withStock: Number(asRow(withStock).at(0)?.count ?? 0),
			stockAgeBuckets: {
				under1h: stockAgeRow?.under_1h ?? 0,
				from1hTo3h: stockAgeRow?.from_1h_to_3h ?? 0,
				over3h: stockAgeRow?.over_3h ?? 0,
			},
			activeBatchByTriggerStatus: asRow(activeBatch).map((row) => ({ trigger: row.trigger, status: row.status, count: row.count })),
			oldestPendingWaitMs: oldestWait == null ? null : Math.round(Number(oldestWait)),
			expiredGeneratingLeases: Number(asRow(expiredLeases).at(0)?.count ?? 0),
		};
	}

	private async runChecks(): Promise<CheckResult[]> {
		const checks: CheckResult[] = [];
		checks.push(await this.checkRows('entryAboveHeadNotStock', `
			SELECT s."userId" AS user_id, e."batchId" AS batch_id FROM "hanami_user_feed_entry" e
			JOIN "hanami_user_feed_state" s ON s."userId" = e."userId" AND s."epochId" = e."epochId"
			WHERE e."sequence" > s."latestSequence" AND e."batchId" IS DISTINCT FROM s."stockBatchId"`, '先頭より上の entry がストックの行ではありません'));
		checks.push(await this.checkRows('stockShapeMismatch', `
			SELECT s."userId" AS user_id, s."stockBatchId" AS batch_id FROM "hanami_user_feed_state" s
			LEFT JOIN "hanami_user_feed_batch" b ON b."id" = s."stockBatchId" AND b."userId" = s."userId"
			WHERE s."stockBatchId" IS NOT NULL AND (b."status" IS DISTINCT FROM 'ready' OR s."stockSequence" <> s."latestSequence" + b."itemCount")`, 'ストックの形が合いません（ready でない、または sequence が連続していない）'));
		checks.push(await this.checkRows('generatingPointerInvalid', `
			SELECT s."userId" AS user_id, s."generatingBatchId" AS batch_id FROM "hanami_user_feed_state" s
			JOIN "hanami_user_feed_batch" b ON b."id" = s."generatingBatchId" AND b."userId" = s."userId"
			WHERE s."generatingBatchId" IS NOT NULL AND b."status" NOT IN ('pending', 'generating')`, 'generatingBatchId が pending/generating を指していません'));
		checks.push(await this.checkRows('orphanActiveBatch', `
			SELECT b."userId" AS user_id, b."id" AS batch_id FROM "hanami_user_feed_batch" b
			LEFT JOIN "hanami_user_feed_state" s ON s."generatingBatchId" = b."id" AND s."userId" = b."userId"
			WHERE b."status" IN ('pending', 'generating') AND s."userId" IS NULL AND b."createdAt" < clock_timestamp() - INTERVAL '1 minute'`, 'どの state も指していない pending/generating batch があります'));
		checks.push(await this.checkRows('expiredLease', `
			SELECT b."userId" AS user_id, b."id" AS batch_id FROM "hanami_user_feed_batch" b
			WHERE b."status" = 'generating' AND b."leaseExpiresAt" <= clock_timestamp() - INTERVAL '1 minute'`, 'リース切れから 1 分以上の generating batch があります'));
		checks.push(await this.checkRows('stalePending', `
			SELECT b."userId" AS user_id, b."id" AS batch_id FROM "hanami_user_feed_batch" b
			WHERE b."status" = 'pending' AND b."availableAt" < clock_timestamp() - INTERVAL '5 minutes'`, 'availableAt から 5 分以上の pending batch があります'));
		checks.push(await this.checkRows('headNotReady', `
			SELECT s."userId" AS user_id, s."latestReadyBatchId" AS batch_id FROM "hanami_user_feed_state" s
			JOIN "hanami_user_feed_batch" b ON b."id" = s."latestReadyBatchId" AND b."userId" = s."userId"
			WHERE s."mode" = 'personalized' AND s."latestReadyBatchId" IS NOT NULL AND b."status" IS DISTINCT FROM 'ready'`, 'personalized の先頭 batch が ready ではありません'));
		checks.push(await this.checkRows('activeUserWithoutStock', `
			SELECT s."userId" AS user_id, NULL::text AS batch_id FROM "hanami_user_feed_state" s
			WHERE s."mode" = 'personalized' AND s."stockBatchId" IS NULL AND s."generatingBatchId" IS NULL
				AND EXISTS (SELECT 1 FROM "hanami_metrics_timeline" t WHERE t."userId" = s."userId" AND t."kind" = 'hanami'
					AND t."day" >= ((clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date - 7))
				AND (SELECT MAX(b2."finishedAt") FROM "hanami_user_feed_batch" b2 WHERE b2."userId" = s."userId") < clock_timestamp() - INTERVAL '15 minutes'`, '使っているのにストックも active batch もありません'));
		checks.push(await this.checkRows('discardedButReferenced', `
			SELECT s."userId" AS user_id, b."id" AS batch_id FROM "hanami_user_feed_state" s
			JOIN "hanami_user_feed_batch" b ON b."userId" = s."userId"
				AND b."id" IN (s."latestReadyBatchId", s."stockBatchId", s."generatingBatchId")
			WHERE b."discardReason" IS NOT NULL`, '捨てた batch を state がまだ指しています'));
		return checks;
	}

	private async checkRows(code: string, sql: string, detail: string): Promise<CheckResult> {
		try {
			// 見本は 5 件まで、件数は LIMIT の前に数える（頭打ちにしない）。
			const rows = asRow<{ user_id: string; batch_id: string | null; total: string }>(await this.db.query(`
				SELECT q.user_id, q.batch_id, COUNT(*) OVER () AS total FROM (${sql}) q LIMIT 5`));
			const total = Number(rows.at(0)?.total ?? 0);
			const samples = rows.map((row) => ({ userId: row.user_id, batchId: row.batch_id, detail }));
			return { code, ok: total === 0, count: total, error: null, samples };
		} catch (error) {
			// 点検できなかったものを「問題なし」とは返さない。
			return { code, ok: false, count: 0, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300), samples: [] };
		}
	}

	private async readUserDetail(userId: string): Promise<Record<string, unknown> | null> {
		const [states, batches, seenTtl, prewarmTtl] = await Promise.all([
			this.db.query(`SELECT s."userId" AS user_id, s."epochId" AS epoch_id, s."mode" AS mode,
				s."initialGenerationState" AS initial_state, s."latestReadyBatchId" AS latest_ready_batch_id,
				s."generatingBatchId" AS generating_batch_id, s."stockBatchId" AS stock_batch_id,
				s."stockSequence"::text AS stock_sequence, s."latestSequence"::text AS latest_sequence, s."updatedAt" AS updated_at
				FROM "hanami_user_feed_state" s WHERE s."userId" = $1`, [userId]),
			this.db.query(`SELECT b."id" AS id, b."trigger" AS trigger, b."reason" AS reason, b."status" AS status,
				b."attempts" AS attempts, b."createdAt" AS created_at, b."startedAt" AS started_at,
				b."finishedAt" AS finished_at, b."promotedAt" AS promoted_at, b."discardReason" AS discard_reason,
				b."failureKind" AS failure_kind, b."itemCount" AS item_count
				FROM "hanami_user_feed_batch" b WHERE b."userId" = $1 ORDER BY b."createdAt" DESC LIMIT 20`, [userId]),
			this.redisClient.ttl(HANAMI_FEED_SEEN_KEY_PREFIX + userId).catch(() => -2),
			this.redisClient.ttl(HANAMI_FEED_PREWARM_KEY_PREFIX + userId).catch(() => -2),
		]);
		const stateRow = asRow(states).at(0);
		if (stateRow == null) return null;
		const batchRows = asRow(batches);
		const headBatchId = stateRow.latest_ready_batch_id as string | null;
		const stockBatchId = stateRow.stock_batch_id as string | null;
		const head = headBatchId == null ? null : this.batchInfo(batchRows, headBatchId);
		const stock = stockBatchId == null ? null : this.batchInfo(batchRows, stockBatchId);
		return {
			state: {
				mode: stateRow.mode,
				initialGenerationState: stateRow.initial_state,
				epochId: stateRow.epoch_id,
				latestReadyBatchId: stateRow.latest_ready_batch_id,
				latestSequence: stateRow.latest_sequence,
				generatingBatchId: stateRow.generating_batch_id,
				stockBatchId: stateRow.stock_batch_id,
				stockSequence: stateRow.stock_sequence,
				updatedAt: toIso(stateRow.updated_at),
			},
			head,
			stock,
			inSession: ttlToSeconds(seenTtl),
			prewarmThrottleSeconds: ttlToSeconds(prewarmTtl),
			recentBatches: batchRows.map((row) => ({
				id: row.id,
				trigger: row.trigger,
				reason: row.reason,
				status: row.status,
				attempts: row.attempts,
				createdAt: toIso(row.created_at),
				startedAt: toIso(row.started_at),
				finishedAt: toIso(row.finished_at),
				promotedAt: toIso(row.promoted_at),
				discardReason: row.discard_reason,
				failureKind: row.failure_kind,
				itemCount: row.item_count,
			})),
		};
	}

	private batchInfo(batches: DbRow[], batchId: string): Record<string, unknown> | null {
		const row = batches.find((batch) => batch.id === batchId);
		if (row == null) return null;
		const finishedAt = row.finished_at == null ? null : Date.parse(String(row.finished_at));
		return {
			batchId,
			finishedAt: toIso(row.finished_at),
			itemCount: row.item_count,
			ageMs: finishedAt == null ? null : Math.max(0, Date.now() - finishedAt),
		};
	}
}

function toIso(value: unknown): string | null {
	if (value == null) return null;
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ttlToSeconds(ttl: number): number | null {
	return ttl < 0 ? null : ttl;
}

function roundNullable(value: number | null | undefined): number | null {
	if (value == null || !Number.isFinite(value)) return null;
	return Math.round(value);
}

function generationFailedRate(counts: Record<string, number>): { rate: number | null; failed: number; total: number } {
	const failed = counts['publish.failed'] ?? 0;
	const total = failed + (counts['publish.stock'] ?? 0) + (counts['publish.head'] ?? 0);
	return { rate: total === 0 ? null : failed / total, failed, total };
}

function issueMessage(code: string): string {
	switch (code) {
		case 'entryAboveHeadNotStock': return '先頭より上にストックではない entry が存在します。';
		case 'stockShapeMismatch': return 'ストックの形が崩れています（ready でない、または連続していない）。';
		case 'generatingPointerInvalid': return 'generatingBatchId が pending/generating を指していません。';
		case 'orphanActiveBatch': return 'どの state も指していない active batch があります。';
		case 'expiredLease': return 'リース切れの generating batch が残っています。';
		case 'stalePending': return 'availableAt を過ぎた pending batch が残っています。';
		case 'headNotReady': return 'personalized の先頭 batch が ready ではありません。';
		case 'activeUserWithoutStock': return '利用中なのにストックも active batch もありません。';
		case 'discardedButReferenced': return '捨てた batch を state がまだ指しています。';
		default: return code;
	}
}
