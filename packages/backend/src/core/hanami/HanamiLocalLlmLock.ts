/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import Logger from '@/logger.js';

export const HANAMI_LOCAL_LLM_LOCK_KEY = 'hanami:llm:exclusive:v1';
export const HANAMI_LLM_EVENTS_KEY = 'hanami:llm:events:v1';
// Large enough to keep about a day of normal runs even while a backlog retries every minute.
export const HANAMI_LLM_EVENTS_MAX = 2000;
// Repeated contention (lockBusy/waiting) is recorded at most once per job family and event within this window.
export const HANAMI_LLM_EVENT_THROTTLE_MS = 60_000;
// Per process: one web process runs these jobs, and a second one would only add one more record per window.
const lastThrottledEventAt = new Map<string, number>();

/** Tests share one process; production never needs to reset the window. */
export function clearHanamiLlmEventThrottle(): void {
	lastThrottledEventAt.clear();
}
export const HANAMI_GPU_JOBS = ['noteJudge', 'topicJudge', 'als', 'tasteTick', 'judgeTrial'] as const;
export const HANAMI_EVENT_JOBS = [...HANAMI_GPU_JOBS, 'generation'] as const;
export const HANAMI_LLM_EVENTS = ['dispatched', 'dispatchFailed', 'rejected', 'lockAcquired', 'lockBusy', 'lockRenewFailed', 'lockReleased', 'waiting', 'gaveUp', 'started', 'finished', 'empty', 'failed', 'interrupted', 'noGpu'] as const;
export type HanamiGpuJob = typeof HANAMI_GPU_JOBS[number];
export type HanamiLlmEvent = {
	at: string;
	job: typeof HANAMI_EVENT_JOBS[number];
	event: typeof HANAMI_LLM_EVENTS[number];
	jobId?: string;
	durationMs?: number;
	counts?: Record<string, number>;
	error?: { name: string; message: string; stderrTail?: string };
};
const LOCK_TTL_MS = 90_000;
const RENEW_INTERVAL_MS = 30_000;
const logger = new Logger('hanami-local-llm-lock');

export type HanamiLocalLlmLock = { readonly token: string; release: () => Promise<void> };

/** Telemetry must never change a job's retry or lock-release behavior when Redis fails. */
export async function recordHanamiLlmEvent(redis: Redis.Redis, input: Omit<HanamiLlmEvent, 'at' | 'error'> & { error?: unknown; throttleMs?: number }): Promise<void> {
	const { error, throttleMs, ...fields } = input;
	if (throttleMs != null) {
		const key = `${fields.job}:${fields.event}`;
		const last = lastThrottledEventAt.get(key);
		if (last != null && Date.now() - last < throttleMs) return;
		lastThrottledEventAt.set(key, Date.now());
	}
	const event: HanamiLlmEvent = { ...fields, at: new Date().toISOString() };
	if (event.durationMs != null) event.durationMs = Math.max(0, Math.round(event.durationMs));
	if (error != null) {
		const value = error as { name?: unknown; message?: unknown; stderr?: unknown };
		event.error = {
			name: typeof value.name === 'string' ? value.name : 'Error',
			message: Array.from(typeof value.message === 'string' ? value.message : String(error)).slice(0, 500).join(''),
			...(value.stderr == null ? {} : { stderrTail: Array.from(String(value.stderr)).slice(-1000).join('') }),
		};
	}
	try {
		const replies = await redis.multi().lpush(HANAMI_LLM_EVENTS_KEY, JSON.stringify(event))
			.ltrim(HANAMI_LLM_EVENTS_KEY, 0, HANAMI_LLM_EVENTS_MAX - 1).expire(HANAMI_LLM_EVENTS_KEY, 7 * 24 * 60 * 60).exec();
		const failure = replies?.find(([error]) => error != null)?.[0];
		if (replies == null || failure != null) throw failure ?? new Error('Event transaction aborted');
	} catch (error) {
		logger.warn('hanami LLM event could not be recorded', { error: String(error) });
	}
}

/** The caller must release in finally, including when its Python process fails. */
export async function acquireHanamiLocalLlmLock(
	redis: Redis.Redis,
	kind: HanamiGpuJob,
	options: { keys?: readonly string[]; jobId?: string; logger?: Pick<Logger, 'warn'> } = {},
): Promise<HanamiLocalLlmLock | null> {
	const acquiredAt = Date.now();
	const token = `${kind}:${acquiredAt}:${process.pid}:${randomUUID()}`;
	const event = (event: HanamiLlmEvent['event'], error?: unknown, throttleMs?: number) => recordHanamiLlmEvent(redis, { job: kind, event, jobId: options.jobId, error, durationMs: Date.now() - acquiredAt, throttleMs });
	const log = options.logger ?? logger;
	const acquired: string[] = [];
	let renewing: Promise<void> | null = null;
	let released = false;
	let complete = false;
	const timer = setInterval(() => {
		if (renewing != null || acquired.length === 0) return;
		renewing = (async () => {
			try {
				const renewed = await redis.eval(
					'local renewed = 0; for i = 1, #KEYS do if redis.call("get", KEYS[i]) == ARGV[1] then renewed = renewed + redis.call("pexpire", KEYS[i], ARGV[2]) end end; return renewed',
					acquired.length, ...acquired, token, LOCK_TTL_MS,
				);
				if (renewed !== acquired.length) {
					log.warn('hanami local LLM lock ownership lost; processing continues');
					await event('lockRenewFailed', new Error('Lock ownership lost; processing continues'));
				}
			} catch (error) {
				log.warn('hanami local LLM lock renewal failed; processing continues', { error: String(error) });
				await event('lockRenewFailed', error);
			}
		})().finally(() => { renewing = null; });
	}, RENEW_INTERVAL_MS);
	timer.unref();
	const release = async () => {
		if (released) return;
		released = true;
		clearInterval(timer);
		await renewing;
		if (acquired.length === 0) return;
		const deleted = await redis.eval(
			'local deleted = 0; for i = 1, #KEYS do if redis.call("get", KEYS[i]) == ARGV[1] then deleted = deleted + redis.call("del", KEYS[i]) end end; return deleted',
			acquired.length, ...acquired, token,
		).catch(() => { /* The short TTL also releases locks after a Redis failure. */ });
		if (complete && deleted === acquired.length) await event('lockReleased');
	};
	try {
		// Taste keeps the legacy reservation first, followed by the shared GPU reservation.
		for (const key of options.keys ?? [HANAMI_LOCAL_LLM_LOCK_KEY]) {
			if (await redis.set(key, token, 'EX', LOCK_TTL_MS / 1000, 'NX') == null) {
				await release();
				await event('lockBusy', undefined, HANAMI_LLM_EVENT_THROTTLE_MS);
				return null;
			}
			acquired.push(key);
		}
		complete = true;
		await event('lockAcquired');
		return { token, release };
	} catch (error) {
		await release();
		throw error;
	}
}
