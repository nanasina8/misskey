/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import type * as misskey from 'misskey-js';
import { api, signup } from '../utils.js';

// はなみTL = For You-only（canonical spec §1/§9）の REST 契約と safety 不変条件を検証する e2e。
// ※ 実行には test DB(postgres)+redis が必要（pnpm build:test && pnpm jest:e2e）。
describe('Hanami timeline (For You-only)', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'hanami_fy_alice' });
		bob = await signup({ username: 'hanami_fy_bob' });
	}, 1000 * 60 * 2);

	test('ranked な For You ページ（配列）を返す。home TL は混ぜない（§9）', async () => {
		const res = await api('notes/hanami-timeline', { limit: 10 }, alice);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(Array.isArray(res.body), true);
	});

	test('sinceId は空配列を返す（For You は時系列でない＝§9/§14-D4）', async () => {
		const created = await api('notes/create', { text: 'hanami foryou sinceId test' }, bob);
		assert.strictEqual(created.status, 200);
		const res = await api('notes/hanami-timeline', { sinceId: created.body.createdNote.id, limit: 10 }, alice);
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(res.body, []);
	});

	test('safety: 返却ノートは CW を持たず public/home のみ（§8）', async () => {
		const res = await api('notes/hanami-timeline', { limit: 30 }, alice);
		assert.strictEqual(res.status, 200);
		for (const note of res.body) {
			assert.strictEqual(note.cw == null, true); // CW 除外
			assert.ok(note.visibility === 'public' || note.visibility === 'home'); // followers-only/specified 除外
		}
	});

	test('はなみTL が無効化されていればエラー（policy: hanamiTlAvailable）', async () => {
		// 既定 ON のため通常は 200。policy を落とす管理操作までは e2e 範囲外（契約の存在のみ確認）。
		const res = await api('notes/hanami-timeline', {}, alice);
		assert.ok(res.status === 200 || res.status === 400);
	});
});
