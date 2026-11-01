/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { AiModerationOutcomeService } from '@/core/AiModerationOutcomeService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:ai-moderation',

	description: '判定で引っかけたアカウントを、いまの状態（凍結・相手のサーバーで消えた・隠している・隠すのをやめた・何もしていない）付きで新しい順に返す。',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				userId: { type: 'string', format: 'misskey:id', optional: false, nullable: false },
				user: { type: 'object', optional: false, nullable: true, ref: 'UserLite' },
				host: { type: 'string', optional: false, nullable: true },
				state: { type: 'string', optional: false, nullable: false, enum: ['suspended', 'deleted', 'hidden', 'unhidden', 'open'] },
				auto: { type: 'string', optional: false, nullable: false, enum: ['none', 'wouldHide', 'hidden'] },
				isSuspended: { type: 'boolean', optional: false, nullable: false },
				isDeleted: { type: 'boolean', optional: false, nullable: false },
				isHidden: { type: 'boolean', optional: false, nullable: false },
				wasUnhidden: { type: 'boolean', optional: false, nullable: false },
				signals: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
				flaggedCount: { type: 'number', optional: false, nullable: false },
				firstAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
				lastAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
				maxSpamScore: { type: 'number', optional: false, nullable: true },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		days: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
		state: { type: 'string', enum: ['suspended', 'deleted', 'hidden', 'unhidden', 'open'] },
		auto: { type: 'string', enum: ['none', 'wouldHide', 'hidden'] },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		offset: { type: 'integer', minimum: 0, default: 0 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private aiModerationOutcomeService: AiModerationOutcomeService,
		private userEntityService: UserEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const since = new Date(Date.now() - ps.days * 24 * 60 * 60 * 1000);
			const accounts = (await this.aiModerationOutcomeService.loadAccounts(since))
				.filter(a => ps.state == null || a.state === ps.state)
				.filter(a => ps.auto == null || a.auto === ps.auto)
				.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
				.slice(ps.offset, ps.offset + ps.limit);

			const users = await this.usersRepository.findBy({ id: In(accounts.filter(a => a.userExists).map(a => a.userId)) });
			const packed = new Map((await this.userEntityService.packMany(users, me)).map(u => [u.id, u]));

			return accounts.map(a => ({
				userId: a.userId,
				user: packed.get(a.userId) ?? null,
				host: a.host,
				state: a.state,
				auto: a.auto,
				isSuspended: a.isSuspended,
				isDeleted: a.isDeleted,
				isHidden: a.isHidden,
				wasUnhidden: a.wasUnhidden,
				signals: [...a.signals],
				flaggedCount: a.flaggedCount,
				firstAt: a.firstAt.toISOString(),
				lastAt: a.lastAt.toISOString(),
				maxSpamScore: a.maxSpamScore,
			}));
		});
	}
}
