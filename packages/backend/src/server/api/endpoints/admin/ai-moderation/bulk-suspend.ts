/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { MiMeta, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { UserSuspendService } from '@/core/UserSuspendService.js';
import { decideAiModerationBulkCount, decideAiModerationBulkSuspendSkip } from '@/misc/ai-moderation.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	requireAdmin: true,
	secure: true,
	kind: 'write:admin:ai-moderation',

	errors: {
		countMismatch: {
			message: 'The number of supplied users differs from the expected count. Refetch and retry.',
			code: 'AI_MODERATION_COUNT_MISMATCH',
			id: '18f48a99-1ed2-46ca-ba49-7cffe0370f83',
			kind: 'client',
		},
		tooManyItems: {
			message: 'Too many users to suspend at once.',
			code: 'AI_MODERATION_TOO_MANY_ITEMS',
			id: '09f374ee-b22f-406c-86c1-6e613e9fb35b',
			kind: 'client',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			suspended: {
				type: 'array', optional: false, nullable: false,
				items: { type: 'string', optional: false, nullable: false },
			},
			skipped: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						userId: { type: 'string', optional: false, nullable: false },
						reason: { type: 'string', optional: false, nullable: false, enum: ['admin', 'moderator', 'localOld', 'alreadySuspended', 'missing'] },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userIds: {
			type: 'array',
			uniqueItems: true,
			minItems: 1,
			maxItems: 200,
			items: { type: 'string', format: 'misskey:id' },
		},
		expectedCount: { type: 'integer', minimum: 1 },
	},
	required: ['userIds', 'expectedCount'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private roleService: RoleService,
		private userSuspendService: UserSuspendService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const userIds = [...new Set(ps.userIds)];

			const decision = decideAiModerationBulkCount(userIds.length, ps.expectedCount, 200);
			if (!decision.ok) {
				throw new ApiError(meta.errors[decision.reason === 'tooMany' ? 'tooManyItems' : decision.reason]);
			}

			const users = await this.usersRepository.findBy({ id: In(userIds) });
			const userById = new Map(users.map(user => [user.id, user]));

			const newAuthorMs = this.serverSettings.aiModerationNewAuthorDays * 24 * 60 * 60 * 1000;

			const suspended: string[] = [];
			const skipped: Array<{ userId: string; reason: 'admin' | 'moderator' | 'localOld' | 'alreadySuspended' | 'missing' }> = [];

			for (const userId of userIds) {
				const user = userById.get(userId);
				if (user == null) {
					skipped.push({ userId, reason: 'missing' });
					continue;
				}

				const isAdministrator = await this.roleService.isAdministrator(user);
				const isModerator = isAdministrator || await this.roleService.isModerator(user);
				const isLocal = user.host == null;
				const isOlderThanNewAuthorDays = Date.now() - this.idService.parse(user.id).date.getTime() > newAuthorMs;

				const reason = decideAiModerationBulkSuspendSkip({
					isAdministrator,
					isModerator,
					isLocal,
					isOlderThanNewAuthorDays,
					isAlreadySuspended: user.isSuspended,
				});

				if (reason != null) {
					skipped.push({ userId, reason });
					continue;
				}

				await this.userSuspendService.suspend(user, me);
				suspended.push(userId);
			}

			return { suspended, skipped };
		});
	}
}
