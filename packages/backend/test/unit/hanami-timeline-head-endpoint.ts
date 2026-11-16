/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { describe, expect, vi as jest, test } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import type { HanamiUserFeedHeadReadResult, HanamiUserFeedRequestPort } from '@/core/hanami/HanamiUserFeedContracts.js';
import { meta as timelineMeta } from '@/server/api/endpoints/notes/hanami-timeline.js';
import HanamiTimelineHeadEndpoint, { meta, paramDef } from '@/server/api/endpoints/notes/hanami-timeline-head.js';

const me = { id: 'user-1' } as MiLocalUser;
const head = {
	mode: 'personalized',
	kind: 'personal',
	feedEpochId: 'epoch-1',
	headBatchId: 'batch-1',
	headSequence: '210',
} as const;

// readHead 以外の口を呼んだら失敗するようにして、「読むだけ」であることを確かめる。
function fixture(result: HanamiUserFeedHeadReadResult = { kind: 'head', head, generationPending: true }) {
	const forbidden = () => { throw new Error('notes/hanami-timeline-head must only read the head'); };
	const port = {
		readHead: jest.fn<HanamiUserFeedRequestPort['readHead']>(async () => result),
		checkAvailability: jest.fn(forbidden),
		evaluateCursorless: jest.fn(forbidden),
		requestRefresh: jest.fn(forbidden),
		maintainStock: jest.fn(forbidden),
		ensureStock: jest.fn(forbidden),
		prewarm: jest.fn(forbidden),
	};
	return { endpoint: new HanamiTimelineHeadEndpoint(port as never), port };
}

describe('notes/hanami-timeline-head endpoint', () => {
	test('認証必須・read:account で、引数を取らず先頭の 4 項目だけを返す', () => {
		expect(meta.requireCredential).toBe(true);
		expect(meta.kind).toBe('read:account');
		expect(paramDef).toEqual({ type: 'object', additionalProperties: false, properties: {}, required: [] });
		expect(meta.res).toMatchObject({ type: 'object', additionalProperties: false });
		expect(Object.keys(meta.res.properties)).toEqual(['mode', 'feedEpochId', 'headBatchId', 'generationPending']);
		expect(JSON.stringify(meta.res)).not.toMatch(/items|Note|nextCursor/);
	});

	test('エラーは本体と同じ種類で、id は新しく本体と重ならない', () => {
		expect(meta.errors.hanamiTlDisabled).toMatchObject({ code: timelineMeta.errors.hanamiTlDisabled.code, httpStatusCode: 403 });
		expect(meta.errors.commonNotReady).toMatchObject({ code: timelineMeta.errors.commonNotReady.code, httpStatusCode: 503, kind: 'server' });
		const ids = Object.values(meta.errors).map(error => error.id);
		const timelineIds = Object.values(timelineMeta.errors).map(error => error.id);
		for (const id of ids) {
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(timelineIds).not.toContain(id);
		}
	});

	test('readHead だけを呼び、先頭と generationPending をそのまま返す', async () => {
		const target = fixture();
		await expect(target.endpoint.exec({}, me, null)).resolves.toEqual({
			mode: 'personalized', feedEpochId: 'epoch-1', headBatchId: 'batch-1', generationPending: true,
		});
		expect(target.port.readHead).toHaveBeenCalledExactlyOnceWith('user-1');
		for (const name of ['checkAvailability', 'evaluateCursorless', 'requestRefresh', 'maintainStock', 'ensureStock', 'prewarm'] as const) {
			expect(target.port[name]).not.toHaveBeenCalled();
		}
	});

	test('使えない人と共通の並びがまだ無いときは本体と同じエラーにする', async () => {
		await expect(fixture({ kind: 'roleDisabled' }).endpoint.exec({}, me, null))
			.rejects.toMatchObject({ code: 'HanamiTL_DISABLED', id: meta.errors.hanamiTlDisabled.id });
		await expect(fixture({ kind: 'commonNotReady' }).endpoint.exec({}, me, null))
			.rejects.toMatchObject({ code: 'HANAMI_COMMON_NOT_READY', id: meta.errors.commonNotReady.id, kind: 'server' });
	});

	test('投稿の詰め込み・表示の記録・指標・チャートの依存を持たない', () => {
		// 受け取るのは受付の口だけ。ページの組み立てや記録のサービスを注入していないことを源で確かめる。
		const source = readFileSync(new URL('../../src/server/api/endpoints/notes/hanami-timeline-head.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/HanamiTimelinePageService|HanamiMetricsPageService|HanamiTimelineChart|ProvenanceService|recordServed|hanami:feed:seen/);
		expect(HanamiTimelineHeadEndpoint.length).toBe(1);
	});
});
