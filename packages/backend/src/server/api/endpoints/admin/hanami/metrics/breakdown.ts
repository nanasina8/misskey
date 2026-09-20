/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsQueryService } from '@/core/hanami/HanamiMetricsQueryService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { breakdownParamDef, breakdownResponseSchema, metricsEndpointMeta, metricsQuery, queryRange } from './schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Break down Hanami engagement by an allowlisted dimension, optionally filtering other dimensions. Cells below five users are suppressed, not zeroed. Lift compares engagement per seen with visible Hanami cells, not normal TL; denominator documents this privacy restriction.',
	res: breakdownResponseSchema,
} as const;

export const paramDef = breakdownParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(query: HanamiMetricsQueryService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => query.breakdown({ range: queryRange(ps.range), dimension: ps.dimension, filter: ps.filter })));
	}
}
