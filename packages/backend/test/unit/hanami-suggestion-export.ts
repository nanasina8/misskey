/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { HanamiSuggestionExportService } from '@/core/hanami/HanamiSuggestionExportService.js';

const keys = [{ id: 'current', secret: 'x'.repeat(48) }];
const startAt = '2026-01-01T00:00:00.000Z';
const endAt = '2026-01-02T00:00:00.000Z';

function row(id: string, eligible = true) {
	return { event_id: id, event_user_id: `user-${id}`, note_id: `note-${id}`, author_id: `author-${id}`, event_type: 'served', feed_kind: 'personal', source: 'globalPopular', occurred_at: null, created_at: new Date(`2026-01-01T00:00:${id.padStart(2, '0')}.000Z`), eligible };
}

describe('HanamiSuggestionExportService', () => {
	test('pages every eligible event in stable order without duplicate or gap', async () => {
		const rows = [row('01'), row('02', false), row('03'), row('04', false), row('05')];
		const db = { query: async (sql: string, params: unknown[]) => {
			if (sql.includes('count(*)')) return [{ count: 3 }];
			const last = params[3] as string | null;
			return rows.filter(value => value.eligible && (last == null || value.event_id > last)).map(({ eligible: _, ...value }) => value);
		} };
		const audit = { log: jest.fn(async () => undefined) };
		const service = new HanamiSuggestionExportService(db as never, { hanamiCursorSigningKeys: keys } as never, audit as never);
		const first = await service.export({ id: 'admin', isAdmin: true }, { startAt, endAt, limit: 2 }, new Date(startAt));
		expect(first.events).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		const second = await service.export({ id: 'admin', isAdmin: true }, { cursor: first.cursor! }, new Date(startAt));
		expect([...first.events, ...second.events].map(event => event.note)).toHaveLength(3);
		expect(new Set([...first.events, ...second.events].map(event => event.note)).size).toBe(3);
		expect(second.cursor).toBeNull();
		expect(audit.log).toHaveBeenCalledTimes(1);
		expect((audit.log.mock.calls as unknown as Array<[unknown, unknown, unknown]>)[0]![2]).toEqual({ period: { startAt, endAt }, count: 3, exportId: first.exportId });
	});

	test('exports only allowlisted categorical provenance and does not expose arbitrary source metadata', async () => {
		const db = { query: async (sql: string) => sql.includes('count(*)') ? [{ count: 1 }] : [{ ...row('01'), event_type: 'reaction', feed_kind: 'personal', source: 'arbitrary:metadata' }] };
		const service = new HanamiSuggestionExportService(db as never, { hanamiCursorSigningKeys: keys } as never, { log: async () => undefined } as never);
		const page = await service.export({ id: 'admin', isAdmin: true }, { startAt, endAt, limit: 1 }, new Date(startAt));
		expect(page.events[0]).toMatchObject({ eventType: 'reaction', feedKind: 'personal', source: null, sources: [], origin: 'personalCandidate', reactionOutcome: true });
		expect(JSON.stringify(page.events[0])).not.toContain('arbitrary:metadata');
	});

	test('rejects non-admins and invalid period or limit at the service boundary', async () => {
		const service = new HanamiSuggestionExportService({ query: async () => [] } as never, { hanamiCursorSigningKeys: keys } as never, { log: async () => undefined } as never);
		await expect(service.export({ id: 'not-admin', isAdmin: false }, { startAt, endAt, limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(service.export({ id: 'admin', isAdmin: true }, { startAt, endAt: '2026-02-01T00:00:00.000Z', limit: 501 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});
