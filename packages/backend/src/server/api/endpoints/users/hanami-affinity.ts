/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 関係値（affinity）ウィジェット用。mode=top は「よく話す人」「ユーザークラウド」、mode=lapsed は「ご無沙汰の人」。
// 要求時計算＋キャッシュのみで、生成ジョブは起動しない（指示書 hanami-widgets-wave-a-codex-brief-20260914.md §3.3）。
import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { HanamiAffinityService } from '@/core/hanami/HanamiAffinityService.js';
import { AFFINITY, affinityRankDelta } from '@/core/hanami/HanamiAffinityContracts.js';

const countSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		out: { type: 'integer', optional: false, nullable: false },
		in: { type: 'integer', optional: false, nullable: false },
	},
} as const;

export const meta = {
	tags: ['users'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			computedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
			items: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						user: { type: 'object', optional: false, nullable: false, ref: 'UserLite' },
						// mode=top
						rank: { type: 'integer', optional: true, nullable: false },
						score: { type: 'number', optional: true, nullable: false },
						rankDelta: { type: 'integer', optional: true, nullable: true },
						mutualFollow: { type: 'boolean', optional: true, nullable: false },
						mutualInteraction: { type: 'boolean', optional: true, nullable: false },
						lastInteractionAt: { type: 'string', format: 'date-time', optional: true, nullable: true },
						counts: {
							type: 'object', optional: true, nullable: false,
							properties: {
								reply: countSchema,
								mention: countSchema,
								renote: countSchema,
								reaction: countSchema,
							},
						},
						// mode=lapsed
						daysSinceLast: { type: 'integer', optional: true, nullable: false },
						pastPerWeek: { type: 'number', optional: true, nullable: false },
						latestNoteAt: { type: 'string', format: 'date-time', optional: true, nullable: true },
						birthdayWithin14d: { type: 'boolean', optional: true, nullable: false },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		mode: { type: 'string', enum: ['top', 'lapsed'], default: 'top' },
		limit: { type: 'integer', minimum: 1, maximum: AFFINITY.apiLimitMax, default: AFFINITY.apiLimitDefault },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private userEntityService: UserEntityService,
		private affinityService: HanamiAffinityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const computedAt = new Date().toISOString();

			if (ps.mode === 'lapsed') {
				const lapsed = (await this.affinityService.computeLapsed(me.id)).slice(0, ps.limit);
				const users = await this.userEntityService.packMany(lapsed.map(entry => entry.userId), me, { schema: 'UserLite' });
				const byId = new Map(users.map(user => [user.id, user]));
				return {
					computedAt,
					items: lapsed.flatMap(entry => {
						const user = byId.get(entry.userId);
						if (user == null) return [];
						return [{
							user,
							daysSinceLast: entry.daysSinceLast,
							pastPerWeek: entry.pastPerWeek,
							latestNoteAt: entry.latestNoteAt?.toISOString() ?? null,
							birthdayWithin14d: entry.birthdayWithin14d,
						}];
					}),
				};
			}

			const top = await this.affinityService.computeTop(me.id);
			const shown = top.slice(0, ps.limit);
			const [users, snapshot] = await Promise.all([
				this.userEntityService.packMany(shown.map(entry => entry.userId), me, { schema: 'UserLite' }),
				this.affinityService.getComparisonSnapshot(me.id),
			]);
			const byId = new Map(users.map(user => [user.id, user]));
			return {
				computedAt,
				items: shown.flatMap((entry, index) => {
					const user = byId.get(entry.userId);
					if (user == null) return [];
					const rank = index + 1;
					return [{
						user,
						rank,
						score: Math.round(entry.score * 100) / 100,
						rankDelta: affinityRankDelta(entry.userId, rank, snapshot),
						mutualFollow: entry.mutualFollow,
						mutualInteraction: entry.mutualInteraction,
						lastInteractionAt: entry.lastInteractionAt?.toISOString() ?? null,
						counts: entry.counts,
					}];
				}),
			};
		});
	}
}
