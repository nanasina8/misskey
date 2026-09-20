/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsInsightsService } from '@/core/hanami/HanamiMetricsInsightsService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { metricsEndpointMeta, metricsQuery, queryRange } from './schemas.js';
import { whatIfParamDef, whatIfResponseSchema } from './insights-schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Evaluate exploration thresholds against the current-prompt served cohort, at most 30 inclusive days. Small cohorts return null, not zero. Omitted threshold arrays use current settings.',
	res: whatIfResponseSchema,
} as const;
export const paramDef = whatIfParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(insights: HanamiMetricsInsightsService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => insights.whatIf({ range: queryRange(ps.range), axis: ps.axis, thresholds: ps.thresholds })));
	}
}
