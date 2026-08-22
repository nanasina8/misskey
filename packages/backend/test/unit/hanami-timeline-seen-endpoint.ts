/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import type { MiLocalUser } from '@/models/User.js';

class HanamiInvalidFeedEntryError extends Error {}

jest.unstable_mockModule('../../src/core/hanami/HanamiForYouProvenanceService.js', () => ({
	HanamiForYouProvenanceService: class {},
	HanamiInvalidFeedEntryError,
}));

const { default: HanamiTimelineSeenEndpoint, meta, paramDef } = await import('../../src/server/api/endpoints/notes/hanami-timeline-seen.js');

const me = { id: 'user1' } as MiLocalUser;
const items = [{ feedEntryId: 'entry1', noteId: 'note1' }];

function fixture(error?: Error) {
	const recordSeenFeedEntries = jest.fn(async () => {
		if (error != null) throw error;
	});
	return {
		endpoint: new HanamiTimelineSeenEndpoint({ recordSeenFeedEntries } as never),
		recordSeenFeedEntries,
	};
}

describe('notes/hanami-timeline-seen endpoint', () => {
	test('publishes strict, exact request and response schemas', () => {
		expect(paramDef).toEqual({
			type: 'object',
			additionalProperties: false,
			properties: {
				items: {
					type: 'array',
					minItems: 1,
					maxItems: 100,
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							feedEntryId: { type: 'string', minLength: 1, maxLength: 512 },
							noteId: { type: 'string', format: 'misskey:id' },
						},
						required: ['feedEntryId', 'noteId'],
					},
				},
			},
			required: ['items'],
		});
		expect(meta.res).toEqual({
			type: 'object',
			optional: false,
			nullable: false,
			additionalProperties: false,
			properties: {
				ok: { type: 'boolean', optional: false, nullable: false },
			},
		});
	});

	test('records the exact locator/note pairs and returns only ok', async () => {
		const target = fixture();
		await expect(target.endpoint.exec({ items }, me, null)).resolves.toEqual({ ok: true });
		expect(target.recordSeenFeedEntries).toHaveBeenCalledWith(me.id, items);
	});

	test.each([
		{ items, extra: true },
		{ items: [{ ...items[0], extra: true }] },
		{ items: [] },
		{ items: [{ feedEntryId: 'entry1' }] },
	])('rejects non-contract input %p before delegation', async request => {
		const target = fixture();
		await expect(target.endpoint.exec(request, me, null)).rejects.toMatchObject({ code: 'INVALID_PARAM', kind: 'client' });
		expect(target.recordSeenFeedEntries).not.toHaveBeenCalled();
	});

	test('maps invalid feed entries to the public 400 error', async () => {
		const target = fixture(new HanamiInvalidFeedEntryError());
		await expect(target.endpoint.exec({ items }, me, null)).rejects.toMatchObject({
			code: 'INVALID_FEED_ENTRY',
			httpStatusCode: 400,
		});
	});

	test('does not hide unexpected service errors', async () => {
		const error = new Error('database unavailable');
		const target = fixture(error);
		await expect(target.endpoint.exec({ items }, me, null)).rejects.toBe(error);
	});
});
