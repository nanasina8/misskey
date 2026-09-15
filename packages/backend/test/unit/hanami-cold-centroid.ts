/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import * as Path from 'node:path';
import { expect, jest, test } from '@jest/globals';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { resolveHanamiRepoRoot } from '@/core/hanami/HanamiPythonRuntime.js';

type BatchInternals = {
	collectColdCentroidSources(now: number): Promise<unknown[]>;
	createRun(kind: string, params: Record<string, unknown>): Promise<string>;
	markRun(runId: string, status: 'ready' | 'failed', params?: Record<string, unknown>): Promise<void>;
	pruneOldRuns(kind: string): Promise<void>;
};

test('cold centroid acquisition is one bounded public/home-only query with reaction, own, and author-diverse follow sources', async () => {
	const query = jest.fn(async () => []);
	const service = new HanamiForYouBatchService({ query } as never, {} as never, {} as never, { gen: jest.fn(() => 'since') } as never, {} as never);
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
