/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import type { MiLocalUser } from '@/models/User.js';
import type { HanamiTimelinePageInput, HanamiTimelinePageResult } from '@/core/hanami/HanamiTimelineContracts.js';

jest.unstable_mockModule('../../src/core/hanami/HanamiTimelinePageService.js', () => ({
	HanamiTimelinePageService: class {},
}));

const { default: HanamiTimelineEndpoint, meta, paramDef } = await import('../../src/server/api/endpoints/notes/hanami-timeline.js');

const me = { id: 'user-1' } as MiLocalUser;
const token = 'A'.repeat(43);
const response = {
	items: [],
	nextCursor: null,
	hasMore: false,
	mode: 'personalized',
	generationPending: false,
	feedEpochId: 'epoch-1',
	headBatchId: 'batch-1',
} as const;

function fixture(result: HanamiTimelinePageResult = { kind: 'ok', response }) {
	const serve = jest.fn<(input: HanamiTimelinePageInput) => Promise<HanamiTimelinePageResult>>(async () => result);
	return { endpoint: new HanamiTimelineEndpoint({ serve } as never), serve };
}

describe('Hanami Phase 5 workstream C endpoint contract', () => {
	test('exposes only the breaking request and exact response fields', () => {
		expect(paramDef.additionalProperties).toBe(false);
		expect(Object.keys(paramDef.properties)).toEqual(['limit', 'cursor', 'refresh', 'refreshToken', 'withFiles']);
		expect(paramDef.properties.cursor).toEqual({ type: 'string', minLength: 1, maxLength: 1024 });
		expect(paramDef.properties.refreshToken).toEqual({ type: 'string' });
		expect(meta.res).toMatchObject({ type: 'object', additionalProperties: false });
		expect(Object.keys(meta.res.properties)).toEqual([
			'items', 'nextCursor', 'hasMore', 'mode', 'generationPending', 'feedEpochId', 'headBatchId',
		]);
		expect(Object.keys(meta.res.properties.items.items.properties)).toEqual(['feedEntryId', 'batchId', 'note']);
		expect(meta.res.properties.items.items).toMatchObject({ type: 'object', additionalProperties: false });
		expect(meta.res.properties.items.items.properties.note).toMatchObject({ type: 'object', ref: 'Note' });
		expect(JSON.stringify(paramDef)).not.toMatch(/sinceId|sinceDate|untilId|untilDate|allowPartial|withRenotes/);
		expect(JSON.stringify(meta.res)).not.toMatch(/source|reason|refreshToken/);
	});

	test.each([
		{ cursor: null },
		{ refreshToken: null },
	])('rejects explicit null for optional string property %p', async request => {
		const target = fixture();
		await expect(target.endpoint.exec(request, me, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', kind: 'client' });
		expect(target.serve).not.toHaveBeenCalled();
	});

	test('normalizes cursorless and continuation defaults and accepts an over-30 supplied limit for service clamping', async () => {
		const cursorless = fixture();
		await expect(cursorless.endpoint.exec({}, me, null)).resolves.toEqual(response);
		expect(cursorless.serve).toHaveBeenCalledWith({
			me,
			request: { limit: 15, cursor: null, refresh: false, refreshToken: null, withFiles: false },
		});

		const continuation = fixture();
		await continuation.endpoint.exec({ cursor: 'opaque-cursor' }, me, null);
		expect(continuation.serve.mock.calls[0]![0].request.limit).toBe(30);

		const oversized = fixture();
		await oversized.endpoint.exec({ limit: 999 }, me, null);
		expect(oversized.serve.mock.calls[0]![0].request.limit).toBe(999);
	});

	test('accepts only cursorless refresh with a valid exact client token', async () => {
		const valid = fixture();
		await valid.endpoint.exec({ refresh: true, refreshToken: token, withFiles: true }, me, null);
		expect(valid.serve.mock.calls[0]![0].request).toEqual({
			limit: 15, cursor: null, refresh: true, refreshToken: token, withFiles: true,
		});

		for (const invalid of [
			{ refresh: true },
			{ refreshToken: token },
			{ refresh: true, refreshToken: token, cursor: 'cursor' },
			{ refresh: true, refreshToken: 'not-a-token' },
		]) {
			const target = fixture();
			await expect(target.endpoint.exec(invalid, me, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', httpStatusCode: 400 });
			expect(target.serve).not.toHaveBeenCalled();
		}
	});

	test.each([
		{ sinceId: 'legacy' },
		{ sinceDate: 1 },
		{ untilId: 'legacy' },
		{ untilDate: 1 },
		{ allowPartial: true },
		{ withRenotes: true },
	])('rejects legacy request property %p as INVALID_PARAM', async legacy => {
		const target = fixture();
		await expect(target.endpoint.exec(legacy, me, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(target.serve).not.toHaveBeenCalled();
	});

	test.each([
		{ kind: 'roleDisabled', code: 'HanamiTL_DISABLED', httpStatusCode: 403 },
		{ kind: 'invalidCursor', code: 'INVALID_CURSOR', httpStatusCode: 400 },
		{ kind: 'cursorExpired', code: 'CURSOR_EXPIRED', httpStatusCode: 400 },
		{ kind: 'commonNotReady', code: 'HANAMI_COMMON_NOT_READY', httpStatusCode: 503 },
		{ kind: 'invalidRefreshToken', code: 'INVALID_PARAM', httpStatusCode: 400 },
		{ kind: 'refreshTokenExpired', code: 'REFRESH_TOKEN_EXPIRED', httpStatusCode: 400 },
		{ kind: 'refreshRateLimited', code: 'HANAMI_REFRESH_RATE_LIMITED', httpStatusCode: 429 },
	] as const)('maps $kind to $code/$httpStatusCode', async ({ kind, code, httpStatusCode }) => {
		const target = fixture({ kind } as HanamiTimelinePageResult);
		await expect(target.endpoint.exec({}, me, null)).rejects.toMatchObject({ code, httpStatusCode });
	});

	test('classifies common-not-ready as a server error', async () => {
		expect(meta.errors.commonNotReady).toMatchObject({
			code: 'HANAMI_COMMON_NOT_READY',
			kind: 'server',
			httpStatusCode: 503,
		});
		const target = fixture({ kind: 'commonNotReady' });
		await expect(target.endpoint.exec({}, me, null)).rejects.toMatchObject({
			code: 'HANAMI_COMMON_NOT_READY',
			kind: 'server',
			httpStatusCode: 503,
		});
	});
});
