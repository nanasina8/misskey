/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { HanamiGpuQueueService } from '@/core/hanami/HanamiGpuQueueService.js';
import { HanamiGpuDispatcherService } from '@/core/hanami/HanamiGpuDispatcherService.js';
import { AiModerationService } from '@/core/AiModerationService.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';
import { findHanamiLlmWaiters, HANAMI_LLM_WANTED_PREFIX, HANAMI_LOCAL_LLM_LOCK_KEY } from '@/core/hanami/HanamiLocalLlmLock.js';
import { HANAMI_GPU_LEGACY_JOB_PRIORITY, HANAMI_GPU_QUEUE_KINDS, HANAMI_GPU_QUEUE_POLICIES, type HanamiGpuQueueKind } from '@/misc/hanami-gpu-queue.js';
import { checkHanamiGpuQueue, simulateHanamiGpuQueueOrder } from '@/misc/hanami-gpu-queue-checks.js';

const num = { type: 'number', optional: false, nullable: false } as const;
const numOrNull = { type: 'number', optional: false, nullable: true } as const;
const str = { type: 'string', optional: false, nullable: false } as const;
const strOrNull = { type: 'string', optional: false, nullable: true } as const;
const kindEnum = { type: 'string', optional: false, nullable: false, enum: HANAMI_GPU_QUEUE_KINDS } as const;

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	secure: true,
	kind: 'read:admin:queue',

	description: 'はなみ GPU 判定キューの様子（判定係・GPU の取り合い・種類ごとの待ち・次にやる順・最近の判定と出来事）と、いつも成り立っているはずのことの見張り（checks）を返す。不具合を見つけるための調べもの用。',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			now: num,
			checks: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						id: str,
						level: { type: 'string', optional: false, nullable: false, enum: ['ok', 'info', 'warn', 'error'] },
						title: str,
						detail: strOrNull,
					},
				},
			},
			dispatcher: {
				type: 'object', optional: false, nullable: true,
				properties: {
					state: str,
					since: num,
					updatedAt: num,
					pid: num,
					workerPid: numOrNull,
					processed: num,
					workerUptimeSec: numOrNull,
					vramGiB: numOrNull,
					lastError: strOrNull,
					inflight: {
						type: 'object', optional: false, nullable: true,
						properties: { kind: str, count: num, startedAt: num },
					},
				},
			},
			leaderPid: strOrNull,
			lock: {
				type: 'object', optional: false, nullable: false,
				properties: { holder: strOrNull, acquiredAt: numOrNull, ttlSec: numOrNull },
			},
			waiters: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: { kind: str, priority: num, since: numOrNull },
				},
			},
			kinds: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						kind: kindEnum,
						base: num,
						maxBatch: num,
						deadlineSec: numOrNull,
						length: num,
						inflight: num,
						oldestWaitSec: numOrNull,
						dropped: num,
						failed: num,
						listOnly: num,
						bodyOnly: num,
						batchesLastHour: num,
						itemsLastHour: num,
						secPerItem: numOrNull,
					},
				},
			},
			next: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						kind: kindEnum,
						itemId: str,
						waitSec: num,
						base: num,
						aging: num,
						deadline: num,
						total: num,
						deadlineInSec: numOrNull,
						attempts: num,
						round: num,
					},
				},
			},
			scan: {
				type: 'object', optional: false, nullable: false,
				properties: { running: { type: 'boolean', optional: false, nullable: false }, exhausted: { type: 'boolean', optional: false, nullable: false }, scanId: strOrNull },
			},
			runtimeAvailable: { type: 'boolean', optional: false, nullable: true },
			batches: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: { at: num, kind: str, size: num, ok: num, errors: num, durationMs: num, maxWaitMs: num, maxAttempts: num },
				},
			},
			events: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: { at: num, type: str, kind: strOrNull, count: numOrNull, durationMs: numOrNull, detail: strOrNull },
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		events: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
		batches: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
		next: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
	},
	required: [],
} as const;

const HOUR = 60 * 60 * 1000;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		private hanamiGpuQueueService: HanamiGpuQueueService,
		private hanamiGpuDispatcherService: HanamiGpuDispatcherService,
		private aiModerationService: AiModerationService,
		private aiModerationScanService: AiModerationScanService,
	) {
		super(meta, paramDef, async (ps) => {
			const now = Date.now();
			const [status, leaderRaw, lockRaw, lockTtl, waiterKinds, stats, events, batches, runtime, scan] = await Promise.all([
				this.hanamiGpuDispatcherService.getStatus(),
				this.redis.get('hanami:gpuq:v1:leader'),
				this.redis.get(HANAMI_LOCAL_LLM_LOCK_KEY),
				this.redis.ttl(HANAMI_LOCAL_LLM_LOCK_KEY),
				findHanamiLlmWaiters(this.redis, 'gpuWorker'),
				this.hanamiGpuQueueService.stats(),
				this.hanamiGpuQueueService.recentEvents(ps.events),
				this.hanamiGpuQueueService.recentBatches(ps.batches),
				this.aiModerationService.loadRuntime(),
				this.aiModerationScanService.queueInfo(),
			]);

			const waiterSince = waiterKinds.length === 0 ? [] : await this.redis.mget(...waiterKinds.map(kind => `${HANAMI_LLM_WANTED_PREFIX}${kind}`));
			const lockParts = lockRaw?.split(':') ?? null;

			const kinds = [];
			const lists = {} as Record<HanamiGpuQueueKind, Awaited<ReturnType<HanamiGpuQueueService['peek']>>>;
			const kindInputs = {} as Parameters<typeof checkHanamiGpuQueue>[0]['kinds'];
			for (const kind of HANAMI_GPU_QUEUE_KINDS) {
				const [peek, consistency] = await Promise.all([
					this.hanamiGpuQueueService.peek(kind, Math.max(ps.next, HANAMI_GPU_QUEUE_POLICIES[kind].maxBatch)),
					this.hanamiGpuQueueService.consistency(kind),
				]);
				lists[kind] = peek;
				const hourBatches = batches.filter(b => b.kind === kind && now - b.at <= HOUR);
				const items = hourBatches.reduce((sum, b) => sum + b.size, 0);
				const ms = hourBatches.reduce((sum, b) => sum + b.durationMs, 0);
				const policy = HANAMI_GPU_QUEUE_POLICIES[kind];
				kindInputs[kind] = { length: stats[kind].length, inflight: consistency.inflight, oldestWaitSec: stats[kind].oldestWaitSec, listOnly: consistency.listOnly, bodyOnly: consistency.bodyOnly };
				kinds.push({
					kind,
					base: policy.base,
					maxBatch: policy.maxBatch,
					deadlineSec: policy.deadlineMs != null ? policy.deadlineMs / 1000 : null,
					length: stats[kind].length,
					inflight: consistency.inflight,
					oldestWaitSec: stats[kind].oldestWaitSec,
					dropped: stats[kind].dropped,
					failed: stats[kind].failed,
					listOnly: consistency.listOnly,
					bodyOnly: consistency.bodyOnly,
					batchesLastHour: hourBatches.length,
					itemsLastHour: items,
					secPerItem: items > 0 ? ms / items / 1000 : null,
				});
			}

			const order = simulateHanamiGpuQueueOrder(lists, now, ps.next);

			const checks = checkHanamiGpuQueue({
				now,
				status: status != null ? {
					state: status.state,
					since: status.since,
					updatedAt: status.updatedAt ?? 0,
					workerPid: status.workerPid ?? null,
					inflight: status.inflight ?? null,
				} : null,
				leaderPid: leaderRaw?.split(':')[0] ?? null,
				lockHolder: lockParts?.[0] ?? null,
				waiters: waiterKinds,
				kinds: kindInputs,
				nextBestPriority: order[0]?.priority.total ?? null,
				runtimeAvailable: runtime?.available ?? null,
				scan,
				events,
				batches,
			});

			return {
				now,
				checks,
				dispatcher: status != null ? {
					state: status.state,
					since: status.since,
					updatedAt: status.updatedAt ?? 0,
					pid: status.pid,
					workerPid: status.workerPid ?? null,
					processed: status.processed,
					workerUptimeSec: status.workerUptimeSec,
					vramGiB: status.vramGiB,
					lastError: status.lastError,
					inflight: status.inflight ?? null,
				} : null,
				leaderPid: leaderRaw?.split(':')[0] ?? null,
				lock: {
					holder: lockParts?.[0] ?? null,
					acquiredAt: lockParts != null && Number.isFinite(Number(lockParts[1])) ? Number(lockParts[1]) : null,
					ttlSec: lockTtl >= 0 ? lockTtl : null,
				},
				waiters: waiterKinds.map((kind, i) => ({
					kind,
					priority: HANAMI_GPU_LEGACY_JOB_PRIORITY[kind] ?? 0,
					since: waiterSince[i] != null && Number.isFinite(Number(waiterSince[i])) ? Number(waiterSince[i]) : null,
				})),
				kinds,
				next: order.map(item => ({
					kind: item.kind,
					itemId: item.itemId,
					waitSec: item.waitSec,
					base: item.priority.base,
					aging: item.priority.aging,
					deadline: item.priority.deadline,
					total: item.priority.total,
					deadlineInSec: item.deadlineInSec,
					attempts: item.attempts,
					round: item.round,
				})),
				scan,
				runtimeAvailable: runtime?.available ?? null,
				batches,
				events: events.map(e => ({ at: e.at, type: e.type, kind: e.kind ?? null, count: e.count ?? null, durationMs: e.durationMs ?? null, detail: e.detail ?? null })),
			};
		});
	}
}
