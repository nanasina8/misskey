/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'write:admin:ai-moderation',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			removed: { type: 'boolean', optional: false, nullable: false },
		},
	},

	errors: {
		invalidTarget: {
			message: 'Specify userId for targetType=user, or host for targetType=host.',
			code: 'INVALID_TARGET',
			id: '1b9e531d-c232-4899-a1e5-45fb0b6fa7cf',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		targetType: { type: 'string', enum: ['user', 'host'] },
		userId: { type: 'string', format: 'misskey:id' },
		host: { type: 'string', minLength: 1, maxLength: 128 },
	},
	required: ['targetType'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private aiModerationHiddenService: AiModerationHiddenService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (ps.targetType === 'user') {
				if (ps.userId == null) throw new ApiError(meta.errors.invalidTarget);
				return { removed: await this.aiModerationHiddenService.unhide({ targetType: 'user', userId: ps.userId }, me) };
			}
			if (ps.host == null) throw new ApiError(meta.errors.invalidTarget);
			return { removed: await this.aiModerationHiddenService.unhide({ targetType: 'host', host: ps.host.toLowerCase() }, me) };
		});
	}
}
