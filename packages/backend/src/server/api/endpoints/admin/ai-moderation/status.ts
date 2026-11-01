/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository, MiMeta } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { HANAMI_LOCAL_LLM_LOCK_KEY } from '@/core/hanami/HanamiLocalLlmLock.js';
import { HanamiGpuQueueService } from '@/core/hanami/HanamiGpuQueueService.js';
import { HanamiGpuDispatcherService } from '@/core/hanami/HanamiGpuDispatcherService.js';
import { AI_MODERATION_LAST_TICK_KEY, AI_MODERATION_PENDING_KEY, AiModerationService, aiModerationJstDayKey } from '@/core/AiModerationService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
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
			gpuQueue: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					state: { type: 'string', optional: false, nullable: false, enum: ['idle', 'unloaded', 'running', 'loading', 'yielded', 'waitingGpu', 'noGpu', 'failed', 'stopped', 'unknown'] },
					lengths: {
						type: 'object',
						optional: false, nullable: false,
						properties: {
							judgeTrial: { type: 'number', optional: false, nullable: false },
							spamJudge: { type: 'number', optional: false, nullable: false },
							spamScan: { type: 'number', optional: false, nullable: false },
						},
					},
					oldestWaitSec: { type: 'number', optional: false, nullable: true },
					processed: { type: 'number', optional: false, nullable: false },
					vramGiB: { type: 'number', optional: false, nullable: true },
					lastBatch: {
						type: 'object',
						optional: false, nullable: true,
						properties: {
							kind: { type: 'string', optional: false, nullable: false },
							size: { type: 'number', optional: false, nullable: false },
							durationMs: { type: 'number', optional: false, nullable: false },
							at: { type: 'number', optional: false, nullable: false },
						},
					},
					lastError: { type: 'string', optional: false, nullable: true },
					dropped: { type: 'number', optional: false, nullable: false },
					failed: { type: 'number', optional: false, nullable: false },
				},
			},
			lastTickAt: {
				type: 'string',
				format: 'date-time',
				optional: false, nullable: true,
			},
			gpuHolder: {
				type: 'string',
				optional: false, nullable: true,
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

		private aiModerationService: AiModerationService,
		private hanamiGpuQueueService: HanamiGpuQueueService,
		private hanamiGpuDispatcherService: HanamiGpuDispatcherService,
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

			const [runtime, lastTickAt, lockToken, gpuStatus, queueStats] = await Promise.all([
				this.aiModerationService.loadRuntime(),
				this.redis.get(AI_MODERATION_LAST_TICK_KEY),
				this.redis.get(HANAMI_LOCAL_LLM_LOCK_KEY),
				this.hanamiGpuDispatcherService.getStatus(),
				this.hanamiGpuQueueService.stats(),
			]);
			const waits = Object.values(queueStats).map(q => q.oldestWaitSec).filter((v): v is number => v != null);
			const gpuQueue = {
				state: gpuStatus?.state ?? 'unknown' as const,
				lengths: {
					judgeTrial: queueStats.judgeTrial.length,
					spamJudge: queueStats.spamJudge.length,
					spamScan: queueStats.spamScan.length,
				},
				oldestWaitSec: waits.length > 0 ? Math.max(...waits) : null,
				processed: gpuStatus?.processed ?? 0,
				vramGiB: gpuStatus?.vramGiB ?? null,
				lastBatch: gpuStatus?.lastBatch ?? null,
				lastError: gpuStatus?.lastError ?? null,
				dropped: Object.values(queueStats).reduce((sum, q) => sum + q.dropped, 0),
				failed: Object.values(queueStats).reduce((sum, q) => sum + q.failed, 0),
			};

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
				gpuQueue,
				lastTickAt,
				gpuHolder: lockToken?.split(':')[0] ?? null,
			};
		});
	}
}
