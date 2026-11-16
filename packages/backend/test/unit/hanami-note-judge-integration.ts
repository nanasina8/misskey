/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { afterAll, beforeAll, describe, expect, vi as jest, test } from 'vitest';
import { IdService } from '@/core/IdService.js';
import { HanamiForYouBatchService, type HanamiNoteJudgeGpuOutput } from '@/core/hanami/HanamiForYouBatchService.js';
import type { HanamiGpuQueueTakenItem } from '@/core/hanami/HanamiGpuQueueService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiPersonalFeedComputationService } from '@/core/hanami/HanamiPersonalFeedComputationService.js';
import type { HanamiPersonalFeedGenerationContext } from '@/core/hanami/HanamiForYouService.js';
import type { HanamiPersonalFeedCandidate } from '@/core/hanami/HanamiUserFeedContracts.js';

type PersonalJudgeInternals = {
	applyJudgeSelection(context: HanamiPersonalFeedGenerationContext, candidates: readonly HanamiPersonalFeedCandidate[], judgeContext: { settings: ReturnType<typeof createDefaultHanamiNoteJudgeSettings>; reduceEphemeralPosts: boolean }): Promise<readonly HanamiPersonalFeedCandidate[]>;
};

function batchService(query: unknown, redis: unknown = { zrem: jest.fn(async (..._args: unknown[]) => 0), zremrangebyscore: jest.fn(async (..._args: unknown[]) => 0), zrangebyscore: jest.fn(async (..._args: unknown[]) => []), get: jest.fn(async (..._args: unknown[]) => null), set: jest.fn(async (..._args: unknown[]) => 'OK'), eval: jest.fn(async (..._args: unknown[]) => 1), del: jest.fn(async (..._args: unknown[]) => 0) }, idService: Pick<IdService, 'gen'> = { gen: () => 'run-id' }): HanamiForYouBatchService {
	return new HanamiForYouBatchService({ query } as never, { insert: jest.fn(async (..._args: unknown[]) => undefined), update: jest.fn(async (..._args: unknown[]) => undefined) } as never, redis as never, idService as never, {} as never);
}

function redisFake() {
	return {
		zrem: jest.fn(async (..._args: unknown[]) => 0), zremrangebyscore: jest.fn(async (..._args: unknown[]) => 0), zrangebyscore: jest.fn(async (..._args: unknown[]) => []),
		get: jest.fn(async (..._args: unknown[]) => null as string | null), set: jest.fn(async (..._args: unknown[]) => 'OK'), eval: jest.fn(async (..._args: unknown[]) => 1), del: jest.fn(async (..._args: unknown[]) => 0),
		multi: () => { const chain = { lpush: () => chain, ltrim: () => chain, expire: () => chain, exec: async () => [] }; return chain; },
	};
}

/** 順番待ち（偽物）つきのサービス。判定係・配り役は動かさない */
function gpuBatchService(query: unknown) {
	const redis = redisFake();
	const modelRuns = { insert: jest.fn(async (..._args: unknown[]) => undefined), update: jest.fn(async (..._args: unknown[]) => undefined) };
	const queue = { enqueue: jest.fn(async (..._args: unknown[]) => true), length: jest.fn(async (..._args: unknown[]) => 0) };
	const service = new HanamiForYouBatchService({ query } as never, modelRuns as never, redis as never, { gen: () => 'run-id' } as never, {} as never, queue as never);
	return { service, redis, modelRuns, queue };
}

function takenItem(itemId: string, noteId: string, promptVersion: number): HanamiGpuQueueTakenItem {
	return { itemId, payload: { noteId, promptVersion, cleanedText: 'text', hasFiles: false, settings: { basis: {}, examples: [] } }, enqueuedAt: Date.now() - 1000, attempts: 0 };
}

// 判定そのものは常駐の判定係が行うので、ここでは「順番待ちに入れる」「返ってきた結果を保存する」を確かめる。
// GPU ゲート（probe）は HANAMI_NOTE_JUDGE_DEVICE=cpu の明示で迂回する（本番の CPU 強制と同じ経路）。
const previousJudgeDevice = process.env.HANAMI_NOTE_JUDGE_DEVICE;
beforeAll(() => { process.env.HANAMI_NOTE_JUDGE_DEVICE = 'cpu'; });
afterAll(() => {
	if (previousJudgeDevice == null) delete process.env.HANAMI_NOTE_JUDGE_DEVICE;
	else process.env.HANAMI_NOTE_JUDGE_DEVICE = previousJudgeDevice;
});

describe('Hanami note judge integration', () => {
	test('rejudges rows selected against a changed prompt version, persists rule exclusions with UPSERT, and emits only <=16 jobs by default', async () => {
		const settings = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 2 };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM "hanami_common_candidate"')) {
				return [
					...Array.from({ length: 65 }, (_, index) => ({ id: `judge-${index}`, text: 'SQLite の運用メモです。', isBot: false, isReply: false })),
					// This represents a row whose stored judgement had promptVersion 1;
					// the versioned LEFT JOIN admits it for promptVersion 2.
					{ id: 'old-version-reply', text: 'reply', isBot: false, isReply: true },
				];
			}
			return [];
		});
		const service = batchService(query);

		await expect(service.prepareNoteJudgeJobs('generation-1')).resolves.toEqual([
			{ noteIds: Array.from({ length: 16 }, (_, index) => `judge-${index}`), promptVersion: 2 },
			{ noteIds: Array.from({ length: 16 }, (_, index) => `judge-${index + 16}`), promptVersion: 2 },
			{ noteIds: Array.from({ length: 16 }, (_, index) => `judge-${index + 32}`), promptVersion: 2 },
			{ noteIds: Array.from({ length: 16 }, (_, index) => `judge-${index + 48}`), promptVersion: 2 },
			{ noteIds: ['judge-64'], promptVersion: 2 },
		]);

		const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		const candidateQuery = calls.find(([sql]) => sql.includes('FROM "hanami_common_candidate"'))!;
		expect(candidateQuery[0]).toContain('c."generationId" = $1');
		expect(candidateQuery[0]).toContain('j."promptVersion" = $2');
		expect(candidateQuery[0]).toContain('j."noteId" IS NULL');
		expect(candidateQuery[1]).toEqual(['generation-1', 2]);
		expect(candidateQuery[0]).not.toMatch(/n\.id\s*>=|createdAt|clock_timestamp|INTERVAL/);
		const upsert = calls.find(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))!;
		expect(upsert[0]).toContain('ON CONFLICT ("noteId") DO UPDATE SET');
		expect(upsert[1]).toEqual(['old-version-reply', 'rule:reply', 2, [1, 0, 0, 0, 0]]);
		// prepareNoteJudgeJobs has no model/runtime dependency: the rule exclusion
		// is durable before any Python job can be made.
		expect(query).toHaveBeenCalledTimes(3);
	});

	test('honors HANAMI_NOTE_JUDGE_BATCH_SIZE within the 1..64 hard cap', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM "hanami_common_candidate"')) {
				return Array.from({ length: 65 }, (_, index) => ({ id: `judge-${index}`, text: 'SQLite の運用メモです。', isBot: false, isReply: false }));
			}
			return [];
		});
		const previous = process.env.HANAMI_NOTE_JUDGE_BATCH_SIZE;
		process.env.HANAMI_NOTE_JUDGE_BATCH_SIZE = '33';
		try {
			const jobs = await batchService(query).prepareNoteJudgeJobs('generation-1');
			expect(jobs.map(job => job.noteIds.length)).toEqual([33, 32]);
		} finally {
			if (previous == null) delete process.env.HANAMI_NOTE_JUDGE_BATCH_SIZE;
			else process.env.HANAMI_NOTE_JUDGE_BATCH_SIZE = previous;
		}
	});

	test('rejects an oversized model job before reading settings or invoking a runtime', async () => {
		const query = jest.fn();
		const service = batchService(query);

		await expect(service.runNoteJudgeJob({ noteIds: Array.from({ length: 65 }, (_, index) => String(index)), promptVersion: 1 }, { warn: jest.fn() } as never)).rejects.toThrow('1..64');
		expect(query).not.toHaveBeenCalled();
	});

	test('hands each judgeable note to the resident GPU worker queue without running a model or creating a run', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [
				{ id: 'note-a', text: '運用に役立つ投稿です。', hasFiles: true, isBot: false, isReply: false },
				{ id: 'reply-b', text: '返信です。これは決まりで落ちます。', hasFiles: false, isBot: false, isReply: true },
			];
			return [];
		});
		const { service, queue, redis, modelRuns } = gpuBatchService(query);

		const result = await service.runNoteJudgeJob({ noteIds: ['note-a', 'reply-b', 'already-judged'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never, 'job-1');

		expect(result).toEqual({ runId: null, status: 'ready', processedCount: 0, queuedCount: 1 });
		expect(queue.enqueue).toHaveBeenCalledTimes(1);
		expect(queue.enqueue).toHaveBeenCalledWith('noteJudge', `${settings.promptVersion}:note-a`, {
			noteId: 'note-a', promptVersion: settings.promptVersion, cleanedText: '運用に役立つ投稿です。', hasFiles: true,
			settings: { basis: settings.basis, examples: settings.examples },
		});
		// 判定に回した投稿の予約は残し（結果が出たら受け取り係が外す）、回さなかった分だけ外す。
		expect(redis.zrem).toHaveBeenCalledWith('hanami:note-judge:queued:v1', 'reply-b', 'already-judged');
		// モデルは動かさないので、実行の記録もロックも作らない。
		expect(modelRuns.insert).not.toHaveBeenCalled();
		expect(redis.set).not.toHaveBeenCalled();
		expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))).toBe(false);
	});

	test('keeps the reservation when the same note is already waiting in the queue', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'note-a', text: '運用に役立つ投稿です。', hasFiles: false, isBot: false, isReply: false }];
			return [];
		});
		const { service, queue, redis } = gpuBatchService(query);
		queue.enqueue.mockResolvedValue(false);

		await expect(service.runNoteJudgeJob({ noteIds: ['note-a'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never)).resolves.toMatchObject({ status: 'ready', queuedCount: 0 });
		expect(redis.zrem).not.toHaveBeenCalled();
	});

	test('queues a prior promptVersion with its immutable historical settings, not newer Meta', async () => {
		const historical = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 8, interestThreshold: 3.1, templatePatterns: ['historical-only'], examples: ['historical example'] };
		const current = { ...historical, promptVersion: 9, interestThreshold: 4.7, templatePatterns: ['current-only'], examples: ['current example'] };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('FROM "hanami_note_judge_settings"')) return [{ settings: historical }];
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings: current }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'prior-note', text: 'useful archived configuration note', hasFiles: false, isBot: false, isReply: false }];
			return [];
		});
		const { service, queue } = gpuBatchService(query);

		await expect(service.runNoteJudgeJob({ noteIds: ['prior-note'], promptVersion: 8 }, { warn: jest.fn() } as never)).resolves.toMatchObject({ status: 'ready', queuedCount: 1 });
		expect(queue.enqueue).toHaveBeenCalledWith('noteJudge', '8:prior-note', expect.objectContaining({ promptVersion: 8, settings: { basis: historical.basis, examples: ['historical example'] } }));
		expect(query.mock.calls.some(([sql]) => sql.includes('SELECT "hanamiNoteJudgeSettings"'))).toBe(false);
	});

	test('the handler durably UPSERTs what the worker returned, records one run for the batch, and clears the reservations', async () => {
		const query = jest.fn(async (..._args: unknown[]) => []);
		const { service, redis, modelRuns } = gpuBatchService(query);
		const items = [takenItem('3:note-a', 'note-a', 3), takenItem('3:note-b', 'note-b', 3)];
		const results = new Map<string, HanamiNoteJudgeGpuOutput>([
			['3:note-a', { noteId: 'note-a', ephemeralScore: 0.25, interest: 4, interestDist: [0, 0, 0, 1, 0], contentType: 2 }],
			['3:note-b', { noteId: 'note-b', ephemeralScore: -3, interest: 2.5, interestDist: [0, 0.5, 0.5, 0, 0], contentType: 9 }],
		]);

		await service.handleNoteJudged(items, results, new Map(), 800);

		const upserts = (query.mock.calls as unknown as Array<[string, unknown[]]>).filter(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'));
		expect(upserts.map(([, values]) => values)).toEqual([
			['note-a', 'Qwen/Qwen3-4B-Instruct-2507', 3, 0.25, 4, [0, 0, 0, 1, 0], 2],
			['note-b', 'Qwen/Qwen3-4B-Instruct-2507', 3, -3, 2.5, [0, 0.5, 0.5, 0, 0], 9],
		]);
		// 消された投稿でも失敗しないよう、いまある投稿だけに入れる文を使う。
		expect(upserts[0][0]).toContain('FROM note n WHERE n.id = $1');
		expect(modelRuns.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note-judge', status: 'pending' }));
		// 実行の記録の開始時刻は、判定係が判定にかけた時間（800ms）ぶん前。指標の「判定 1 回の時間」に判定の時間が入る。
		const startedAt = (modelRuns.insert.mock.calls[0] as unknown as [{ startedAt: Date }])[0].startedAt;
		expect(Date.now() - startedAt.getTime()).toBeGreaterThanOrEqual(800);
		expect(Date.now() - startedAt.getTime()).toBeLessThan(5000);
		expect(modelRuns.update).toHaveBeenCalledWith({ id: 'run-id' }, expect.objectContaining({ status: 'ready', params: expect.objectContaining({ processedCount: 2, secondsPerItem: 0.4, residentWorker: true }) }));
		expect(redis.zrem).toHaveBeenCalledWith('hanami:note-judge:queued:v1', 'note-a', 'note-b');
	});

	test('the handler skips notes the worker could not judge, still closes the run, and frees them for the next reconcile', async () => {
		const query = jest.fn(async (..._args: unknown[]) => []);
		const { service, redis, modelRuns } = gpuBatchService(query);
		const items = [takenItem('1:ok-note', 'ok-note', 1), takenItem('1:error-note', 'error-note', 1), takenItem('1:broken-note', 'broken-note', 1)];
		const results = new Map<string, HanamiNoteJudgeGpuOutput>([
			['1:ok-note', { noteId: 'ok-note', ephemeralScore: 1, interest: 3, interestDist: [0, 0, 1, 0, 0], contentType: 4 }],
			// 形のおかしい結果は保存しない。
			['1:broken-note', { noteId: 'broken-note', ephemeralScore: Number.NaN, interest: 3, interestDist: [1], contentType: 4 }],
		]);

		await service.handleNoteJudged(items, results, new Map([['1:error-note', 'RuntimeError: inference failed']]), 600);

		const upserts = (query.mock.calls as unknown as Array<[string, unknown[]]>).filter(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'));
		expect(upserts.map(([, values]) => values[0])).toEqual(['ok-note']);
		expect(modelRuns.update).toHaveBeenCalledWith({ id: 'run-id' }, expect.objectContaining({ status: 'ready', params: expect.objectContaining({ processedCount: 1, itemErrors: 1, firstItemError: 'RuntimeError: inference failed' }) }));
		expect(redis.zrem).toHaveBeenCalledWith('hanami:note-judge:queued:v1', 'ok-note', 'error-note', 'broken-note');
	});

	test('the handler rejects when saving fails, so the dispatcher puts the batch back, and marks the run failed with the reason', async () => {
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('INSERT INTO "hanami_note_judgement"')) throw new Error('database is down');
			return [];
		});
		const { service, modelRuns } = gpuBatchService(query);
		const results = new Map<string, HanamiNoteJudgeGpuOutput>([['1:note-a', { noteId: 'note-a', ephemeralScore: 0, interest: 3, interestDist: [0, 0, 1, 0, 0], contentType: 1 }]]);

		await expect(service.handleNoteJudged([takenItem('1:note-a', 'note-a', 1)], results, new Map(), 300)).rejects.toThrow('database is down');
		expect(modelRuns.update).toHaveBeenCalledWith({ id: 'run-id' }, expect.objectContaining({ status: 'failed', params: expect.objectContaining({ processedCount: 0, failure: 'database is down' }) }));
	});

	test('fails the queue attempt when the hand-off fails, frees the reservation, and reconciliation re-emits pending work for a new prompt version', async () => {
		const v1 = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 1 };
		const v2 = { ...v1, promptVersion: 2 };
		let settings = v1;
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'retry-note', text: '役立つ情報です。', hasFiles: false, isBot: false, isReply: false }];
			if (sql.includes('FROM "hanami_common_candidate"')) return [{ id: 'retry-note', text: '役立つ情報です。', isBot: false, isReply: false }];
			return [];
		});
		const { service, queue, redis } = gpuBatchService(query);
		queue.enqueue.mockRejectedValueOnce(new Error('redis is down'));

		await expect(service.runNoteJudgeJob({ noteIds: ['retry-note'], promptVersion: 1 }, { warn: jest.fn() } as never)).rejects.toThrow('redis is down');
		expect(redis.zrem).toHaveBeenCalledWith('hanami:note-judge:queued:v1', 'retry-note');
		settings = v2;
		// 版が変わったあとに残っていた古い版のジョブは、何もせずに終わる。
		await expect(service.runNoteJudgeJob({ noteIds: ['retry-note'], promptVersion: 1 }, { warn: jest.fn() } as never)).resolves.toMatchObject({ status: 'ready', processedCount: 0, queuedCount: 0 });
		await expect(service.reconcileNoteJudgeJobs()).resolves.toEqual([{ noteIds: ['retry-note'], promptVersion: 2 }]);
	});

	test('cleans only judgements older than fourteen days', async () => {
		const query = jest.fn(async (..._args: unknown[]) => [[], 1]);
		await expect(batchService(query).cleanupNoteJudgements()).resolves.toBe(1);
		expect(query).toHaveBeenCalledWith(expect.stringContaining('"judgedAt" < clock_timestamp() - INTERVAL \'14 days\''));
		// The strict less-than predicate preserves rows exactly at the boundary and all newer rows.
	});

	test.each(['aid', 'aidx', 'meid', 'meidg', 'ulid', 'objectid'])('reconciles the generated-ID window for %s using current ready, unjudged candidates (modeled query)', async (format) => {
		const now = Date.UTC(2026, 8, 16, 12);
		const cutoff = now - 72 * 60 * 60 * 1000;
		const settings = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 9 };
		const idService = new IdService({ id: format } as never);
		const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
		try {
			const sinceId = idService.gen(cutoff);
			const candidate = (id: string, overrides: { generationId?: string; status?: string; judgedVersion?: number } = {}) => ({
				id, text: '運用に役立つ投稿です。', isBot: false, isReply: false,
				generationId: 'latest-ready', status: 'ready', judgedVersion: undefined as number | undefined, ...overrides,
			});
			// Reuse the exact generated ID for equality: another ID generated at the
			// same millisecond need not compare >= it. Whole-second gaps also cover objectid.
			const older = candidate(idService.gen(cutoff - 1000));
			const equal = candidate(sinceId);
			const newer = candidate(idService.gen(cutoff + 1000));
			const previousVersion = candidate(idService.gen(cutoff + 2000), { judgedVersion: 8 });
			const fixtures = [
				older, equal, newer, previousVersion,
				candidate(idService.gen(cutoff + 3000), { judgedVersion: 9 }),
				candidate(idService.gen(cutoff + 4000), { generationId: 'historical-ready' }),
				candidate(idService.gen(cutoff + 5000), { status: 'building' }),
			];
			expect(older.id < sinceId).toBe(true);
			expect(newer.id > sinceId).toBe(true);
			const genSpy = jest.spyOn(idService, 'gen').mockReturnValue(sinceId);
			try {
				const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
					if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
					if (!sql.includes('FROM "hanami_common_candidate"')) return [];
					expect(sql).toContain('n.id >= $1');
					expect(sql).not.toMatch(/n\."?createdAt"?|clock_timestamp|INTERVAL/);
					expect(sql).toContain('c."generationId" = (');
					expect(sql).toContain('SELECT state."latestReadyGenerationId" FROM "hanami_common_feed_state" state');
					expect(sql).toContain('JOIN "hanami_common_generation" g ON g.id = c."generationId" AND g.status = \'ready\'');
					expect(sql).toContain('LEFT JOIN "hanami_note_judgement" j ON j."noteId" = n.id AND j."promptVersion" = $2');
					expect(sql).toContain('j."noteId" IS NULL');
					expect(parameters).toEqual([sinceId, 9]);
					// Model the asserted query contract over fixtures, not PostgreSQL execution.
					const [boundSinceId, boundVersion] = parameters as [string, number];
					return fixtures.filter(row => row.id >= boundSinceId
						&& row.generationId === 'latest-ready' && row.status === 'ready'
						&& row.judgedVersion !== boundVersion)
						.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
				});
				await expect(batchService(query, undefined, idService).reconcileNoteJudgeJobs()).resolves.toEqual([
					{ noteIds: [previousVersion.id, newer.id, equal.id], promptVersion: 9 },
				]);
				expect(genSpy).toHaveBeenCalledTimes(1);
				expect(genSpy).toHaveBeenCalledWith(cutoff);
				expect(query).toHaveBeenCalledTimes(2);
			} finally {
				genSpy.mockRestore();
			}
		} finally {
			nowSpy.mockRestore();
		}
	});

	test('cleanup followed by reconciliation excludes an older-ID ready candidate without an UPSERT or job (modeled query)', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const idService = new IdService({ id: 'aid' } as never);
		const cutoff = Date.UTC(2026, 8, 13, 12);
		const sinceId = idService.gen(cutoff);
		const historicalCandidate = { id: idService.gen(cutoff - 1000), text: '運用に役立つ投稿です。', isBot: false, isReply: false };
		let hasJudgement = true;
		const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
			if (sql.includes('DELETE FROM "hanami_note_judgement"')) {
				hasJudgement = false;
				return [[], 1];
			}
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM "hanami_common_candidate"')) {
				// Cleanup makes this otherwise eligible row pending again, but the bound
				// ID window must prevent recreating the deleted judgement or emitting a job.
				expect(hasJudgement).toBe(false);
				expect(parameters).toEqual([sinceId, settings.promptVersion]);
				return [historicalCandidate].filter(row => !hasJudgement && row.id >= (parameters![0] as string));
			}
			return [];
		});
		const insert = jest.fn(async (..._args: unknown[]) => undefined);
		const service = new HanamiForYouBatchService({ query } as never, { insert, update: jest.fn() } as never, { zrem: jest.fn(async (..._args: unknown[]) => 0), zremrangebyscore: jest.fn(async (..._args: unknown[]) => 0), zrangebyscore: jest.fn(async (..._args: unknown[]) => []), get: jest.fn(async (..._args: unknown[]) => null), set: jest.fn(async (..._args: unknown[]) => 'OK'), eval: jest.fn(async (..._args: unknown[]) => 1), del: jest.fn(async (..._args: unknown[]) => 0) } as never, { gen: () => sinceId } as never, {} as never);

		await expect(service.cleanupNoteJudgements()).resolves.toBe(1);
		await expect(service.reconcileNoteJudgeJobs()).resolves.toEqual([]);

		const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		const cleanupCall = calls.findIndex(([sql]) => sql.includes('DELETE FROM "hanami_note_judgement"'));
		const reconcileCall = calls.findIndex(([sql]) => sql.includes('FROM "hanami_common_candidate"'));
		expect(cleanupCall).toBeGreaterThanOrEqual(0);
		expect(reconcileCall).toBeGreaterThan(cleanupCall);
		const reconcileQuery = calls[reconcileCall][0];
		expect(reconcileQuery).toContain('c."generationId" = (');
		expect(reconcileQuery).toContain('"latestReadyGenerationId"');
		expect(reconcileQuery).toContain('g.status = \'ready\'');
		expect(reconcileQuery).toContain('n.id >= $1');
		expect(reconcileQuery).not.toMatch(/n\."?createdAt"?/);
		expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))).toBe(false);
		expect(insert).not.toHaveBeenCalled();
	});

	test('does not wait for, take, or ask for the GPU lock: the hand-off works while another job holds it, and reconciliation is unaffected', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'locked-note', text: '役立つ情報です。', hasFiles: false, isBot: false, isReply: false }];
			return [];
		});
		const { service, queue, redis } = gpuBatchService(query);
		// ほかの判定が GPU の鍵を持っていて、以前の「話題の判定が待っている」目印も残っている。
		redis.get.mockImplementation(async (key: unknown) => key === 'hanami:llm:exclusive:v1' ? 'gpuWorker:1:1:token' : key === 'hanami:llm:topic-judge-waiting:v1' ? '1' : null);

		await expect(service.runNoteJudgeJob({ noteIds: ['locked-note'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never)).resolves.toMatchObject({ status: 'ready', queuedCount: 1 });
		expect(queue.enqueue).toHaveBeenCalledTimes(1);
		expect(redis.set).not.toHaveBeenCalled();
		await service.reconcileNoteJudgeJobs();
		const reconcileQuery = (query.mock.calls as unknown as Array<[string]>).find(([sql]) => sql.includes('FROM "hanami_common_candidate"'))![0];
		expect(reconcileQuery).toContain('"latestReadyGenerationId"');
		expect(reconcileQuery).toContain('n.id >= $1');
	});

	test('registers the note and topic handlers on the dispatcher at module init', () => {
		const registerHandler = jest.fn();
		const service = new HanamiForYouBatchService({ query: jest.fn() } as never, {} as never, {} as never, {} as never, {} as never, {} as never, { registerHandler } as never);
		service.onModuleInit();
		expect(registerHandler.mock.calls.map(([kind]) => kind)).toEqual(['noteJudge', 'topicJudge']);
	});

	test('filters judged ephemeral popular/trending candidates outside direct follows while retaining unrelated axes', async () => {
		const queryRunner = { query: jest.fn(async (..._args: unknown[]) => [{ settings: createDefaultHanamiNoteJudgeSettings() }]) };
		const service = new HanamiPersonalFeedComputationService({} as never, {} as never, {} as never, {} as never, {} as never);
		const context = { userId: 'viewer', queryRunner } as unknown as HanamiPersonalFeedGenerationContext;
		const candidate = (noteId: string, axis: string, relationshipClass: 'directFollow' | 'unknown'): HanamiPersonalFeedCandidate => ({
			noteId,
			authorId: `author-${noteId}`,
			axis: axis as HanamiPersonalFeedCandidate['axis'],
			origin: axis === 'globalPopular' || axis === 'trending' ? 'commonCandidate' : 'personalCandidate',
			score: 1,
			relationshipClass,
			hanamiJudge: { ephemeralScore: 1, interest: 4 },
			hanamiJudgeReason: 'llm',
			hanamiHasFiles: false,
		} as HanamiPersonalFeedCandidate);

		const selected = await (service as unknown as PersonalJudgeInternals).applyJudgeSelection(context, [
			candidate('popular-outside', 'globalPopular', 'unknown'),
			candidate('trending-outside', 'trending', 'unknown'),
			candidate('direct-follow', 'globalPopular', 'directFollow'),
			candidate('unrelated-ephemeral', 'neighborTrending', 'unknown'),
		], { settings: createDefaultHanamiNoteJudgeSettings(), reduceEphemeralPosts: true });

		expect(selected.map(item => item.noteId)).toEqual(['direct-follow', 'unrelated-ephemeral']);
	});

	test('viewer OFF retains ephemeral exploration and popular/trending while keeping exploration interest gating', async () => {
		const queryRunner = { query: jest.fn(async (..._args: unknown[]) => [{ settings: createDefaultHanamiNoteJudgeSettings() }]) };
		const service = new HanamiPersonalFeedComputationService({} as never, {} as never, {} as never, {} as never, {} as never);
		const context = { userId: 'viewer', queryRunner } as unknown as HanamiPersonalFeedGenerationContext;
		const candidate = (noteId: string, axis: string, interest: number): HanamiPersonalFeedCandidate => ({
			noteId, authorId: `author-${noteId}`, axis: axis as HanamiPersonalFeedCandidate['axis'],
			origin: axis === 'globalPopular' || axis === 'trending' || axis === 'exploration' ? 'commonCandidate' : 'personalCandidate', score: 1,
			relationshipClass: 'unknown', hanamiJudge: { ephemeralScore: 1, interest }, hanamiReduceEphemeralPosts: false,
		} as HanamiPersonalFeedCandidate);
		const selected = await (service as unknown as PersonalJudgeInternals).applyJudgeSelection(context, [
			candidate('popular', 'globalPopular', 4), candidate('trending', 'trending', 4),
			candidate('explore', 'exploration', 4), candidate('low-interest', 'exploration', 2.94),
		], { settings: createDefaultHanamiNoteJudgeSettings(), reduceEphemeralPosts: false });
		expect(selected.map(item => item.noteId)).toEqual(['popular', 'trending', 'explore']);
	});

	test('keeps rule exclusions and image posts on popular while excluding text-only LLM ephemerals', async () => {
		const service = new HanamiPersonalFeedComputationService({} as never, {} as never, {} as never, {} as never, {} as never);
		const context = { userId: 'viewer', queryRunner: { query: jest.fn(async (..._args: unknown[]) => [{ settings: createDefaultHanamiNoteJudgeSettings() }]) } } as unknown as HanamiPersonalFeedGenerationContext;
		const candidate = (noteId: string, reason: 'llm' | 'emptyText', hasFiles: boolean): HanamiPersonalFeedCandidate => ({
			noteId, authorId: `author-${noteId}`, axis: 'globalPopular', origin: 'commonCandidate', score: 1,
			relationshipClass: 'unknown', hanamiJudge: { ephemeralScore: 1, interest: 4 },
			hanamiJudgeReason: reason, hanamiHasFiles: hasFiles,
		} as HanamiPersonalFeedCandidate);

		const selected = await (service as unknown as PersonalJudgeInternals).applyJudgeSelection(context, [
			candidate('empty-text-image', 'emptyText', true),
			candidate('llm-text-only', 'llm', false),
			candidate('llm-image', 'llm', true),
		], { settings: createDefaultHanamiNoteJudgeSettings(), reduceEphemeralPosts: true });

		expect(selected.map(item => item.noteId)).toEqual(['empty-text-image', 'llm-image']);
	});
});

describe('Hanami note judge GPU gate', () => {
	test('without a GPU, rule exclusions are still recorded but no LLM job is emitted and queued jobs are skipped without loading the model', async () => {
		const previousDevice = process.env.HANAMI_NOTE_JUDGE_DEVICE;
		const previousScript = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		const dir = await mkdtemp(Path.join(tmpdir(), 'hanami-judge-gate-'));
		const scriptPath = Path.join(dir, 'judge.py');
		// --probe は GPU なしを返し、判定モードで呼ばれたら失敗する（呼ばれてはいけない）。
		await writeFile(scriptPath, 'import json, sys\nif sys.argv[1:] == [\'--probe\']:\n    print(json.dumps({\'cudaAvailable\': False, \'deviceName\': None, \'error\': None}))\n    sys.exit(0)\nsys.exit(99)\n');
		delete process.env.HANAMI_NOTE_JUDGE_DEVICE;
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;
		try {
			const settings = createDefaultHanamiNoteJudgeSettings();
			const query = jest.fn(async (sql: string) => {
				if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
				if (sql.includes('FROM "hanami_common_candidate"')) {
					return [
						{ id: 'text-1', text: 'SQLite の運用メモです。', isBot: false, isReply: false },
						{ id: 'reply-1', text: 'reply', isBot: false, isReply: true },
					];
				}
				if (sql.includes('FROM note n')) return [{ id: 'text-1', text: 'SQLite の運用メモです。', hasFiles: false, isBot: false, isReply: false }];
				return [];
			});
			const insert = jest.fn(async (..._args: unknown[]) => undefined);
			const update = jest.fn(async (..._args: unknown[]) => undefined);
			const service = new HanamiForYouBatchService({ query } as never, { insert, update } as never, { zrem: jest.fn(async (..._args: unknown[]) => 0), zremrangebyscore: jest.fn(async (..._args: unknown[]) => 0), zrangebyscore: jest.fn(async (..._args: unknown[]) => []), get: jest.fn(async (..._args: unknown[]) => null), set: jest.fn(async (..._args: unknown[]) => 'OK'), eval: jest.fn(async (..._args: unknown[]) => 1), del: jest.fn(async (..._args: unknown[]) => 0) } as never, { gen: () => 'run-id' } as never, {} as never);

			await expect(service.prepareNoteJudgeJobs('generation-1')).resolves.toEqual([]);
			const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
			expect(calls.find(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))![1]).toEqual(['reply-1', 'rule:reply', 1, [1, 0, 0, 0, 0]]);

			const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as never;
			await expect(service.runNoteJudgeJob({ noteIds: ['text-1'], promptVersion: 1 }, logger)).resolves.toEqual({ runId: 'run-id', status: 'ready', processedCount: 0, queuedCount: 0 });
			expect(update).toHaveBeenCalledWith({ id: 'run-id' }, expect.objectContaining({ status: 'ready', params: expect.objectContaining({ processedCount: 0, skippedReason: expect.stringContaining('GPU') }) }));
			expect(calls.some(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"') && sql.includes('$4'))).toBe(true);
			// 判定に回す投稿の読み出しは行われない（除外の記録の INSERT も「今ある投稿だけ」のために note を見るので、それは除く）。
			expect(calls.filter(([sql]) => sql.includes('FROM note n') && !sql.includes('INSERT INTO "hanami_note_judgement"')).length).toBe(0);
		} finally {
			if (previousDevice == null) delete process.env.HANAMI_NOTE_JUDGE_DEVICE; else process.env.HANAMI_NOTE_JUDGE_DEVICE = previousDevice;
			if (previousScript == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT; else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previousScript;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
