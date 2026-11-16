/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { MiMeta } from '@/models/Meta.js';
import { CacheService } from '@/core/CacheService.js';
import { HANAMI_FOR_YOU_AXES } from '@/core/hanami/HanamiForYouInterleave.js';
import { normalizeHanamiTuning, resolveHanamiTuning, resolveHanamiSuggestionBase, getAvailableHanamiAxes } from '@/core/hanami/HanamiTuning.js';
import { HANAMI_TUNING_COUNTS_SQL, computeHanamiDriftFactors, suggestHanamiTuning, type HanamiTuningCounts } from '@/core/hanami/HanamiTuningSuggestion.js';

export const meta = {
	description: 'Show how the authenticated user reacted to each kind of Hanami timeline post over the last 14 days, the multiplier derived from it, and the amounts suggested from it.',
	tags: ['account'], requireCredential: true, kind: 'read:account',
	limit: { duration: 60_000, max: 10 },
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			eligible: { type: 'boolean', optional: false, nullable: false },
			minSeen: { type: 'number', optional: false, nullable: false },
			minReactions: { type: 'number', optional: false, nullable: false },
			totalSeen: { type: 'number', optional: false, nullable: false },
			totalReactions: { type: 'number', optional: false, nullable: false },
			axes: { type: 'array', optional: false, nullable: false, items: {
				type: 'object', optional: false, nullable: false,
				properties: {
					axis: { type: 'string', enum: HANAMI_FOR_YOU_AXES, optional: false, nullable: false },
					seen: { type: 'number', optional: false, nullable: false },
					reactions: { type: 'number', optional: false, nullable: false },
					rate: { type: 'number', optional: false, nullable: false },
					factor: { type: 'number', optional: false, nullable: false },
					current: { type: 'number', optional: false, nullable: false },
					suggested: { type: 'number', optional: false, nullable: false },
				},
			} },
			groups: {
				type: 'object', optional: false, nullable: false,
				properties: {
					close: { type: 'integer', minimum: 0, maximum: 4, optional: false, nullable: false },
					buzz: { type: 'integer', minimum: 0, maximum: 4, optional: false, nullable: false },
					fresh: { type: 'integer', minimum: 0, maximum: 4, optional: false, nullable: false },
				},
			},
		},
	},
} as const;
export const paramDef = { type: 'object', properties: {}, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.meta) private serverMeta: MiMeta,
		private cacheService: CacheService,
	) {
		super(meta, paramDef, async (_ps, me) => {
			const profile = await this.cacheService.userProfileCache.fetch(me.id);
			const axisConfig = this.serverMeta.hanamiRecommendationAxisConfig;
			const base = resolveHanamiSuggestionBase(normalizeHanamiTuning(profile, axisConfig), axisConfig);
			const available = getAvailableHanamiAxes(this.serverMeta.hanamiRecommendationAxisConfig);
			const rows = await this.db.query(HANAMI_TUNING_COUNTS_SQL, [me.id, available]) as HanamiTuningCounts[];
			// current は、いま実際に使っている量（おまかせ・方向だけ決める では、反応に寄せたあとの量）。
			const tuning = resolveHanamiTuning(profile, axisConfig, computeHanamiDriftFactors(rows));
			return suggestHanamiTuning(rows, tuning, base);
		});
	}
}
