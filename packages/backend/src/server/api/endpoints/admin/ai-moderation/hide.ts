/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { UsersRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { RoleService } from '@/core/RoleService.js';
import { UtilityService } from '@/core/UtilityService.js';
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
			created: { type: 'boolean', optional: false, nullable: false },
		},
	},

	errors: {
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: 'f8cfb83f-af3a-47e6-9979-c2dcec0b2183',
		},
		cannotHideModerator: {
			message: 'Cannot hide a moderator or an administrator.',
			code: 'CANNOT_HIDE_MODERATOR',
			id: '1f461b50-6a59-4215-a76f-2664b1eaa87b',
		},
		invalidTarget: {
			message: 'Specify userId for targetType=user, or a remote host for targetType=host.',
			code: 'INVALID_TARGET',
			id: '67c2f774-331a-424e-8e7a-39d3e357fac3',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		targetType: { type: 'string', enum: ['user', 'host'] },
		userId: { type: 'string', format: 'misskey:id' },
		host: { type: 'string', minLength: 1, maxLength: 128 },
		sourceQueueId: { type: 'string', format: 'misskey:id' },
		moderationNote: { type: 'string', maxLength: 8192 },
	},
	required: ['targetType'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private roleService: RoleService,
		private utilityService: UtilityService,
		private aiModerationHiddenService: AiModerationHiddenService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const opts = { moderator: me, sourceQueueId: ps.sourceQueueId ?? null, moderationNote: ps.moderationNote ?? '' };

			if (ps.targetType === 'user') {
				if (ps.userId == null) throw new ApiError(meta.errors.invalidTarget);
				const user = await this.usersRepository.findOneBy({ id: ps.userId });
				if (user == null) throw new ApiError(meta.errors.noSuchUser);
				if (await this.roleService.isModerator(user)) throw new ApiError(meta.errors.cannotHideModerator);
				return { created: await this.aiModerationHiddenService.hide({ targetType: 'user', userId: user.id }, opts) };
			}

			// このサーバー自身は隠せない（ポート付き・無しのどちらでも）
			const host = ps.host?.toLowerCase();
			if (host == null || this.utilityService.isSelfHost(host) || host === this.config.hostname.toLowerCase()) throw new ApiError(meta.errors.invalidTarget);
			return { created: await this.aiModerationHiddenService.hide({ targetType: 'host', host }, opts) };
		});
	}
}
