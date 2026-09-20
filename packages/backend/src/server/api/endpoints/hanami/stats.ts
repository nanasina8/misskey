/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsQueryService } from '@/core/hanami/HanamiMetricsQueryService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { metricsEndpointMeta, metricsQuery, queryRange, rangeParamDef, statsResponseSchema } from '../admin/hanami/metrics/schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Get admin-only anonymous Hanami statistics with weekly series and small-cell suppression. The query service caches this subset for 60 seconds; no public HTTP cache is enabled.',
	res: statsResponseSchema,
} as const;

export const paramDef = rangeParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(query: HanamiMetricsQueryService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => query.stats(queryRange(ps.range))));
	}
}
