/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type Logger from '@/logger.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import { HanamiGpuQueueService, type HanamiGpuQueueTakenItem } from '@/core/hanami/HanamiGpuQueueService.js';
import { acquireHanamiLocalLlmLock, findHanamiLlmWaiters, HANAMI_LOCAL_LLM_LOCK_KEY, type HanamiLocalLlmLock } from '@/core/hanami/HanamiLocalLlmLock.js';
import { cpus } from 'node:os';
import { HANAMI_PYTHON_THREAD_ENV, prepareHanamiPythonCommand, probeHanamiNoteJudgeRuntime, resolveHanamiGpuWorkerScript } from '@/core/hanami/HanamiPythonRuntime.js';
import {
	HANAMI_GPU_QUEUE_KINDS,
	HANAMI_GPU_QUEUE_POLICIES,
	chooseHanamiGpuQueueKind,
	hanamiGpuQueueEffectivePriority,
	shouldYieldHanamiGpu,
	type HanamiGpuQueueKind,
	type HanamiGpuSpamScores,
} from '@/misc/hanami-gpu-queue.js';

const LEADER_KEY = 'hanami:gpuq:v1:leader';
const STATUS_KEY = 'hanami:gpuq:v1:status';
const LEADER_TTL_SECONDS = 30;
const LEADER_RENEW_INTERVAL_MS = 10_000;
const LEADER_RETRY_MS = 15_000;
const IDLE_SLEEP_MS = 2_000;
/** 判定係が載っていて暇なとき、状態（GPU メモリ等）を聞く間隔 */
const PING_INTERVAL_MS = 30_000;
const NO_GPU_WAIT_MS = 60_000;
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const RESULT_TIMEOUT_MS = 5 * 60 * 1000;
const EXIT_GRACE_MS = 10_000;

export type HanamiGpuQueueState = 'idle' | 'unloaded' | 'running' | 'loading' | 'yielded' | 'waitingGpu' | 'noGpu' | 'failed' | 'stopped';

export type HanamiGpuDispatcherStatus = {
	state: HanamiGpuQueueState;
	since: number;
	pid: number;
	processed: number;
	workerUptimeSec: number | null;
	vramGiB: number | null;
	lastBatch: { kind: HanamiGpuQueueKind; size: number; durationMs: number; at: number } | null;
	lastError: string | null;
	/** この状態を書いた時刻（古ければ配り役が止まっている） */
	updatedAt: number;
	/** いま判定係に渡している1回分 */
	inflight: { kind: HanamiGpuQueueKind; count: number; startedAt: number } | null;
	/** 判定係の Python のプロセス ID（載っていなければ null） */
	workerPid: number | null;
};

export type HanamiGpuQueueHandler = (
	items: readonly HanamiGpuQueueTakenItem[],
	results: ReadonlyMap<string, HanamiGpuSpamScores>,
	errors: ReadonlyMap<string, string>,
	durationMs: number | null,
) => Promise<void>;

type PendingRequest = {
	resolve: (value: WorkerResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type WorkerResponse =
	| { op: 'result'; requestId: string; results: Array<{ itemId: string; scores: HanamiGpuSpamScores }>; errors: Array<{ itemId: string; error: string }>; durationMs: number }
	| { op: 'error'; error: string };

/**
 * 配り役。ジョブキューのプロセスのうち1つだけがリーダーになり、常駐の判定係（Python）を
 * 1つ持って、順番待ちから次にやる仕事を選んで判定係に渡す。AiModeration* には依存しない
 * （受け取り係・補充係は registerHandler / registerRefill で登録される）。
 */
@Injectable()
export class HanamiGpuDispatcherService {
	private logger: Logger;
	private handlers = new Map<HanamiGpuQueueKind, HanamiGpuQueueHandler>();
	private refills = new Map<HanamiGpuQueueKind, () => Promise<void>>();

	private running = false;
	private loopPromise: Promise<void> | null = null;
	private leaderToken: string | null = null;
	private isLeader = false;
	private lastLeaderRenewAt = 0;
	private backoffMs = 30_000;

	private worker: ChildProcess | null = null;
	private workerStdin: NodeJS.WritableStream | null = null;
	private stdoutLines: Interface | null = null;
	private pending = new Map<string, PendingRequest>();
	private workerReady = false;

	private state: HanamiGpuQueueState = 'stopped';
	private stateSince = Date.now();
	private processed = 0;
	private workerUptimeSec: number | null = null;
	private vramGiB: number | null = null;
	private lastBatch: HanamiGpuDispatcherStatus['lastBatch'] = null;
	private lastError: string | null = null;
	private lock: HanamiLocalLlmLock | null = null;
	private leaderTimer: NodeJS.Timeout | null = null;
	private lastPingAt = 0;
	private inflight: HanamiGpuDispatcherStatus['inflight'] = null;
	private statusTimer: NodeJS.Timeout | null = null;
	private spawnedAt = 0;

	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		private hanamiGpuQueueService: HanamiGpuQueueService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('hanami-gpu-dispatcher');
	}

	@bindThis
	public registerHandler(kind: HanamiGpuQueueKind, handler: HanamiGpuQueueHandler): void {
		this.handlers.set(kind, handler);
	}

	@bindThis
	public registerRefill(kind: HanamiGpuQueueKind, refill: () => Promise<void>): void {
		this.refills.set(kind, refill);
	}

	@bindThis
	public async getStatus(): Promise<HanamiGpuDispatcherStatus | null> {
		const raw = await this.redis.get(STATUS_KEY);
		if (raw == null) return null;
		try {
			return JSON.parse(raw) as HanamiGpuDispatcherStatus;
		} catch {
			return null;
		}
	}

	@bindThis
	public start(): void {
		if (this.running) return;
		this.running = true;
		this.setState('idle');
		// 読み込みや長い判定の間も状態を書き続ける（書かれなくなったら止まっている、と見分けられるように）
		this.statusTimer = setInterval(() => {
			void this.persistStatus();
		}, 15_000);
		this.statusTimer.unref();
		this.loopPromise = this.loop().catch(err => {
			this.logger.error('dispatcher loop crashed', { err });
		});
	}

	@bindThis
	public async stop(): Promise<void> {
		this.running = false;
		if (this.statusTimer != null) clearInterval(this.statusTimer);
		this.statusTimer = null;
		const wasLeader = this.isLeader;
		if (this.loopPromise != null) {
			await Promise.race([this.loopPromise, new Promise<void>(resolve => setTimeout(resolve, EXIT_GRACE_MS))]);
			this.loopPromise = null;
		}
		await this.teardownWorker();
		this.setState('stopped');
		// リーダーだったときだけ「止まった」と書く（リーダーでないプロセスが書くと、動いているリーダーの状態を上書きしてしまう）
		if (wasLeader) await this.persistStatus(true);
		await this.releaseLeader();
	}

	@bindThis
	public isRunning(): boolean {
		return this.running;
	}

	//#region leader

	private async tryBecomeLeader(): Promise<boolean> {
		const token = `${process.pid}:${randomUUID()}`;
		const got = await this.redis.set(LEADER_KEY, token, 'EX', LEADER_TTL_SECONDS, 'NX');
		if (got == null) return false;
		this.leaderToken = token;
		this.isLeader = true;
		this.lastLeaderRenewAt = Date.now();
		await this.hanamiGpuQueueService.recordEvent({ type: 'leaderAcquired', detail: `pid=${process.pid}` });
		// モデルの読み込みや長い判定の間もリーダーを失わないよう、ループとは別に延長する
		// （失うと別のプロセスが判定係を起動し、GPU にモデルが2つ載ってしまう）
		this.leaderTimer = setInterval(() => {
			void this.maybeRenewLeader();
		}, LEADER_RENEW_INTERVAL_MS);
		this.leaderTimer.unref();
		return true;
	}

	private async maybeRenewLeader(): Promise<void> {
		if (!this.isLeader || this.leaderToken == null) return;
		if (Date.now() - this.lastLeaderRenewAt < LEADER_RENEW_INTERVAL_MS) return;
		const renewed = await this.redis.eval(
			'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end',
			1, LEADER_KEY, this.leaderToken, LEADER_TTL_SECONDS,
		).catch(() => 0);
		this.lastLeaderRenewAt = Date.now();
		if (renewed !== 1) {
			this.logger.warn('hanami GPU dispatcher leadership lost');
			await this.hanamiGpuQueueService.recordEvent({ type: 'leaderLost', detail: `pid=${process.pid}` });
			this.isLeader = false;
			this.leaderToken = null;
			this.clearLeaderTimer();
			await this.teardownWorker();
		}
	}

	private clearLeaderTimer(): void {
		if (this.leaderTimer != null) clearInterval(this.leaderTimer);
		this.leaderTimer = null;
	}

	private async releaseLeader(): Promise<void> {
		this.clearLeaderTimer();
		if (this.leaderToken == null) return;
		const token = this.leaderToken;
		this.leaderToken = null;
		this.isLeader = false;
		await this.redis.eval(
			'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
			1, LEADER_KEY, token,
		).catch(() => 0);
	}

	//#endregion

	//#region worker

	private async spawnWorker(): Promise<void> {
		const configured = Number(process.env.HANAMI_LLM_MAX_THREADS);
		const maxThreads = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : Math.max(1, Math.floor(cpus().length / 2));
		const command = prepareHanamiPythonCommand([resolveHanamiGpuWorkerScript()], {
			env: { ...process.env, ...HANAMI_PYTHON_THREAD_ENV, HANAMI_LLM_MAX_THREADS: String(maxThreads) },
		});
		this.worker = spawn(command.file, [...command.args], {
			env: command.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.workerStdin = this.worker.stdin;
		this.workerReady = false;
		this.spawnedAt = Date.now();
		await this.hanamiGpuQueueService.recordEvent({ type: 'workerSpawn', detail: `pid=${this.worker.pid ?? '?'}` });

		this.worker.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			if (text.trim().length > 0) this.logger.warn('gpu worker stderr', { text: text.trim() });
		});

		this.worker.on('exit', (code, signal) => {
			this.logger.warn('gpu worker exited', { code, signal });
			void this.hanamiGpuQueueService.recordEvent({ type: 'workerExit', durationMs: Date.now() - this.spawnedAt, detail: `code=${code} signal=${signal}` });
			this.workerReady = false;
			this.rejectAllPending(new Error(`gpu worker exited (code=${code} signal=${signal})`));
		});

		this.stdoutLines = createInterface({ input: this.worker.stdout! });
		this.stdoutLines.on('line', (line) => this.onWorkerLine(line));
	}

	private onWorkerLine(line: string): void {
		if (line.trim().length === 0) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.logger.warn('gpu worker emitted non-JSON line', { line });
			return;
		}
		if (message == null || typeof message !== 'object') return;
		const msg = message as { op?: string; requestId?: string; processed?: number; uptimeSec?: number; vramGiB?: number; results?: unknown; errors?: unknown; durationMs?: number; error?: string };
		switch (msg.op) {
			case 'ready': {
				this.workerReady = true;
				this.setState('running');
				void this.hanamiGpuQueueService.recordEvent({ type: 'workerReady', durationMs: Date.now() - this.spawnedAt, detail: JSON.stringify((message as { runtime?: unknown }).runtime ?? null).slice(0, 300) });
				break;
			}
			case 'failed': {
				this.workerReady = false;
				this.lastError = msg.error ?? 'gpu worker failed to start';
				void this.hanamiGpuQueueService.recordEvent({ type: 'workerFailed', detail: this.lastError.slice(0, 500) });
				this.rejectAllPending(new Error(this.lastError));
				break;
			}
			case 'pong': {
				this.processed = typeof msg.processed === 'number' ? msg.processed : this.processed;
				this.workerUptimeSec = typeof msg.uptimeSec === 'number' ? msg.uptimeSec : this.workerUptimeSec;
				this.vramGiB = typeof msg.vramGiB === 'number' ? msg.vramGiB : null;
				break;
			}
			case 'result': {
				const requestId = msg.requestId ?? '';
				const pending = this.pending.get(requestId);
				if (pending != null) {
					this.pending.delete(requestId);
					clearTimeout(pending.timer);
					pending.resolve({
						op: 'result',
						requestId,
						results: (Array.isArray(msg.results) ? msg.results : []) as Array<{ itemId: string; scores: HanamiGpuSpamScores }>,
						errors: (Array.isArray(msg.errors) ? msg.errors : []) as Array<{ itemId: string; error: string }>,
						durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : 0,
					});
				}
				break;
			}
			case 'error': {
				const requestId = msg.requestId ?? '';
				const pending = this.pending.get(requestId);
				if (pending != null) {
					this.pending.delete(requestId);
					clearTimeout(pending.timer);
					pending.resolve({ op: 'error', error: msg.error ?? 'unknown error' });
				}
				break;
			}
			default:
				this.logger.warn('gpu worker emitted unknown op', { op: msg.op });
		}
	}

	private rejectAllPending(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private sendRequest(op: string, payload: Record<string, unknown>): Promise<WorkerResponse> {
		if (this.workerStdin == null) return Promise.reject(new Error('gpu worker is not running'));
		const requestId = randomUUID();
		const line = JSON.stringify({ op, requestId, ...payload });
		return new Promise<WorkerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`gpu worker request timed out (${op})`));
			}, RESULT_TIMEOUT_MS);
			this.pending.set(requestId, { resolve, reject, timer });
			this.workerStdin!.write(line + '\n', (err) => {
				if (err != null) {
					this.pending.delete(requestId);
					clearTimeout(timer);
					reject(err);
				}
			});
		});
	}

	private async waitForReady(): Promise<boolean> {
		if (this.worker == null) return false;
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (this.workerReady === false && Date.now() < deadline) {
			if (this.worker.exitCode != null || this.worker.signalCode != null) return false;
			await sleep(200);
		}
		return this.workerReady;
	}

	private async stopWorker(): Promise<void> {
		if (this.worker == null) return;
		const worker = this.worker;
		this.workerReady = false;
		try {
			this.workerStdin?.write(JSON.stringify({ op: 'exit' }) + '\n');
			const exited = await Promise.race([
				new Promise<boolean>(resolve => worker.once('exit', () => resolve(true))),
				sleep(EXIT_GRACE_MS).then(() => false),
			]);
			if (!exited) worker.kill('SIGKILL');
		} catch {
			worker.kill('SIGKILL');
		}
		this.stdoutLines?.close();
		this.stdoutLines = null;
		this.workerStdin = null;
		this.worker = null;
		this.pending.clear();
	}

	private async teardownWorker(): Promise<void> {
		await this.stopWorker();
		if (this.lock != null) {
			await this.lock.release();
			this.lock = null;
			await this.hanamiGpuQueueService.recordEvent({ type: 'lockReleased' });
		}
	}

	//#endregion

	//#region loop

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				if (!this.isLeader) {
					const got = await this.tryBecomeLeader();
					if (!got) {
						await sleep(LEADER_RETRY_MS);
						continue;
					}
				}
				await this.maybeRenewLeader();
				if (!this.isLeader) {
					await sleep(LEADER_RETRY_MS);
					continue;
				}
				const waitMs = await this.tick();
				await this.persistStatus();
				await sleep(waitMs);
			} catch (err) {
				this.logger.error('hanami GPU dispatcher tick failed', { err });
				await sleep(IDLE_SLEEP_MS);
			}
		}
	}

	/** 1回分。戻り値は次に回るまでの待ち時間（ミリ秒）。 */
	private async tick(): Promise<number> {
		const now = Date.now();

		// 1. 次の1種類を選ぶ
		const heads = await Promise.all(HANAMI_GPU_QUEUE_KINDS.map(kind => this.hanamiGpuQueueService.head(kind)));
		const kind = chooseHanamiGpuQueueKind(heads, now);
		const head = heads.find(h => h != null && h.kind === kind) ?? null;
		const bestPriority = head != null ? hanamiGpuQueueEffectivePriority(head, now) : null;

		// 2. 譲る: 今までどおりのジョブ（自分でモデルを読み込む noteJudge など）が GPU を待っていて、
		//    その重要度がこちらの次の仕事より高ければ（こちらに仕事が無ければ）、判定係を止めてロックを返す。
		//    低ければ譲らない（ロックが空いたらこちらが取る）。相手が待っている間に取り直すと相手が取れないので、
		//    譲ると決めている間はロックを取り直さない
		const waiters = await findHanamiLlmWaiters(this.redis, 'gpuWorker');
		if (shouldYieldHanamiGpu(waiters, bestPriority)) {
			if (this.worker != null || this.lock != null) await this.teardownWorker();
			// 仕事が無くても判定係は降りているので「譲っている」と出す（「載せたまま待機」は判定係が載っているときだけ）
			if (this.state !== 'yielded') {
				await this.hanamiGpuQueueService.recordEvent({ type: 'yield', kind: kind ?? undefined, detail: `waiters=${waiters.join(',')} next=${bestPriority ?? 'none'}` });
			}
			this.setState('yielded');
			this.lastError = `ほかの判定（${waiters.join('・')}）が GPU を待っているので、先に譲っています`;
			return IDLE_SLEEP_MS;
		}

		if (kind == null) {
			await this.callRefill('spamScan');
			// 載せたまま待つ（常駐）。ときどき状態を聞いて画面に出す
			if (this.workerReady && now - this.lastPingAt >= PING_INTERVAL_MS) {
				this.lastPingAt = now;
				this.workerStdin?.write(JSON.stringify({ op: 'ping' }) + '\n');
			}
			this.setState(this.workerReady ? 'idle' : 'unloaded');
			return IDLE_SLEEP_MS;
		}

		// 3. GPU の準備
		const runtime = await probeHanamiNoteJudgeRuntime();
		if (!runtime.available) {
			this.setState('noGpu');
			this.lastError = `判定の実行環境が使えません: ${runtime.reason ?? 'unknown'}`;
			return NO_GPU_WAIT_MS;
		}

		// 4. GPU のロック（判定係が生きている間は持ち続ける）
		if (this.worker == null) {
			if (this.lock == null) {
				this.lock = await acquireHanamiLocalLlmLock(this.redis, 'gpuWorker');
				if (this.lock != null) {
					await this.hanamiGpuQueueService.recordEvent({ type: 'lockAcquired', kind });
				}
				if (this.lock == null) {
					if (this.state !== 'waitingGpu') {
						const holder = (await this.redis.get(HANAMI_LOCAL_LLM_LOCK_KEY))?.split(':')[0] ?? null;
						await this.hanamiGpuQueueService.recordEvent({ type: 'lockBusy', kind, detail: `holder=${holder ?? 'unknown'}` });
					}
					this.setState('waitingGpu');
					this.lastError = 'GPU がほかの判定に使われています';
					return IDLE_SLEEP_MS;
				}
			}
		}

		// 5. 判定係が無ければ起動
		if (this.worker == null) {
			this.setState('loading');
			await this.spawnWorker();
			const ready = await this.waitForReady();
			if (!ready) {
				this.lastError = '判定係を起動できませんでした';
				this.setState('failed');
				await this.teardownWorker();
				const wait = this.backoffMs;
				this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60 * 1000);
				return wait;
			}
			this.backoffMs = 30_000;
		}

		// 6. 選んだ種類から取り出して判定
		const policy = HANAMI_GPU_QUEUE_POLICIES[kind];
		const items = await this.hanamiGpuQueueService.take(kind, policy.maxBatch);
		if (items.length === 0) {
			this.setState('idle');
			return IDLE_SLEEP_MS;
		}
		await this.hanamiGpuQueueService.setInflight(kind, items.length);
		this.inflight = { kind, count: items.length, startedAt: Date.now() };
		await this.persistStatus();
		try {
			return await this.judgeTaken(kind, items);
		} finally {
			this.inflight = null;
			await this.hanamiGpuQueueService.setInflight(kind, 0);
		}
	}

	/** 取り出した items を判定係に送り、結果を受け取り係に渡す。戻り値は次に回るまでの待ち時間 */
	private async judgeTaken(kind: HanamiGpuQueueKind, items: HanamiGpuQueueTakenItem[]): Promise<number> {
		const policy = HANAMI_GPU_QUEUE_POLICIES[kind];

		const scores = new Map<string, HanamiGpuSpamScores>();
		const errors = new Map<string, string>();
		let durationMs: number | null = null;
		let judgeFailed = false;

		try {
			const response = await this.sendRequest(policy.op, {
				items: items.map(item => ({ itemId: item.itemId, text: String((item.payload as { text?: unknown })?.text ?? '') })),
			});
			if (response.op === 'result') {
				durationMs = response.durationMs;
				for (const result of response.results) scores.set(result.itemId, result.scores);
				for (const error of response.errors) errors.set(error.itemId, error.error);
			} else {
				judgeFailed = true;
				this.lastError = response.error;
			}
		} catch (err) {
			judgeFailed = true;
			this.lastError = String(err);
		}

		if (judgeFailed) {
			// 判定係が落ちた → kill して items を戻す
			await this.hanamiGpuQueueService.recordEvent({ type: 'batchFailed', kind, count: items.length, detail: (this.lastError ?? '').slice(0, 500) });
			await this.teardownWorker();
			await this.hanamiGpuQueueService.retry(kind, items);
			await this.hanamiGpuQueueService.recordEvent({ type: 'retry', kind, count: items.length });
			this.setState('failed');
			const wait = this.backoffMs;
			this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60 * 1000);
			return wait;
		}

		this.backoffMs = 30_000;

		// 7. 結果を受け取り係に渡す
		const handler = this.handlers.get(kind);
		if (handler == null) {
			await this.hanamiGpuQueueService.complete(kind, items.map(item => item.itemId));
		} else {
			try {
				await handler(items, scores, errors, durationMs);
				await this.hanamiGpuQueueService.complete(kind, items.map(item => item.itemId));
			} catch (err) {
				this.logger.error('hanami GPU queue handler failed', { kind, err });
				await this.hanamiGpuQueueService.recordEvent({ type: 'handlerFailed', kind, count: items.length, detail: String(err).slice(0, 500) });
				await this.hanamiGpuQueueService.retry(kind, items);
				await this.hanamiGpuQueueService.recordEvent({ type: 'retry', kind, count: items.length });
			}
		}

		this.processed += scores.size;
		this.lastBatch = { kind, size: items.length, durationMs: durationMs ?? 0, at: Date.now() };
		const takenAt = this.inflight?.startedAt ?? Date.now();
		await this.hanamiGpuQueueService.recordBatch({
			at: Date.now(),
			kind,
			size: items.length,
			ok: scores.size,
			errors: errors.size,
			durationMs: durationMs ?? 0,
			maxWaitMs: Math.max(0, ...items.map(item => takenAt - item.enqueuedAt)),
			maxAttempts: Math.max(0, ...items.map(item => item.attempts)),
		});
		await this.hanamiGpuQueueService.recordEvent({ type: 'batch', kind, count: items.length, durationMs: durationMs ?? 0, detail: errors.size > 0 ? `errors=${errors.size} ${[...errors.values()][0].slice(0, 200)}` : undefined });
		this.lastError = null;
		this.setState('running');

		// 8. 続きがあればすぐ次へ（譲るかどうかは次の回の最初に見る）
		return 0;
	}

	private async callRefill(kind: HanamiGpuQueueKind): Promise<void> {
		const refill = this.refills.get(kind);
		if (refill == null) return;
		try {
			await refill();
		} catch (err) {
			this.logger.error('hanami GPU queue refill failed', { kind, err });
		}
	}

	//#endregion

	//#region status

	private setState(state: HanamiGpuQueueState): void {
		if (this.state !== state) this.stateSince = Date.now();
		this.state = state;
	}

	private async persistStatus(force = false): Promise<void> {
		if (!this.isLeader && !force) return;
		const status: HanamiGpuDispatcherStatus = {
			state: this.state,
			since: this.stateSince,
			pid: process.pid,
			processed: this.processed,
			workerUptimeSec: this.workerUptimeSec,
			vramGiB: this.vramGiB,
			lastBatch: this.lastBatch,
			lastError: this.lastError,
			updatedAt: Date.now(),
			inflight: this.inflight,
			workerPid: this.worker?.pid ?? null,
		};
		await this.redis.set(STATUS_KEY, JSON.stringify(status), 'EX', 300).catch(() => 'OK');
	}

	//#endregion
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
