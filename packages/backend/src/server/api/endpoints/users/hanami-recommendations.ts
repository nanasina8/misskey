/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';

// フォロー候補（おすすめユーザー）。FoF（友達の友達）をスコア順に返す（[[hanami-tl-osusume-redesign]] step10）。
// 各候補に reason（fof）と mutualCount（共通の知り合い数）を添える。
export const meta = {
	tags: ['users'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				user: {
					type: 'object',
					optional: false, nullable: false,
					ref: 'UserDetailed',
				},
				reason: { type: 'string', optional: false, nullable: false },
				mutualCount: { type: 'integer', optional: false, nullable: false },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private userEntityService: UserEntityService,
		private hanamiRecommendationService: HanamiRecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const candidates = await this.hanamiRecommendationService.getFollowCandidates(me.id, ps.limit);
			if (candidates.length === 0) return [];

			const packed = await this.userEntityService.packMany(candidates.map(c => c.userId), me, { schema: 'UserDetailed' });
			const byId = new Map(packed.map(u => [u.id, u]));

			const result = candidates.flatMap(c => {
				const user = byId.get(c.userId);
				return user ? [{ user, reason: c.reason, mutualCount: c.mutualCount }] : [];
			});

			await this.hanamiRecommendationService.recordFollowCandidatesShown(me.id, result.map(x => x.user.id));
			return result;
		});
	}
}
