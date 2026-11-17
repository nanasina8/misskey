/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * はなみ GPU 判定キューで使う純粋関数（DB や Redis に触らない）。
 * 種類ごとの決まり（基本の重要度・締め切り・1回の上限）と、
 * 各列の先頭から「次にやる1種類」を選ぶ方法。
 */

export const HANAMI_GPU_QUEUE_KINDS = ['judgeTrial', 'spamJudge', 'topicJudge', 'noteJudge', 'spamScan', 'rankBacktest'] as const;
export type HanamiGpuQueueKind = typeof HANAMI_GPU_QUEUE_KINDS[number];

export type HanamiGpuQueuePolicy = {
	/** 基本の重要度 */
	base: number;
	/** 締め切り（投入からの経過ミリ秒）。null は締め切りなし */
	deadlineMs: number | null;
	/** 1回で判定係に渡す件数の上限 */
	maxBatch: number;
	/** 判定係に送る op */
	op: HanamiGpuWorkerOp;
};

/** 常駐の判定係が受け付ける仕事の種類 */
export type HanamiGpuWorkerOp = 'spamJudge' | 'noteJudge' | 'topicJudge' | 'promptChoice';

export const HANAMI_GPU_QUEUE_POLICIES: Record<HanamiGpuQueueKind, HanamiGpuQueuePolicy> = {
	judgeTrial: { base: 100, deadlineMs: 60_000, maxBatch: 1, op: 'spamJudge' },
	spamJudge: { base: 90, deadlineMs: null, maxBatch: 32, op: 'spamJudge' },
	// 話題の判定は「いまの話題」1 回分が 1 項目。20 分たつと古くなるので捨てる
	topicJudge: { base: 70, deadlineMs: 20 * 60_000, maxBatch: 1, op: 'topicJudge' },
	// 投稿の判定は 1 投稿が 1 項目。判定係は 1 件ずつ判定するので、1 回に渡す件数は少なめにして割り込みやすくする
	noteJudge: { base: 50, deadlineMs: null, maxBatch: 8, op: 'noteJudge' },
	spamScan: { base: 10, deadlineMs: null, maxBatch: 32, op: 'spamJudge' },
	// 並べ替えの物差し（過去の記録を採点し直す）。ほかの仕事が無いときだけ少しずつ足すので、いちばん低い。
	// 待ち時間の加点（最大 40）が付いても、投稿の判定（50）は超えない
	rankBacktest: { base: 5, deadlineMs: null, maxBatch: 8, op: 'promptChoice' },
};

/** 待ち時間の加点: 1分ごとに +1 */
export const HANAMI_GPU_QUEUE_AGING_PER_MINUTE = 1;
/** 待ち時間の加点の上限 */
export const HANAMI_GPU_QUEUE_AGING_MAX = 40;
/** 締め切りの加点の上限 */
export const HANAMI_GPU_QUEUE_DEADLINE_BOOST_MAX = 30;

export type HanamiGpuQueueHead = {
	kind: HanamiGpuQueueKind;
	enqueuedAt: number;
	deadlineAt: number | null;
} | null;

export type HanamiGpuSpamScores = { normal: number; spam: number; scam: number; abuse: number };

/**
 * 実効優先度 = base + min(待ち分数×1, 40) + 締め切りの加点。
 * 締め切りの加点は、締め切りまでの残りが少ないほど最大30まで線形に増える。
 */
export function hanamiGpuQueueEffectivePriority(head: NonNullable<HanamiGpuQueueHead>, now: number): number {
	const policy = HANAMI_GPU_QUEUE_POLICIES[head.kind];

	const waitMinutes = Math.max(0, Math.floor((now - head.enqueuedAt) / 60_000));
	const aging = Math.min(waitMinutes * HANAMI_GPU_QUEUE_AGING_PER_MINUTE, HANAMI_GPU_QUEUE_AGING_MAX);

	let deadlineBoost = 0;
	if (head.deadlineAt != null && policy.deadlineMs != null && policy.deadlineMs > 0) {
		const remaining = head.deadlineAt - now;
		if (remaining <= 0) {
			deadlineBoost = HANAMI_GPU_QUEUE_DEADLINE_BOOST_MAX;
		} else {
			deadlineBoost = Math.min(HANAMI_GPU_QUEUE_DEADLINE_BOOST_MAX, HANAMI_GPU_QUEUE_DEADLINE_BOOST_MAX * (1 - remaining / policy.deadlineMs));
		}
	}

	return policy.base + aging + deadlineBoost;
}

/**
 * 先頭が無い種類は除き、実効優先度が最大の種類を返す。
 * 同点なら enqueuedAt が古いほう。全部空なら null。
 */
export function chooseHanamiGpuQueueKind(heads: readonly HanamiGpuQueueHead[], now: number): HanamiGpuQueueKind | null {
	let best: HanamiGpuQueueKind | null = null;
	let bestPriority = -Infinity;
	let bestEnqueuedAt = Infinity;
	for (const head of heads) {
		if (head == null) continue;
		const priority = hanamiGpuQueueEffectivePriority(head, now);
		if (priority > bestPriority || (priority === bestPriority && head.enqueuedAt < bestEnqueuedAt)) {
			bestPriority = priority;
			bestEnqueuedAt = head.enqueuedAt;
			best = head.kind;
		}
	}
	return best;
}

/**
 * まだ常駐の判定係に載せ替えていない、自分でモデルを GPU に読み込むジョブの重要度。
 * 残っているのは はなみの管理画面の「判定の試し」だけ（人が待っている）。
 * 投稿の判定・話題の判定は順番待ちに載せ替えた。おすすめの計算・好みの学習は CPU の処理で、GPU とは取り合わない。
 * 順番待ちの実効優先度と同じ物差しで比べ、待っている相手のほうが高いときだけ GPU を譲る。
 */
export const HANAMI_GPU_LEGACY_JOB_PRIORITY: Record<string, number> = {
	judgeTrial: 100,
};

/**
 * 待っているジョブに GPU を譲るか。GPU を使わないジョブ（上の表に無い種類）が待っていても譲らない
 * （譲ると判定係を降ろすことになり、次の判定でモデルを読み込み直す）。
 * GPU を使うジョブが待っていて、こちらに仕事が無い（bestPriority=null）なら譲る。
 * 仕事があれば、待っている相手の重要度のほうが高いときだけ譲る（同じなら、こちらを続ける）。
 */
export function shouldYieldHanamiGpu(waiters: readonly string[], bestPriority: number | null): boolean {
	const gpuWaiters = waiters.filter(kind => HANAMI_GPU_LEGACY_JOB_PRIORITY[kind] != null);
	if (gpuWaiters.length === 0) return false;
	if (bestPriority == null) return true;
	const waiterPriority = Math.max(...gpuWaiters.map(kind => HANAMI_GPU_LEGACY_JOB_PRIORITY[kind] ?? 0));
	return waiterPriority > bestPriority;
}
