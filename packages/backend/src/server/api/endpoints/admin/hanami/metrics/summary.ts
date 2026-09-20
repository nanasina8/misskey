/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsQueryService } from '@/core/hanami/HanamiMetricsQueryService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { metricsEndpointMeta, metricsQuery, queryRange, rangeParamDef, summaryResponseSchema } from './schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Get anonymous Hanami usage, per-type DISTINCT reaction + reply + renote engagement, and generation aggregates. Suppressed or unavailable values are null; consult coverage.',
	res: summaryResponseSchema,
} as const;

export const paramDef = rangeParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(query: HanamiMetricsQueryService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => query.summary(queryRange(ps.range))));
	}
}
