/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository, MiMeta } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { peekHanamiNoteJudgeRuntime } from '@/core/hanami/HanamiPythonRuntime.js';
import { AI_MODERATION_PENDING_KEY, aiModerationJstDayKey } from '@/core/AiModerationService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			pending: {
				type: 'number',
				optional: false, nullable: false,
			},
			enqueuedToday: {
				type: 'number',
				optional: false, nullable: false,
			},
			droppedToday: {
				type: 'number',
				optional: false, nullable: false,
			},
			judgedLast24h: {
				type: 'number',
				optional: false, nullable: false,
			},
			flaggedLast24h: {
				type: 'number',
				optional: false, nullable: false,
			},
			autoHiddenLast24h: {
				type: 'number',
				optional: false, nullable: false,
			},
			wouldHideLast24h: {
				type: 'number',
				optional: false, nullable: false,
			},
			autoHideMode: {
				type: 'string',
				optional: false, nullable: false,
				enum: ['off', 'trial', 'on'],
			},
			lastJudgedAt: {
				type: 'string',
				format: 'date-time',
				optional: false, nullable: true,
			},
			runtime: {
				type: 'object',
				optional: false, nullable: true,
				properties: {
					available: {
						type: 'boolean',
						optional: false, nullable: false,
					},
					device: {
						type: 'string',
						optional: false, nullable: true,
					},
					deviceName: {
						type: 'string',
						optional: false, nullable: true,
					},
					reason: {
						type: 'string',
						optional: false, nullable: true,
					},
					probedAt: {
						type: 'string',
						format: 'date-time',
						optional: false, nullable: false,
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		@Inject(DI.meta)
		private serverSettings: MiMeta,
	) {
		super(meta, paramDef, async () => {
			const day = aiModerationJstDayKey();

			const [pending, enqueuedToday, droppedToday, lastJudgedRow, stats24h] = await Promise.all([
				this.redis.zcard(AI_MODERATION_PENDING_KEY),
				this.redis.get(`aiModeration:daily:${day}`),
				this.redis.get(`aiModeration:dropped:${day}`),
				this.aiModerationQueueRepository.createQueryBuilder('queue')
					.select('MAX(queue.judgedAt)', 'lastJudgedAt')
					.getRawOne<{ lastJudgedAt: Date | null }>(),
				this.aiModerationQueueRepository.createQueryBuilder('queue')
					.select('COUNT(*)', 'judged')
					.addSelect('COUNT(*) FILTER (WHERE queue.flagged = TRUE)', 'flagged')
					.addSelect('COUNT(*) FILTER (WHERE queue.autoAction IN (\'hidden\', \'hiddenHost\'))', 'autoHidden')
					.addSelect('COUNT(*) FILTER (WHERE queue.autoAction IN (\'wouldHide\', \'wouldHideHost\'))', 'wouldHide')
					.where('queue.judgedAt >= :since', { since: new Date(Date.now() - 24 * 60 * 60 * 1000) })
					.getRawOne<{ judged: string; flagged: string; autoHidden: string; wouldHide: string }>(),
			]);

			const runtime = peekHanamiNoteJudgeRuntime();

			return {
				pending,
				enqueuedToday: enqueuedToday != null ? Number(enqueuedToday) : 0,
				droppedToday: droppedToday != null ? Number(droppedToday) : 0,
				judgedLast24h: stats24h != null ? Number(stats24h.judged) : 0,
				flaggedLast24h: stats24h != null ? Number(stats24h.flagged) : 0,
				autoHiddenLast24h: stats24h != null ? Number(stats24h.autoHidden) : 0,
				wouldHideLast24h: stats24h != null ? Number(stats24h.wouldHide) : 0,
				autoHideMode: this.serverSettings.aiModerationAutoHideMode,
				lastJudgedAt: lastJudgedRow?.lastJudgedAt != null ? new Date(lastJudgedRow.lastJudgedAt).toISOString() : null,
				runtime,
			};
		});
	}
}
