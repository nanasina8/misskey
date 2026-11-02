/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Redis from 'ioredis';
import Logger from '@/logger.js';
import { jstDay } from './HanamiMetricsContracts.js';

export const HANAMI_FEED_EVENTS_KEY = 'hanami:feed:events:v1';
export const HANAMI_FEED_DAILY_KEY_PREFIX = 'hanami:feed:daily:';
// 「前回見た」「先回り」の Redis キーと TTL（30 分）。
export const HANAMI_FEED_SEEN_KEY_PREFIX = 'hanami:feed:seen:';
export const HANAMI_FEED_SEEN_TTL_SECONDS = 30 * 60;
export const HANAMI_FEED_PREWARM_KEY_PREFIX = 'hanami:feed:prewarm:';
export const HANAMI_FEED_PREWARM_TTL_SECONDS = 30 * 60;
// 診断 API が直近の latency を計算できるよう、出来事リストは最大 5000 件・14 日保持する。
export const HANAMI_FEED_EVENTS_MAX = 5000;
export const HANAMI_FEED_EVENTS_TTL_SECONDS = 14 * 24 * 60 * 60;
export const HANAMI_FEED_DAILY_TTL_SECONDS = 40 * 24 * 60 * 60;
// 記録の失敗でログを埋めないよう、失敗はプロセス内で間引いて warn する。
const HANAMI_FEED_EVENT_WARN_THROTTLE_MS = 60_000;
const lastWarnedAt = new Map<string, number>();

export type HanamiFeedEventKind = 'open' | 'refresh' | 'tuning' | 'prewarm' | 'upkeep' | 'discard' | 'publish';

/** batch の reason 列に入る値（この batch を作ったきっかけ）。 */
export type HanamiFeedStockReason =
	| 'open' | 'prewarm' | 'refresh' | 'tuning' | 'session'
	| 'afterServe' | 'afterPromote' | 'afterGenerate' | 'upkeep';

/** batch の discardReason 列に入る値（ストックを捨てた理由）。 */
export type HanamiFeedDiscardReason = 'stale' | 'tuning' | 'publish' | 'hibernate' | 'revive' | 'upkeep' | 'prewarm';

export type HanamiFeedEvent = {
	at: string;
	userId: string;
	kind: HanamiFeedEventKind;
	outcome: string;
	durationMs?: number;
	stockAgeMs?: number;
	batchId?: string;
	reason?: string;
};

export function hanamiFeedDailyKey(day: string): string {
	return `${HANAMI_FEED_DAILY_KEY_PREFIX}${day}`;
}

/** テストが同一プロセスで走るため、間引き窓をリセットできるようにする。 */
export function clearHanamiFeedEventWarnThrottle(): void {
	lastWarnedAt.clear();
}

/**
 * 出来事リスト（LPUSH → LTRIM → EXPIRE）と日ごとの数（HINCRBY → EXPIRE）を
 * 同じ multi で記録する。記録の失敗は応答・生成に影響させず、warn は間引く。
 */
export async function recordHanamiFeedEvent(redis: Redis.Redis, event: HanamiFeedEvent): Promise<void> {
	const now = Date.now();
	const dailyKey = hanamiFeedDailyKey(jstDay(new Date(now)));
	const outcomeField = `${event.kind}.${event.outcome}`;
	try {
		const replies = await redis.multi()
			.lpush(HANAMI_FEED_EVENTS_KEY, JSON.stringify(event))
			.ltrim(HANAMI_FEED_EVENTS_KEY, 0, HANAMI_FEED_EVENTS_MAX - 1)
			.expire(HANAMI_FEED_EVENTS_KEY, HANAMI_FEED_EVENTS_TTL_SECONDS)
			.hincrby(dailyKey, outcomeField, 1)
			.expire(dailyKey, HANAMI_FEED_DAILY_TTL_SECONDS)
			.exec();
		const failure = replies?.find(([error]) => error != null)?.[0];
		if (replies == null || failure != null) throw failure ?? new Error('Feed event transaction aborted');
	} catch (error) {
		const warnKey = 'record';
		const last = lastWarnedAt.get(warnKey);
		if (last != null && now - last < HANAMI_FEED_EVENT_WARN_THROTTLE_MS) return;
		lastWarnedAt.set(warnKey, now);
		const logger = new Logger('hanami-feed-stock-events');
		logger.warn('hanami feed event could not be recorded', { error: String(error) });
	}
}
