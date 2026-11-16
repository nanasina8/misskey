/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, vi as jest, test } from 'vitest';
import * as Bull from 'bullmq';
import { HanamiForYouBatchService, type HanamiNoteJudgeGpuOutput } from '@/core/hanami/HanamiForYouBatchService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';

class MockBullNoteJudgeLifecycle {
	public attemptsMade = 0;
	public state: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' = 'waiting';
	public readonly job = {
		name: 'hanamiNoteJudge',
		data: { noteIds: ['note-1'], promptVersion: 1 },
		token: 'worker-token',
		log: jest.fn(async (..._args: unknown[]) => undefined),
		updateProgress: jest.fn(async (..._args: unknown[]) => undefined),
		moveToDelayed: jest.fn(async (_timestamp: number, _token?: string) => {
			this.state = 'delayed';
		}),
	};

	public async process(processor: HanamiCommonGenerationProcessorService): Promise<void> {
		this.state = 'active';
		try {
			await processor.processNoteJudge(this.job as never);
			this.state = 'completed';
		} catch (error) {
			if (error instanceof Bull.DelayedError) return;
			this.attemptsMade += 1;
			this.state = 'failed';
			throw error;
		}
	}
}

// GPU ゲート（probe）は HANAMI_NOTE_JUDGE_DEVICE=cpu の明示で迂回する（本番の CPU 強制と同じ経路）。
const previousJudgeDevice = process.env.HANAMI_NOTE_JUDGE_DEVICE;
beforeAll(() => { process.env.HANAMI_NOTE_JUDGE_DEVICE = 'cpu'; });
afterAll(() => {
	if (previousJudgeDevice == null) delete process.env.HANAMI_NOTE_JUDGE_DEVICE;
	else process.env.HANAMI_NOTE_JUDGE_DEVICE = previousJudgeDevice;
});

describe('Hanami note judge Bull lifecycle', () => {
	test('completes on the first attempt while the GPU lock is busy, then persists when the resident worker answers', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const persistedJudgements: unknown[][] = [];
		const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) {
				return [{ id: 'note-1', text: '役立つ運用メモです。', hasFiles: false, isBot: false, isReply: false }];
			}
			if (sql.includes('INSERT INTO "hanami_note_judgement"')) {
				persistedJudgements.push(parameters!);
				return [];
			}
			return [];
		});
		const modelRuns = {
			insert: jest.fn(async (..._args: unknown[]) => undefined),
			update: jest.fn(async (..._args: unknown[]) => undefined),
		};
		// 以前はここで GPU の鍵（SET NX）を取りにいき、取れないとジョブを 60 秒遅らせていた。
		const redis = {
			zrem: jest.fn(async (..._args: unknown[]) => 0), zremrangebyscore: jest.fn(async (..._args: unknown[]) => 0), zrangebyscore: jest.fn(async (..._args: unknown[]) => []), get: jest.fn(async (..._args: unknown[]) => null),
			set: jest.fn(async (..._args: unknown[]) => null),
			eval: jest.fn(async (..._args: unknown[]) => 1),
			del: jest.fn(async (..._args: unknown[]) => 0),
		};
		const queued: Array<{ kind: string; itemId: string; payload: unknown }> = [];
		const gpuQueue = {
			enqueue: jest.fn(async (kind: string, itemId: string, payload: unknown) => { queued.push({ kind, itemId, payload }); return true; }),
			length: jest.fn(async (..._args: unknown[]) => 0),
		};
		const batch = new HanamiForYouBatchService(
			{ query } as never,
			modelRuns as never,
			redis as never,
			{ gen: () => 'run-1' } as never,
			{} as never,
			gpuQueue as never,
		);
		const processor = new HanamiCommonGenerationProcessorService(
			{} as never,
			{} as never,
			{ logger: { createSubLogger: () => ({ info: jest.fn(), succ: jest.fn(), warn: jest.fn() }) } } as never,
			batch,
		);
		const lifecycle = new MockBullNoteJudgeLifecycle();

		await lifecycle.process(processor);

		expect(lifecycle.state).toBe('completed');
		expect(lifecycle.attemptsMade).toBe(0);
		expect(lifecycle.job.moveToDelayed).not.toHaveBeenCalled();
		expect(lifecycle.job.updateProgress).toHaveBeenCalledWith(100);
		expect(redis.set).not.toHaveBeenCalled();
		expect(modelRuns.insert).not.toHaveBeenCalled();
		expect(persistedJudgements).toEqual([]);
		expect(queued).toEqual([{ kind: 'noteJudge', itemId: '1:note-1', payload: expect.objectContaining({ noteId: 'note-1', promptVersion: 1, cleanedText: '役立つ運用メモです。' }) }]);

		// 常駐の判定係が返事をしたら、受け取り係が保存して実行の記録を閉じる。
		const results = new Map<string, HanamiNoteJudgeGpuOutput>([['1:note-1', { noteId: 'note-1', ephemeralScore: 0.25, interest: 4, interestDist: [0, 0, 0, 1, 0], contentType: 2 }]]);
		await batch.handleNoteJudged([{ itemId: '1:note-1', payload: queued[0].payload, enqueuedAt: Date.now() - 500, attempts: 0 }], results, new Map(), 400);

		expect(persistedJudgements).toEqual([['note-1', 'Qwen/Qwen3-4B-Instruct-2507', 1, 0.25, 4, [0, 0, 0, 1, 0], 2]]);
		expect(modelRuns.update).toHaveBeenCalledWith({ id: 'run-1' }, expect.objectContaining({ status: 'ready' }));
		expect(redis.zrem).toHaveBeenCalledWith('hanami:note-judge:queued:v1', 'note-1');
	});
});
