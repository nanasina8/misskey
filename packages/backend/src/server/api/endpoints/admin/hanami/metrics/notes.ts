/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsInsightsService } from '@/core/hanami/HanamiMetricsInsightsService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { metricsEndpointMeta, metricsQuery, queryRange } from './schemas.js';
import { notesParamDef, notesResponseSchema } from './insights-schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Get up to 20 public, currently visible notes from cohorts with at least 20 serves, at most 30 inclusive days. Text is limited to 160 characters; the service rechecks visibility even on cache hits.',
	res: notesResponseSchema,
} as const;
export const paramDef = notesParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(insights: HanamiMetricsInsightsService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => insights.notes({ range: queryRange(ps.range), dimension: ps.dimension, key: ps.key })));
	}
}
