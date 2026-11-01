/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationScanItemRepository, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { packedAiModerationScanItemSchema } from '@/models/json-schema/ai-moderation-scan.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	description: '全体スキャンで判定した投稿を新しい順に返す（既定は引っかけたものだけ）。',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			...packedAiModerationScanItemSchema,
			properties: {
				...packedAiModerationScanItemSchema.properties,
				user: { type: 'object', optional: false, nullable: true, ref: 'UserLite' },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		scanId: { type: 'string', format: 'misskey:id' },
		flagged: { type: 'boolean', nullable: true, default: true },
		wouldHide: { type: 'boolean' },
		label: { type: 'string', enum: ['normal', 'spam', 'scam', 'abuse'] },
		host: { type: 'string', nullable: true },
		signal: { type: 'string', maxLength: 32 },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
	},
	required: ['scanId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationScanItemRepository)
		private aiModerationScanItemRepository: AiModerationScanItemRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private aiModerationScanService: AiModerationScanService,
		private userEntityService: UserEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = this.aiModerationScanItemRepository.createQueryBuilder('item')
				.where('item.scanId = :scanId', { scanId: ps.scanId })
				.orderBy('item.id', 'DESC')
				.limit(ps.limit);
			if (ps.flagged != null) query.andWhere('item.flagged = :flagged', { flagged: ps.flagged });
			if (ps.wouldHide != null) query.andWhere('item.wouldHide = :wouldHide', { wouldHide: ps.wouldHide });
			if (ps.label != null) query.andWhere('item.localLabel = :label', { label: ps.label });
			if (ps.host === null) query.andWhere('item.noteUserHost IS NULL');
			else if (ps.host != null) query.andWhere('item.noteUserHost = :host', { host: ps.host });
			if (ps.signal != null) query.andWhere(':signal = ANY(item.spamSignals)', { signal: ps.signal });
			if (ps.sinceId != null) query.andWhere('item.id > :sinceId', { sinceId: ps.sinceId });
			if (ps.untilId != null) query.andWhere('item.id < :untilId', { untilId: ps.untilId });
			const items = await query.getMany();

			const users = await this.usersRepository.findBy({ id: In([...new Set(items.map(i => i.noteUserId))]) });
			const packedUsers = new Map((await this.userEntityService.packMany(users, me)).map(u => [u.id, u]));
			const packed = await this.aiModerationScanService.packItems(items);
			return packed.map(item => ({ ...item, user: packedUsers.get(item.noteUserId) ?? null }));
		});
	}
}
