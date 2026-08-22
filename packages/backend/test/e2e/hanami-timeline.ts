/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import type * as misskey from 'misskey-js';
import { api, castAsError, signup } from '../utils.js';

type TimelineRequest = misskey.Endpoints['notes/hanami-timeline']['req'];
type TimelineResponse = misskey.entities.NotesHanamiTimelineResponse;

const responseFields = [
	'feedEpochId',
	'generationPending',
	'hasMore',
	'headBatchId',
	'items',
	'mode',
	'nextCursor',
];
const itemFields = ['batchId', 'feedEntryId', 'note'];

describe('Hanami timeline Phase 5 API contract', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let legacyNoteId: string;
	let cwNoteId: string;
	let followersNoteId: string;
	let specifiedNoteId: string;

	beforeAll(async () => {
		alice = await signup({ username: 'hanami_fy_alice' });
		bob = await signup({ username: 'hanami_fy_bob' });

		const [legacy, cw, followers, specified] = await Promise.all([
			api('notes/create', { text: 'hanami phase5 public' }, bob),
			api('notes/create', { text: 'hanami phase5 cw body', cw: 'hanami phase5 cw' }, bob),
			api('notes/create', { text: 'hanami phase5 followers', visibility: 'followers' }, bob),
			api('notes/create', {
				text: 'hanami phase5 specified',
				visibility: 'specified',
				visibleUserIds: [alice.id],
			}, bob),
		]);
		for (const result of [legacy, cw, followers, specified]) assert.strictEqual(result.status, 200);
		legacyNoteId = legacy.body.createdNote.id;
		cwNoteId = cw.body.createdNote.id;
		followersNoteId = followers.body.createdNote.id;
		specifiedNoteId = specified.body.createdNote.id;
	}, 1000 * 60 * 2);

	function assertPage(page: TimelineResponse, limit: number): void {
		assert.ok(page != null && typeof page === 'object' && !Array.isArray(page));
		assert.deepStrictEqual(Object.keys(page).sort(), responseFields);
		assert.ok(Array.isArray(page.items));
		assert.ok(page.items.length <= limit);
		assert.ok(page.nextCursor === null || typeof page.nextCursor === 'string');
		assert.strictEqual(typeof page.hasMore, 'boolean');
		assert.ok(page.mode === 'personalized' || page.mode === 'common');
		assert.strictEqual(typeof page.generationPending, 'boolean');
		assert.ok(typeof page.feedEpochId === 'string' && page.feedEpochId.length > 0);
		assert.ok(typeof page.headBatchId === 'string' && page.headBatchId.length > 0);

		for (const item of page.items) {
			assert.deepStrictEqual(Object.keys(item).sort(), itemFields);
			assert.ok(typeof item.feedEntryId === 'string' && item.feedEntryId.length > 0);
			assert.ok(typeof item.batchId === 'string' && item.batchId.length > 0);
			assert.ok(item.note != null && typeof item.note === 'object');
			assert.ok(typeof item.note.id === 'string' && item.note.id.length > 0);
			assert.ok(typeof item.note.createdAt === 'string');
			assert.ok(item.note.text === null || typeof item.note.text === 'string');
			assert.ok(item.note.cw == null || typeof item.note.cw === 'string');
			assert.ok(typeof item.note.userId === 'string' && item.note.userId.length > 0);
			assert.ok(item.note.user != null && typeof item.note.user === 'object');
			assert.ok(item.note.visibility === 'public' || item.note.visibility === 'home');
		}
	}

	function assertApiError(
		result: { status: number; body: TimelineResponse },
		status: number,
		code: string,
	): void {
		assert.strictEqual(result.status, status);
		assert.strictEqual(castAsError(result.body).error.code, code);
	}

	async function requestPage(params: TimelineRequest, limit: number, allowCommonNotReady = true): Promise<TimelineResponse | null> {
		const result = await api('notes/hanami-timeline', params, alice);
		if (result.status === 503) {
			assert.strictEqual(allowCommonNotReady, true, 'an established cursor must not regress to common-not-ready');
			const error = castAsError(result.body).error;
			assert.strictEqual(error.code, 'HANAMI_COMMON_NOT_READY');
			assert.strictEqual(error.kind, 'server');
			assert.strictEqual(result.headers.get('WWW-Authenticate'), null);
			return null;
		}
		assert.strictEqual(result.status, 200);
		assertPage(result.body, limit);
		return result.body;
	}

	test('returns the strict Phase 5 page and item-wrapper schema', async () => {
		await requestPage({ limit: 10 }, 10);
	});

	test.each([
		['sinceId', 'legacy'],
		['sinceDate', 1],
		['untilId', 'legacy'],
		['untilDate', 1],
		['allowPartial', true],
		['withRenotes', true],
	] as const)('rejects legacy field %s', async (field, value) => {
		const result = await api('notes/hanami-timeline', { [field]: value } as unknown as TimelineRequest, alice);
		assertApiError(result, 400, 'INVALID_PARAM');
	});

	test.each([
		['cursor', null],
		['refreshToken', null],
	] as const)('rejects explicit null for optional %s', async (field, value) => {
		const result = await api('notes/hanami-timeline', { [field]: value } as unknown as TimelineRequest, alice);
		assertApiError(result, 400, 'INVALID_PARAM');
	});

	test('uses an opaque continuation cursor instead of a Note ID', async () => {
		const noteIdResult = await api('notes/hanami-timeline', { cursor: legacyNoteId }, alice);
		assertApiError(noteIdResult, 400, 'INVALID_CURSOR');

		const first = await requestPage({ limit: 1 }, 1);
		if (first?.nextCursor == null) return;
		assert.ok(!first.items.some(item => item.note.id === first.nextCursor));
		const continuation = await requestPage({ cursor: first.nextCursor, limit: 1 }, 1, false);
		assert.strictEqual(continuation?.feedEpochId, first.feedEpochId);
	});

	test('keeps CW available for client folding while enforcing visibility safety', async () => {
		const page = await requestPage({ limit: 30 }, 30);
		if (page == null) return;

		const noteIds = new Set(page.items.map(item => item.note.id));
		assert.ok(!noteIds.has(followersNoteId));
		assert.ok(!noteIds.has(specifiedNoteId));
		const cwItem = page.items.find(item => item.note.id === cwNoteId);
		if (cwItem != null) {
			assert.strictEqual(cwItem.note.cw, 'hanami phase5 cw');
			assert.strictEqual(cwItem.note.text, 'hanami phase5 cw body');
		}
	});
});
