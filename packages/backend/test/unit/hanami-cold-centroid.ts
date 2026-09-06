/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { expect, jest, test } from '@jest/globals';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { resolveHanamiRepoRoot } from '@/core/hanami/HanamiPythonRuntime.js';

type BatchInternals = {
	collectColdCentroidSources(now: number): Promise<unknown[]>;
	runQualityShadow(notes: { id: string; text: string }[], logger: { warn: jest.Mock }): Promise<void>;
	createRun(kind: string, params: Record<string, unknown>): Promise<string>;
	markRun(runId: string, status: 'ready' | 'failed', params?: Record<string, unknown>): Promise<void>;
	pruneOldRuns(kind: string): Promise<void>;
};

test('cold centroid acquisition is one bounded public/home-only query with reaction, own, and author-diverse follow sources', async () => {
	const query = jest.fn(async () => []);
	const service = new HanamiForYouBatchService({ query } as never, {} as never, { gen: jest.fn(() => 'since') } as never, {} as never);
	await (service as unknown as { collectColdCentroidSources(now: number): Promise<unknown[]> }).collectColdCentroidSources(Date.now());
	expect(query).toHaveBeenCalledTimes(1);
	const [sql, parameters] = (query.mock.calls as unknown as Array<[string, unknown[]]>)[0]!;
	expect(sql).toContain("n.visibility IN ('public','home')");
	expect(sql).toContain('n."channelId" IS NULL');
	expect(sql).toContain('HAVING count(r.id) <= $3');
	expect(sql).toContain('u."isDeleted" = false AND u."isSuspended" = false');
	expect(sql).toContain('LEFT JOIN "hanami_foryou_user_centroid" c');
	expect(sql).toContain('c.model = $5');
	expect(sql).toContain('ORDER BY min(c."updatedAt") ASC NULLS FIRST');
	expect(sql).toContain('DISTINCT ON (f."followerId", n."userId")');
	expect(sql).toContain('EXISTS (');
	expect(parameters).toEqual([2000, 'since', 4, 3, 'paraphrase-multilingual-MiniLM-L12-v2']);
});

test('E5 shadow script keeps exact query prefix, masked mean pooling, normalization, thread limits, and cache-only failure handling', () => {
	const script = readFileSync(Path.join(resolveHanamiRepoRoot(), 'scripts/hanami-foryou/rec_quality_shadow_cpu.py'), 'utf8');
	expect(script).toContain('torch.set_num_threads(2)');
	expect(script).toContain('torch.set_num_interop_threads(2)');
	expect(script).toContain('local_files_only=True');
	expect(script).toContain('"query: " + text');
	expect(script).toContain('encoded["attention_mask"].unsqueeze(-1)');
	expect(script).toContain('torch.nn.functional.normalize(vectors, p=2, dim=1)');
	expect(script).toContain('"version": VERSION');
	expect(script).toContain('status="unavailable"');
});

test('primary embedding remains ready when its post-ready prune and shadow call fail', async () => {
	const root = mkdtempSync(Path.join(tmpdir(), 'hanami-primary-shadow-'));
	const script = Path.join(root, 'static-content.sh');
	writeFileSync(script, '#!/bin/sh\nprintf \'{"model":"paraphrase-multilingual-MiniLM-L12-v2","dim":2,"embeddings":[],"centroids":[]}\' > "$2"\n');
	chmodSync(script, 0o755);
	const previousPython = process.env.HANAMI_FORYOU_PYTHON;
	const previousScript = process.env.HANAMI_FORYOU_CONTENT_SCRIPT;
	process.env.HANAMI_FORYOU_PYTHON = '/bin/sh';
	process.env.HANAMI_FORYOU_CONTENT_SCRIPT = script;
	try {
		const updates: unknown[][] = [];
		const db = { query: jest.fn(async (sql: string) => sql.includes('hanami_note_embedding') ? [{ id: 'note', text: 'text' }] : []) };
		const repository = { insert: jest.fn(), update: jest.fn(async (...args: unknown[]) => { updates.push(args); }) };
		const service = new HanamiForYouBatchService(db as never, repository as never, { gen: () => 'run-id' } as never, {} as never);
		const internals = service as unknown as BatchInternals;
		jest.spyOn(internals, 'collectColdCentroidSources').mockResolvedValue([]);
		jest.spyOn(internals, 'pruneOldRuns').mockRejectedValue(new Error('prune failed'));
		jest.spyOn(internals, 'runQualityShadow').mockRejectedValue(new Error('shadow failed'));

		await expect(service.runEmbeddingBatch({ warn: jest.fn() } as never)).resolves.toEqual({ runId: 'run-id', status: 'ready' });
		expect(updates).toHaveLength(1);
		expect(updates[0]![1]).toEqual(expect.objectContaining({ status: 'ready' }));
	} finally {
		if (previousPython == null) delete process.env.HANAMI_FORYOU_PYTHON; else process.env.HANAMI_FORYOU_PYTHON = previousPython;
		if (previousScript == null) delete process.env.HANAMI_FORYOU_CONTENT_SCRIPT; else process.env.HANAMI_FORYOU_CONTENT_SCRIPT = previousScript;
		rmSync(root, { recursive: true, force: true });
	}
});

test('shadow create, process, mark, and prune failures are swallowed without touching a primary run', async () => {
	const repository = { insert: jest.fn(), update: jest.fn() };
	const service = new HanamiForYouBatchService({ query: jest.fn() } as never, repository as never, { gen: () => 'shadow-id' } as never, {} as never);
	const shadow = service as unknown as BatchInternals;
	const logger = { warn: jest.fn() };

	const createRun = jest.spyOn(shadow, 'createRun').mockRejectedValueOnce(new Error('create /private/path'));
	const prune = jest.spyOn(shadow, 'pruneOldRuns').mockRejectedValueOnce(new Error('prune /private/path'));
	await expect(shadow.runQualityShadow([], logger)).resolves.toBeUndefined();
	expect(prune).toHaveBeenCalledWith('embedding-e5-shadow');

	createRun.mockResolvedValue('shadow-id');
	const mark = jest.spyOn(shadow, 'markRun').mockRejectedValue(new Error('mark /private/path'));
	prune.mockRejectedValue(new Error('prune /private/path'));
	const previousPython = process.env.HANAMI_FORYOU_PYTHON;
	process.env.HANAMI_FORYOU_PYTHON = '/not/a/python';
	try {
		await expect(shadow.runQualityShadow([{ id: 'note', text: 'text' }], logger)).resolves.toBeUndefined();
	} finally {
		if (previousPython == null) delete process.env.HANAMI_FORYOU_PYTHON; else process.env.HANAMI_FORYOU_PYTHON = previousPython;
	}
	expect(mark).toHaveBeenCalledWith('shadow-id', 'failed', expect.objectContaining({ shadowErrorCategory: 'Error' }));
	expect(logger.warn).toHaveBeenCalledWith('hanami foryou: E5 quality shadow unavailable: Error');
});
