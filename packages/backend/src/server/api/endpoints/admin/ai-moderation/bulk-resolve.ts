/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { decideAiModerationBulkCount, type AiModerationGroupBy } from '@/misc/ai-moderation.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'write:admin:ai-moderation',

	errors: {
		countMismatch: {
			message: 'The number of matching items differs from the expected count. Refetch and retry.',
			code: 'AI_MODERATION_COUNT_MISMATCH',
			id: '345af22f-4e8e-4a3d-887a-25a9cd979fae',
			kind: 'client',
		},
		tooManyItems: {
			message: 'Too many matching items to resolve at once.',
			code: 'AI_MODERATION_TOO_MANY_ITEMS',
			id: 'f79f00be-6bbf-4665-b6ea-cf0939611621',
			kind: 'client',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		groupBy: { type: 'string', enum: ['host', 'link', 'fingerprint'] },
		key: { type: 'string', nullable: true },
		windowHours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
		expectedCount: { type: 'integer', minimum: 1 },
		moderationNote: { type: 'string', nullable: true },
	},
	required: ['groupBy', 'key', 'expectedCount'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		private moderationLogService: ModerationLogService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const groupBy: AiModerationGroupBy = ps.groupBy;
			const windowStart = new Date(Date.now() - ps.windowHours * 60 * 60 * 1000);

			const buildQuery = () => {
				const query = this.aiModerationQueueRepository.createQueryBuilder('queue')
					.where('queue.judgedAt >= :since', { since: windowStart })
					.andWhere('queue.resolved = FALSE');

				switch (groupBy) {
					case 'host':
						if (ps.key == null) {
							query.andWhere('queue.noteUserHost IS NULL');
						} else {
							query.andWhere('queue.noteUserHost = :key', { key: ps.key });
						}
						break;
					case 'link':
						query.andWhere(':key = ANY(queue.links)', { key: ps.key });
						break;
					case 'fingerprint':
						query.andWhere('queue.textFingerprint = :key', { key: ps.key });
						break;
				}

				return query;
			};

			const count = await buildQuery().getCount();
			const decision = decideAiModerationBulkCount(count, ps.expectedCount, 1000);
			if (!decision.ok) {
				throw new ApiError(meta.errors[decision.reason === 'tooMany' ? 'tooManyItems' : decision.reason]);
			}

			const ids = (await buildQuery().select('queue.id', 'id').getRawMany<{ id: string }>()).map(row => row.id);

			await this.aiModerationQueueRepository.createQueryBuilder()
				.update()
				.set({
					resolved: true,
					assigneeId: me.id,
					...(ps.moderationNote != null ? { moderationNote: ps.moderationNote } : {}),
				})
				.where('id IN (:...ids)', { ids })
				.execute();

			await this.moderationLogService.log(me, 'resolveAiModerationBulk', {
				groupBy,
				key: ps.key,
				count,
				moderationNote: ps.moderationNote ?? null,
			});
		});
	}
}
