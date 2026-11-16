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
	const redis = {
		lists, hashes, strings,
		async hsetnx(k: string, f: string, v: string) { if (hash(k).has(f)) return 0; hash(k).set(f, v); return 1; },
		async hset(k: string, f: string, v: string) { hash(k).set(f, v); return 1; },
		async hget(k: string, f: string) { return hash(k).get(f) ?? null; },
		async hgetall(k: string) { return Object.fromEntries(hash(k)); },
		async hkeys(k: string) { return [...hash(k).keys()]; },
		async hdel(k: string, ...fs: string[]) { let n = 0; for (const f of fs) if (hash(k).delete(f)) n++; return n; },
		async rpush(k: string, ...vs: string[]) { list(k).push(...vs); return list(k).length; },
		async lpush(k: string, ...vs: string[]) { list(k).unshift(...vs.reverse()); return list(k).length; },
		async lpop(k: string) { return list(k).shift() ?? null; },
		async lindex(k: string, i: number) { return list(k)[i] ?? null; },
		async llen(k: string) { return list(k).length; },
		async lrange(k: string) { return [...list(k)]; },
		async lrem(k: string, _count: number, v: string) { const before = list(k).length; lists.set(k, list(k).filter(x => x !== v)); return before - list(k).length; },
		async del(k: string) { lists.delete(k); strings.delete(k); return 1; },
		async incr(k: string) { const v = Number(strings.get(k) ?? 0) + 1; strings.set(k, String(v)); return v; },
		async get(k: string) { return strings.get(k) ?? null; },
		async set(k: string, v: string) { strings.set(k, v); return 'OK'; },
		async publish() { return 1; },
		/** 順に実行するだけの MULTI もどき（出来事の記録と removeWhere が使う） */
		multi() {
			const ops: Array<() => Promise<unknown>> = [];
			const chain = {
				lrem(k: string, count: number, v: string) { ops.push(() => redis.lrem(k, count, v)); return chain; },
				hdel(k: string, ...fs: string[]) { ops.push(() => redis.hdel(k, ...fs)); return chain; },
				lpush(k: string, ...vs: string[]) { ops.push(() => redis.lpush(k, ...vs)); return chain; },
				ltrim() { return chain; },
				expire() { return chain; },
				async exec() { const out: Array<[null, unknown]> = []; for (const op of ops) out.push([null, await op()]); return out; },
			};
			return chain;
		},
	};
	return redis;
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

	test('removeWhere の最中に入った項目は列から消えない', async () => {
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamScan', 's1:a', { scanId: 's1' });
		await q.enqueue('spamScan', 's2:b', { scanId: 's2' });
		let added = false;
		// 列を調べている途中で、ほかのプロセスが次のスキャンの項目を入れる
		const removed = await q.removeWhere('spamScan', p => {
			if (!added) {
				added = true;
				void q.enqueue('spamScan', 's3:late', { scanId: 's3' });
			}
			return (p as { scanId: string }).scanId === 's1';
		});
		expect(removed).toBe(1);
		expect((await q.take('spamScan', 5)).map(t => t.itemId)).toEqual(['s2:b', 's3:late']);
		expect(await q.consistency('spamScan')).toMatchObject({ listOnly: 0 });
	});

	test('recoverOrphans は、取り出されたまま残った項目を先頭に戻し、判定中の数を消す', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamJudge', 'a', { text: 'a' });
		await q.enqueue('spamJudge', 'b', { text: 'b' });
		await q.enqueue('spamJudge', 'c', { text: 'c' });
		// 配り役が a・b を取り出して判定中に止まった（complete も retry も呼ばれない）
		expect((await q.take('spamJudge', 2)).map(t => t.itemId)).toEqual(['a', 'b']);
		await q.setInflight('spamJudge', 2);
		expect(await q.consistency('spamJudge')).toMatchObject({ bodyOnly: 0, inflight: 2 });

		vi.setSystemTime(NOW + 5 * MIN);
		// 入れている最中かもしれない新しい項目（本体だけあって列にまだ無い）は拾わない
		await redis.hsetnx('hanami:gpuq:v1:item:spamJudge', 'fresh', JSON.stringify({ payload: { text: 'f' }, enqueuedAt: NOW + 5 * MIN, deadlineAt: null, attempts: 0 }));

		expect(await q.recoverOrphans('spamJudge')).toBe(2);
		expect(await q.pending('spamJudge')).toBe(3);
		const taken = await q.take('spamJudge', 5);
		expect(taken.map(t => t.itemId)).toEqual(['a', 'b', 'c']);
		expect(taken.map(t => t.attempts)).toEqual([1, 1, 0]);
		// 同じ itemId をもう一度入れられないまま残り続けることがない
		await q.complete('spamJudge', ['a', 'b', 'c']);
		expect(await q.enqueue('spamJudge', 'a', { text: 'a' })).toBe(true);
	});

	test('recoverOrphans は迷子が無ければ何もしない。3回止まった項目は諦める', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamScan', 's1:a', { scanId: 's1' });
		vi.setSystemTime(NOW + 5 * MIN);
		expect(await q.recoverOrphans('spamScan')).toBe(0);
		expect((await q.take('spamScan', 5)).map(t => t.itemId)).toEqual(['s1:a']);
		expect(await q.recoverOrphans('spamScan')).toBe(1); // 1回目
		await q.take('spamScan', 5);
		expect(await q.recoverOrphans('spamScan')).toBe(1); // 2回目
		await q.take('spamScan', 5);
		expect(await q.recoverOrphans('spamScan')).toBe(1); // 3回目で捨てる
		expect((await q.stats()).spamScan.failed).toBe(1);
		expect(await q.take('spamScan', 5)).toEqual([]);
		expect(await q.consistency('spamScan')).toMatchObject({ listOnly: 0, bodyOnly: 0 });
	});

	test('同じ itemId が列に2回入っていても、1回分には1度だけ入る', async () => {
		const redis = fakeRedis();
		const q = new HanamiGpuQueueService(redis as any);
		await q.enqueue('spamJudge', 'a', { text: 'a' });
		await redis.lpush('hanami:gpuq:v1:list:spamJudge', 'a'); // 戻し直しが重なった
		await q.enqueue('spamJudge', 'b', { text: 'b' });
		expect((await q.take('spamJudge', 5)).map(t => t.itemId)).toEqual(['a', 'b']);
	});
});

describe('自分でモデルを読み込むジョブに GPU を譲るか', () => {
	// 譲る相手は、はなみの管理画面の「判定の試し」（100）だけ。投稿の判定・話題の判定は順番待ちに載せ替えた。
	test('こちらに仕事が無ければ、待っている「判定の試し」に譲る', () => {
		expect(shouldYieldHanamiGpu(['judgeTrial'], null)).toBe(true);
	});

	test('誰も待っていなければ譲らない', () => {
		expect(shouldYieldHanamiGpu([], null)).toBe(false);
	});

	test('GPU を使わないジョブ（おすすめの計算・好みの学習）が待っていても譲らない＝判定係を降ろさない', () => {
		expect(shouldYieldHanamiGpu(['als'], null)).toBe(false);
		expect(shouldYieldHanamiGpu(['tasteTick', 'als'], 10)).toBe(false);
	});

	test('載せ替えた種類（投稿の判定・話題の判定）の古い目印が残っていても譲らない', () => {
		expect(shouldYieldHanamiGpu(['noteJudge'], null)).toBe(false);
		expect(shouldYieldHanamiGpu(['topicJudge'], 10)).toBe(false);
	});

	test('「判定の試し」（100）には、AI投稿チェック（90）も譲る。同点以上ならこちらを続ける', () => {
		expect(shouldYieldHanamiGpu(['judgeTrial', 'als'], 90)).toBe(true);
		expect(shouldYieldHanamiGpu(['judgeTrial'], 100)).toBe(false);
		expect(shouldYieldHanamiGpu(['judgeTrial'], 115)).toBe(false);
	});
});

describe('載せ替えた種類の順番', () => {
	test('話題の判定は投稿の判定より先。20 分の締め切りが近づくと AI投稿チェックに並ぶ', () => {
		expect(chooseHanamiGpuQueueKind([
			{ kind: 'noteJudge', enqueuedAt: NOW - MIN, deadlineAt: null },
			{ kind: 'topicJudge', enqueuedAt: NOW, deadlineAt: NOW + 20 * MIN },
		], NOW)).toBe('topicJudge');
		// 70 + 待ち 19 + 締め切り 28.5 = 117.5 > 90
		expect(hanamiGpuQueueEffectivePriority({ kind: 'topicJudge', enqueuedAt: NOW - 19 * MIN, deadlineAt: NOW + MIN }, NOW)).toBeCloseTo(117.5, 5);
	});

	test('投稿の判定は長く待つと上がるが、来たばかりの AI投稿チェックは追い越さない（50 + 40 = 90 の同点は先に来たほう）', () => {
		expect(hanamiGpuQueueEffectivePriority({ kind: 'noteJudge', enqueuedAt: NOW - 600 * MIN, deadlineAt: null }, NOW)).toBe(90);
	});
});
