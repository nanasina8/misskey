/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'write:admin:ai-moderation',

	errors: {
		noSuchQueue: {
			message: 'No such AI moderation queue item.',
			code: 'NO_SUCH_AI_MODERATION_QUEUE',
			id: '9b7b8a1f-2e0b-4c3a-8f0e-1b2c3d4e5f60',
			kind: 'server',
			httpStatusCode: 404,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		queueId: { type: 'string', format: 'misskey:id' },
		moderationNote: { type: 'string' },
	},
	required: ['queueId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,
	) {
		super(meta, paramDef, async (ps, me) => {
			const queue = await this.aiModerationQueueRepository.findOneBy({ id: ps.queueId });
			if (queue == null) {
				throw new ApiError(meta.errors.noSuchQueue);
			}

			await this.aiModerationQueueRepository.update(queue.id, {
				resolved: true,
				assigneeId: me.id,
				moderationNote: ps.moderationNote ?? queue.moderationNote,
			});
		});
	}
}
