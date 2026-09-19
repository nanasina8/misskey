/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { IdService } from '@/core/IdService.js';
import { HanamiForYouBatchService, HanamiNoteJudgeLockContentionError } from '@/core/hanami/HanamiForYouBatchService.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { HanamiPersonalFeedComputationService } from '@/core/hanami/HanamiPersonalFeedComputationService.js';
import type { HanamiPersonalFeedGenerationContext } from '@/core/hanami/HanamiForYouService.js';
import type { HanamiPersonalFeedCandidate } from '@/core/hanami/HanamiUserFeedContracts.js';

type PersonalJudgeInternals = {
	applyJudgeSelection(context: HanamiPersonalFeedGenerationContext, candidates: readonly HanamiPersonalFeedCandidate[], judgeContext: { settings: ReturnType<typeof createDefaultHanamiNoteJudgeSettings>; reduceEphemeralPosts: boolean }): Promise<readonly HanamiPersonalFeedCandidate[]>;
};

function batchService(query: unknown, redis: unknown = { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) }, idService: Pick<IdService, 'gen'> = { gen: () => 'run-id' }): HanamiForYouBatchService {
	return new HanamiForYouBatchService({ query } as never, { insert: jest.fn(async () => undefined), update: jest.fn(async () => undefined) } as never, redis as never, idService as never, {} as never);
}

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

	test('salvages incrementally flushed judgements when the runtime is killed mid-batch', async () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const modelRuns = {
			insert: jest.fn(async () => undefined),
			update: jest.fn(async () => undefined),
		};
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('SELECT "hanamiNoteJudgeSettings"')) return [{ settings }];
			if (sql.includes('FROM note n JOIN "user"')) return [
				{ id: 'note-a', text: '運用に役立つ投稿です。', hasFiles: false, isBot: false, isReply: false },
				{ id: 'note-b', text: 'こちらも役立つ投稿です。', hasFiles: false, isBot: false, isReply: false },
			];
			return [];
		});
		const service = new HanamiForYouBatchService(
			{ query } as never,
			modelRuns as never,
			{ set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) } as never,
			{ gen: () => 'run-id' } as never,
			{} as never,
		);
		const scriptDir = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-salvage-'));
		const scriptPath = Path.join(scriptDir, 'judge.py');
		const previous = process.env.HANAMI_NOTE_JUDGE_SCRIPT;
		// Emulates a timeout kill: the runtime flushed note-a's judgement, then died.
		await writeFile(scriptPath, `import json, sys\ninput_path, output_path = sys.argv[1:]\nwith open(input_path, encoding='utf-8') as source: job = json.load(source)\nnote = job['notes'][0]\nwith open(output_path, 'w', encoding='utf-8') as target: json.dump({'status': 'partial', 'promptVersion': job['settings']['promptVersion'], 'judgements': [{'noteId': note['noteId'], 'ephemeralScore': 0.25, 'interest': 4.0, 'interestDist': [0, 0, 0, 1, 0], 'contentType': 2}]}, target)\nsys.exit(1)\n`);
		process.env.HANAMI_NOTE_JUDGE_SCRIPT = scriptPath;
		try {
			const result = await service.runNoteJudgeJob({ noteIds: ['note-a', 'note-b'], promptVersion: settings.promptVersion }, { warn: jest.fn() } as never);
			expect(result).toMatchObject({ status: 'ready', processedCount: 1 });
			const upserts = (query.mock.calls as unknown as Array<[string, unknown[]]>).filter(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'));
			expect(upserts.length).toBe(1);
			expect(upserts[0][1]).toEqual(['note-a', 'Qwen/Qwen3-4B-Instruct-2507', settings.promptVersion, 0.25, 4, [0, 0, 0, 1, 0], 2]);
			expect(modelRuns.update).toHaveBeenCalledWith(
				{ id: 'run-id' },
				expect.objectContaining({ status: 'ready', params: expect.objectContaining({ processedCount: 1, salvagedPartial: true }) }),
			);
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
		const insert = jest.fn(async () => undefined);
		const service = new HanamiForYouBatchService({ query } as never, { insert, update: jest.fn() } as never, { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) } as never, { gen: () => sinceId } as never, {} as never);

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
		expect(reconcileQuery).toContain('n.id >= $1');
		expect(reconcileQuery).not.toMatch(/n\."?createdAt"?/);
		expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "hanami_note_judgement"'))).toBe(false);
		expect(insert).not.toHaveBeenCalled();
	});

	test('does not create a run while the shared local-LLM lock is held, and still permits reconciliation', async () => {
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
		expect(reconcileQuery).toContain('n.id >= $1');
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
