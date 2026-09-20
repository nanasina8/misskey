/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsInsightsService } from '@/core/hanami/HanamiMetricsInsightsService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { metricsEndpointMeta, metricsQuery, queryRange } from './schemas.js';
import { opportunitiesParamDef, opportunitiesResponseSchema } from './insights-schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Get read-only Hanami improvement suggestions from visible aggregate cohorts. Suggestions are never applied automatically; consult suppressed and unavailable.',
	res: opportunitiesResponseSchema,
} as const;
export const paramDef = opportunitiesParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(insights: HanamiMetricsInsightsService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => insights.opportunities(queryRange(ps.range))));
	}
}
