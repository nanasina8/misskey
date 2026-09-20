/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsQueryService } from '@/core/hanami/HanamiMetricsQueryService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { errorsResponseSchema, metricsEndpointMeta, metricsQuery, queryRange, rangeParamDef } from './schemas.js';

export const meta = {
	...metricsEndpointMeta,
	description: 'Get privacy-preserving Hanami generation error aggregates and sanitized recent failures. No raw user IDs, note IDs, or note content are returned.',
	res: errorsResponseSchema,
} as const;

export const paramDef = rangeParamDef;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(query: HanamiMetricsQueryService) {
		super(meta, paramDef, async (ps) => metricsQuery(() => query.errors(queryRange(ps.range))));
	}
}
