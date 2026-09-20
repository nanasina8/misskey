/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiMetricsInsightsService } from '@/core/hanami/HanamiMetricsInsightsService.js';
import { ApiError } from '@/server/api/error.js';
import { metricsQuery, queryRange, rangeSchema } from './metrics/schemas.js';
import { explorationAxisSchema, judgeCohortSchema } from './metrics/insights-schemas.js';
export const meta = { tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue', description: 'Get legacy last-24-hour judge aggregates. Supplying range or axis selects the served-exploration what-if cohort at the current interest threshold (max 30 days); cohort contains the result and legacy counts are null with empty legacy lists.', res: { type: 'object', optional: false, nullable: false, properties: {
	judged: { type: 'integer', optional: false, nullable: true },
	ephemeral: { type: 'integer', optional: false, nullable: true },
	interestFiltered: { type: 'integer', optional: false, nullable: true },
	cohort: { ...judgeCohortSchema, optional: true },
	typeBreakdown: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
		contentType: { type: 'integer', optional: false, nullable: false },
		count: { type: 'integer', optional: false, nullable: false },
	} } },
	topServed: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
		noteId: { type: 'string', optional: false, nullable: false },
		text: { type: 'string', optional: false, nullable: false },
		reactionScore: { type: 'number', optional: false, nullable: true },
		interest: { type: 'number', optional: false, nullable: true },
		ephemeralScore: { type: 'number', optional: false, nullable: true },
	} } },
} } } as const;
export const paramDef = { type: 'object', properties: { range: rangeSchema, axis: explorationAxisSchema }, required: [], additionalProperties: false } as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(@Inject(DI.db) private db: DataSource, @Optional() private insights?: HanamiMetricsInsightsService) {
		super(meta, paramDef, async (ps) => {
			const cohortMode = ps.range !== undefined || ps.axis !== undefined;
			if (cohortMode && !this.insights) throw new ApiError({ message: 'Metrics insights service is unavailable.', code: 'METRICS_INSIGHTS_UNAVAILABLE', id: '24d466ef-2389-47ce-b42c-b065920f2021', httpStatusCode: 503 });
			const metaRows = await this.db.query<{ settings: unknown }[]>('SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1');
			const checked = validateHanamiNoteJudgeSettings(metaRows.at(0)?.settings);
			const settings = checked.ok ? checked.value : createDefaultHanamiNoteJudgeSettings();
			if (cohortMode && this.insights) {
				const insights = this.insights;
				const result = await metricsQuery(() => insights.whatIf({ range: queryRange(ps.range), axis: 'exploration', thresholds: { interest: [settings.interestThreshold] } }));
				return {
					judged: null, ephemeral: null, interestFiltered: null, typeBreakdown: [], topServed: [],
					cohort: { range: result.range, passed: result.interest.find(point => point.theta === settings.interestThreshold)?.passed ?? null, suppressed: result.suppressed, unavailable: result.unavailable },
				};
			}
			const [counts] = await this.db.query('SELECT count(*)::int AS judged, count(*) FILTER (WHERE "ephemeralScore" > $1)::int AS ephemeral, count(*) FILTER (WHERE interest < $2)::int AS "interestFiltered" FROM "hanami_note_judgement" WHERE "judgedAt" >= clock_timestamp() - INTERVAL \'24 hours\'', [settings.ephemeralThreshold, settings.interestThreshold]);
			const typeBreakdown = await this.db.query('SELECT "contentType", count(*)::int AS count FROM "hanami_note_judgement" WHERE "judgedAt" >= clock_timestamp() - INTERVAL \'24 hours\' GROUP BY "contentType" ORDER BY "contentType"');
			const topServed = await this.db.query('SELECT e."noteId" AS "noteId", left(COALESCE(n.text, \'\'), 160) AS text, c."baseScore" AS "reactionScore", j.interest, j."ephemeralScore" FROM "hanami_recommendation_event" e JOIN note n ON n.id = e."noteId" LEFT JOIN "hanami_common_candidate" c ON c."noteId" = e."noteId" AND c.axis = \'exploration\' LEFT JOIN "hanami_note_judgement" j ON j."noteId" = e."noteId" AND j."promptVersion" = $1 WHERE e."eventType" = \'served\' AND e."occurredAt" >= clock_timestamp() - INTERVAL \'24 hours\' ORDER BY e."occurredAt" DESC LIMIT 20', [settings.promptVersion]);
			return { ...counts, typeBreakdown, topServed };
		});
	}
}
