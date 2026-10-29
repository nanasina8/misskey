/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueueService } from '@/core/QueueService.js';
import { HANAMI_EVENT_JOBS, HANAMI_GPU_JOBS, HANAMI_LLM_EVENTS, HANAMI_LLM_EVENTS_KEY, HANAMI_LLM_EVENTS_MAX, HANAMI_LOCAL_LLM_LOCK_KEY, type HanamiLlmEvent } from '@/core/hanami/HanamiLocalLlmLock.js';
import { getHanamiJudgeStatus } from './judge-status.js';

const RUN_KINDS = ['note-judge', 'als', 'embedding'] as const;
const WARNINGS = ['gpuUnavailable', 'lockLong', 'topicJudgeStale', 'queueBacklog', 'recentFailures', 'stuckPending'] as const;
const count = (description: string) => ({ type: 'integer', optional: false, nullable: false, description } as const);
const text = (description: string) => ({ type: 'string', optional: false, nullable: false, description } as const);
const date = (description: string) => ({ ...text(description), format: 'date-time' } as const);
const flag = (description: string) => ({ type: 'boolean', optional: false, nullable: false, description } as const);
const runSchema = {
	type: 'object', optional: false, nullable: true, description: 'Model run from hanami_foryou_model_run; null when no matching run exists.',
	properties: {
		status: text('Persisted model run status: pending, ready or failed.'),
		startedAt: date('Run start time in UTC from startedAt.'),
		finishedAt: { ...date('Run completion time in UTC from finishedAt; null while pending.'), nullable: true },
		processedCount: { ...count('Number of items processed, from params.processedCount; null when unrecorded.'), nullable: true },
		failure: { ...text('Failure reason from params.failure; null when unrecorded.'), nullable: true },
		interrupted: flag('True when params.interrupted marks a pending run recovered after interruption.'),
		skippedReason: { ...text('Reason for skipping this run from params.skippedReason; null when unrecorded.'), nullable: true },
	},
} as const;

export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue',
	description: 'Inspect Hanami GPU jobs, bounded queue counts, model runs and recent diagnostic events without accessing logs or the database.',
	res: {
		type: 'object', optional: false, nullable: false, description: 'Current Hanami job diagnostics; all timestamps are UTC ISO 8601 strings.',
		properties: {
			gpu: { type: 'object', optional: false, nullable: false, description: 'Same cached Python runtime probe as admin/hanami/judge-status.runtime; CPU override can be available without CUDA.', properties: {
				available: flag('Whether the judge runtime is usable according to the Python probe.'),
				device: { ...text('Selected Python runtime device, such as cuda or cpu.'), nullable: true },
				deviceName: { ...text('GPU device name reported by the Python probe.'), nullable: true },
				reason: { ...text('Runtime probe explanation when the runtime is unavailable.'), nullable: true },
				probedAt: date('UTC time of the runtime probe.'),
			} },
			lock: { type: 'object', optional: false, nullable: false, description: 'Atomic Redis GET/PTTL snapshot of hanami:llm:exclusive:v1; legacy owners are retained as held with unknown metadata.', properties: {
				held: flag('Whether the shared Redis lock exists.'),
				kind: { ...text('Owner kind parsed from the token; null for missing, legacy or unreadable tokens.'), nullable: true },
				acquiredAt: { ...date('UTC acquisition time encoded in the owner token; null if unreadable.'), nullable: true },
				expiresInMs: { ...count('Remaining Redis lock TTL in milliseconds; null if absent or without expiry.'), nullable: true },
			} },
			topicJudgeWaiting: flag('Whether the Redis topic-judge-waiting marker asks note judges to yield.'),
			queue: { type: 'object', optional: false, nullable: false, description: 'hanamiGeneration jobs read from the same BullMQ getJobs source as admin/queue/jobs.', properties: {
				truncated: flag('True if any state contains more than 500 jobs; counts and oldest timestamps then cover the scanned subset.'),
				jobs: { type: 'array', optional: false, nullable: false, description: 'Job-name groups, including the five primary generation/judge names even when empty.', items: {
					type: 'object', optional: false, nullable: false, description: 'Per-name counts among at most 500 jobs per state.', properties: {
						name: text('BullMQ job name.'), active: count('Number of active jobs in the scan.'), wait: count('Number of waiting jobs in the scan.'),
						delayed: count('Number of delayed jobs in the scan.'), failed: count('Number of failed jobs in the scan.'),
						oldestWaitingAt: { ...date('Oldest creation timestamp among scanned wait and delayed jobs of this name; null if none.'), nullable: true },
					},
				} },
			} },
			runs: { type: 'array', optional: false, nullable: false, description: 'Persisted note-judge, als and embedding model runs. Taste tick has no model_run rows; its activity is recorded in events.', items: {
				type: 'object', optional: false, nullable: false, description: 'Summary of one persisted model run kind.', properties: {
					kind: { ...text('Persisted model_run kind; embedding is the existing taste/centroid embedding batch.'), enum: RUN_KINDS },
					latest: { ...runSchema, description: 'Latest run ordered by startedAt and id, including empty runs; null if none.' },
					latestWork: { ...runSchema, description: 'Latest run with numeric params.processedCount > 0, ordered by startedAt and id; null if none.' },
					last24h: { type: 'object', optional: false, nullable: false, description: 'Counts of currently retained runs in the last 24 hours using finishedAt, or startedAt if unfinished; runs pruned by existing retention are excluded. Interrupted is a subset of failed; empty is a subset of ready.', properties: {
						ready: count('Runs with status ready in the window.'), failed: count('Runs with status failed in the window.'),
						interrupted: count('Runs marked params.interrupted = true in the window.'), empty: count('Ready runs with numeric params.processedCount = 0 in the window.'),
					} },
				},
			} },
			noteJudge: { type: 'object', optional: false, nullable: false, description: 'Same inventory and throughput calculation as admin/hanami/judge-status.', properties: {
				backlog: { ...count('Unjudged distinct notes in the latest ready generation and fence; null if no ready inventory exists.'), nullable: true },
				secPerNote: { type: 'number', optional: false, nullable: true, description: 'Seconds per processed note from the latest run; null when unavailable.' },
			} },
			topicJudge: { type: 'object', optional: false, nullable: true, description: 'Last topic judgement from hanami:trend:topic-judge:last:v1 (seven-day TTL); null before any record.', properties: {
				at: date('UTC time the latest topic outcome was recorded.'),
				outcome: { ...text('Latest topic judge outcome.'), enum: ['ok', 'partial', 'noGpu', 'nothingToDo', 'waiting', 'gaveUp', 'rejected', 'failed'] },
				requested: { type: 'object', optional: false, nullable: false, description: 'Requested task counts after cache filtering, or input counts when waiting/rejected.', properties: {
					daily: count('Requested daily-topic verdicts.'), pairs: count('Requested same-topic pair verdicts.'), titles: count('Requested topic titles.'),
				} },
				saved: { type: 'object', optional: false, nullable: false, description: 'Results successfully saved in Redis.', properties: {
					daily: count('Saved daily-topic verdicts.'), same: count('Saved same-topic verdicts.'), titles: count('Saved titles.'),
				} },
				rejectedTitles: count('Returned titles rejected by validation.'),
				lastSuccessAt: { ...date('Last ok, partial or nothingToDo (everything already judged) time, retained across subsequent outcomes; null before the first success.'), nullable: true },
				waitedMs: { ...count('Elapsed queue waiting time in milliseconds when recorded.'), optional: true },
				error: { ...text('Recorded topic error, at most 300 characters.'), optional: true },
			} },
			recentFailures: { type: 'array', optional: false, nullable: false, description: 'At most ten failed model runs in the last 24 hours, newest completion first (startedAt fallback).', items: {
				type: 'object', optional: false, nullable: false, description: 'One persisted model run failure.', properties: {
					kind: text('Persisted model_run kind.'), startedAt: date('UTC start time of the failed run.'),
					failure: { ...text('First 200 characters of params.failure; null when no reason was recorded.'), nullable: true },
				},
			} },
			warnings: { type: 'array', optional: false, nullable: false, description: 'Server-evaluated conditions: CUDA unavailable; lock older than ten minutes; topic success older than forty minutes/missing; delayed queue at least thirty; failure in last hour; note-judge pending older than ten minutes, or als/embedding pending older than 35 minutes (their Python timeout is 30 minutes).', items: {
				...text('Stable warning code, localized by the client.'), enum: WARNINGS,
			} },
			events: { type: 'array', optional: false, nullable: false, description: 'Newest-first events from the Redis list, filtered by eventJobs before applying eventsLimit; up to 2000 retained for seven days. Repeated lockBusy/waiting events are recorded at most once per job family per minute.', items: {
				type: 'object', optional: false, nullable: false, description: 'One diagnostic event emitted by a GPU job or generation dispatcher.', properties: {
					at: date('UTC event recording time.'), job: { ...text('Job family that emitted the event.'), enum: HANAMI_EVENT_JOBS },
					event: { ...text('Stable event code; successful lock renewals are not recorded.'), enum: HANAMI_LLM_EVENTS },
					jobId: { ...text('BullMQ job id when available; omitted for direct batch/API calls.'), optional: true },
					durationMs: { ...count('Elapsed operation or waiting time in milliseconds when available.'), optional: true },
					counts: { type: 'object', optional: true, nullable: false, description: 'Small operation-specific integer counts, such as requested, saved, jobs, notes or failedSteps.', additionalProperties: count('Operation-specific item count.') },
					error: { type: 'object', optional: true, nullable: false, description: 'Diagnostic error details, with bounded text.', properties: {
						name: text('Error class name, or Error for non-Error rejections.'), message: text('First 500 characters of the error message.'),
						stderrTail: { ...text('Last 1000 characters of Python standard error, when provided by the process error.'), optional: true },
					} },
				},
			} },
		},
	},
} as const;

export const paramDef = { type: 'object', properties: {
	eventsLimit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Maximum number of matching newest events.' },
	eventJobs: { type: 'array', items: { type: 'string', enum: HANAMI_EVENT_JOBS }, uniqueItems: true, description: 'Restrict events to these job families; omitted means all families.' },
}, required: [] } as const;

type RunRow = { status: string; startedAt: Date | string; finishedAt: Date | string | null; params: Record<string, unknown> };

function packRun(row: RunRow | null) {
	if (row == null) return null;
	return { status: row.status, startedAt: new Date(row.startedAt).toISOString(), finishedAt: row.finishedAt == null ? null : new Date(row.finishedAt).toISOString(),
		processedCount: typeof row.params.processedCount === 'number' && Number.isSafeInteger(row.params.processedCount) && row.params.processedCount >= 0 ? row.params.processedCount : null,
		failure: typeof row.params.failure === 'string' ? row.params.failure : null, interrupted: row.params.interrupted === true,
		skippedReason: typeof row.params.skippedReason === 'string' ? row.params.skippedReason : null };
}

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(@Inject(DI.db) private db: DataSource, @Inject(DI.redis) private redisClient: Redis.Redis, private queueService: QueueService) {
		super(meta, paramDef, async ps => {
			const now = Date.now();
			const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
			const [judge, queue, lockSnapshot, waiting, summaries, failures, conditions, rawEvents] = await Promise.all([
				getHanamiJudgeStatus(this.db, this.redisClient), this.queueService.getHanamiJobsStatus(),
				this.redisClient.eval('return {redis.call("get", KEYS[1]), redis.call("pttl", KEYS[1])}', 1, HANAMI_LOCAL_LLM_LOCK_KEY) as Promise<[string | null, number]>,
				this.redisClient.get('hanami:llm:topic-judge-waiting:v1'),
				this.db.query<Array<{ kind: typeof RUN_KINDS[number]; latest: RunRow | null; latestWork: RunRow | null; ready: number; failed: number; interrupted: number; empty: number }>>(`SELECT k.kind, row_to_json(latest) AS latest, row_to_json(work) AS "latestWork", stats.*
					FROM unnest($1::varchar[]) AS k(kind)
					LEFT JOIN LATERAL (SELECT status, "startedAt", "finishedAt", params FROM hanami_foryou_model_run WHERE kind = k.kind ORDER BY "startedAt" DESC, id DESC LIMIT 1) latest ON true
					LEFT JOIN LATERAL (SELECT status, "startedAt", "finishedAt", params FROM hanami_foryou_model_run WHERE kind = k.kind AND CASE WHEN jsonb_typeof(params->'processedCount') = 'number' THEN (params->>'processedCount')::numeric > 0 ELSE false END ORDER BY "startedAt" DESC, id DESC LIMIT 1) work ON true
					LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status = 'ready')::int AS ready, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
						COUNT(*) FILTER (WHERE params->'interrupted' = 'true'::jsonb)::int AS interrupted,
						COUNT(*) FILTER (WHERE status = 'ready' AND params->'processedCount' = '0'::jsonb)::int AS empty
						FROM hanami_foryou_model_run WHERE kind = k.kind AND COALESCE("finishedAt", "startedAt") >= $2) stats ON true`, [RUN_KINDS, dayAgo]),
				this.db.query<Array<{ kind: string; startedAt: Date | string; failure: string | null }>>(`SELECT kind, "startedAt", CASE WHEN jsonb_typeof(params->'failure') = 'string' THEN left(params->>'failure', 200) ELSE NULL END AS failure
					FROM hanami_foryou_model_run WHERE kind = ANY($1::varchar[]) AND status = 'failed' AND COALESCE("finishedAt", "startedAt") >= $2 ORDER BY COALESCE("finishedAt", "startedAt") DESC, id DESC LIMIT 10`, [RUN_KINDS, dayAgo]),
				this.db.query<Array<{ recentFailures: boolean; stuckPending: boolean }>>(`SELECT
					EXISTS (SELECT 1 FROM hanami_foryou_model_run WHERE kind = ANY($1::varchar[]) AND status = 'failed' AND COALESCE("finishedAt", "startedAt") >= $2) AS "recentFailures",
					EXISTS (SELECT 1 FROM hanami_foryou_model_run WHERE kind = ANY($1::varchar[]) AND status = 'pending' AND "startedAt" < CASE WHEN kind = 'note-judge' THEN $3::timestamptz ELSE $4::timestamptz END) AS "stuckPending"`, [RUN_KINDS, new Date(now - 60 * 60 * 1000), new Date(now - 10 * 60 * 1000), new Date(now - 35 * 60 * 1000)]),
				this.redisClient.lrange(HANAMI_LLM_EVENTS_KEY, 0, HANAMI_LLM_EVENTS_MAX - 1),
			]);
			const [token, ttl] = lockSnapshot;
			const parts = typeof token === 'string' ? token.split(':') : [];
			const acquiredMs = /^\d+$/.test(parts[1] ?? '') ? Number(parts[1]) : NaN;
			const knownOwner = parts.length === 4 && (HANAMI_GPU_JOBS as readonly string[]).includes(parts[0]) && Number.isSafeInteger(acquiredMs) && acquiredMs >= 0 && acquiredMs <= Date.now() && /^\d+$/.test(parts[2]) && parts[3].length > 0;
			const lock = { held: token != null, kind: knownOwner ? parts[0] : null, acquiredAt: knownOwner ? new Date(acquiredMs).toISOString() : null, expiresInMs: token != null && ttl >= 0 ? ttl : null };
			const gpuAvailable = judge.runtime.available && judge.runtime.device === 'cuda';
			const lastSuccess = judge.trendTopicJudge?.lastSuccessAt == null ? NaN : Date.parse(judge.trendTopicJudge.lastSuccessAt);
			const warnings: typeof WARNINGS[number][] = [];
			if (!gpuAvailable) warnings.push('gpuUnavailable');
			if (knownOwner && acquiredMs < now - 10 * 60 * 1000) warnings.push('lockLong');
			if (gpuAvailable && (!Number.isFinite(lastSuccess) || lastSuccess < now - 40 * 60 * 1000)) warnings.push('topicJudgeStale');
			if (queue.jobs.reduce((n, job) => n + job.delayed, 0) >= 30) warnings.push('queueBacklog');
			if (conditions[0]?.recentFailures) warnings.push('recentFailures');
			if (conditions[0]?.stuckPending) warnings.push('stuckPending');
			const events = rawEvents.flatMap(raw => {
				try {
					const event = JSON.parse(raw) as HanamiLlmEvent;
					if (!HANAMI_EVENT_JOBS.includes(event.job) || !HANAMI_LLM_EVENTS.includes(event.event) || !Number.isFinite(Date.parse(event.at))) return [];
					return ps.eventJobs == null || ps.eventJobs.includes(event.job) ? [event] : [];
				} catch { return []; }
			}).slice(0, ps.eventsLimit);
			return { gpu: judge.runtime, lock, topicJudgeWaiting: waiting != null, queue,
				runs: summaries.map(row => ({ kind: row.kind, latest: packRun(row.latest), latestWork: packRun(row.latestWork), last24h: { ready: row.ready, failed: row.failed, interrupted: row.interrupted, empty: row.empty } })),
				noteJudge: { backlog: judge.backlog, secPerNote: judge.secPerNote ?? null }, topicJudge: judge.trendTopicJudge,
				recentFailures: failures.map(row => ({ ...row, startedAt: new Date(row.startedAt).toISOString() })), warnings, events };
		});
	}
}
