/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppLockService } from '@/core/AppLockService.js';
import { HanamiMetricsTimelineHealthService } from '@/core/hanami/HanamiMetricsTimelineHealthService.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import Chart from '../core.js';
import { ChartLoggerService } from '../ChartLoggerService.js';
import { name, schema } from './entities/hanami-timeline.js';
import type { HanamiTimelineKind } from './entities/hanami-timeline.js';
import type { KVs } from '../core.js';

/**
 * Successful REST timeline requests only (including empty pages and pagination).
 * Chart windows remain UTC, with the framework's buffered-save boundary semantics.
 * uniqueIncrement persists temporary internal identifiers, NOT just cardinalities:
 * configure the same HANAMI_METRICS_SALT on all workers to HMAC those identifiers.
 * Without it we use the existing ActiveUsersChart ID convention, never a fixed salt.
 * Do not rotate the salt mid-window. These arrays must never be exposed via the API.
 * Register clean() with the chart cleanup job: core clears arrays 1–3 days old;
 * an outage longer than that needs a separate catch-up cleanup by operations.
 *
 * hanami_metrics_timeline is the authoritative JST supplement, not the UTC chart.
 * Its nullable userId is internal (FK to user, ON DELETE CASCADE); anonymous rows
 * count requests but must be excluded from distinct-user counts. The main-owned
 * migration supplies UNIQUE NULLS NOT DISTINCT (day, kind, userId). Rollups must
 * COUNT(DISTINCT userId), not sum daily users when calculating week/month users.
 * Counter writes are awaited, but failures preserve serving availability and warn.
 * The health collector persists gaps and fail-closed session watermarks separately.
 */
@Injectable()
export default class HanamiTimelineChart extends Chart<typeof schema> { // eslint-disable-line import/no-default-export
	private readonly metricsSalt = process.env.HANAMI_METRICS_SALT;
	private lastWarningAt = -Infinity;

	constructor(
		@Inject(DI.db)
		private db: DataSource,
		private appLockService: AppLockService,
		private chartLoggerService: ChartLoggerService,
		@Optional() private readonly health?: HanamiMetricsTimelineHealthService,
	) {
		super(db, (k) => appLockService.getChartInsertLock(k), chartLoggerService.logger, name, schema);
	}

	protected async tickMajor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	protected async tickMinor(): Promise<Partial<KVs<typeof schema>>> {
		return {};
	}

	/** Await the counter attempt before returning a response; failures remain nonfatal. */
	@bindThis
	public async hit(kind: HanamiTimelineKind, userId: string | null): Promise<void> {
		// Capture the successful request's day before waiting for a DB connection.
		// JST is UTC+09:00 year-round; do not use the database execution timestamp.
		const day = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
		try { this.health?.begin(day); } catch { this.warn('health begin failed'); }
		try {
			const key = userId == null ? null : this.metricsSalt
				? createHmac('sha256', this.metricsSalt).update(userId).digest('hex')
				: userId;
			this.commit({
				[`${kind}.requests`]: 1,
				...(key == null ? {} : { [`${kind}.users`]: [key] }),
			});
		} catch {
			this.warn('chart commit failed');
		}

		await this.writeJstCounter(day, kind, userId);
	}

	private async writeJstCounter(day: string, kind: HanamiTimelineKind, userId: string | null): Promise<void> {
		let ok = false;
		try {
			await this.db.query(`
				INSERT INTO "hanami_metrics_timeline" ("day", "kind", "userId", "requests")
				VALUES ($1::date, $2, $3, 1)
				ON CONFLICT ("day", "kind", "userId") DO UPDATE
				SET "requests" = "hanami_metrics_timeline"."requests" + EXCLUDED."requests"
			`, [day, kind, userId]);
			ok = true;
		} catch {
			// Do not log query parameters or driver errors containing raw user IDs.
			this.warn('JST counter write failed; collection gap');
		} finally {
			try { this.health?.finish(day, ok); } catch { this.warn('health finish failed'); }
		}
	}

	private warn(reason: string): void {
		// Avoid log floods on a missing migration/outage. Logging is also best effort.
		if (Date.now() - this.lastWarningAt < 60_000) return;
		this.lastWarningAt = Date.now();
		try {
			this.chartLoggerService.logger.warn(`hanamiTimeline: ${reason}`);
		} catch { /* Metrics must not affect timeline availability. */ }
	}
}
