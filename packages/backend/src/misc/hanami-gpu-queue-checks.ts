/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * GPU 判定キューの見張り（純粋関数、DB や Redis に触らない）。
 * 「いつも成り立っているはずのこと」を確かめて、崩れていれば理由つきで返す。
 * 管理画面と API（admin/hanami/gpu-queue）から使う。不具合を見つけるのが目的なので、
 * 1回だけの揺らぎで騒がないよう、時間の幅を持たせている。
 */

import {
	HANAMI_GPU_LEGACY_JOB_PRIORITY,
	HANAMI_GPU_QUEUE_AGING_MAX,
	HANAMI_GPU_QUEUE_AGING_PER_MINUTE,
	HANAMI_GPU_QUEUE_KINDS,
	HANAMI_GPU_QUEUE_POLICIES,
	hanamiGpuQueueEffectivePriority,
	type HanamiGpuQueueKind,
} from '@/misc/hanami-gpu-queue.js';

export type HanamiGpuQueueCheckLevel = 'ok' | 'info' | 'warn' | 'error';

export type HanamiGpuQueueCheck = {
	id: string;
	level: HanamiGpuQueueCheckLevel;
	title: string;
	detail: string | null;
};

export type HanamiGpuQueueCheckEvent = { at: number; type: string; kind?: string; count?: number; durationMs?: number; detail?: string };
export type HanamiGpuQueueCheckBatch = { at: number; kind: string; size: number; ok: number; errors: number; durationMs: number };

export type HanamiGpuQueueCheckInput = {
	now: number;
	status: {
		state: string;
		since: number;
		updatedAt: number;
		workerPid: number | null;
		inflight: { kind: string; count: number; startedAt: number } | null;
	} | null;
	leaderPid: string | null;
	lockHolder: string | null;
	waiters: string[];
	kinds: Record<HanamiGpuQueueKind, { length: number; inflight: number; oldestWaitSec: number | null; listOnly: number; bodyOnly: number }>;
	/** 次にやる仕事の実効優先度（仕事が無ければ null） */
	nextBestPriority: number | null;
	runtimeAvailable: boolean | null;
	scan: { running: boolean; exhausted: boolean } | null;
	events: readonly HanamiGpuQueueCheckEvent[];
	batches: readonly HanamiGpuQueueCheckBatch[];
};

const MIN = 60_000;
/** 状態がこれより古ければ、配り役が止まっている */
const STATUS_STALE_MS = 60_000;
/** 判定係の返事を待つ上限（配り役の RESULT_TIMEOUT_MS 5分）を少し超えたら、返事が来ていない */
const INFLIGHT_STALE_MS = 6 * MIN;
/** 種類ごとに「待ちすぎ」とみなす時間。全体スキャンは後回しが前提なので長め */
const STUCK_AFTER_SEC: Record<HanamiGpuQueueKind, number> = {
	judgeTrial: 90,
	spamJudge: 15 * 60,
	spamScan: 6 * 60 * 60,
};
/** 判定係が載っている（はずの）状態 */
const LOADED_STATES = new Set(['idle', 'running']);
/** 判定係が降りている（はずの）状態 */
const UNLOADED_STATES = new Set(['yielded', 'unloaded', 'noGpu', 'stopped', 'failed']);

function within(events: readonly HanamiGpuQueueCheckEvent[], now: number, ms: number, types: readonly string[]): HanamiGpuQueueCheckEvent[] {
	return events.filter(e => now - e.at <= ms && types.includes(e.type));
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export function checkHanamiGpuQueue(input: HanamiGpuQueueCheckInput): HanamiGpuQueueCheck[] {
	const { now, status } = input;
	const checks: HanamiGpuQueueCheck[] = [];
	const add = (id: string, level: HanamiGpuQueueCheckLevel, title: string, detail: string | null = null) => checks.push({ id, level, title, detail });
	const pending = HANAMI_GPU_QUEUE_KINDS.reduce((sum, kind) => sum + input.kinds[kind].length + input.kinds[kind].inflight, 0);

	// 1. 配り役が動いているか
	if (status == null) {
		add('dispatcherAlive', pending > 0 ? 'error' : 'info', '配り役の状態がありません', pending > 0 ? `待ちが ${pending} 件あるのに、配り役（ジョブキューのプロセス）が一度も状態を書いていません` : 'まだ一度も動いていないか、5分以上止まっています');
	} else if (now - status.updatedAt > STATUS_STALE_MS && status.state !== 'stopped') {
		add('dispatcherAlive', 'error', '配り役が止まっています', `状態の更新が ${Math.round((now - status.updatedAt) / 1000)} 秒前で止まっています（15秒ごとに書くはず）。最後の状態: ${status.state}`);
	} else {
		add('dispatcherAlive', 'ok', '配り役は動いています', null);
	}

	// 2. リーダー
	if (input.leaderPid == null && pending > 0) {
		add('leader', 'error', 'リーダーがいません', `待ちが ${pending} 件あるのに、判定を配るプロセスがいません`);
	} else {
		add('leader', 'ok', 'リーダー', input.leaderPid != null ? `pid ${input.leaderPid}` : '待ちが無いので不要');
	}

	// 3. 判定係と GPU のロックが合っているか（崩れると GPU にモデルが2つ載る）
	if (status != null && status.workerPid != null && LOADED_STATES.has(status.state) && input.lockHolder !== 'gpuWorker') {
		add('lockConsistency', 'error', '判定係が載っているのに GPU のロックを持っていません', `ロックの持ち主: ${input.lockHolder ?? 'なし'}。ほかの判定が同時にモデルを読み込み、GPU のメモリが足りなくなる恐れがあります`);
	} else if (status != null && status.workerPid == null && UNLOADED_STATES.has(status.state) && input.lockHolder === 'gpuWorker') {
		add('lockConsistency', 'warn', '判定係が降りているのにロックが残っています', `状態: ${status.state}。返し忘れなら、ほかの判定がロックの期限（90秒）まで待たされます`);
	} else {
		add('lockConsistency', 'ok', '判定係と GPU のロックは合っています', `ロックの持ち主: ${input.lockHolder ?? 'なし'}`);
	}

	// 4. 優先度の逆転（重要度の低い判定に譲っていないか）
	if (status?.state === 'yielded' && input.nextBestPriority != null) {
		const waiterPriority = Math.max(0, ...input.waiters.map(kind => HANAMI_GPU_LEGACY_JOB_PRIORITY[kind] ?? 0));
		if (input.waiters.length === 0) {
			add('priorityInversion', 'warn', '待っている判定がいないのに譲ったままです', `次の仕事の重要度 ${input.nextBestPriority.toFixed(1)}`);
		} else if (waiterPriority <= input.nextBestPriority) {
			add('priorityInversion', 'error', '重要度の低い判定に GPU を譲っています', `待っている判定: ${input.waiters.join('・')}（${waiterPriority}）、こちらの次の仕事: ${input.nextBestPriority.toFixed(1)}`);
		} else {
			add('priorityInversion', 'ok', '譲り方は重要度どおりです', `待っている判定: ${input.waiters.join('・')}（${waiterPriority}） > こちら ${input.nextBestPriority.toFixed(1)}`);
		}
	} else {
		add('priorityInversion', 'ok', '譲り方は重要度どおりです', null);
	}

	// 5. 待ちすぎ（種類ごと）
	for (const kind of HANAMI_GPU_QUEUE_KINDS) {
		const wait = input.kinds[kind].oldestWaitSec;
		if (wait != null && wait > STUCK_AFTER_SEC[kind]) {
			add(`stuck:${kind}`, kind === 'spamScan' ? 'info' : 'warn', `${kind} が待ちすぎています`, `いちばん古い項目は ${Math.round(wait / 60)} 分待っています（目安 ${Math.round(STUCK_AFTER_SEC[kind] / 60)} 分）。状態: ${status?.state ?? '不明'}`);
		}
	}

	// 6. 待ちがあるのに判定が進んでいない
	const lastBatch = input.events.find(e => e.type === 'batch');
	// 進み始めた時刻: 最後の判定・判定係が使えるようになった時刻・今の状態になった時刻のうち新しいもの
	const lastReady = input.events.find(e => e.type === 'workerReady');
	const progressAt = Math.max(lastBatch?.at ?? 0, lastReady?.at ?? 0, status?.since ?? 0);
	const judging = status?.inflight != null && now - status.inflight.startedAt <= INFLIGHT_STALE_MS;
	if (pending > 0 && status != null && LOADED_STATES.has(status.state) && !judging && now - progressAt > 10 * MIN) {
		add('throughput', 'error', '待ちがあるのに判定が進んでいません', `待ち ${pending} 件、状態 ${status.state}、最後の判定 ${lastBatch != null ? `${Math.round((now - lastBatch.at) / MIN)} 分前` : 'なし'}`);
	} else {
		add('throughput', 'ok', '判定は進んでいます', lastBatch != null ? `最後の判定 ${Math.round((now - lastBatch.at) / 1000)} 秒前` : null);
	}

	// 7. 列と本体の食い違い
	const broken = HANAMI_GPU_QUEUE_KINDS.filter(kind => input.kinds[kind].listOnly > 0 || input.kinds[kind].bodyOnly > 0);
	if (broken.length > 0) {
		add('consistency', 'warn', '列と本体が食い違っています', broken.map(kind => `${kind}: 本体の無い列 ${input.kinds[kind].listOnly}・列に無い本体（迷子）${input.kinds[kind].bodyOnly}`).join(' / '));
	} else {
		add('consistency', 'ok', '列と本体は合っています', null);
	}

	// 8. 判定係の返事が来ない
	if (status?.inflight != null && now - status.inflight.startedAt > INFLIGHT_STALE_MS) {
		add('inflight', 'error', '判定係の返事が来ません', `${status.inflight.kind} ${status.inflight.count} 件を ${Math.round((now - status.inflight.startedAt) / 1000)} 秒前に渡したままです（5分で打ち切るはず）`);
	} else {
		add('inflight', 'ok', '判定係の返事', status?.inflight != null ? `${status.inflight.kind} ${status.inflight.count} 件を判定中（${Math.round((now - status.inflight.startedAt) / 1000)} 秒）` : '判定中の分なし');
	}

	// 9. 判定係の起動のくり返し・起動失敗
	const spawns = within(input.events, now, 30 * MIN, ['workerSpawn']);
	const startFailures = within(input.events, now, 60 * MIN, ['workerFailed']);
	if (startFailures.length > 0) {
		add('workerStart', 'warn', '判定係の起動に失敗しています', `直近1時間に ${startFailures.length} 回。最後: ${startFailures[0].detail ?? '理由なし'}`);
	} else if (spawns.length >= 3) {
		add('workerStart', 'warn', '判定係を何度も起動し直しています', `直近30分に ${spawns.length} 回（譲るたびに降ろすので、ほかの判定と頻繁に入れ替わっている可能性）`);
	} else {
		add('workerStart', 'ok', '判定係の起動', `直近30分の起動 ${spawns.length} 回`);
	}

	// 10. 失敗・あきらめ・捨てた項目
	const failures = within(input.events, now, 60 * MIN, ['batchFailed', 'handlerFailed']);
	const giveUps = within(input.events, now, 60 * MIN, ['giveUp']);
	if (failures.length > 0 || giveUps.length > 0) {
		const last = failures[0];
		add('failures', 'warn', '判定や保存の失敗があります', `直近1時間: 失敗 ${failures.length} 回・3回失敗して捨てた ${giveUps.reduce((s, e) => s + (e.count ?? 1), 0)} 件${last != null ? `。最後: ${last.type} ${last.kind ?? ''} ${last.detail ?? ''}` : ''}`);
	} else {
		add('failures', 'ok', '判定や保存の失敗はありません', null);
	}
	const drops = within(input.events, now, 60 * MIN, ['drop']);
	if (drops.length > 0) {
		add('drops', 'info', '締め切り切れで捨てた項目があります', `直近1時間に ${drops.length} 件（試すの時間切れなど）`);
	}

	// 11. 1件ごとの判定エラー（直近20回）
	const recent = input.batches.slice(0, 20);
	const size = recent.reduce((s, b) => s + b.size, 0);
	const errors = recent.reduce((s, b) => s + b.errors, 0);
	if (size > 0 && errors / size > 0.05) {
		add('itemErrors', 'warn', '1件ごとの判定エラーが多いです', `直近 ${recent.length} 回で ${errors}/${size} 件（${Math.round(errors / size * 100)}%）`);
	}

	// 12. GPU なしで止まっている
	if (input.runtimeAvailable === false && pending > 0) {
		add('runtime', 'warn', 'GPU が使えないので判定が止まっています', `待ち ${pending} 件`);
	}

	// 13. 全体スキャンが補充されていない
	if (input.scan?.running === true && !input.scan.exhausted && input.kinds.spamScan.length + input.kinds.spamScan.inflight === 0) {
		const lastRefill = input.events.find(e => e.type === 'refill');
		if (lastRefill == null || now - lastRefill.at > 5 * MIN) {
			add('scanRefill', 'warn', '全体スキャンの分がキューに足されていません', `スキャンは実行中なのに、キューに1件もありません。最後の補充: ${lastRefill != null ? `${Math.round((now - lastRefill.at) / MIN)} 分前` : 'なし'}`);
		}
	}

	// 14. いつもより遅い1回
	const last = recent[0];
	const perItem = recent.slice(1).filter(b => b.kind === last?.kind && b.size > 0).map(b => b.durationMs / b.size);
	const med = median(perItem);
	if (last != null && last.size > 0 && med != null && perItem.length >= 3 && last.durationMs / last.size > med * 3) {
		add('slowBatch', 'info', '最後の1回がいつもより遅いです', `${last.kind}: 1件あたり ${(last.durationMs / last.size / 1000).toFixed(2)} 秒（いつもは ${(med / 1000).toFixed(2)} 秒）`);
	}

	return checks;
}

export type HanamiGpuQueueOrderItem = {
	kind: HanamiGpuQueueKind;
	itemId: string;
	waitSec: number;
	priority: { base: number; aging: number; deadline: number; total: number };
	deadlineInSec: number | null;
	attempts: number;
	/** 何回目の判定でまとめて渡されるか（1から） */
	round: number;
};

/**
 * 今の列から「実際に処理される順」をなぞる。配り役と同じく、先頭どうしを比べて種類を選び、
 * その種類から1回分（maxBatch 件）を取る、を limit 件になるまで繰り返す。
 * 時間は止めて計算する（待っている間の加点の増え方は含めない）。
 */
export function simulateHanamiGpuQueueOrder(
	lists: Record<HanamiGpuQueueKind, readonly { itemId: string; enqueuedAt: number; deadlineAt: number | null; attempts: number }[]>,
	now: number,
	limit: number,
): HanamiGpuQueueOrderItem[] {
	const cursors: Record<string, number> = {};
	const order: HanamiGpuQueueOrderItem[] = [];
	let round = 0;
	while (order.length < limit) {
		let bestKind: HanamiGpuQueueKind | null = null;
		let bestPriority = -Infinity;
		let bestAt = Infinity;
		for (const kind of HANAMI_GPU_QUEUE_KINDS) {
			const head = lists[kind][cursors[kind] ?? 0];
			if (head == null || head.enqueuedAt < 0) continue;
			const priority = hanamiGpuQueueEffectivePriority({ kind, enqueuedAt: head.enqueuedAt, deadlineAt: head.deadlineAt }, now);
			if (priority > bestPriority || (priority === bestPriority && head.enqueuedAt < bestAt)) {
				bestKind = kind;
				bestPriority = priority;
				bestAt = head.enqueuedAt;
			}
		}
		if (bestKind == null) break;
		round++;
		const policy = HANAMI_GPU_QUEUE_POLICIES[bestKind];
		for (let i = 0; i < policy.maxBatch && order.length < limit; i++) {
			const index = cursors[bestKind] ?? 0;
			const item = lists[bestKind][index];
			if (item == null || item.enqueuedAt < 0) break;
			cursors[bestKind] = index + 1;
			const total = hanamiGpuQueueEffectivePriority({ kind: bestKind, enqueuedAt: item.enqueuedAt, deadlineAt: item.deadlineAt }, now);
			const waitMinutes = Math.max(0, Math.floor((now - item.enqueuedAt) / MIN));
			const aging = Math.min(waitMinutes * HANAMI_GPU_QUEUE_AGING_PER_MINUTE, HANAMI_GPU_QUEUE_AGING_MAX);
			order.push({
				kind: bestKind,
				itemId: item.itemId,
				waitSec: Math.max(0, Math.round((now - item.enqueuedAt) / 1000)),
				priority: { base: policy.base, aging, deadline: Math.round((total - policy.base - aging) * 10) / 10, total: Math.round(total * 10) / 10 },
				deadlineInSec: item.deadlineAt != null ? Math.round((item.deadlineAt - now) / 1000) : null,
				attempts: item.attempts,
				round,
			});
		}
	}
	return order;
}
