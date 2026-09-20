/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import JudgeAggregateEndpoint from '@/server/api/endpoints/admin/hanami/judge-aggregate.js';
import JudgeSettingsEndpoint from '@/server/api/endpoints/admin/hanami/judge-settings.js';
import JudgeStatusEndpoint from '@/server/api/endpoints/admin/hanami/judge-status.js';
import JudgeTrialEndpoint from '@/server/api/endpoints/admin/hanami/judge-trial.js';
import { HANAMI_NOTE_JUDGE_MODEL, createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';

const admin = { id: 'admin' } as never;

// これらのテストは偽の Python スクリプトで実行経路を検証する。GPU ゲート（probe）は
// HANAMI_NOTE_JUDGE_DEVICE=cpu の明示で迂回する（本番の CPU 強制と同じ経路）。
const previousJudgeDevice = process.env.HANAMI_NOTE_JUDGE_DEVICE;
beforeAll(() => { process.env.HANAMI_NOTE_JUDGE_DEVICE = 'cpu'; });
afterAll(() => {
	if (previousJudgeDevice == null) delete process.env.HANAMI_NOTE_JUDGE_DEVICE;
	else process.env.HANAMI_NOTE_JUDGE_DEVICE = previousJudgeDevice;
});

describe('Hanami judge admin endpoint contracts', () => {
	test('settings gets defaults and persists validated updates with a server-owned promptVersion increment', async () => {
		const getQuery = jest.fn(async () => []);
		const queue = { enqueueHanamiGenerationReconcile: jest.fn(async () => undefined) };
		const get = new JudgeSettingsEndpoint({ query: getQuery } as never, queue as never);
		await expect(get.exec({}, admin, null)).resolves.toEqual(createDefaultHanamiNoteJudgeSettings());
		expect(getQuery).toHaveBeenCalledTimes(1);

		const current = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 7 };
		const transactionQuery = jest.fn(async (sql: string) => {
			if (sql.includes('FROM meta')) return [{ id: 'meta-1', settings: current }];
			if (sql.includes('MAX("promptVersion")')) return [{ promptVersion: 7 }];
			return [];
		});
		const update = new JudgeSettingsEndpoint({ transaction: async (operation: (manager: unknown) => unknown) => await operation({ query: transactionQuery }) } as never, queue as never);
		const requested = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 99, interestThreshold: 3.5, examples: ['判定例を足した'] };
		await expect(update.exec({ settings: requested }, admin, null)).resolves.toMatchObject({ promptVersion: 8, interestThreshold: 3.5 });
		const updateCalls = transactionQuery.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		expect(updateCalls[0]![0]).toContain('FOR UPDATE');
		const [, parameters] = updateCalls[2]!;
		expect(JSON.parse(parameters![0] as string)).toMatchObject({ promptVersion: 8, interestThreshold: 3.5 });
		expect(JSON.parse(parameters![0] as string).basis).toEqual(requested.basis);
		expect(updateCalls[3]![0]).toContain('INSERT INTO "hanami_note_judge_settings"');
		expect(queue.enqueueHanamiGenerationReconcile).toHaveBeenCalledTimes(1);
	});

	test('threshold, score, and content-type bonus changes keep the promptVersion (no re-judge) and overwrite the same history row', async () => {
		const current = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 7 };
		const transactionQuery = jest.fn(async (sql: string) => {
			if (sql.includes('FROM meta')) return [{ id: 'meta-1', settings: current }];
			if (sql.includes('MAX("promptVersion")')) return [{ promptVersion: 7 }];
			return [];
		});
		const queue = { enqueueHanamiGenerationReconcile: jest.fn(async () => undefined) };
		const update = new JudgeSettingsEndpoint({ transaction: async (operation: (manager: unknown) => unknown) => await operation({ query: transactionQuery }) } as never, queue as never);
		const bonus = [0, 1, 3, 3, 3, 3, 0, 0, 0, 0];
		const requested = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 99, interestThreshold: 3.5, contentTypeBonus: bonus };
		await expect(update.exec({ settings: requested }, admin, null)).resolves.toMatchObject({ promptVersion: 7, interestThreshold: 3.5, contentTypeBonus: bonus });
		const updateCalls = transactionQuery.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		expect(JSON.parse(updateCalls[2]![1]![0] as string)).toMatchObject({ promptVersion: 7, contentTypeBonus: bonus });
		expect(updateCalls[3]![0]).toContain('ON CONFLICT ("promptVersion") DO UPDATE');
		expect(updateCalls[3]![1]![0]).toBe(7);
	});

	test('rejects a content-type bonus table of the wrong shape or with negative values', async () => {
		const queue = { enqueueHanamiGenerationReconcile: jest.fn(async () => undefined) };
		const update = new JudgeSettingsEndpoint({ transaction: async () => { throw new Error('unreachable'); } } as never, queue as never);
		await expect(update.exec({ settings: { ...createDefaultHanamiNoteJudgeSettings(), contentTypeBonus: [0, 1, 2] } }, admin, null)).rejects.toThrow(); // schema (minItems/maxItems)
		await expect(update.exec({ settings: { ...createDefaultHanamiNoteJudgeSettings(), contentTypeBonus: [0, 1, 2, 2, 2, 2, -1, 0, 0, 0] } }, admin, null)).rejects.toThrow(/contentTypeBonus/);
	});

	test('concurrent material updates serialize on Meta and retain distinct immutable versions', async () => {
		let settings = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 7 };
		const history = new Map<number, typeof settings>([[7, settings]]);
		let locked = false;
		const waiters: Array<() => void> = [];
		let firstRead: (() => void) | undefined;
		let secondAttempted: (() => void) | undefined;
		let releaseFirstRead: (() => void) | undefined;
		const firstReadPromise = new Promise<void>(resolve => { firstRead = resolve; });
		const secondAttemptedPromise = new Promise<void>(resolve => { secondAttempted = resolve; });
		const releaseFirstReadPromise = new Promise<void>(resolve => { releaseFirstRead = resolve; });
		let transactions = 0;
		const db = {
			transaction: async (operation: (manager: { query: (sql: string, parameters?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
				const transaction = ++transactions;
				if (transaction === 2) secondAttempted?.();
				const observedSettings = settings;
				const observedVersion = Math.max(...history.keys());
				let holdsMetaLock = false;
				try {
					return await operation({ query: async (sql, parameters = []) => {
						if (sql.includes('FROM meta')) {
							if (sql.includes('FOR UPDATE')) {
								while (locked) await new Promise<void>(resolve => waiters.push(resolve));
								locked = true;
								holdsMetaLock = true;
							}
							if (transaction === 1) { firstRead?.(); await releaseFirstReadPromise; }
							return [{ id: 'meta-1', settings: holdsMetaLock ? settings : observedSettings }];
						}
						if (sql.includes('MAX("promptVersion")')) return [{ promptVersion: holdsMetaLock ? Math.max(...history.keys()) : observedVersion }];
						if (sql.startsWith('UPDATE meta')) { settings = JSON.parse(parameters[0] as string); return []; }
						if (sql.startsWith('INSERT INTO "hanami_note_judge_settings"')) { history.set(parameters[0] as number, JSON.parse(parameters[1] as string)); return []; }
						return [];
					} });
				} finally {
					if (holdsMetaLock) {
						locked = false;
						waiters.shift()?.();
					}
				}
			},
		};
		const queue = { enqueueHanamiGenerationReconcile: jest.fn(async () => undefined) };
		const endpoint = new JudgeSettingsEndpoint(db as never, queue as never);
		const first = endpoint.exec({ settings: { ...createDefaultHanamiNoteJudgeSettings(), interestThreshold: 3.1, examples: ['例1'] } }, admin, null);
		await firstReadPromise;
		const second = endpoint.exec({ settings: { ...createDefaultHanamiNoteJudgeSettings(), interestThreshold: 4.2, examples: ['例2'] } }, admin, null);
		await secondAttemptedPromise;
		releaseFirstRead?.();
		await expect(Promise.all([first, second])).resolves.toEqual([
			expect.objectContaining({ promptVersion: 8, interestThreshold: 3.1 }),
			expect.objectContaining({ promptVersion: 9, interestThreshold: 4.2 }),
		]);
		expect(history.get(8)).toMatchObject({ promptVersion: 8, interestThreshold: 3.1 });
		expect(history.get(9)).toMatchObject({ promptVersion: 9, interestThreshold: 4.2 });
		expect(queue.enqueueHanamiGenerationReconcile).toHaveBeenCalledTimes(2);
	});

	test('status returns the configured version, latest run, and numeric version-scoped backlog', async () => {
		const settings = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 4 };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('FROM meta')) return [{ settings }];
			if (sql.includes('hanami_foryou_model_run')) return [{ id: 'run-1', status: 'ready', params: { processedCount: 2 }, startedAt: 'start', finishedAt: 'end' }];
			return [{ count: '12' }];
		});

		await expect(new JudgeStatusEndpoint({ query } as never).exec({}, admin, null)).resolves.toEqual({
			model: HANAMI_NOTE_JUDGE_MODEL,
			promptVersion: 4,
			latestRun: { id: 'run-1', status: 'ready', params: { processedCount: 2 }, startedAt: 'start', finishedAt: 'end' },
			backlog: 12,
			runtime: expect.objectContaining({ available: true, device: 'cpu' }),
		});
		const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		expect(calls[2]![0]).toContain('j."promptVersion" = $1');
		expect(calls[2]![1]).toEqual([4]);
	});

	test('trial uses validated draft templates locally and neither reads saved settings nor writes judgements', async () => {
		const draft = { ...createDefaultHanamiNoteJudgeSettings(), templatePatterns: ['draft-only'] };
		const query = jest.fn(async () => [{ noteId: 'note-1', text: 'draft-only post', reactionScore: 4, hasFiles: false, isBot: false, isReply: false }]);

		await expect(new JudgeTrialEndpoint({ query } as never, {} as never).exec({ limit: 50, settings: draft }, admin, null)).resolves.toEqual({
			items: [{ noteId: 'note-1', text: 'draft-only post', reactionScore: 4, ephemeralScore: null, interest: null, contentType: null, reason: 'template' }],
		});
		expect(query).toHaveBeenCalledTimes(1);
		const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		expect(calls[0]![0]).toContain('WHERE c.axis = \'exploration\'');
		expect(calls[0]![0]).not.toContain('hanami_note_judgement');
		expect(calls[0]![1]).toEqual([50]);
	});

	test('trial rejects an invalid draft before any database query', async () => {
		const query = jest.fn();
		const invalid = { ...createDefaultHanamiNoteJudgeSettings(), templatePatterns: ['('] };

		await expect(new JudgeTrialEndpoint({ query } as never, {} as never).exec({ settings: invalid }, admin, null)).rejects.toThrow('Invalid Hanami judge trial settings');
		expect(query).not.toHaveBeenCalled();
	});

	test('trial returns retryable busy error without starting Python when the shared LLM lock is held', async () => {
		const query = jest.fn(async () => [{ noteId: 'note-1', text: 'useful operational note', reactionScore: 4, hasFiles: false, isBot: false, isReply: false }]);
		const redis = { set: jest.fn(async () => null), eval: jest.fn() };

		await expect(new JudgeTrialEndpoint({ query } as never, redis as never).exec({ settings: createDefaultHanamiNoteJudgeSettings() }, admin, null)).rejects.toMatchObject({
			code: 'HANAMI_LLM_BUSY', httpStatusCode: 503,
		});
		expect(redis.set).toHaveBeenCalledWith('hanami:llm:exclusive:v1', expect.any(String), 'EX', 35 * 60, 'NX');
		expect(redis.eval).not.toHaveBeenCalled();
	});

	test('trial releases its shared LLM lock with its acquisition token after Python completes', async () => {
		const query = jest.fn(async () => [{ noteId: 'note-1', text: 'useful operational note', reactionScore: 4, hasFiles: false, isBot: false, isReply: false }]);
		const redis = {
			set: jest.fn(async (_key: string, _value: string, ..._options: unknown[]) => 'OK' as const),
			eval: jest.fn(async () => 1),
		};
		const directory = await mkdtemp(Path.join(tmpdir(), 'hanami-judge-trial-lock-'));
		const scriptPath = Path.join(directory, 'judge.py');
		const previousScript = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		await writeFile(scriptPath, 'import json, sys\nwith open(sys.argv[1], encoding=\'utf-8\') as source: job = json.load(source)\nnote = job[\'notes\'][0]\nwith open(sys.argv[2], \'w\', encoding=\'utf-8\') as target: json.dump({\'status\': \'ok\', \'judgements\': [{\'noteId\': note[\'noteId\'], \'ephemeralScore\': 0.25, \'interest\': 4.0, \'contentType\': 2}]}, target)\n');
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;

		try {
			await expect(new JudgeTrialEndpoint({ query } as never, redis as never).exec({ settings: createDefaultHanamiNoteJudgeSettings() }, admin, null)).resolves.toMatchObject({
				items: [expect.objectContaining({ noteId: 'note-1', ephemeralScore: 0.25, interest: 4, contentType: 2 })],
			});
			const token = redis.set.mock.calls[0]![1] as unknown as string;
			expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'), 1, 'hanami:llm:exclusive:v1', token);
		} finally {
			if (previousScript == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT;
			else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previousScript;
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('aggregate returns count, breakdown, and served result contracts scoped by settings', async () => {
		const settings = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 6, ephemeralThreshold: 0.5, interestThreshold: 4 };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('FROM meta')) return [{ settings }];
			if (sql.includes('FILTER')) return [{ judged: 10, ephemeral: 2, interestFiltered: 3 }];
			if (sql.includes('GROUP BY')) return [{ contentType: 2, count: 4 }];
			return [{ noteId: 'served-1', interest: 5, ephemeralScore: 0 }];
		});

		await expect(new JudgeAggregateEndpoint({ query } as never).exec({}, admin, null)).resolves.toEqual({
			judged: 10,
			ephemeral: 2,
			interestFiltered: 3,
			typeBreakdown: [{ contentType: 2, count: 4 }],
			topServed: [{ noteId: 'served-1', interest: 5, ephemeralScore: 0 }],
		});
		const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		expect(calls[1]![1]).toEqual([0.5, 4]);
		expect(calls[3]![1]).toEqual([6]);
	});
});
