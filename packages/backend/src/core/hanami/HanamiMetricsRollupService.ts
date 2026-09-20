/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import type { Config } from '@/config.js';
import {
	HANAMI_METRICS_DIMENSIONS, jstDay, shiftMetricsDay, resolveRange, rangeParameters,
	metricsCohortSql, METRICS_NORMAL_SQL, metricsGenerationSql,
} from './HanamiMetricsContracts.js';
import type { MetricsAggregateRow, MetricsGenerationRow } from './HanamiMetricsContracts.js';
import type { DataSource, EntityManager } from 'typeorm';

interface DailyRow extends MetricsAggregateRow {
	extra?: object;
}
const emptyCounts = { users: 0, served: 0, seen: 0, reaction: 0, reply: 0, renote: 0 };

@Injectable()
export class HanamiMetricsRollupService {
	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		@Optional() @Inject(DI.redis) private readonly redis?: { get(key: string): Promise<string | null> },
		@Optional() @Inject(DI.config) private readonly config?: Config,
	) {}

	/** Each scope/dimension is atomic and independently retryable. No global day transaction. */
	public async rollupDay(day: string, { recompute }: { recompute: boolean }): Promise<void> {
		const range = resolveRange({ from: day, to: day });
		const bounds = rangeParameters(range);
		const cohortParams = [...bounds, '{}'];
		// Note timestamps live in IDs, not a note.createdAt column. Decode with the
		// configured canonical IdService rather than guessing a SQL ID format.
		if (this.config) {
			const ids = new IdService(this.config);
			const rows = await this.db.query<{ id: string; noteId: string; createdAt: Date }[]>(`SELECT id,"noteId","createdAt" FROM hanami_metrics_event
				WHERE "eventType"='served' AND "createdAt">=$1::timestamptz AND "createdAt"<$2::timestamptz AND dimensions->>'freshness'='unknown'`, bounds);
			for (const row of rows) {
				const age = new Date(row.createdAt).getTime() - ids.parse(row.noteId).date.getTime();
				if (!Number.isFinite(age) || age < 0) continue;
				const freshness = age < 6 * 3600000 ? '0-6h' : age < 24 * 3600000 ? '6-24h' : age < 72 * 3600000 ? '1-3d' : '3d+';
				await this.db.query(`UPDATE hanami_metrics_event SET dimensions=jsonb_set(dimensions,'{freshness}',to_jsonb($2::text)) WHERE id=$1`, [row.id, freshness]);
			}
		}
		for (const dimension of ['total', ...HANAMI_METRICS_DIMENSIONS] as const) {
			await this.replace(day, 'engagement', dimension, recompute, async manager => manager.query<DailyRow[]>(
				metricsCohortSql(dimension === 'total' ? 'total' : 'dimension'),
				dimension === 'total' ? cohortParams : [...cohortParams, dimension],
			));
		}
		await this.replace(day, 'engagement', 'normal', recompute, manager => manager.query<DailyRow[]>(METRICS_NORMAL_SQL, bounds));
		await this.replace(day, 'usage', 'total', recompute, async manager => {
			const [row] = await manager.query<{ users: number; refreshes: number; userDays: number; refreshUsers: number }[]>(`SELECT
				(SELECT COUNT(DISTINCT "userId")::int FROM hanami_metrics_event WHERE "eventType" = 'served' AND "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz) AS users,
				COUNT(*)::int AS refreshes, COUNT(DISTINCT "userId")::int AS "refreshUsers"
				FROM hanami_metrics_refresh WHERE "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz`, bounds);
			// Absence/expiry of an instrumentation counter is NOT evidence of zero requests.
			let rateLimited: number | null = null;
			if (this.redis) {
				try {
					const value = await this.redis.get(`hanami:metrics:429:${day}`);
					if (value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) rateLimited = Number(value);
				} catch { /* Metrics must not make Redis availability a rollup dependency. */ }
			}
			if (rateLimited === null) {
				const previous = await manager.query<{ rateLimited: number | null }[]>('SELECT (extra->>\'rateLimited\')::int AS "rateLimited" FROM hanami_metrics_daily WHERE day = $1::date AND scope = \'usage\' AND dimension = \'total\' AND key = \'total\'', [day]);
				rateLimited = previous[0]?.rateLimited ?? null;
			}
			return [{ ...emptyCounts, key: 'total', users: row.users, extra: { manualRefresh: row.refreshes, refreshUsers: row.refreshUsers, rateLimited, rateLimitedAvailable: rateLimited !== null } }];
		});
		await this.replace(day, 'usage', 'tlKind', recompute, async manager => {
			const rows = await manager.query<{ key: string; users: number; requests: number }[]>('SELECT kind AS key, COUNT(DISTINCT "userId")::int AS users, SUM(requests)::int AS requests FROM hanami_metrics_timeline WHERE day = $1::date GROUP BY kind', [day]);
			return rows.map(row => ({ ...emptyCounts, key: row.key, users: row.users, extra: { requests: row.requests } }));
		});
		for (const kind of ['personal', 'common', 'judge'] as const) {
			await this.replace(day, 'generation', kind, recompute, async manager => {
				const rows = await manager.query<MetricsGenerationRow[]>(metricsGenerationSql(), bounds);
				const row = rows.find(item => item.key === kind);
				return [{ ...emptyCounts, key: kind, users: row?.users ?? 0, extra: row ?? { total: 0, failed: 0, p50Ms: null, p95Ms: null, failures: [] } }];
			});
		}
		for (const [scope, dimension] of [['dropped', 'exploration'], ['tuning', 'axisLevel']]) {
			await this.replace(day, scope, dimension, recompute, async manager => {
				const rows = await manager.query<{ key: string; users: number; data: object }[]>(`SELECT key,users,data FROM hanami_metrics_diagnostic WHERE day=$1::date AND scope=$2`, [day, scope]);
				return rows.length ? rows.map(row => ({ ...emptyCounts, key: row.key, users: row.users, extra: row.data }))
					: [{ ...emptyCounts, key: 'unavailable', extra: { available: false, reason: 'No historical snapshot was captured' } }];
			});
		}
	}

	public async rollupRecent(): Promise<void> {
		// Yesterday plus the preceding 14 days: the fifteenth day needs one final
		// pass AFTER its whole inclusive outcome window has closed (not at 03:30
		// on the last still-open day).
		const today = jstDay();
		for (let ago = 15; ago >= 1; ago--) await this.rollupDay(shiftMetricsDay(today, -ago), { recompute: true });
	}

	private async replace(day: string, scope: string, dimension: string, recompute: boolean, compute: (manager: EntityManager) => Promise<DailyRow[]>): Promise<void> {
		await this.db.transaction(async manager => {
			// Serialize competing CLI/job runs, including the initially empty dimension.
			await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hanami-metrics:${day}:${scope}:${dimension}`]);
			if (!recompute) {
				const existing = await manager.query<{ exists: boolean }[]>('SELECT EXISTS(SELECT 1 FROM hanami_metrics_daily WHERE day = $1::date AND scope = $2 AND dimension = $3) AS exists', [day, scope, dimension]);
				if (existing[0]?.exists) return;
			}
			const rows = await compute(manager);
			// Remove obsolete top-30/bucket keys as well as upserting surviving keys.
			await manager.query('DELETE FROM hanami_metrics_daily WHERE day = $1::date AND scope = $2 AND dimension = $3 AND NOT (key = ANY($4::varchar[]))', [day, scope, dimension, rows.map(row => row.key)]);
			for (const row of rows) {
				await manager.query(`INSERT INTO hanami_metrics_daily (day,scope,dimension,key,users,served,seen,reaction,reply,renote,extra,"updatedAt")
					VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now())
					ON CONFLICT (day,scope,dimension,key) DO UPDATE SET users=EXCLUDED.users, served=EXCLUDED.served,
					seen=EXCLUDED.seen,reaction=EXCLUDED.reaction,reply=EXCLUDED.reply,renote=EXCLUDED.renote,extra=EXCLUDED.extra,"updatedAt"=EXCLUDED."updatedAt"`,
				[day, scope, dimension, row.key, row.users, row.served, row.seen, row.reaction, row.reply, row.renote, JSON.stringify(row.extra ?? {})]);
			}
		});
	}
}
