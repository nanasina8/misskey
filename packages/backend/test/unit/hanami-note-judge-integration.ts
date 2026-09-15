/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { HanamiForYouBatchService, HanamiNoteJudgeLockContentionError } from '@/core/hanami/HanamiForYouBatchService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiPersonalFeedComputationService } from '@/core/hanami/HanamiPersonalFeedComputationService.js';
import type { HanamiPersonalFeedGenerationContext } from '@/core/hanami/HanamiForYouService.js';
import type { HanamiPersonalFeedCandidate } from '@/core/hanami/HanamiUserFeedContracts.js';

type PersonalJudgeInternals = {
	applyJudgeSelection(context: HanamiPersonalFeedGenerationContext, candidates: readonly HanamiPersonalFeedCandidate[], judgeContext: { settings: ReturnType<typeof createDefaultHanamiNoteJudgeSettings>; reduceEphemeralPosts: boolean }): Promise<readonly HanamiPersonalFeedCandidate[]>;
};

function batchService(query: unknown, redis: unknown = { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) }): HanamiForYouBatchService {
	return new HanamiForYouBatchService({ query } as never, { insert: jest.fn(async () => undefined), update: jest.fn(async () => undefined) } as never, redis as never, { gen: () => 'run-id' } as never, {} as never);
}

describe('Hanami note judge integration', () => {
	test('rejudges rows selected against a changed prompt version, persists rule exclusions with UPSERT, and emits only <=64 jobs', async () => {
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
			{ noteIds: Array.from({ length: 64 }, (_, index) => `judge-${index}`), promptVersion: 2 },
			{ noteIds: ['judge-64'], promptVersion: 2 },
		]);

		const calls = query.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
		const candidateQuery = calls.find(([sql]) => sql.includes('FROM "hanami_common_candidate"'))!;
		expect(candidateQuery[0]).toContain('j."promptVersion" = $2');
		expect(candidateQuery[0]).toContain('j."noteId" IS NULL');
		expect(candidateQuery[1]).toEqual(['generation-1', 2]);
		const upsert = calls.find(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))!;
		expect(upsert[0]).toContain('ON CONFLICT ("noteId") DO UPDATE SET');
		expect(upsert[1]).toEqual(['old-version-reply', 'rule:reply', 2, [1, 0, 0, 0, 0]]);
		// prepareNoteJudgeJobs has no model/runtime dependency: the rule exclusion
		// is durable before any Python job can be made.
		expect(query).toHaveBeenCalledTimes(3);
	});

	test('rejects an oversized model job before reading settings or invoking a runtime', async () => {
		const query = jest.fn();
		const service = batchService(query);

		await expect(service.runNoteJudgeJob({ noteIds: Array.from({ length: 65 }, (_, index) => String(index)), promptVersion: 1 }, { warn: jest.fn() } as never)).rejects.toThrow('1..64');
		expect(query).not.toHaveBeenCalled();
	});

	test('transfers the Node file payload to the Python runtime, parses its result, and durably UPSERTs it', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'note-a', text: '運用に役立つ投稿です。', hasFiles: false, isBot: false, isReply: false }];
			return [];
		});
		const scriptDir = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-test-'));
		const scriptPath = Path.join(scriptDir, 'judge.py');
		const previous = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		await writeFile(scriptPath, `import json, sys\ninput_path, output_path = sys.argv[1:]\nwith open(input_path, encoding='utf-8') as source: job = json.load(source)\nnote = job['notes'][0]\nwith open(output_path, 'w', encoding='utf-8') as target: json.dump({'status': 'ok', 'promptVersion': job['settings']['promptVersion'], 'judgements': [{'noteId': note['noteId'], 'ephemeralScore': 0.25, 'interest': 4.0, 'interestDist': [0, 0, 0, 1, 0], 'contentType': 2}]}, target)\n`);
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;
		try {
			const result = await batchService(query).runNoteJudgeJob({ noteIds: ['note-a'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never);
			expect(result).toMatchObject({ status: 'ready', processedCount: 1 });
			const upsert = (query.mock.calls as unknown as Array<[string, unknown[]]>).find(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))!;
			expect(upsert[1]).toEqual(['note-a', 'Qwen/Qwen3-4B-Instruct-2507', settings.promptVersion, 0.25, 4, [0, 0, 0, 1, 0], 2]);
		} finally {
			if (previous == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT;
			else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previous;
			await rm(scriptDir, { recursive: true, force: true });
		}
	});

	test('runs a prior queued promptVersion with its immutable historical settings, not newer Meta', async () => {
		const historical = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 8, interestThreshold: 3.1, templatePatterns: ['historical-only'] };
		const current = { ...historical, promptVersion: 9, interestThreshold: 4.7, templatePatterns: ['current-only'] };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('FROM "hanami_note_judge_settings"')) return [{ settings: historical }];
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings: current }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'prior-note', text: 'useful archived configuration note', hasFiles: false, isBot: false, isReply: false }];
			return [];
		});
		const scriptDir = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-history-'));
		const scriptPath = Path.join(scriptDir, 'judge.py');
		const previous = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		await writeFile(scriptPath, `import json, sys\nwith open(sys.argv[1], encoding='utf-8') as source: job = json.load(source)\nassert job['settings']['promptVersion'] == 8\nassert job['settings']['interestThreshold'] == 3.1\nassert job['settings']['templatePatterns'] == ['historical-only']\nnote = job['notes'][0]\nwith open(sys.argv[2], 'w', encoding='utf-8') as target: json.dump({'status': 'ok', 'promptVersion': 8, 'judgements': [{'noteId': note['noteId'], 'ephemeralScore': 0.1, 'interest': 4, 'interestDist': [0, 0, 0, 1, 0], 'contentType': 2}]}, target)\n`);
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;
		try {
			await expect(batchService(query).runNoteJudgeJob({ noteIds: ['prior-note'], promptVersion: 8 }, { warn: jest.fn() } as never)).resolves.toMatchObject({ status: 'ready', processedCount: 1 });
			expect(query.mock.calls.some(([sql]) => sql.includes('SELECT "hanamiNoteJudgeSettings"'))).toBe(false);
		} finally {
			if (previous == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT;
			else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previous;
			await rm(scriptDir, { recursive: true, force: true });
		}
	});

	test('marks an all-error Python response failed without judging its pending notes', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const modelRuns = {
			insert: jest.fn(async () => undefined),
			update: jest.fn(async () => undefined),
		};
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'error-note', text: '役立つ情報です。', hasFiles: false, isBot: false, isReply: false }];
			return [];
		});
		const service = new HanamiForYouBatchService(
			{ query } as never,
			modelRuns as never,
			{ set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) } as never,
			{ gen: () => 'run-id' } as never,
			{} as never,
		);
		const scriptDir = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-all-errors-'));
		const scriptPath = Path.join(scriptDir, 'judge.py');
		const previous = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		await writeFile(scriptPath, `import json, sys\nwith open(sys.argv[2], 'w', encoding='utf-8') as target: json.dump({'status': 'ok', 'promptVersion': 1, 'judgements': [], 'errors': [{'noteId': 'error-note', 'error': 'inference failed'}]}, target)\n`);
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;
		try {
			await expect(service.runNoteJudgeJob({ noteIds: ['error-note'], promptVersion: 1 }, { warn: jest.fn() } as never)).rejects.toThrow('returned 0/1 judgements');
			expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))).toBe(false);
			expect(modelRuns.update).toHaveBeenCalledWith(
				{ id: 'run-id' },
				expect.objectContaining({ status: 'failed', params: expect.objectContaining({ processedCount: 0 }) }),
			);
		} finally {
			if (previous == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT;
			else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previous;
			await rm(scriptDir, { recursive: true, force: true });
		}
	});

	test('fails the queue attempt on runtime failure and reconciliation re-emits pending work for a new prompt version', async () => {
		const v1 = { ...createDefaultHanamiNoteJudgeSettings(), promptVersion: 1 };
		const v2 = { ...v1, promptVersion: 2 };
		let settings = v1;
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [{ id: 'retry-note', text: '役立つ情報です。', hasFiles: false, isBot: false, isReply: false }];
			if (sql.includes('FROM "hanami_common_candidate"')) return [{ id: 'retry-note', text: '役立つ情報です。', isBot: false, isReply: false }];
			return [];
		});
		const scriptDir = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-fail-'));
		const scriptPath = Path.join(scriptDir, 'judge.py');
		const previous = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		await writeFile(scriptPath, `import json, sys\nwith open(sys.argv[2], 'w', encoding='utf-8') as target: json.dump({'status': 'unavailable', 'error': 'stub failure'}, target)\n`);
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;
		try {
			const service = batchService(query);
			await expect(service.runNoteJudgeJob({ noteIds: ['retry-note'], promptVersion: 1 }, { warn: jest.fn() } as never)).rejects.toThrow('stub failure');
			settings = v2;
			await expect(service.runNoteJudgeJob({ noteIds: ['retry-note'], promptVersion: 1 }, { warn: jest.fn() } as never)).resolves.toMatchObject({ status: 'ready', processedCount: 0 });
			await expect(service.reconcileNoteJudgeJobs()).resolves.toEqual([{ noteIds: ['retry-note'], promptVersion: 2 }]);
		} finally {
			if (previous == null) delete process.env.HANAMI_NOTE_JUDGE_SCRIPT;
			else process.env.HANAMI_NOTE_JUDGE_SCRIPT = previous;
			await rm(scriptDir, { recursive: true, force: true });
		}
	});

	test('cleans only judgements older than fourteen days', async () => {
		const query = jest.fn(async () => [[], 1]);
		await expect(batchService(query).cleanupNoteJudgements()).resolves.toBe(1);
		expect(query).toHaveBeenCalledWith(expect.stringContaining('"judgedAt" < clock_timestamp() - INTERVAL \'14 days\''));
		// The strict less-than predicate preserves rows exactly at the boundary and all newer rows.
	});

	test('cleanup followed by reconciliation excludes a historical ready candidate without an UPSERT or job', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const historicalCandidate = { id: 'historical-note', text: '運用に役立つ投稿です。', isBot: false, isReply: false };
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('DELETE FROM "hanami_note_judgement"')) return [[], 1];
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM "hanami_common_candidate"')) {
				// The mocked lifecycle exposes this old, otherwise judgeable row unless
				// reconciliation constrains candidates to the current ready generation and 72h window.
				const isCurrentReadyGeneration = sql.includes('c."generationId" = (')
					&& sql.includes('SELECT state."latestReadyGenerationId" FROM "hanami_common_feed_state" state')
					&& sql.includes("g.status = 'ready'");
				const isWithinCurrentWindow = sql.includes('n."createdAt" >= clock_timestamp() - INTERVAL \'72 hours\'');
				return isCurrentReadyGeneration && isWithinCurrentWindow ? [] : [historicalCandidate];
			}
			return [];
		});
		const insert = jest.fn(async () => undefined);
		const service = new HanamiForYouBatchService({ query } as never, { insert, update: jest.fn() } as never, { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) } as never, { gen: () => 'run-id' } as never, {} as never);

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
		expect(reconcileQuery).toContain("g.status = 'ready'");
		expect(reconcileQuery).toContain("INTERVAL '72 hours'");
		expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))).toBe(false);
		expect(insert).not.toHaveBeenCalled();
	});

	test('does not create a run while the shared local-LLM lock is held, and reconciliation ignores historical candidates', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM "hanami_common_candidate"')) return [];
			return [];
		});
		const insert = jest.fn(async () => undefined);
		const service = new HanamiForYouBatchService({ query } as never, { insert, update: jest.fn() } as never, { set: jest.fn(async () => null), eval: jest.fn() } as never, { gen: () => 'run-id' } as never, {} as never);
		await expect(service.runNoteJudgeJob({ noteIds: ['locked-note'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never)).rejects.toBeInstanceOf(HanamiNoteJudgeLockContentionError);
		expect(insert).not.toHaveBeenCalled();
		await service.reconcileNoteJudgeJobs();
		const reconcileQuery = (query.mock.calls as unknown as Array<[string]>).find(([sql]) => sql.includes('FROM "hanami_common_candidate"'))![0];
		expect(reconcileQuery).toContain('"latestReadyGenerationId"');
		expect(reconcileQuery).toContain("INTERVAL '72 hours'");
	});

	test('releases the shared lock when createRun rejects', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const query = jest.fn(async (sql: string) => sql.includes('SELECT "hanamiNoteJudgeSettings"') ? [{ settings }] : []);
		const evalRedis = jest.fn(async () => 1);
		const service = new HanamiForYouBatchService(
			{ query } as never,
			{ insert: jest.fn(async () => { throw new Error('createRun failed'); }), update: jest.fn() } as never,
			{ set: jest.fn(async () => 'OK'), eval: evalRedis } as never,
			{ gen: () => 'run-id' } as never,
			{} as never,
		);

		await expect(service.runNoteJudgeJob({ noteIds: ['create-run-reject'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never)).rejects.toThrow('createRun failed');
		expect(evalRedis).toHaveBeenCalledWith(expect.any(String), 1, 'hanami:llm:exclusive:v1', expect.any(String));
	});

	test('filters judged ephemeral popular/trending candidates outside direct follows while retaining unrelated axes', async () => {
		const queryRunner = { query: jest.fn(async () => [{ settings: createDefaultHanamiNoteJudgeSettings() }]) };
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
		const queryRunner = { query: jest.fn(async () => [{ settings: createDefaultHanamiNoteJudgeSettings() }]) };
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
		const context = { userId: 'viewer', queryRunner: { query: jest.fn(async () => [{ settings: createDefaultHanamiNoteJudgeSettings() }]) } } as unknown as HanamiPersonalFeedGenerationContext;
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
