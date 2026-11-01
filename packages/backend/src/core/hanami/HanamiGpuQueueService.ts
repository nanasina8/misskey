/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import {
	HANAMI_GPU_QUEUE_KINDS,
	HANAMI_GPU_QUEUE_POLICIES,
	type HanamiGpuQueueKind,
} from '@/misc/hanami-gpu-queue.js';

/**
 * はなみ GPU 判定キューの順番待ち（Redis）。1件ずつ FIFO の列＋項目の本体（hash）。
 * キーはすべて `hanami:gpuq:v1:` で始める。
 */
const PREFIX = 'hanami:gpuq:v1:';
const WAKE_CHANNEL = `${PREFIX}wake`;
export const HANAMI_GPU_QUEUE_RESULT_PREFIX = `${PREFIX}result:`;

export type HanamiGpuQueueBody = {
	payload: unknown;
	enqueuedAt: number;
	deadlineAt: number | null;
	attempts: number;
};

export type HanamiGpuQueueTakenItem = {
	itemId: string;
	payload: unknown;
	enqueuedAt: number;
	attempts: number;
};

/** 出来事の記録（調べもの用）。新しい順に最大 EVENTS_MAX 件 */
export type HanamiGpuQueueEvent = {
	at: number;
	type:
		| 'leaderAcquired' | 'leaderLost'
		| 'lockAcquired' | 'lockBusy' | 'lockReleased'
		| 'workerSpawn' | 'workerReady' | 'workerExit' | 'workerFailed'
		| 'batch' | 'batchFailed' | 'handlerFailed'
		| 'retry' | 'giveUp' | 'drop'
		| 'yield' | 'refill';
	kind?: HanamiGpuQueueKind;
	count?: number;
	durationMs?: number;
	detail?: string;
};

/** 判定1回分の記録（まとめる件数・速さの調整用）。新しい順に最大 BATCHES_MAX 件 */
export type HanamiGpuQueueBatchRecord = {
	at: number;
	kind: HanamiGpuQueueKind;
	size: number;
	ok: number;
	errors: number;
	durationMs: number;
	/** 取り出したときの、いちばん長く待っていた項目の待ち時間 */
	maxWaitMs: number;
	maxAttempts: number;
};

export type HanamiGpuQueuePeekItem = {
	itemId: string;
	enqueuedAt: number;
	deadlineAt: number | null;
	attempts: number;
};

export type HanamiGpuQueueStats = {
	length: number;
	oldestWaitSec: number | null;
	dropped: number;
	failed: number;
};

const listKey = (kind: HanamiGpuQueueKind) => `${PREFIX}list:${kind}`;
const itemKey = (kind: HanamiGpuQueueKind) => `${PREFIX}item:${kind}`;
const droppedKey = (kind: HanamiGpuQueueKind) => `${PREFIX}stats:dropped:${kind}`;
const failedKey = (kind: HanamiGpuQueueKind) => `${PREFIX}stats:failed:${kind}`;
const inflightKey = (kind: HanamiGpuQueueKind) => `${PREFIX}inflight:${kind}`;
const EVENTS_KEY = `${PREFIX}events`;
const BATCHES_KEY = `${PREFIX}batches`;
const EVENTS_MAX = 500;
const BATCHES_MAX = 200;
const HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;

function parseBody(raw: string | null): HanamiGpuQueueBody | null {
	if (raw == null) return null;
	try {
		const parsed = JSON.parse(raw) as HanamiGpuQueueBody;
		if (parsed == null || typeof parsed !== 'object' || typeof parsed.enqueuedAt !== 'number') return null;
		return parsed;
	} catch {
		return null;
	}
}

@Injectable()
export class HanamiGpuQueueService {
	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,
	) {
	}

	/**
	 * 本体を HSETNX で入れ、入ったときだけ列に RPUSH（同じ itemId の二重登録はしない）。
	 * 戻り値は入れたかどうか。deadlineMs が無ければ種類の policy の deadlineMs を使う。
	 */
	public async enqueue(kind: HanamiGpuQueueKind, itemId: string, payload: unknown, opts: { deadlineMs?: number } = {}): Promise<boolean> {
		const policy = HANAMI_GPU_QUEUE_POLICIES[kind];
		const deadlineMs = opts.deadlineMs ?? policy.deadlineMs;
		const enqueuedAt = Date.now();
		const body: HanamiGpuQueueBody = {
			payload,
			enqueuedAt,
			deadlineAt: deadlineMs != null ? enqueuedAt + deadlineMs : null,
			attempts: 0,
		};
		const added = await this.redis.hsetnx(itemKey(kind), itemId, JSON.stringify(body));
		if (added === 0) return false;
		await this.redis.rpush(listKey(kind), itemId);
		await this.redis.publish(WAKE_CHANNEL, kind);
		return true;
	}

	/** 列の先頭の本体を見て HanamiGpuQueueHead を返す。先頭の本体が無ければ列から外して次を見る。 */
	public async head(kind: HanamiGpuQueueKind): Promise<{ kind: HanamiGpuQueueKind; enqueuedAt: number; deadlineAt: number | null } | null> {
		for (;;) {
			const itemId = await this.redis.lindex(listKey(kind), 0);
			if (itemId == null) return null;
			const raw = await this.redis.hget(itemKey(kind), itemId);
			const body = parseBody(raw);
			if (body == null) {
				await this.redis.lpop(listKey(kind));
				continue;
			}
			return { kind, enqueuedAt: body.enqueuedAt, deadlineAt: body.deadlineAt };
		}
	}

	/** 左から最大 n 件取り出して本体と一緒に返す。締め切りを過ぎたものは捨てて数える。 */
	public async take(kind: HanamiGpuQueueKind, n: number): Promise<HanamiGpuQueueTakenItem[]> {
		const now = Date.now();
		const results: HanamiGpuQueueTakenItem[] = [];
		for (let i = 0; i < n; i++) {
			const itemId = await this.redis.lpop(listKey(kind));
			if (itemId == null) break;
			const raw = await this.redis.hget(itemKey(kind), itemId);
			const body = parseBody(raw);
			if (body == null) {
				i--; // 消えていた先頭を外したので、もう1件試す
				continue;
			}
			if (body.deadlineAt != null && body.deadlineAt <= now) {
				await this.redis.hdel(itemKey(kind), itemId);
				await this.redis.incr(droppedKey(kind));
				await this.recordEvent({ type: 'drop', kind, count: 1, durationMs: now - body.enqueuedAt, detail: itemId });
				i--;
				continue;
			}
			results.push({ itemId, payload: body.payload, enqueuedAt: body.enqueuedAt, attempts: body.attempts });
		}
		return results;
	}

	/** 本体を消す。 */
	public async complete(kind: HanamiGpuQueueKind, itemIds: readonly string[]): Promise<void> {
		if (itemIds.length === 0) return;
		await this.redis.hdel(itemKey(kind), ...itemIds);
	}

	/** attempts+1 で列の先頭に戻す（LPUSH）。attempts が3以上になったものは捨てて数える。 */
	public async retry(kind: HanamiGpuQueueKind, items: readonly HanamiGpuQueueTakenItem[]): Promise<void> {
		for (const item of items) {
			const raw = await this.redis.hget(itemKey(kind), item.itemId);
			const body = parseBody(raw);
			const attempts = (body?.attempts ?? item.attempts) + 1;
			if (attempts >= 3) {
				await this.redis.hdel(itemKey(kind), item.itemId);
				await this.redis.incr(failedKey(kind));
				await this.recordEvent({ type: 'giveUp', kind, count: 1, detail: item.itemId });
				continue;
			}
			const next: HanamiGpuQueueBody = {
				payload: body?.payload ?? item.payload,
				enqueuedAt: body?.enqueuedAt ?? item.enqueuedAt,
				deadlineAt: body?.deadlineAt ?? null,
				attempts,
			};
			await this.redis.hset(itemKey(kind), item.itemId, JSON.stringify(next));
			await this.redis.lpush(listKey(kind), item.itemId);
		}
	}

	public async length(kind: HanamiGpuQueueKind): Promise<number> {
		return await this.redis.llen(listKey(kind));
	}

	/** 取り出して判定中の件数を残す／消す（補充係が「列に無いが、まだ数え終わっていない」分を知るため） */
	public async setInflight(kind: HanamiGpuQueueKind, count: number): Promise<void> {
		if (count > 0) {
			await this.redis.set(inflightKey(kind), String(count), 'EX', 600);
		} else {
			await this.redis.del(inflightKey(kind));
		}
	}

	/** 列に残っている件数＋判定中の件数 */
	public async pending(kind: HanamiGpuQueueKind): Promise<number> {
		const [length, inflight] = await Promise.all([this.redis.llen(listKey(kind)), this.redis.get(inflightKey(kind))]);
		return length + (inflight != null ? Number(inflight) : 0);
	}

	/** 種類ごとの件数、いちばん古い待ち（秒）、dropped・failed の数。 */
	public async stats(): Promise<Record<HanamiGpuQueueKind, HanamiGpuQueueStats>> {
		const result = {} as Record<HanamiGpuQueueKind, HanamiGpuQueueStats>;
		const now = Date.now();
		for (const kind of HANAMI_GPU_QUEUE_KINDS) {
			const [length, itemId, dropped, failed] = await Promise.all([
				this.redis.llen(listKey(kind)),
				this.redis.lindex(listKey(kind), 0),
				this.redis.get(droppedKey(kind)),
				this.redis.get(failedKey(kind)),
			]);
			let oldestWaitSec: number | null = null;
			if (itemId != null) {
				const body = parseBody(await this.redis.hget(itemKey(kind), itemId));
				if (body != null) oldestWaitSec = Math.max(0, Math.floor((now - body.enqueuedAt) / 1000));
			}
			result[kind] = {
				length,
				oldestWaitSec,
				dropped: dropped != null ? Number(dropped) : 0,
				failed: failed != null ? Number(failed) : 0,
			};
		}
		return result;
	}

	/** 出来事を残す。記録の失敗で判定を止めない */
	public async recordEvent(event: Omit<HanamiGpuQueueEvent, 'at'>): Promise<void> {
		try {
			await this.redis.multi()
				.lpush(EVENTS_KEY, JSON.stringify({ at: Date.now(), ...event }))
				.ltrim(EVENTS_KEY, 0, EVENTS_MAX - 1)
				.expire(EVENTS_KEY, HISTORY_TTL_SECONDS)
				.exec();
		} catch {
			// 記録は調べもの用なので、失敗しても続ける
		}
	}

	public async recordBatch(record: HanamiGpuQueueBatchRecord): Promise<void> {
		try {
			await this.redis.multi()
				.lpush(BATCHES_KEY, JSON.stringify(record))
				.ltrim(BATCHES_KEY, 0, BATCHES_MAX - 1)
				.expire(BATCHES_KEY, HISTORY_TTL_SECONDS)
				.exec();
		} catch {
			// 同上
		}
	}

	public async recentEvents(limit: number): Promise<HanamiGpuQueueEvent[]> {
		return (await this.redis.lrange(EVENTS_KEY, 0, limit - 1)).flatMap(raw => {
			try {
				return [JSON.parse(raw) as HanamiGpuQueueEvent];
			} catch {
				return [];
			}
		});
	}

	public async recentBatches(limit: number): Promise<HanamiGpuQueueBatchRecord[]> {
		return (await this.redis.lrange(BATCHES_KEY, 0, limit - 1)).flatMap(raw => {
			try {
				return [JSON.parse(raw) as HanamiGpuQueueBatchRecord];
			} catch {
				return [];
			}
		});
	}

	/** 列の先頭から最大 n 件を、取り出さずに見る（本体が無い列の項目は itemId だけ・enqueuedAt=-1 で返す） */
	public async peek(kind: HanamiGpuQueueKind, n: number): Promise<HanamiGpuQueuePeekItem[]> {
		const itemIds = await this.redis.lrange(listKey(kind), 0, n - 1);
		const result: HanamiGpuQueuePeekItem[] = [];
		for (const itemId of itemIds) {
			const body = parseBody(await this.redis.hget(itemKey(kind), itemId));
			result.push(body == null
				? { itemId, enqueuedAt: -1, deadlineAt: null, attempts: 0 }
				: { itemId, enqueuedAt: body.enqueuedAt, deadlineAt: body.deadlineAt, attempts: body.attempts });
		}
		return result;
	}

	/**
	 * 列と本体の食い違い（調べもの用）。列にあるのに本体が無い（取り出すとき捨てられる）、
	 * 本体があるのに列に無い（判定中の分を除くと、永遠に取り出されない＝迷子）。
	 */
	public async consistency(kind: HanamiGpuQueueKind): Promise<{ listOnly: number; bodyOnly: number; inflight: number }> {
		const [listIds, bodyIds, inflightRaw] = await Promise.all([
			this.redis.lrange(listKey(kind), 0, -1),
			this.redis.hkeys(itemKey(kind)),
			this.redis.get(inflightKey(kind)),
		]);
		const inList = new Set(listIds);
		const inBody = new Set(bodyIds);
		const inflight = inflightRaw != null ? Number(inflightRaw) : 0;
		return {
			listOnly: listIds.filter(id => !inBody.has(id)).length,
			// 判定中の分は列から外れて本体だけ残っているので、その数を引く
			bodyOnly: Math.max(0, bodyIds.filter(id => !inList.has(id)).length - inflight),
			inflight,
		};
	}

	/** 列と本体の両方から、predicate に当たる項目を消す（全体スキャンの中止に使う）。 */
	public async removeWhere(kind: HanamiGpuQueueKind, predicate: (payload: unknown) => boolean): Promise<number> {
		const itemIds = await this.redis.lrange(listKey(kind), 0, -1);
		const keep: string[] = [];
		let removed = 0;
		for (const itemId of itemIds) {
			const raw = await this.redis.hget(itemKey(kind), itemId);
			const body = parseBody(raw);
			if (body != null && predicate(body.payload)) {
				removed++;
				await this.redis.hdel(itemKey(kind), itemId);
			} else {
				keep.push(itemId);
			}
		}
		if (removed > 0) {
			await this.redis.del(listKey(kind));
			if (keep.length > 0) await this.redis.rpush(listKey(kind), ...keep);
		}
		return removed;
	}
}
