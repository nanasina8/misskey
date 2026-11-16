/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { HanamiGpuDispatcherService } from '@/core/hanami/HanamiGpuDispatcherService.js';
import { HanamiGpuQueueService, type HanamiGpuQueueTakenItem } from '@/core/hanami/HanamiGpuQueueService.js';
import type { HanamiGpuSpamScores } from '@/misc/hanami-gpu-queue.js';

// GPU の有無は確かめず、判定係は下の偽物（Python）に差し替える。配り役とキューは本物を、実 Redis で動かす。
const runtime = vi.hoisted(() => vi.fn(async () => ({ available: true, device: 'cuda', deviceName: 'fake', reason: null, probedAt: new Date().toISOString() })));
vi.mock('@/core/hanami/HanamiPythonRuntime.js', async importOriginal => ({
	...await importOriginal<typeof import('@/core/hanami/HanamiPythonRuntime.js')>(),
	probeHanamiNoteJudgeRuntime: runtime,
}));

/** 本物の判定係（HanamiGpuWorker.py）と同じ JSON 行のやり取りだけをする偽物。モデルは読み込まない。 */
const FAKE_WORKER = `
import json, os, sys

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()

emit({"op": "ready", "model": "fake", "runtime": {"device": "cuda"}})
handled = 0
while True:
    line = sys.stdin.readline()
    if line == "":
        break
    request = json.loads(line)
    op = request.get("op")
    if op == "spamJudge":
        handled += 1
        if os.environ.get("FAKE_WORKER_CRASH_ON_FIRST") == "1" and not os.path.exists(os.environ["FAKE_WORKER_MARK"]):
            open(os.environ["FAKE_WORKER_MARK"], "w").close()
            os._exit(3)
        emit({"op": "result", "requestId": request.get("requestId"),
              "results": [{"itemId": item["itemId"], "scores": {"normal": 1, "spam": 0, "scam": 0, "abuse": 0}} for item in request["items"]],
              "errors": [], "durationMs": 1})
    elif op == "noteJudge":
        handled += 1
        results, errors = [], []
        for item in request["items"]:
            if item["cleanedText"] == "boom":
                errors.append({"itemId": item["itemId"], "error": "RuntimeError: inference failed"})
            else:
                results.append({"itemId": item["itemId"], "output": {"noteId": item["noteId"], "ephemeralScore": 0.5, "interest": 4, "interestDist": [0, 0, 0, 1, 0], "contentType": 2,
                                                                     "sawBasis": item["settings"]["basis"]["interest5"], "hasFiles": item["hasFiles"]}})
        emit({"op": "result", "requestId": request.get("requestId"), "results": results, "errors": errors, "durationMs": 3})
    elif op == "topicJudge":
        handled += 1
        emit({"op": "result", "requestId": request.get("requestId"),
              "results": [{"itemId": item["itemId"], "output": {"status": "ok", "titles": [], "judgements": [{"kind": "daily", "topicId": topic, "probability": 0.9} for topic in item["job"]["dailyIds"]]}} for item in request["items"]],
              "errors": [], "durationMs": 5})
    elif op == "ping":
        emit({"op": "pong", "processed": handled, "uptimeSec": 0, "vramGiB": None})
    elif op == "exit":
        break
`;

let directory: string;
let server: ChildProcess;
let redis: Redis;

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), succ: vi.fn() };
const loggerService = { getLogger: () => logger };

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('condition was not met in time');
}

function makeDispatcher() {
	const queue = new HanamiGpuQueueService(redis);
	const dispatcher = new HanamiGpuDispatcherService(redis, queue, loggerService as never);
	const judged: Array<{ itemId: string; attempts: number; scores: HanamiGpuSpamScores | undefined }> = [];
	dispatcher.registerHandler('spamJudge', async (items: readonly HanamiGpuQueueTakenItem[], results) => {
		for (const item of items) judged.push({ itemId: item.itemId, attempts: item.attempts, scores: results.get(item.itemId) });
	});
	return { queue, dispatcher, judged };
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'hanami-gpu-dispatcher-'));
	const socket = join(directory, 'redis.sock');
	server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.once('exit', code => { reject(new Error(`Test Redis exited: ${code}`)); });
		server.stdout!.on('data', chunk => { if (/ready to accept connections/i.test(String(chunk))) resolve(); });
	});
	redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 10 });
	redis.on('error', () => { /* 最初の接続がソケット作成より先になることがある */ });
	await redis.connect();
	await writeFile(join(directory, 'fake_worker.py'), FAKE_WORKER);
}, 30_000);

afterAll(async () => {
	if (redis?.status === 'ready') await redis.quit();
	else redis?.disconnect();
	if (server?.exitCode == null) {
		const exited = once(server, 'exit');
		server.kill();
		await exited;
	}
	await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
	await redis.flushall();
	vi.stubEnv('HANAMI_GPU_WORKER_SCRIPT', join(directory, 'fake_worker.py'));
	vi.stubEnv('HANAMI_FORYOU_PYTHON', 'python3');
	vi.stubEnv('FAKE_WORKER_MARK', join(directory, `crashed-${Date.now()}`));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('はなみ GPU の配り役（HanamiGpuDispatcherService）', () => {
	test('順番待ちを判定係に渡して結果を受け取り係に届け、止めると判定係も終わる', async () => {
		const { queue, dispatcher, judged } = makeDispatcher();
		await queue.enqueue('spamJudge', 'n1', { text: 'a' });
		await queue.enqueue('spamJudge', 'n2', { text: 'b' });

		dispatcher.start();
		try {
			await waitFor(() => judged.length === 2);
			expect(judged.map(item => item.itemId).sort()).toEqual(['n1', 'n2']);
			expect(judged.every(item => item.scores?.normal === 1)).toBe(true);
			// 判定が終わった項目は本体も消え、同じ itemId をまた入れられる。
			await waitFor(async () => (await queue.consistency('spamJudge')).bodyOnly === 0 && await queue.pending('spamJudge') === 0);
			const status = await dispatcher.getStatus();
			expect(status?.workerPid).toEqual(expect.any(Number));
		} finally {
			await dispatcher.stop();
		}
		expect((await dispatcher.getStatus())?.state).toBe('stopped');
		expect((await dispatcher.getStatus())?.workerPid).toBeNull();
	}, 30_000);

	test('前の配り役が判定の途中で止まって取り出されたままになった項目を、リーダーになった時に拾い直す', async () => {
		const { queue, dispatcher, judged } = makeDispatcher();
		await queue.enqueue('spamJudge', 'orphan-1', { text: 'a' });
		await queue.enqueue('spamJudge', 'orphan-2', { text: 'b' });
		// 前の配り役が取り出したまま止まった（complete も retry も呼ばれていない）。
		expect(await queue.take('spamJudge', 2)).toHaveLength(2);
		await queue.setInflight('spamJudge', 2);
		// 入れてから 5 分たったことにする（入れている最中の項目と区別するための猶予は 60 秒）。
		for (const itemId of ['orphan-1', 'orphan-2']) {
			const body = JSON.parse((await redis.hget('hanami:gpuq:v1:item:spamJudge', itemId))!);
			await redis.hset('hanami:gpuq:v1:item:spamJudge', itemId, JSON.stringify({ ...body, enqueuedAt: Date.now() - 5 * 60_000 }));
		}
		await queue.enqueue('spamJudge', 'fresh', { text: 'c' });
		expect(await queue.consistency('spamJudge')).toMatchObject({ inflight: 2 });

		dispatcher.start();
		try {
			await waitFor(() => judged.length === 3);
			expect(judged.map(item => item.itemId).sort()).toEqual(['fresh', 'orphan-1', 'orphan-2']);
			// 拾い直した分は 1 回やり直した扱い。
			expect(judged.find(item => item.itemId === 'orphan-1')?.attempts).toBe(1);
			expect(judged.find(item => item.itemId === 'fresh')?.attempts).toBe(0);
			await waitFor(async () => {
				const state = await queue.consistency('spamJudge');
				return state.bodyOnly === 0 && state.listOnly === 0 && state.inflight === 0;
			});
		} finally {
			await dispatcher.stop();
		}
	}, 30_000);

	test('判定の途中で判定係が落ちたら項目を列に戻してロックを返し、次に動いたときに判定し終える', async () => {
		vi.stubEnv('FAKE_WORKER_CRASH_ON_FIRST', '1');
		const first = makeDispatcher();
		await first.queue.enqueue('spamJudge', 'n1', { text: 'a' });

		first.dispatcher.start();
		try {
			await waitFor(async () => (await first.dispatcher.getStatus())?.state === 'failed', 10_000);
			// 落ちた回の項目は捨てず、1 回やり直した扱いで列に戻す。GPU のロックも返す（ほかの判定を止めない）。
			expect(first.judged).toHaveLength(0);
			expect(await first.queue.peek('spamJudge', 5)).toEqual([expect.objectContaining({ itemId: 'n1', attempts: 1 })]);
			expect(await redis.get('hanami:llm:exclusive:v1')).toBeNull();
			expect((await first.dispatcher.getStatus())?.workerPid).toBeNull();
		} finally {
			// 落ちたあとは 30 秒あけてからやり直す。ここでは待たずに止めて、次の配り役で続きを確かめる。
			await first.dispatcher.stop();
		}

		const second = makeDispatcher();
		second.dispatcher.start();
		try {
			await waitFor(() => second.judged.length === 1, 15_000);
			expect(second.judged[0]).toMatchObject({ itemId: 'n1', attempts: 1 });
			expect((await second.queue.stats()).spamJudge.failed).toBe(0);
		} finally {
			await second.dispatcher.stop();
		}
	}, 40_000);

	test('判定係を起動できないときは、すぐ「失敗」になって項目は列に残り、停止も待たされない', async () => {
		vi.stubEnv('HANAMI_FORYOU_PYTHON', join(directory, 'no-such-python'));
		const { queue, dispatcher, judged } = makeDispatcher();
		await queue.enqueue('spamJudge', 'n1', { text: 'a' });

		dispatcher.start();
		const startedAt = Date.now();
		try {
			// 以前は 'exit' が来ないので準備待ちの上限（10 分）まで「読み込み中」のままだった。
			await waitFor(async () => (await dispatcher.getStatus())?.state === 'failed', 10_000);
			expect(judged).toHaveLength(0);
			expect(await queue.pending('spamJudge')).toBe(1);
		} finally {
			await dispatcher.stop();
		}
		// 間隔あけ（30 秒）の途中でも、止めるとすぐ終わる。
		expect(Date.now() - startedAt).toBeLessThan(15_000);
		expect((await dispatcher.getStatus())?.state).toBe('stopped');
	}, 40_000);
	test('投稿の判定・話題の判定を同じ判定係に渡し、種類ごとの形の結果を受け取り係に届ける。重要度の順は 話題 → 投稿', async () => {
		const queue = new HanamiGpuQueueService(redis);
		const dispatcher = new HanamiGpuDispatcherService(redis, queue, loggerService as never);
		const order: string[] = [];
		const notes: Array<{ itemId: string; output: unknown; error: string | undefined }> = [];
		const topics: unknown[] = [];
		dispatcher.registerHandler<Record<string, unknown>>('noteJudge', async (items, results, errors) => {
			order.push('noteJudge');
			for (const item of items) notes.push({ itemId: item.itemId, output: results.get(item.itemId), error: errors.get(item.itemId) });
		});
		dispatcher.registerHandler<Record<string, unknown>>('topicJudge', async (items, results) => {
			order.push('topicJudge');
			for (const item of items) topics.push(results.get(item.itemId));
		});
		const settings = { basis: { interest5: 'とても興味深い' }, examples: [] };
		await queue.enqueue('noteJudge', '1:n1', { noteId: 'n1', promptVersion: 1, cleanedText: '役立つ運用メモです。', hasFiles: true, settings });
		await queue.enqueue('noteJudge', '1:n2', { noteId: 'n2', promptVersion: 1, cleanedText: 'boom', hasFiles: false, settings });
		await queue.enqueue('topicJudge', 'current', { job: { topics: [{ topicId: 'a', text: 'A' }], dailyIds: ['a'], pairs: [], titles: [] } });

		dispatcher.start();
		try {
			await waitFor(() => notes.length === 2 && topics.length === 1);
			expect(order).toEqual(['topicJudge', 'noteJudge']);
			expect(topics).toEqual([{ status: 'ok', titles: [], judgements: [{ kind: 'daily', topicId: 'a', probability: 0.9 }] }]);
			// 判定係には、投稿の本文・画像の有無・判定の基準がそのまま渡っている。
			expect(notes.find(note => note.itemId === '1:n1')).toEqual({ itemId: '1:n1', error: undefined, output: { noteId: 'n1', ephemeralScore: 0.5, interest: 4, interestDist: [0, 0, 0, 1, 0], contentType: 2, sawBasis: 'とても興味深い', hasFiles: true } });
			// 判定係が失敗を返した投稿は、結果なし・理由つきで届く。
			expect(notes.find(note => note.itemId === '1:n2')).toEqual({ itemId: '1:n2', output: undefined, error: 'RuntimeError: inference failed' });
			await waitFor(async () => await queue.pending('noteJudge') === 0 && await queue.pending('topicJudge') === 0);
		} finally {
			await dispatcher.stop();
		}
	}, 30_000);

	test('CPU の処理（おすすめの計算・好みの学習）が待っていても判定係を降ろさない。「判定の試し」が待っていれば降ろして譲る', async () => {
		const { queue, dispatcher, judged } = makeDispatcher();
		await queue.enqueue('spamJudge', 'n1', { text: 'a' });

		dispatcher.start();
		try {
			await waitFor(() => judged.length === 1);
			const workerPid = (await dispatcher.getStatus())?.workerPid;
			expect(workerPid).toEqual(expect.any(Number));

			// 以前は、これらの目印が立つと仕事の無い判定係を降ろしていた（次の判定でモデルを読み込み直す）。
			await redis.set('hanami:llm:wanted:als', String(Date.now()), 'EX', 150);
			await redis.set('hanami:llm:wanted:tasteTick', String(Date.now()), 'EX', 150);
			await redis.set('hanami:llm:wanted:noteJudge', String(Date.now()), 'EX', 150);
			await new Promise(resolve => setTimeout(resolve, 2500));
			expect((await dispatcher.getStatus())?.workerPid).toBe(workerPid);
			await queue.enqueue('spamJudge', 'n2', { text: 'b' });
			await waitFor(() => judged.length === 2);
			expect((await dispatcher.getStatus())?.workerPid).toBe(workerPid);
			expect(await redis.get('hanami:llm:exclusive:v1')).toMatch(/^gpuWorker:/);

			// 自分でモデルを読み込む「判定の試し」（管理画面）には、今までどおり譲る。
			await redis.set('hanami:llm:wanted:judgeTrial', String(Date.now()), 'EX', 150);
			await waitFor(async () => (await dispatcher.getStatus())?.state === 'yielded', 10_000);
			expect((await dispatcher.getStatus())?.workerPid).toBeNull();
			expect(await redis.get('hanami:llm:exclusive:v1')).toBeNull();
		} finally {
			await dispatcher.stop();
		}
	}, 40_000);
});
