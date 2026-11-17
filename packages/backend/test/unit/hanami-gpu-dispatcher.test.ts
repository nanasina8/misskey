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
import { HanamiRankBacktestService } from '@/core/hanami/HanamiRankBacktestService.js';
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
    elif op == "promptChoice":
        handled += 1
        results, errors = [], []
        for item in request["items"]:
            # 文面の最後の区切り（採点する投稿）に「好き」があれば、高い確率で「はい」
            target = item["prompt"].split("[")[-1]
            if "boom" in target:
                errors.append({"itemId": item["itemId"], "error": "RuntimeError: inference failed"})
            else:
                results.append({"itemId": item["itemId"], "output": {"probabilities": [0.9, 0.1] if "好き" in target else [0.2, 0.8]}})
        emit({"op": "result", "requestId": request.get("requestId"), "results": results, "errors": errors, "durationMs": 2})
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

/**
 * 並べ替えの物差し（HanamiRankBacktestService）を、本物の配り役・順番待ち・実 Redis と、偽の判定係で通しで動かす。
 * DB だけ差し替える（見た記録・投稿の文・本人が前に反応した投稿）。
 */
function makeBacktest(data: {
	samples: Array<{ uid: string; nid: string; author?: string; cluster?: string; at: string; source: string; relationship: string; engaged: boolean; interest: number | null }>;
	notes: Record<string, string>;
	history: Record<string, string[]>;
	/** 本人が作者の投稿に付けた反応（prior の材料）。id は「r@時刻」の形 */
	prior?: Record<string, Array<{ id: string; noteId: string; author: string }>>;
	/** 投稿に本人以外が付けた反応（social・reactions の材料） */
	reactions?: Array<{ noteId: string; id: string; followed: boolean }>;
	/** 投稿の時刻（ID から読む時刻の代わり） */
	postedAt?: Record<string, string>;
}) {
	const queue = new HanamiGpuQueueService(redis);
	const dispatcher = new HanamiGpuDispatcherService(redis, queue, loggerService as never);
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	const manager = {
		query: async (sql: string, params: unknown[] = []) => {
			if (sql.startsWith('SET ')) return [];
			queries.push({ sql, params });
			if (sql.includes('FROM "hanami_metrics_event"')) return data.samples.slice(0, params[1] as number).map(row => ({ author: `author-${row.nid}`, cluster: 'none', ...row }));
			if (sql.includes('AS followed')) return (data.reactions ?? []).filter(row => (params[1] as string[]).includes(row.noteId));
			if (sql.includes('AS author')) return (data.prior?.[params[0] as string] ?? []).filter(row => (params[3] as string[]).includes(row.author));
			if (sql.includes('SELECT n.text')) return (data.history[params[0] as string] ?? []).slice(0, params[3] as number).map(text => ({ text }));
			if (sql.includes('FROM note WHERE id = ANY')) return (params[0] as string[]).flatMap(id => data.notes[id] == null ? [] : [{ id, text: data.notes[id] }]);
			return [];
		},
	};
	const db = { transaction: async <T>(run: (m: typeof manager) => Promise<T>) => await run(manager) };
	// 時刻は ID から読む。テストでは、反応の ID を「r@時刻」、投稿の時刻を表で渡す。
	const ids = {
		gen: (at?: number) => `id${at ?? 0}`,
		parse: (id: string) => ({ date: new Date(id.includes('@') ? id.split('@')[1] : (data.postedAt?.[id] ?? '2026-11-17T00:00:00Z')) }),
	};
	const service = new HanamiRankBacktestService(redis, db as never, ids as never, queue, dispatcher);
	service.onModuleInit();
	return { queue, dispatcher, service, queries };
}

const BACKTEST_DATA = {
	samples: [
		// u1 は前に反応した投稿が 3 件ある（personal の対象）。u2 は 1 件だけ（personal では対象外）。
		{ uid: 'u1', nid: 'n1', at: '2026-11-17T10:00:00Z', source: 'neighborTrending', relationship: 'directFollow', engaged: true, interest: 2 },
		{ uid: 'u1', nid: 'n2', at: '2026-11-17T09:00:00Z', source: 'globalPopular', relationship: 'unknown', engaged: false, interest: 4 },
		{ uid: 'u2', nid: 'n3', at: '2026-11-17T08:00:00Z', source: 'fof', relationship: 'unknown', engaged: true, interest: null },
		{ uid: 'u2', nid: 'n4', at: '2026-11-17T07:00:00Z', source: 'exploration', relationship: 'unknown', engaged: false, interest: 3 },
		// 採点の前に消えた投稿（文を読めない）
		{ uid: 'u1', nid: 'gone', at: '2026-11-17T06:00:00Z', source: 'globalPopular', relationship: 'unknown', engaged: false, interest: null },
	],
	notes: { n1: '好きな猫の写真の話', n2: '税金の計算の話', n3: '好きな犬の話', n4: '株価の話' },
	history: { u1: ['猫がかわいい', '好きな本の話', '犬もかわいい'], u2: ['一度だけ反応した投稿'] },
};

describe('並べ替えの物差し（HanamiRankBacktestService）', () => {
	test('始めると、ほかの仕事が無いときに判定係が少しずつ採点し、付け方ごとの結果が出る', async () => {
		const { queue, dispatcher, service, queries } = makeBacktest(BACKTEST_DATA);
		expect(await service.status()).toEqual({ active: false, run: null });

		const run = await service.start({ days: 30, limit: 100 }, 'manual', Date.parse('2026-11-17T12:00:00Z'));
		expect(run).toMatchObject({ samples: 5, variants: ['personal', 'generic'], finishedAt: null });
		// 対象は「過去 30 日・新しい順に 100 件まで」
		expect(queries[0].params).toEqual([new Date('2026-10-18T12:00:00Z'), 100]);
		// 実行中にもう 1 つは始められない
		await expect(service.start({ days: 30, limit: 100 }, 'manual')).rejects.toThrow('already running');
		expect((await service.status()).run?.progress).toEqual([
			{ variant: 'personal', scored: 0, pending: 5, skipped: 0, errors: 0 },
			{ variant: 'generic', scored: 0, pending: 5, skipped: 0, errors: 0 },
		]);

		dispatcher.start();
		try {
			await waitFor(async () => (await service.status()).active === false, 30_000);
		} finally {
			await dispatcher.stop();
		}

		const status = await service.status();
		expect(status.run).toMatchObject({ id: run.id, startedBy: 'manual', days: 30, limit: 100, samples: 5, compared: 2 });
		expect(status.run?.finishedAt).not.toBeNull();
		// personal は、前の反応が少ない u2 の 2 件と、消えた投稿を飛ばす。generic は消えた投稿だけ飛ばす。
		expect(status.run?.progress).toEqual([
			{ variant: 'personal', scored: 2, pending: 0, skipped: 3, errors: 0 },
			{ variant: 'generic', scored: 4, pending: 0, skipped: 1, errors: 0 },
		]);
		expect(await queue.pending('rankBacktest')).toBe(0);
		// personal の文面には、見た時刻より前に本人が反応した投稿が入る（採点する投稿そのものは入れない）
		const historyQuery = queries.find(query => query.sql.includes('SELECT n.text'))!;
		expect(historyQuery.params).toEqual(['u1', `id${Date.parse('2026-11-17T10:00:00Z')}`, 'n1', 8]);

		// 比べるのは、どの付け方でも点数が付いた 2 件（u1 の n1・n2）だけ。
		const result = (variant: string, subset: string) => status.run!.results.find(row => row.variant === variant && row.subset === subset)!;
		for (const variant of ['personal', 'generic', 'follow']) {
			// 反応した n1（「好き」を含む・フォロー中）のほうが点数が高い
			expect(result(variant, 'all')).toMatchObject({ seen: 2, engaged: 1, auc: 1, withinUserAuc: 1, withinUsers: 1 });
		}
		// いまの判定の「興味」は、反応した n1 のほうが低い（2 対 4）
		expect(result('interest', 'all')).toMatchObject({ seen: 2, engaged: 1, auc: 0 });
		expect(result('generic', 'all').buckets.map(bucket => [bucket.from, bucket.to, bucket.seen, bucket.engaged])).toEqual([[0.2, 0.2, 1, 0], [0.9, 0.9, 1, 1]]);
		// 関係ごとに分けると 1 件ずつなので、比べられない（null）
		expect(result('generic', 'unknown')).toMatchObject({ seen: 1, engaged: 0, auc: null });
		expect(result('generic', 'directFollow')).toMatchObject({ seen: 1, engaged: 1, auc: null });
	}, 60_000);

	test('判定係が失敗を返した記録は errors に数え、残りはそのまま採点し終える', async () => {
		const { dispatcher, service } = makeBacktest({ ...BACKTEST_DATA, notes: { ...BACKTEST_DATA.notes, n2: 'boom' } });
		await service.start({ days: 30, limit: 100, variants: ['generic'] }, 'manual');
		dispatcher.start();
		try {
			await waitFor(async () => (await service.status()).active === false, 30_000);
		} finally {
			await dispatcher.stop();
		}
		const status = await service.status();
		expect(status.run?.progress).toEqual([{ variant: 'generic', scored: 3, pending: 0, skipped: 1, errors: 1 }]);
		expect(status.run?.compared).toBe(3);
	}, 60_000);

	test('進まなくなった実行は、やり直しの指定で打ち切って始め直せる（順番待ちに残った分は捨て、付いた点数は残す）', async () => {
		const { queue, service } = makeBacktest(BACKTEST_DATA);
		const first = await service.start({ days: 30, limit: 100 }, 'manual');
		await service.refill();
		expect(await queue.length('rankBacktest')).toBe(6);
		// 別の種類の項目は巻き込まない
		await queue.enqueue('spamScan', 'other', { text: 'そのまま残る' });
		// 1 件だけ採点が済んだところで止まった、という状況
		await service.handleScored([{ itemId: `${first.id}:generic:0`, payload: null, enqueuedAt: 0, attempts: 0 }], new Map([[`${first.id}:generic:0`, { probabilities: [0.9, 0.1] }]]), new Map());

		await expect(service.start({ days: 30, limit: 100 }, 'manual')).rejects.toThrow('already running');
		const second = await service.start({ days: 30, limit: 100, variants: ['generic'], force: true }, 'manual');

		expect(second.id).not.toBe(first.id);
		expect(await queue.length('rankBacktest')).toBe(0);
		expect(await queue.length('spamScan')).toBe(1);
		expect(await redis.exists(`hanami:rankbt:v1:pending:${first.id}:personal`, `hanami:rankbt:v1:pending:${first.id}:generic`)).toBe(0);
		expect(await redis.hgetall(`hanami:rankbt:v1:scores:${first.id}:generic`)).toEqual({ 0: '0.900000' });
		expect(JSON.parse((await redis.get(`hanami:rankbt:v1:run:${first.id}`))!).finishedAt).not.toBeNull();
		expect(await service.status()).toMatchObject({ active: true, run: { id: second.id, progress: [{ variant: 'generic', scored: 0, pending: 5 }] } });
	});

	test('対象の記録が無ければ、何も採点せずに終わった実行として残る', async () => {
		const { queue, service } = makeBacktest({ samples: [], notes: {}, history: {} });
		const run = await service.start({ days: 7, limit: 100 }, 'manual');
		expect(run.finishedAt).not.toBeNull();
		await service.refill();
		expect(await queue.pending('rankBacktest')).toBe(0);
		expect(await service.status()).toMatchObject({ active: false, run: { samples: 0, compared: 0 } });
	});

	test('自動の実行は GPU を使わずにその場で終わる。前の実行から 7 日たつか、付け方の版が変わるまでは始めない', async () => {
		const { queue, service, queries } = makeBacktest(BACKTEST_DATA);
		// 実行がまだ無い → 既定（60 日・4,000 件まで）で始める。GPU の付け方は入れないので、順番待ちには何も入らず、すぐ終わる。
		await service.refill();
		const first = await service.status();
		expect(first).toMatchObject({ active: false, run: { startedBy: 'auto', days: 60, limit: 4000, samples: 5, compared: 5, progress: [] } });
		expect(first.run?.finishedAt).not.toBeNull();
		expect(queries[0].params[1]).toBe(4000);
		expect(await queue.pending('rankBacktest')).toBe(0);
		expect([...new Set(first.run!.results.map(row => row.variant))]).toEqual(['interest', 'follow', 'prior', 'social', 'reactions', 'fresh', 'clustered']);

		// 確かめるのは数時間に 1 回だけ。確かめる間隔が過ぎても、7 日たつまでは次を始めない。
		await service.refill();
		await redis.del('hanami:rankbt:v1:autoChecked');
		await service.refill();
		expect((await service.status()).run?.id).toBe(first.run?.id);

		// 付け方の版が古い実行しか無いとき（デプロイで付け方が増えた直後）は、7 日を待たずに取り直す。
		const key = `hanami:rankbt:v1:run:${first.run!.id}`;
		await redis.set(key, JSON.stringify({ ...JSON.parse((await redis.get(key))!), version: 1 }));
		await redis.del('hanami:rankbt:v1:autoChecked');
		await service.refill();
		expect((await service.status()).run?.id).not.toBe(first.run?.id);
	});

	test('記録と DB の値を使う付け方は、見た時点までに分かっていたことだけを数える', async () => {
		const seenAt = '2026-11-17T10:00:00Z';
		const { service } = makeBacktest({
			samples: [{ uid: 'u1', nid: 'n1', author: 'a1', cluster: 'clustered', at: seenAt, source: 'neighborTrending', relationship: 'unknown', engaged: true, interest: null }],
			notes: { n1: '好きな猫の写真の話' },
			history: {},
			postedAt: { n1: '2026-11-17T02:00:00Z' },
			prior: { u1: [
				{ id: 'r@2026-11-10T00:00:00Z', noteId: 'other-1', author: 'a1' }, // 数える
				{ id: 'r@2026-10-01T00:00:00Z', noteId: 'other-2', author: 'a1' }, // 数える（90 日以内）
				{ id: 'r@2026-08-01T00:00:00Z', noteId: 'other-3', author: 'a1' }, // 90 日より前 → 数えない
				{ id: 'r@2026-11-17T11:00:00Z', noteId: 'other-4', author: 'a1' }, // 見たあと → 数えない
				{ id: 'r@2026-11-17T09:00:00Z', noteId: 'n1', author: 'a1' }, // 採点する投稿そのもの → 数えない
			] },
			reactions: [
				{ noteId: 'n1', id: 'r@2026-11-17T03:00:00Z', followed: true }, // 見る前・フォロー中の人
				{ noteId: 'n1', id: 'r@2026-11-17T04:00:00Z', followed: false }, // 見る前・ほかの人
				{ noteId: 'n1', id: 'r@2026-11-17T12:00:00Z', followed: true }, // 見たあと → 数えない
			],
		});
		await service.start({ days: 30, limit: 100, variants: [] }, 'manual');

		const status = await service.status();
		const score = (variant: string) => status.run!.results.find(row => row.variant === variant && row.subset === 'all')!.buckets[0]?.from;
		expect(score('prior')).toBe(2);
		expect(score('social')).toBe(1);
		expect(score('reactions')).toBe(2);
		expect(score('fresh')).toBe(-8); // 投稿から 8 時間
		expect(score('clustered')).toBe(1);
		expect(score('follow')).toBe(0);
		// 記録が少ないので、組み合わせた点数の検証はしない
		expect(status.run?.model).toBeNull();
	});
});

