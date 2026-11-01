/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationCriteriaRepository, AiModerationScanItemRepository, AiModerationScanRepository, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';
import { packedAiModerationScanItemSchema, packedAiModerationScanSchema } from '@/models/json-schema/ai-moderation-scan.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	description: '全体スキャンの結果を、判定条件（使った版すべての中身）と一緒に書き出す。項目は古い順に最大 5000 件ずつ（sinceId で続き）。',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			scan: packedAiModerationScanSchema,
			criteria: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						version: { type: 'string', optional: false, nullable: false },
						firstUsedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
						criteria: { type: 'object', optional: false, nullable: false },
					},
				},
			},
			items: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					...packedAiModerationScanItemSchema,
					properties: {
						...packedAiModerationScanItemSchema.properties,
						username: { type: 'string', optional: false, nullable: true },
					},
				},
			},
			next: { type: 'string', optional: false, nullable: true },
		},
	},

	errors: {
		noSuchScan: {
			message: 'No such scan.',
			code: 'NO_SUCH_SCAN',
			id: 'c9670bc3-616e-4177-832e-bf61fbebd2b9',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		scanId: { type: 'string', format: 'misskey:id' },
		onlyFlagged: { type: 'boolean', default: false },
		limit: { type: 'integer', minimum: 1, maximum: 5000, default: 5000 },
		sinceId: { type: 'string', format: 'misskey:id' },
	},
	required: ['scanId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationScanRepository)
		private aiModerationScanRepository: AiModerationScanRepository,

		@Inject(DI.aiModerationScanItemRepository)
		private aiModerationScanItemRepository: AiModerationScanItemRepository,

		@Inject(DI.aiModerationCriteriaRepository)
		private aiModerationCriteriaRepository: AiModerationCriteriaRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private aiModerationScanService: AiModerationScanService,
	) {
		super(meta, paramDef, async (ps) => {
			const scan = await this.aiModerationScanRepository.findOneBy({ id: ps.scanId });
			if (scan == null) throw new ApiError(meta.errors.noSuchScan);

			const query = this.aiModerationScanItemRepository.createQueryBuilder('item')
				.where('item.scanId = :scanId', { scanId: scan.id })
				.orderBy('item.id', 'ASC')
				.limit(ps.limit);
			if (ps.onlyFlagged) query.andWhere('item.flagged = true');
			if (ps.sinceId != null) query.andWhere('item.id > :sinceId', { sinceId: ps.sinceId });
			const items = await query.getMany();

			// スキャンの版と、項目が実際に使った版の中身をすべて付ける
			const versions = [...new Set([scan.criteriaVersion, ...items.map(i => i.criteriaVersion).filter((v): v is string => v != null)])];
			const criteria = await this.aiModerationCriteriaRepository.findBy({ id: In(versions) });

			const users = items.length === 0 ? [] : await this.usersRepository.find({
				where: { id: In([...new Set(items.map(i => i.noteUserId))]) },
				select: { id: true, username: true },
			});
			const usernames = new Map(users.map(u => [u.id, u.username]));

			return {
				scan: await this.aiModerationScanService.packScan(scan),
				criteria: criteria.map(c => ({ version: c.id, firstUsedAt: c.firstUsedAt.toISOString(), criteria: c.criteria })),
				items: (await this.aiModerationScanService.packItems(items)).map(item => ({ ...item, username: usernames.get(item.noteUserId) ?? null })),
				next: items.length === ps.limit ? items[items.length - 1].id : null,
			};
		});
	}
}
