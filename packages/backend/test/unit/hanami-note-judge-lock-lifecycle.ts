/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import * as Bull from 'bullmq';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';

class MockBullNoteJudgeLifecycle {
	public attemptsMade = 0;
	public state: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' = 'waiting';
	public delayedUntil: number | null = null;
	public terminalFailure = false;
	public readonly job = {
		name: 'hanamiNoteJudge',
		data: { noteIds: ['note-1'], promptVersion: 1 },
		token: 'worker-token',
		log: jest.fn(async () => undefined),
		updateProgress: jest.fn(async () => undefined),
		moveToDelayed: jest.fn(async (timestamp: number) => {
			this.state = 'delayed';
			this.delayedUntil = timestamp;
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
			this.terminalFailure = true;
			this.state = 'failed';
			throw error;
		}
	}
}

describe('Hanami note judge lock Bull lifecycle', () => {
	test('delays lock contention without an attempt, then persists after the lock becomes available', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		let lockAvailable = false;
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
			insert: jest.fn(async () => undefined),
			update: jest.fn(async () => undefined),
		};
		const redis = {
			set: jest.fn(async () => lockAvailable ? 'OK' : null),
			eval: jest.fn(async () => 1),
		};
		const batch = new HanamiForYouBatchService(
			{ query } as never,
			modelRuns as never,
			redis as never,
			{ gen: () => 'run-1' } as never,
			{} as never,
		);
		const processor = new HanamiCommonGenerationProcessorService(
			{} as never,
			{} as never,
			{ logger: { createSubLogger: () => ({ info: jest.fn(), succ: jest.fn(), warn: jest.fn() }) } } as never,
			batch,
		);
		const lifecycle = new MockBullNoteJudgeLifecycle();
		const scriptDir = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-lock-lifecycle-'));
		const scriptPath = Path.join(scriptDir, 'judge.py');
		const previousScript = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
		await writeFile(scriptPath, `import json, sys\nwith open(sys.argv[1], encoding='utf-8') as source: job = json.load(source)\nnote = job['notes'][0]\nwith open(sys.argv[2], 'w', encoding='utf-8') as target: json.dump({'status': 'ok', 'promptVersion': job['settings']['promptVersion'], 'judgements': [{'noteId': note['noteId'], 'ephemeralScore': 0.25, 'interest': 4.0, 'interestDist': [0, 0, 0, 1, 0], 'contentType': 2}]}, target)\n`);
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;

		try {
			await lifecycle.process(processor);

			expect(lifecycle.state).toBe('delayed');
			expect(lifecycle.delayedUntil).toBe(1_700_000_000_000 + 60_000);
			expect(lifecycle.job.moveToDelayed).toHaveBeenCalledWith(lifecycle.delayedUntil, 'worker-token');
			expect(lifecycle.attemptsMade).toBe(0);
			expect(lifecycle.terminalFailure).toBe(false);
			expect(modelRuns.insert).not.toHaveBeenCalled();

			lockAvailable = true;
			await lifecycle.process(processor);

			expect(lifecycle.state).toBe('completed');
			expect(lifecycle.attemptsMade).toBe(0);
			expect(lifecycle.terminalFailure).toBe(false);
			expect(persistedJudgements).toEqual([['note-1', 'Qwen/Qwen3-4B-Instruct-2507', 1, 0.25, 4, [0, 0, 0, 1, 0], 2]]);
			expect(modelRuns.update).toHaveBeenCalledWith({ id: 'run-1' }, expect.objectContaining({ status: 'ready' }));
			expect(lifecycle.job.updateProgress).toHaveBeenCalledWith(100);
		} finally {
			now.mockRestore();
			if (previousScript == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT;
			else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previousScript;
			await rm(scriptDir, { recursive: true, force: true });
		}
	});
});
