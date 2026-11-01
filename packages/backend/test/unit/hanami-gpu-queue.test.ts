/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import {
	chooseHanamiGpuQueueKind,
	hanamiGpuQueueEffectivePriority,
	shouldYieldHanamiGpu,
} from '@/misc/hanami-gpu-queue.js';
import { HanamiGpuQueueService } from '@/core/hanami/HanamiGpuQueueService.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;

describe('実効優先度', () => {
	test('待ち時間で1分ごとに1ずつ上がり、40で頭打ち', () => {
		expect(hanamiGpuQueueEffectivePriority({ kind: 'spamScan', enqueuedAt: NOW, deadlineAt: null }, NOW)).toBe(10);
		expect(hanamiGpuQueueEffectivePriority({ kind: 'spamScan', enqueuedAt: NOW - 5 * MIN, deadlineAt: null }, NOW)).toBe(15);
		expect(hanamiGpuQueueEffectivePriority({ kind: 'spamScan', enqueuedAt: NOW - 120 * MIN, deadlineAt: null }, NOW)).toBe(50);
	});

	test('締め切りが近いほど最大30まで上がる', () => {
		// judgeTrial は締め切り60秒。半分過ぎたら +15
		expect(hanamiGpuQueueEffectivePriority({ kind: 'judgeTrial', enqueuedAt: NOW - 30_000, deadlineAt: NOW + 30_000 }, NOW)).toBe(115);
		expect(hanamiGpuQueueEffectivePriority({ kind: 'judgeTrial', enqueuedAt: NOW - 60_000, deadlineAt: NOW }, NOW)).toBe(131);
	});

	test('全体スキャンは長く待っても、来たばかりのいつもの判定を追い越さない', () => {
		const scan = hanamiGpuQueueEffectivePriority({ kind: 'spamScan', enqueuedAt: NOW - 600 * MIN, deadlineAt: null }, NOW);
		const judge = hanamiGpuQueueEffectivePriority({ kind: 'spamJudge', enqueuedAt: NOW, deadlineAt: null }, NOW);
		expect(scan).toBeLessThan(judge);
	});
});

describe('次の種類の選び方', () => {
	test('空の種類は除き、いちばん高いものを選ぶ', () => {
		expect(chooseHanamiGpuQueueKind([
			null,
			{ kind: 'spamJudge', enqueuedAt: NOW, deadlineAt: null },
			{ kind: 'spamScan', enqueuedAt: NOW - 10 * MIN, deadlineAt: null },
		], NOW)).toBe('spamJudge');
	});

	test('全部空なら null', () => {
		expect(chooseHanamiGpuQueueKind([null, null, null], NOW)).toBeNull();
	});

	test('同点なら先に来たほう', () => {
		const a = { kind: 'spamScan' as const, enqueuedAt: NOW - 30_000, deadlineAt: null };
		const b = { kind: 'spamScan' as const, enqueuedAt: NOW - 10_000, deadlineAt: null };
		// 種類が同じでも、配列の順に関係なく古いほう（ここでは a）の種類が選ばれる
		expect(chooseHanamiGpuQueueKind([b, a], NOW)).toBe('spamScan');
	});
});

/** list / hash / 文字列だけのメモリ上の Redis もどき */
function fakeRedis() {
	const lists = new Map<string, string[]>();
	const hashes = new Map<string, Map<string, string>>();
	const strings = new Map<string, string>();
	const list = (k: string) => lists.get(k) ?? (lists.set(k, []), lists.get(k)!);
	const hash = (k: string) => hashes.get(k) ?? (hashes.set(k, new Map()), hashes.get(k)!);
	return {
		lists, hashes, strings,
		async hsetnx(k: string, f: string, v: string) { if (hash(k).has(f)) return 0; hash(k).set(f, v); return 1; },
		async hset(k: string, f: string, v: string) { hash(k).set(f, v); return 1; },
		async hget(k: string, f: string) { return hash(k).get(f) ?? null; },
		async hdel(k: string, ...fs: string[]) { let n = 0; for (const f of fs) if (hash(k).delete(f)) n++; return n; },
		async rpush(k: string, ...vs: string[]) { list(k).push(...vs); return list(k).length; },
		async lpush(k: string, ...vs: string[]) { list(k).unshift(...vs.reverse()); return list(k).length; },
		async lpop(k: string) { return list(k).shift() ?? null; },
		async lindex(k: string, i: number) { return list(k)[i] ?? null; },
		async llen(k: string) { return list(k).length; },
		async lrange(k: string) { return [...list(k)]; },
		async del(k: string) { lists.delete(k); return 1; },
		async incr(k: string) { const v = Number(strings.get(k) ?? 0) + 1; strings.set(k, String(v)); return v; },
		async get(k: string) { return strings.get(k) ?? null; },
		async publish() { return 1; },
	};
}

describe('順番待ち（HanamiGpuQueueService）', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('同じ itemId は二重に入らない', async () => {
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		expect(await q.enqueue('spamJudge', 'n1', { text: 'a' })).toBe(true);
		expect(await q.enqueue('spamJudge', 'n1', { text: 'a' })).toBe(false);
		expect(await q.length('spamJudge')).toBe(1);
	});

	test('来た順に取り出し、締め切り切れは捨てて数える', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('judgeTrial', 'old', { text: 'a' });
		vi.setSystemTime(NOW + 30_000);
		await q.enqueue('judgeTrial', 'new', { text: 'b' });
		vi.setSystemTime(NOW + 61_000); // old は60秒の締め切りを過ぎた
		const taken = await q.take('judgeTrial', 5);
		expect(taken.map(t => t.itemId)).toEqual(['new']);
		expect((await q.stats()).judgeTrial.dropped).toBe(1);
	});

	test('retry で先頭に戻り、3回目の失敗で捨てて数える', async () => {
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamJudge', 'a', { text: 'a' });
		await q.enqueue('spamJudge', 'b', { text: 'b' });
		let [first] = await q.take('spamJudge', 1);
		await q.retry('spamJudge', [first]); // 1回目
		[first] = await q.take('spamJudge', 1);
		expect(first.itemId).toBe('a'); // 先頭に戻っている
		await q.retry('spamJudge', [first]); // 2回目
		[first] = await q.take('spamJudge', 1);
		await q.retry('spamJudge', [first]); // 3回目で捨てる
		expect((await q.stats()).spamJudge.failed).toBe(1);
		expect((await q.take('spamJudge', 5)).map(t => t.itemId)).toEqual(['b']);
	});

	test('complete で本体が消える', async () => {
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamJudge', 'a', { text: 'a' });
		const taken = await q.take('spamJudge', 1);
		await q.complete('spamJudge', taken.map(t => t.itemId));
		expect(await q.enqueue('spamJudge', 'a', { text: 'a' })).toBe(true); // 消えたのでまた入れられる
	});

	test('removeWhere で条件に合うものだけ列と本体から消す', async () => {
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamScan', 's1:a', { scanId: 's1' });
		await q.enqueue('spamScan', 's2:b', { scanId: 's2' });
		await q.enqueue('spamScan', 's1:c', { scanId: 's1' });
		expect(await q.removeWhere('spamScan', p => (p as { scanId: string }).scanId === 's1')).toBe(2);
		expect((await q.take('spamScan', 5)).map(t => t.itemId)).toEqual(['s2:b']);
	});
});

describe('今までどおりのジョブに GPU を譲るか', () => {
	test('こちらに仕事が無ければ、待っている相手に譲る', () => {
		expect(shouldYieldHanamiGpu(['noteJudge'], null)).toBe(true);
	});

	test('誰も待っていなければ譲らない', () => {
		expect(shouldYieldHanamiGpu([], null)).toBe(false);
	});

	test('新しい投稿の AI投稿チェック（90）は、投稿の判定（50）に譲らない', () => {
		expect(shouldYieldHanamiGpu(['noteJudge'], 90)).toBe(false);
	});

	test('全体スキャン（10）は投稿の判定（50）に譲る。同点ならこちらを続ける', () => {
		expect(shouldYieldHanamiGpu(['noteJudge'], 10)).toBe(true);
		expect(shouldYieldHanamiGpu(['noteJudge'], 50)).toBe(false);
	});

	test('いま話題の判定（70）が待っていれば、全体スキャンは譲るが、AI投稿チェックは続ける', () => {
		expect(shouldYieldHanamiGpu(['topicJudge', 'als'], 30)).toBe(true);
		expect(shouldYieldHanamiGpu(['topicJudge'], 90)).toBe(false);
	});
});
