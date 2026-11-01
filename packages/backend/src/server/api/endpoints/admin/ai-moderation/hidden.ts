/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdService } from '@/core/IdService.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				id: { type: 'string', optional: false, nullable: false, format: 'id' },
				createdAt: { type: 'string', optional: false, nullable: false, format: 'date-time' },
				targetType: { type: 'string', optional: false, nullable: false, enum: ['user', 'host'] },
				userId: { type: 'string', optional: false, nullable: true, format: 'id' },
				user: { type: 'object', optional: false, nullable: true, ref: 'UserLite' },
				host: { type: 'string', optional: false, nullable: true },
				reason: { type: 'string', optional: false, nullable: false, enum: ['manual', 'auto'] },
				createdBy: { type: 'object', optional: false, nullable: true, ref: 'UserLite' },
				sourceQueueId: { type: 'string', optional: false, nullable: true, format: 'id' },
				moderationNote: { type: 'string', optional: false, nullable: false },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		targetType: { type: 'string', enum: ['user', 'host'] },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private userEntityService: UserEntityService,
		private idService: IdService,
		private aiModerationHiddenService: AiModerationHiddenService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const rows = await this.aiModerationHiddenService.list({
				limit: ps.limit,
				sinceId: ps.sinceId,
				untilId: ps.untilId,
				targetType: ps.targetType,
			});
			const users = [...rows.map(r => r.user), ...rows.map(r => r.createdBy)].filter(u => u != null);
			const packed = await this.userEntityService.packMany(users, me, { schema: 'UserLite' });
			const packedById = new Map(packed.map(u => [u.id, u]));

			return rows.map(row => ({
				id: row.id,
				createdAt: this.idService.parse(row.id).date.toISOString(),
				targetType: row.targetType,
				userId: row.userId,
				user: row.userId != null ? packedById.get(row.userId) ?? null : null,
				host: row.host,
				reason: row.reason,
				createdBy: row.createdById != null ? packedById.get(row.createdById) ?? null : null,
				sourceQueueId: row.sourceQueueId,
				moderationNote: row.moderationNote,
			}));
		});
	}
}
