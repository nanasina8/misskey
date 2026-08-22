/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { reportHanamiSeen } from '@/utility/hanami-seen.js';

const account = vi.hoisted(() => ({ id: 'account-0', token: 'token' }));
const misskeyApiMock = vi.hoisted(() => vi.fn<(
	endpoint: string,
	data: { items: { feedEntryId: string; noteId: string }[] },
	token: string,
) => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })));
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

	test('deduplicates by feed entry while retaining separate locators for the same note', async () => {
		reportHanamiSeen('entry-1', 'note-1');
		reportHanamiSeen('entry-1', 'note-1');
		reportHanamiSeen('entry-2', 'note-1');

		await vi.advanceTimersByTimeAsync(2000);

		expect(misskeyApiMock).toHaveBeenCalledOnce();
		expect(misskeyApiMock).toHaveBeenCalledWith(
			'notes/hanami-timeline-seen',
			{
				items: [
					{ feedEntryId: 'entry-1', noteId: 'note-1' },
					{ feedEntryId: 'entry-2', noteId: 'note-1' },
				],
			},
			'token',
		);
	});

	test('automatically retries a failed batch', async () => {
		misskeyApiMock.mockRejectedValueOnce(new Error('network error'));
		reportHanamiSeen('entry-1', 'note-1');

		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		expect(misskeyApiMock.mock.calls[1]?.[1]).toEqual({
			items: [{ feedEntryId: 'entry-1', noteId: 'note-1' }],
		});
	});

	test('isolates invalid locators, commits valid sub-batches, and does not retry terminal singletons', async () => {
		misskeyApiMock.mockImplementation((_endpoint, data) => {
			return data.items.some(item => item.feedEntryId === 'invalid')
				? Promise.reject({ code: 'INVALID_FEED_ENTRY' })
				: Promise.resolve({ ok: true });
		});
		reportHanamiSeen('valid-1', 'note-1');
		reportHanamiSeen('invalid', 'note-2');
		reportHanamiSeen('valid-2', 'note-3');

		await vi.advanceTimersByTimeAsync(2000);

		expect(misskeyApiMock).toHaveBeenCalledTimes(5);
		expect(misskeyApiMock.mock.calls.map(call => call[1].items)).toContainEqual([
			{ feedEntryId: 'valid-1', noteId: 'note-1' },
		]);
		expect(misskeyApiMock.mock.calls.map(call => call[1].items)).toContainEqual([
			{ feedEntryId: 'valid-2', noteId: 'note-3' },
		]);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(misskeyApiMock).toHaveBeenCalledTimes(5);
	});

	test('isolates 100 invalid locators sequentially with finite completion', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		misskeyApiMock.mockImplementation(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			inFlight--;
			throw { code: 'INVALID_FEED_ENTRY' };
		});
		for (let i = 0; i < 100; i++) reportHanamiSeen(`invalid-${i}`, `note-${i}`);

		await vi.advanceTimersByTimeAsync(2000);

		expect(maxInFlight).toBe(1);
		expect(inFlight).toBe(0);
		expect(misskeyApiMock).toHaveBeenCalledTimes(199);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(misskeyApiMock).toHaveBeenCalledTimes(199);
	});

	test('keeps overflow and newly queued entries behind a delayed isolation chain', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let rejectFirstRequest: (() => void) | undefined;
		const successful = new Set<string>();
		misskeyApiMock.mockImplementation((_endpoint, data) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (misskeyApiMock.mock.calls.length === 1) {
				return new Promise((_resolve, reject) => {
					rejectFirstRequest = () => {
						inFlight--;
						reject({ code: 'INVALID_FEED_ENTRY' });
					};
				});
			}

			return Promise.resolve().then(() => {
				if (data.items.some(item => item.feedEntryId === 'invalid')) throw { code: 'INVALID_FEED_ENTRY' };
				for (const item of data.items) successful.add(item.feedEntryId);
				return { ok: true };
			}).finally(() => {
				inFlight--;
			});
		});
		const validIds = Array.from({ length: 101 }, (_, i) => `valid-${i}`);
		reportHanamiSeen('invalid', 'note-invalid');
		for (const id of validIds) reportHanamiSeen(id, `note-${id}`);

		await vi.advanceTimersByTimeAsync(2000);
		reportHanamiSeen('valid-new', 'note-new');
		await vi.advanceTimersByTimeAsync(10_000);

		expect(misskeyApiMock).toHaveBeenCalledOnce();
		expect(maxInFlight).toBe(1);

		rejectFirstRequest?.();
		await vi.advanceTimersByTimeAsync(0);
		const callsAfterIsolation = misskeyApiMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1999);
		expect(misskeyApiMock).toHaveBeenCalledTimes(callsAfterIsolation);
		await vi.advanceTimersByTimeAsync(1);

		expect(maxInFlight).toBe(1);
		expect(inFlight).toBe(0);
		expect(successful).toEqual(new Set([...validIds, 'valid-new']));
		const completedCalls = misskeyApiMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(misskeyApiMock).toHaveBeenCalledTimes(completedCalls);
	});

	test('does not let a transport retry timer overlap recursive isolation', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let retryAttempts = 0;
		let rejectInvalidSingleton: (() => void) | undefined;
		misskeyApiMock.mockImplementation((_endpoint, data) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const ids = data.items.map(item => item.feedEntryId);
			if (ids.length === 2) {
				inFlight--;
				return Promise.reject({ code: 'INVALID_FEED_ENTRY' });
			}
			if (ids[0] === 'invalid') {
				return new Promise((_resolve, reject) => {
					rejectInvalidSingleton = () => {
						inFlight--;
						reject({ code: 'INVALID_FEED_ENTRY' });
					};
				});
			}

			retryAttempts++;
			inFlight--;
			return retryAttempts === 1
				? Promise.reject(new Error('network error'))
				: Promise.resolve({ ok: true });
		});
		reportHanamiSeen('retry', 'note-retry');
		reportHanamiSeen('invalid', 'note-invalid');

		await vi.advanceTimersByTimeAsync(2000);
		await vi.advanceTimersByTimeAsync(2000);

		expect(retryAttempts).toBe(1);
		expect(maxInFlight).toBe(1);
		rejectInvalidSingleton?.();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1999);
		expect(retryAttempts).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		expect(retryAttempts).toBe(2);
		expect(maxInFlight).toBe(1);
		expect(inFlight).toBe(0);
	});

	test.each([
		'AUTHENTICATION_FAILED',
		'CREDENTIAL_REQUIRED',
		'PERMISSION_DENIED',
		'ROLE_PERMISSION_DENIED',
	])('drops terminal authentication or permission error %s', async code => {
		misskeyApiMock.mockRejectedValueOnce({ code });
		reportHanamiSeen('entry-1', 'note-1');

		await vi.advanceTimersByTimeAsync(2000);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(misskeyApiMock).toHaveBeenCalledOnce();
	});

	test('retries INTERNAL_ERROR as a server failure', async () => {
		misskeyApiMock.mockRejectedValueOnce({ code: 'INTERNAL_ERROR' });
		reportHanamiSeen('entry-1', 'note-1');

		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
	});

	test('accepts the same locator again once the re-report cooldown elapses', async () => {
		reportHanamiSeen('entry-1', 'note-1');
		await vi.advanceTimersByTimeAsync(2000);

		await vi.advanceTimersByTimeAsync(60_000);
		reportHanamiSeen('entry-1', 'note-1');
		await vi.advanceTimersByTimeAsync(2000);

		expect(misskeyApiMock).toHaveBeenCalledTimes(2);
		expect(misskeyApiMock.mock.calls[1]?.[1].items).toEqual([
			{ feedEntryId: 'entry-1', noteId: 'note-1' },
		]);
	});

	test('throttles a re-report of the same locator inside the cooldown', async () => {
		reportHanamiSeen('entry-1', 'note-1');
		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock).toHaveBeenCalledOnce();

		// v-appear は交差のたびに発火するため、短時間の再表示は送らない。
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(500);
			reportHanamiSeen('entry-1', 'note-1');
		}
		await vi.advanceTimersByTimeAsync(2000);

		expect(misskeyApiMock).toHaveBeenCalledOnce();
	});

	test('stops retrying a persistently failing batch instead of looping forever', async () => {
		misskeyApiMock.mockRejectedValue({ code: 'INTERNAL_ERROR' });
		reportHanamiSeen('entry-1', 'note-1');

		await vi.advanceTimersByTimeAsync(2000 * 20);

		expect(misskeyApiMock).toHaveBeenCalledTimes(5);
	});

	test('deduplicates the same locator while its request is in flight', async () => {
		let resolveRequest: ((value: { ok: boolean }) => void) | undefined;
		misskeyApiMock.mockImplementationOnce(() => new Promise(resolve => {
			resolveRequest = resolve;
		}));
		reportHanamiSeen('entry-1', 'note-1');

		await vi.advanceTimersByTimeAsync(2000);
		reportHanamiSeen('entry-1', 'note-1');
		await vi.advanceTimersByTimeAsync(10_000);

		expect(misskeyApiMock).toHaveBeenCalledOnce();
		resolveRequest?.({ ok: true });
		await vi.advanceTimersByTimeAsync(0);
	});

	test('sends at most 100 locators per request', async () => {
		for (let i = 0; i < 101; i++) reportHanamiSeen(`entry-${i}`, `note-${i}`);

		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock.mock.calls[0]?.[1].items).toHaveLength(100);

		await vi.advanceTimersByTimeAsync(2000);
		expect(misskeyApiMock.mock.calls[1]?.[1].items).toHaveLength(1);
	});
});
