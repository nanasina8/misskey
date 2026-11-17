/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiRankBacktestService } from '@/core/hanami/HanamiRankBacktestService.js';
import { HANAMI_RANK_BACKTEST_GPU_VARIANTS, HANAMI_RANK_BACKTEST_SUBSETS, HANAMI_RANK_BACKTEST_VARIANTS } from '@/core/hanami/HanamiRankBacktest.js';

const count = (description: string) => ({ type: 'integer', optional: false, nullable: false, description } as const);
const numberOrNull = (description: string) => ({ type: 'number', optional: false, nullable: true, description } as const);

export const meta = {
	tags: ['admin'],
	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:queue',
	description: 'Progress and results of the latest Hanami rank backtest. A backtest re-scores past "seen on the Hanami timeline" records with several scoring methods and reports how well each score separates the notes the viewer engaged with from the ones they did not. Only counts and ratios are returned.',
	res: {
		type: 'object', optional: false, nullable: false,
		description: 'Latest Hanami rank backtest.',
		properties: {
			active: { type: 'boolean', optional: false, nullable: false, description: 'Whether the latest run is still being scored.' },
			run: {
				type: 'object', optional: false, nullable: true,
				description: 'The latest run, or null when no run has been made (results are kept for 14 days).',
				properties: {
					id: { type: 'string', optional: false, nullable: false, description: 'Run ID.' },
					createdAt: { type: 'string', optional: false, nullable: false, format: 'date-time', description: 'When the run was started.' },
					finishedAt: { type: 'string', optional: false, nullable: true, format: 'date-time', description: 'When scoring finished, or null while it is still in progress.' },
					startedBy: { type: 'string', optional: false, nullable: false, enum: ['auto', 'manual'], description: 'auto = started by itself while the GPU was idle, manual = started through the API.' },
					days: count('How many days of seen records were sampled.'),
					limit: count('Maximum number of sampled records.'),
					samples: count('Sampled records: one per (viewer, note), newest first, text notes by other users only.'),
					compared: count('Records scored by every GPU method of the run. Results are computed on these records only, so the methods are compared on the same records.'),
					progress: {
						type: 'array', optional: false, nullable: false,
						description: 'Scoring progress of each GPU method.',
						items: {
							type: 'object', optional: false, nullable: false, description: 'One GPU method.',
							properties: {
								variant: { type: 'string', optional: false, nullable: false, enum: HANAMI_RANK_BACKTEST_GPU_VARIANTS, description: 'personal = the prompt shows notes the viewer recently reacted to, generic = the prompt shows the note only.' },
								scored: count('Records scored so far.'),
								pending: count('Records not yet handed to the GPU queue.'),
								skipped: count('Records left out (the note is gone, or the viewer has too few earlier reactions for the personal prompt).'),
								errors: count('Records the GPU worker failed to score.'),
							},
						},
					},
					results: {
						type: 'array', optional: false, nullable: false,
						description: 'One row per scoring method and subset. interest = the stored note-judge interest score, follow = 1 when the author is followed.',
						items: {
							type: 'object', optional: false, nullable: false, description: 'One scoring method on one subset.',
							properties: {
								variant: { type: 'string', optional: false, nullable: false, enum: HANAMI_RANK_BACKTEST_VARIANTS, description: 'Scoring method.' },
								subset: { type: 'string', optional: false, nullable: false, enum: HANAMI_RANK_BACKTEST_SUBSETS, description: 'all, or only records whose author had this relationship to the viewer when served.' },
								seen: count('Records with a score in this subset.'),
								engaged: count('Of those, records the viewer reacted to, replied to or renoted.'),
								auc: numberOrNull('Chance that an engaged record scores higher than a non-engaged one, over all viewers together (0.5 = random). Null without both kinds of records.'),
								withinUserAuc: numberOrNull('The same chance computed inside each viewer and pooled, which removes differences in how readily viewers react. This is the number that matters for ordering one viewer\'s timeline.'),
								withinUsers: count('Viewers that had both engaged and non-engaged records.'),
								top20: {
									type: 'object', optional: false, nullable: false, description: 'The fifth of the records with the highest scores.',
									properties: { seen: count('Records.'), engaged: count('Engaged records.') },
								},
								buckets: {
									type: 'array', optional: false, nullable: false,
									description: 'Records split into five equal parts from the lowest score to the highest.',
									items: {
										type: 'object', optional: false, nullable: false, description: 'One part.',
										properties: {
											from: { type: 'number', optional: false, nullable: false, description: 'Lowest score in the part.' },
											to: { type: 'number', optional: false, nullable: false, description: 'Highest score in the part.' },
											seen: count('Records.'),
											engaged: count('Engaged records.'),
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiRankBacktestService: HanamiRankBacktestService,
	) {
		super(meta, paramDef, async () => {
			return await this.hanamiRankBacktestService.status();
		});
	}
}
