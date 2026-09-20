/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { DataSource } from 'typeorm';

/** Run after finalizing recent cohorts. Each indexed deletion is independently retryable. */
@Injectable()
export class HanamiMetricsRetentionService {
	constructor(@Inject(DI.db) private readonly db: DataSource) {}

	public async prune(): Promise<void> {
		for (const [table, timestamp] of [
			['hanami_metrics_event', 'createdAt'], ['hanami_metrics_judgement', 'judgedAt'], ['hanami_metrics_refresh', 'createdAt'],
			['hanami_metrics_page', 'servedAt'], ['hanami_metrics_candidate', 'capturedAt'],
		] as const) {
			await this.db.query(`DELETE FROM "${table}" WHERE "${timestamp}" < clock_timestamp() - interval '105 days'`);
		}
		await this.db.query(`DELETE FROM hanami_metrics_timeline WHERE day < (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date - 105`);
		await this.db.query(`DELETE FROM hanami_metrics_gap WHERE day < (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date - 105`);
		await this.db.query(`DELETE FROM hanami_metrics_collector WHERE "stoppedAt" < clock_timestamp() - interval '105 days'`);
		// Unlike the generic chart cleaner, catch up even after outages longer than three days.
		const columns = ['home', 'local', 'social', 'global', 'hanami'].map(kind => `"unique_temp___${kind}_users" = '{}'`).join(',');
		for (const table of ['__chart__hanami_timeline', '__chart_day__hanami_timeline']) {
			await this.db.query(`UPDATE "${table}" SET ${columns} WHERE date < EXTRACT(EPOCH FROM date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::integer - 86400`);
		}
	}
}
