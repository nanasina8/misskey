/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { beforeAll, describe, test } from 'vitest';
import type * as misskey from 'misskey-js';
import { api, signup } from '../utils.js';

describe('並べ替えの物差し（admin/hanami/rank-backtest）', () => {
	let root: misskey.entities.SignupResponse;
	let alice: misskey.entities.SignupResponse;

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
	}, 1000 * 60 * 2);

	test('はなみTL で見た記録が無いサーバーでは、採点するものが無いまま終わった実行として返る', async () => {
		const started = await api('admin/hanami/rank-backtest-start', { days: 7, limit: 100 }, root);
		assert.strictEqual(started.status, 200);
		assert.strictEqual(started.body.samples, 0);
		assert.strictEqual(typeof started.body.id, 'string');

		const res = await api('admin/hanami/rank-backtest', {}, root);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.active, false);
		const run = res.body.run;
		assert.ok(run != null);
		assert.strictEqual(run.id, started.body.id);
		assert.strictEqual(run.startedBy, 'manual');
		assert.strictEqual(run.days, 7);
		assert.strictEqual(run.limit, 100);
		assert.strictEqual(run.samples, 0);
		assert.strictEqual(run.compared, 0);
		assert.ok(run.finishedAt != null);
		assert.deepStrictEqual(run.progress, [
			{ variant: 'personal', scored: 0, pending: 0, skipped: 0, errors: 0 },
			{ variant: 'generic', scored: 0, pending: 0, skipped: 0, errors: 0 },
		]);
		// 付け方 4 つ × 対象の分け方 3 つ。記録が無いので、どれも 0 件・比べられない（null）。
		assert.strictEqual(run.results.length, 12);
		assert.deepStrictEqual([...new Set(run.results.map(row => row.variant))], ['personal', 'generic', 'interest', 'follow']);
		assert.ok(run.results.every(row => row.seen === 0 && row.engaged === 0 && row.auc === null && row.withinUserAuc === null && row.buckets.length === 0));
	});

	test('管理者でなければ、見ることも始めることもできない', async () => {
		assert.strictEqual((await api('admin/hanami/rank-backtest', {}, alice)).status, 403);
		assert.strictEqual((await api('admin/hanami/rank-backtest-start', {}, alice)).status, 403);
	});

	test('範囲の外の引数は断る', async () => {
		assert.strictEqual((await api('admin/hanami/rank-backtest-start', { days: 91 }, root)).status, 400);
		assert.strictEqual((await api('admin/hanami/rank-backtest-start', { limit: 99 }, root)).status, 400);
		assert.strictEqual((await api('admin/hanami/rank-backtest-start', { variants: ['unknown'] } as never, root)).status, 400);
	});
});
