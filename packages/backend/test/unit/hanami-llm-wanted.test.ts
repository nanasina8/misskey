/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
	acquireHanamiLocalLlmLock,
	clearHanamiLlmEventThrottle,
	findHanamiLlmWaiters,
	HANAMI_LLM_WANTED_PREFIX,
} from '@/core/hanami/HanamiLocalLlmLock.js';

/** ロックと「待っている」目印に必要なぶんだけの、メモリ上の Redis もどき */
function fakeRedis() {
	const store = new Map<string, string>();
	const redis = {
		store,
		async set(key: string, value: string, ...args: unknown[]) {
			if (args.includes('NX') && store.has(key)) return null;
			store.set(key, value);
			return 'OK';
		},
		async get(key: string) { return store.get(key) ?? null; },
		async del(key: string) { return store.delete(key) ? 1 : 0; },
		async mget(...keys: string[]) { return keys.map(key => store.get(key) ?? null); },
		async eval(_script: string, n: number, ...rest: string[]) {
			// release: 自分の token のときだけ消す
			const keys = rest.slice(0, n);
			const token = rest[n];
			let count = 0;
			for (const key of keys) {
				if (store.get(key) === token) {
					store.delete(key);
					count++;
				}
			}
			return count;
		},
		multi() {
			const chain = { lpush: () => chain, ltrim: () => chain, expire: () => chain, exec: async () => [] };
			return chain;
		},
	};
	return redis;
}

describe('GPU を待っている目印', () => {
	beforeEach(() => clearHanamiLlmEventThrottle());

	test('ロックを取れなかったジョブは目印を立て、取れたら消す', async () => {
		const redis = fakeRedis();
		const scan = await acquireHanamiLocalLlmLock(redis as any, 'spamScan');
		expect(scan).not.toBeNull();

		expect(await acquireHanamiLocalLlmLock(redis as any, 'noteJudge')).toBeNull();
		expect(redis.store.has(`${HANAMI_LLM_WANTED_PREFIX}noteJudge`)).toBe(true);
		expect(await findHanamiLlmWaiters(redis as any, 'spamScan')).toEqual(['noteJudge']);

		await scan!.release();
		const note = await acquireHanamiLocalLlmLock(redis as any, 'noteJudge');
		expect(note).not.toBeNull();
		expect(await findHanamiLlmWaiters(redis as any, 'spamScan')).toEqual([]);
		await note!.release();
	});

	test('全体スキャン（譲る側）は取れなくても目印を立てない', async () => {
		const redis = fakeRedis();
		const note = await acquireHanamiLocalLlmLock(redis as any, 'noteJudge');
		expect(await acquireHanamiLocalLlmLock(redis as any, 'spamScan')).toBeNull();
		expect(redis.store.has(`${HANAMI_LLM_WANTED_PREFIX}spamScan`)).toBe(false);
		expect(await findHanamiLlmWaiters(redis as any)).toEqual([]);
		await note!.release();
	});
});
