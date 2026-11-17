/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import {
	HANAMI_RANK_BACKTEST_DEFAULT_DAYS,
	HANAMI_RANK_BACKTEST_DEFAULT_LIMIT,
	HANAMI_RANK_BACKTEST_MAX_DAYS,
	HANAMI_RANK_BACKTEST_MAX_LIMIT,
	HanamiRankBacktestAlreadyRunningError,
	HanamiRankBacktestService,
} from '@/core/hanami/HanamiRankBacktestService.js';
import { HANAMI_RANK_BACKTEST_GPU_VARIANTS } from '@/core/hanami/HanamiRankBacktest.js';

export const meta = {
	tags: ['admin'],
	requireCredential: true,
	requireAdmin: true,
	kind: 'write:admin:queue',
	description: 'Start a Hanami rank backtest now instead of waiting for the automatic weekly run. The records are sampled immediately; scoring proceeds little by little while the GPU has no other work. With force, a run that is still in progress is cut short first (its scores so far are kept).',

	errors: {
		alreadyRunning: {
			message: 'A Hanami rank backtest is already running.',
			code: 'HANAMI_RANK_BACKTEST_ALREADY_RUNNING',
			id: '65ba6809-01fc-4f19-9570-610e8a8b8c4a',
		},
	},

	res: {
		type: 'object', optional: false, nullable: false,
		description: 'The started run.',
		properties: {
			id: { type: 'string', optional: false, nullable: false, description: 'Run ID.' },
			samples: { type: 'integer', optional: false, nullable: false, description: 'Sampled records.' },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		days: { type: 'integer', minimum: 1, maximum: HANAMI_RANK_BACKTEST_MAX_DAYS, default: HANAMI_RANK_BACKTEST_DEFAULT_DAYS, description: 'How many days of seen records to sample.' },
		limit: { type: 'integer', minimum: 100, maximum: HANAMI_RANK_BACKTEST_MAX_LIMIT, default: HANAMI_RANK_BACKTEST_DEFAULT_LIMIT, description: 'Maximum number of records, newest first.' },
		variants: {
			type: 'array', uniqueItems: true,
			description: 'GPU scoring methods to run. All of them when omitted.',
			items: { type: 'string', enum: HANAMI_RANK_BACKTEST_GPU_VARIANTS },
		},
		force: { type: 'boolean', default: false, description: 'Cut the run in progress short and start a new one.' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiRankBacktestService: HanamiRankBacktestService,
	) {
		super(meta, paramDef, async (ps) => {
			try {
				const run = await this.hanamiRankBacktestService.start({ days: ps.days, limit: ps.limit, variants: ps.variants, force: ps.force }, 'manual');
				return { id: run.id, samples: run.samples };
			} catch (err) {
				if (err instanceof HanamiRankBacktestAlreadyRunningError) throw new ApiError(meta.errors.alreadyRunning);
				throw err;
			}
		});
	}
}
