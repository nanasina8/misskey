/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect } from 'vitest';
import { checkHanamiGpuQueue, simulateHanamiGpuQueueOrder, type HanamiGpuQueueCheckInput } from '@/misc/hanami-gpu-queue-checks.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;
const emptyKind = { length: 0, inflight: 0, oldestWaitSec: null, listOnly: 0, bodyOnly: 0 };

function input(overrides: Partial<HanamiGpuQueueCheckInput> = {}): HanamiGpuQueueCheckInput {
	return {
		now: NOW,
		status: { state: 'idle', since: NOW - 60 * MIN, updatedAt: NOW - 5_000, workerPid: 123, inflight: null },
		leaderPid: '42',
		lockHolder: 'gpuWorker',
		waiters: [],
		kinds: { judgeTrial: { ...emptyKind }, spamJudge: { ...emptyKind }, spamScan: { ...emptyKind } },
		nextBestPriority: null,
		runtimeAvailable: true,
		scan: { running: false, exhausted: false },
		events: [],
		batches: [],
		...overrides,
	};
}

const level = (checks: ReturnType<typeof checkHanamiGpuQueue>, id: string) => checks.find(c => c.id === id)?.level;

describe('GPU キューの見張り', () => {
	test('ふつうの状態では error も warn も出ない', () => {
		const checks = checkHanamiGpuQueue(input());
		expect(checks.filter(c => c.level === 'error' || c.level === 'warn')).toEqual([]);
	});

	test('状態が1分以上書かれていなければ「配り役が止まっています」', () => {
		expect(level(checkHanamiGpuQueue(input({ status: { state: 'running', since: NOW - 60 * MIN, updatedAt: NOW - 2 * MIN, workerPid: 1, inflight: null } })), 'dispatcherAlive')).toBe('error');
	});

	test('待ちがあるのにリーダーがいなければ error', () => {
		const kinds = { judgeTrial: { ...emptyKind }, spamJudge: { ...emptyKind, length: 3, oldestWaitSec: 10 }, spamScan: { ...emptyKind } };
		expect(level(checkHanamiGpuQueue(input({ leaderPid: null, kinds })), 'leader')).toBe('error');
	});

	test('判定係が載っているのにロックがほかの判定のものなら error（GPU に2つ載る）', () => {
		expect(level(checkHanamiGpuQueue(input({ lockHolder: 'noteJudge' })), 'lockConsistency')).toBe('error');
	});

	test('判定係が降りているのに gpuWorker のロックが残っていれば warn', () => {
		expect(level(checkHanamiGpuQueue(input({ status: { state: 'yielded', since: NOW - 60 * MIN, updatedAt: NOW, workerPid: null, inflight: null }, waiters: ['noteJudge'] })), 'lockConsistency')).toBe('warn');
	});

	test('重要度の低い判定に譲っていれば error（優先度の逆転）', () => {
		const checks = checkHanamiGpuQueue(input({
			status: { state: 'yielded', since: NOW - 60 * MIN, updatedAt: NOW, workerPid: null, inflight: null },
			lockHolder: 'noteJudge',
			waiters: ['noteJudge'],
			nextBestPriority: 90,
		}));
		expect(level(checks, 'priorityInversion')).toBe('error');
	});

	test('重要度の高い判定に譲っているのは ok', () => {
		const checks = checkHanamiGpuQueue(input({
			status: { state: 'yielded', since: NOW - 60 * MIN, updatedAt: NOW, workerPid: null, inflight: null },
			lockHolder: 'noteJudge',
			waiters: ['noteJudge'],
			nextBestPriority: 10,
		}));
		expect(level(checks, 'priorityInversion')).toBe('ok');
	});

	test('判定係が載っていて待ちがあるのに10分判定していなければ error', () => {
		const kinds = { judgeTrial: { ...emptyKind }, spamJudge: { ...emptyKind, length: 5, oldestWaitSec: 700 }, spamScan: { ...emptyKind } };
		const checks = checkHanamiGpuQueue(input({ kinds, events: [{ at: NOW - 20 * MIN, type: 'batch' }] }));
		expect(level(checks, 'throughput')).toBe('error');
		expect(level(checks, 'stuck:spamJudge')).toBeUndefined(); // 15分未満なので待ちすぎではない
	});

	test('判定係に渡したばかり（判定中）なら、判定が無くても「進んでいない」とは言わない', () => {
		const kinds = { judgeTrial: { ...emptyKind }, spamJudge: { ...emptyKind, length: 0, inflight: 1 }, spamScan: { ...emptyKind } };
		const checks = checkHanamiGpuQueue(input({ kinds, status: { state: 'idle', since: NOW - 60 * MIN, updatedAt: NOW, workerPid: 1, inflight: { kind: 'spamJudge', count: 1, startedAt: NOW - 9_000 } } }));
		expect(level(checks, 'throughput')).toBe('ok');
	});

	test('判定係が使えるようになってから10分たっていなければ「進んでいない」とは言わない', () => {
		const kinds = { judgeTrial: { ...emptyKind }, spamJudge: { ...emptyKind, length: 2, oldestWaitSec: 60 }, spamScan: { ...emptyKind } };
		const checks = checkHanamiGpuQueue(input({ kinds, events: [{ at: NOW - 2 * MIN, type: 'workerReady' }] }));
		expect(level(checks, 'throughput')).toBe('ok');
	});

	test('列と本体の食い違い（迷子）を warn で出す', () => {
		const kinds = { judgeTrial: { ...emptyKind }, spamJudge: { ...emptyKind, bodyOnly: 2 }, spamScan: { ...emptyKind } };
		expect(level(checkHanamiGpuQueue(input({ kinds })), 'consistency')).toBe('warn');
	});

	test('判定係に渡して6分以上返事が無ければ error', () => {
		expect(level(checkHanamiGpuQueue(input({ status: { state: 'running', since: NOW - 60 * MIN, updatedAt: NOW, workerPid: 1, inflight: { kind: 'spamJudge', count: 4, startedAt: NOW - 7 * MIN } } })), 'inflight')).toBe('error');
	});

	test('判定係を30分に3回以上起動し直していれば warn', () => {
		const events = [1, 2, 3].map(i => ({ at: NOW - i * MIN, type: 'workerSpawn' }));
		expect(level(checkHanamiGpuQueue(input({ events })), 'workerStart')).toBe('warn');
	});

	test('保存の失敗や3回失敗して捨てた項目があれば warn', () => {
		expect(level(checkHanamiGpuQueue(input({ events: [{ at: NOW - MIN, type: 'handlerFailed', kind: 'spamJudge', detail: 'boom' }] })), 'failures')).toBe('warn');
		expect(level(checkHanamiGpuQueue(input({ events: [{ at: NOW - MIN, type: 'giveUp', kind: 'spamJudge', count: 1 }] })), 'failures')).toBe('warn');
	});

	test('全体スキャンが実行中なのにキューに無く、5分補充されていなければ warn', () => {
		expect(level(checkHanamiGpuQueue(input({ scan: { running: true, exhausted: false }, events: [{ at: NOW - 10 * MIN, type: 'refill' }] })), 'scanRefill')).toBe('warn');
		expect(level(checkHanamiGpuQueue(input({ scan: { running: true, exhausted: true } })), 'scanRefill')).toBeUndefined();
	});

	test('1件ごとの判定エラーが5%を超えたら warn', () => {
		const batches = [{ at: NOW, kind: 'spamJudge', size: 10, ok: 8, errors: 2, durationMs: 1000 }];
		expect(level(checkHanamiGpuQueue(input({ batches })), 'itemErrors')).toBe('warn');
	});
});

describe('次にやる順のなぞり', () => {
	test('先頭どうしを比べて種類を選び、その種類から1回分ずつ取る', () => {
		const order = simulateHanamiGpuQueueOrder({
			judgeTrial: [],
			spamJudge: [{ itemId: 'j1', enqueuedAt: NOW - 1000, deadlineAt: null, attempts: 0 }, { itemId: 'j2', enqueuedAt: NOW - 500, deadlineAt: null, attempts: 0 }],
			spamScan: [{ itemId: 's1', enqueuedAt: NOW - 30 * MIN, deadlineAt: null, attempts: 1 }],
		}, NOW, 10);
		expect(order.map(o => o.itemId)).toEqual(['j1', 'j2', 's1']);
		expect(order[0]).toMatchObject({ round: 1, priority: { base: 90, aging: 0, total: 90 } });
		expect(order[2]).toMatchObject({ round: 2, attempts: 1, priority: { base: 10, aging: 30, total: 40 } });
	});

	test('試すは1件ずつ（maxBatch=1）で、締め切りの加点が付く', () => {
		const order = simulateHanamiGpuQueueOrder({
			judgeTrial: [{ itemId: 't1', enqueuedAt: NOW - 30_000, deadlineAt: NOW + 30_000, attempts: 0 }, { itemId: 't2', enqueuedAt: NOW, deadlineAt: NOW + 60_000, attempts: 0 }],
			spamJudge: [],
			spamScan: [],
		}, NOW, 10);
		expect(order.map(o => [o.itemId, o.round])).toEqual([['t1', 1], ['t2', 2]]);
		expect(order[0].priority.deadline).toBe(15);
		expect(order[0].deadlineInSec).toBe(30);
	});
});
