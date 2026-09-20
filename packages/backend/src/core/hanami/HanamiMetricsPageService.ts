/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { HANAMI_FOR_YOU_AXES } from './HanamiForYouInterleave.js';
import { diagnosticAxisLevel } from './HanamiMetricsDiagnosticsService.js';
import { HanamiMetricsTimelineHealthService } from './HanamiMetricsTimelineHealthService.js';
import { jstDay } from './HanamiMetricsContracts.js';
import type { DataSource } from 'typeorm';

@Injectable()
export class HanamiMetricsPageService {
	constructor(@Inject(DI.db) private db: DataSource, private health: HanamiMetricsTimelineHealthService) {}

	/** Snapshot the actual packed REST page, including zero-source pages. Never reconstruct demand from later preferences. */
	public async record(userId: string, feedEntryIds: readonly string[]): Promise<void> {
		const servedAt = new Date();
		const day = jstDay(servedAt);
		this.health.begin(day);
		let succeeded = false;
		try {
			await this.db.transaction(async manager => {
				const [profile] = await manager.query<{ axes: Record<string, unknown> }[]>(`SELECT "hanamiRecommendationAxes" AS axes FROM user_profile WHERE "userId"=$1`, [userId]);
				const [meta] = await manager.query<{ axes: Record<string, { available?: boolean; default?: boolean }> }[]>(`SELECT "hanamiRecommendationAxisConfig" AS axes FROM meta LIMIT 1`);
				if (!profile) throw new Error('Metrics profile unavailable');
				const unique = [...new Set(feedEntryIds)];
				const rows = await manager.query<{ source: string; count: number }[]>(`SELECT source,count(*)::int AS count FROM hanami_recommendation_event
					WHERE "userId"=$1 AND "eventType"='served' AND "feedEntryId"=ANY($2::varchar[]) GROUP BY source`, [userId, unique]);
				if (rows.reduce((sum, row) => sum + row.count, 0) !== unique.length) throw new Error('Metrics page provenance incomplete');
				const counts = Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, rows.find(row => row.source === axis)?.count ?? 0]));
				const axes = Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, diagnosticAxisLevel(axis, profile.axes ?? {}, meta?.axes ?? {})]));
				await manager.query(`INSERT INTO hanami_metrics_page(id,"userId","servedAt",counts,axes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [randomUUID(), userId, servedAt, JSON.stringify(counts), JSON.stringify(axes)]);
			});
			succeeded = true;
		} catch { /* The collector marks missingness without leaking parameters or failing serving. */ }
		finally { this.health.finish(day, succeeded); }
	}
}
