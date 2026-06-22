/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { reportHanamiSeen } from '@/utility/hanami-seen.js';

const account = vi.hoisted(() => ({ id: 'account-0', token: 'token' }));
const misskeyApiMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
let accountSequence = 0;

vi.mock('@/i.js', () => ({
	get $i() {
		return account;
	},
}));

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: misskeyApiMock,
}));

describe('reportHanamiSeen', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		misskeyApiMock.mockReset();
		misskeyApiMock.mockResolvedValue({ ok: true });
		account.id = `account-${accountSequence++}`;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('records the same note separately for home and rec', async () => {
		reportHanamiSeen('note-1', 'home');
		reportHanamiSeen('note-1', 'home');
		reportHanamiSeen('note-1', 'rec');
		reportHanamiSeen('note-1', 'rec');

		await vi.advanceTimersByTimeAsync(2000);

		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		expect(misskeyApiMock).toHaveBeenCalledWith(
			'notes/hanami-timeline-seen',
			{ noteIds: ['note-1'], kind: 'home' },
			'token',
		);
		expect(misskeyApiMock).toHaveBeenCalledWith(
			'notes/hanami-timeline-seen',
			{ noteIds: ['note-1'], kind: 'rec' },
			'token',
		);
	});

	test('retries only the failed note and kind pair', async () => {
		misskeyApiMock.mockRejectedValueOnce(new Error('network error'));
		reportHanamiSeen('note-1', 'rec');
		await vi.advanceTimersByTimeAsync(2000);

		reportHanamiSeen('note-1', 'rec');
		await vi.advanceTimersByTimeAsync(2000);

		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
	});
});
