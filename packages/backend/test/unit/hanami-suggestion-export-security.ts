/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import { createHanamiSuggestionExportId, decodeHanamiSuggestionExportCursor, encodeHanamiSuggestionExportCursor, pseudonymizeHanamiSuggestionExportId } from '@/core/hanami/HanamiSuggestionExportCodec.js';

const keys = [{ id: 'current', secret: 'k'.repeat(48) }];
const payload = { exportId: 'export-id', actorId: 'admin-canary', startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-01-02T00:00:00.000Z', limit: 5, lastCreatedAt: '2026-01-01T01:00:00.000Z', lastEventId: 'raw-event-canary', expiresAt: '2026-01-01T02:00:00.000Z' } as const;

describe('Hanami suggestion export security', () => {
	test('encrypts authenticated cursor state with fresh IVs and rejects mutation, truncation and expiry', () => {
		const first = encodeHanamiSuggestionExportCursor(payload, keys);
		const second = encodeHanamiSuggestionExportCursor(payload, keys);
		expect(first).not.toBe(second);
		expect(Buffer.from(first, 'base64url').includes(Buffer.from('raw-event-canary'))).toBe(false);
		const mutated = `${first.slice(0, -1)}${first.endsWith('A') ? 'B' : 'A'}`;
		expect(() => decodeHanamiSuggestionExportCursor(mutated, keys, new Date('2026-01-01T01:00:00.000Z'))).toThrow();
		expect(() => decodeHanamiSuggestionExportCursor(first.slice(0, -4), keys, new Date('2026-01-01T01:00:00.000Z'))).toThrow();
		expect(() => decodeHanamiSuggestionExportCursor(first, keys, new Date('2026-01-01T02:00:00.000Z'))).toThrow();
	});

	test('pseudonyms are stable only within one export and domain separated', () => {
		const exportA = createHanamiSuggestionExportId(); const exportB = createHanamiSuggestionExportId();
		expect(pseudonymizeHanamiSuggestionExportId(exportA, 'user', 'same', keys)).toBe(pseudonymizeHanamiSuggestionExportId(exportA, 'user', 'same', keys));
		expect(pseudonymizeHanamiSuggestionExportId(exportA, 'user', 'same', keys)).not.toBe(pseudonymizeHanamiSuggestionExportId(exportB, 'user', 'same', keys));
		expect(new Set(['user', 'note', 'author'].map(domain => pseudonymizeHanamiSuggestionExportId(exportA, domain as 'user' | 'note' | 'author', 'same', keys))).size).toBe(3);
	});
});
