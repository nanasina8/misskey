/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HanamiMetricsTimelineHealthService } from '@/core/hanami/HanamiMetricsTimelineHealthService.js';

type Statement = [string, unknown[]];

function harness() {
	const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
	const committed: Statement[][] = [];
	let beforeCommit: () => Promise<void> = async () => {};
	const transaction = jest.fn(async (run: (manager: { query: typeof query }) => Promise<void>) => {
		const statements: Statement[] = [];
		const transactionalQuery = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockImplementation(async (sql, params) => {
			statements.push([sql, params]);
			return [];
		});
		await run({ query: transactionalQuery });
		await beforeCommit();
		committed.push(statements);
	});
	const health = new HanamiMetricsTimelineHealthService({ query, transaction } as never);
	return { health, query, transaction, committed, setBeforeCommit: (hook: typeof beforeCommit) => { beforeCommit = hook; } };
}

beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-09-20T14:59:59Z')); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('timeline coverage health (mock DB only)', () => {
	test('startup registers exactly one random session, and shutdown removes its unref timer', async () => {
		const { health, query, committed } = harness();
		await Promise.all([health.onModuleInit(), health.onModuleInit()]);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0][1]).toEqual([expect.stringMatching(/^[a-f0-9-]{36}$/), '2026-09-19']);
		expect(jest.getTimerCount()).toBe(1);
		expect((health as unknown as { timer: NodeJS.Timeout }).timer.hasRef()).toBe(false);
		await health.onApplicationShutdown();
		expect(jest.getTimerCount()).toBe(0);
		expect(committed[0][2][1]).toEqual([query.mock.calls[0][1][0], '2026-09-19', true]);
	});

	test('startup failure rejects without driver details, retries, timers, or an unregistered heartbeat', async () => {
		const { health, query, transaction } = harness();
		query.mockRejectedValue(new Error('postgres://private-user:credential@host'));
		await expect(health.onModuleInit()).rejects.toThrow('Timeline metrics collector registration failed');
		await expect(health.onModuleInit()).rejects.not.toThrow('credential');
		await health.heartbeat();
		await health.onApplicationShutdown();
		expect(query).toHaveBeenCalledTimes(1);
		expect(transaction).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
	});

	test('healthy zero-request days advance only through yesterday JST every 30 seconds', async () => {
		const { health, committed } = harness();
		await health.onModuleInit();
		await jest.advanceTimersByTimeAsync(30_000);
		expect(committed).toHaveLength(1);
		expect(committed[0][0][1]).toEqual([[]]);
		expect(committed[0][2][1].slice(1)).toEqual(['2026-09-20', false]);
		await health.onApplicationShutdown();
		expect(jest.getTimerCount()).toBe(0);
	});

	test('yesterday remains uncertain until all its attempts finish; today cannot block yesterday', async () => {
		const { health, committed } = harness();
		await health.onModuleInit();
		health.begin('2026-09-20');
		health.begin('2026-09-20');
		jest.setSystemTime(new Date('2026-09-20T15:00:00Z'));
		health.begin('2026-09-21');
		await health.heartbeat();
		health.finish('2026-09-20', true);
		await health.heartbeat();
		expect(committed.map(batch => batch[2][1][1])).toEqual([null, null]);
		health.finish('2026-09-20', false);
		await health.heartbeat();
		expect(committed[2][0][1]).toEqual([['2026-09-20']]);
		expect(committed[2][2][1][1]).toBe('2026-09-20');
		health.finish('2026-09-21', true);
		await health.onApplicationShutdown();
	});

	test('DB outage retains failed days until gap and watermark commit together, without counter retries or logs', async () => {
		const warn = jest.spyOn(console, 'warn');
		const error = jest.spyOn(console, 'error');
		const { health, query, transaction, committed, setBeforeCommit } = harness();
		await health.onModuleInit();
		health.begin('2026-09-20');
		health.finish('2026-09-20', false);
		jest.setSystemTime(new Date('2026-09-20T15:00:00Z'));
		setBeforeCommit(async () => { throw new Error('private-user-id credential'); });
		await expect(health.heartbeat()).resolves.toBeUndefined();
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(committed).toEqual([]);
		setBeforeCommit(async () => {});
		await health.heartbeat();
		expect(committed[0][0][1]).toEqual([['2026-09-20']]);
		expect(committed[0][0][0]).toContain('ON CONFLICT ("day", "metric") DO NOTHING');
		expect(committed[0][2][1][1]).toBe('2026-09-20');
		await health.heartbeat();
		expect(committed[1][0][1]).toEqual([[]]);
		expect(query).toHaveBeenCalledTimes(1); // Registration only: never retry request counters.
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		await health.onApplicationShutdown();
	});

	test('a failed gap INSERT prevents even attempting the watermark UPDATE', async () => {
		const { health, transaction, committed } = harness();
		await health.onModuleInit();
		health.begin('2026-09-20');
		health.finish('2026-09-20', false);
		const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('offline'));
		transaction.mockImplementationOnce(async run => { await run({ query }); });
		await health.heartbeat();
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0][0]).toContain('INSERT INTO "hanami_metrics_gap"');
		expect(committed).toEqual([]);
		await health.heartbeat();
		expect(committed[0][0][1]).toEqual([['2026-09-20']]);
		await health.onApplicationShutdown();
	});

	test('same-day failure during commit survives the snapshot, and overlapping heartbeats coalesce', async () => {
		const { health, transaction, committed, setBeforeCommit } = harness();
		await health.onModuleInit();
		health.begin('2026-09-20');
		health.finish('2026-09-20', false);
		let release!: () => void;
		setBeforeCommit(() => new Promise<void>(resolve => { release = resolve; }));
		const flush = health.heartbeat();
		expect(health.heartbeat()).toBe(flush);
		// Reach the mock COMMIT gate without running timers.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		health.begin('2026-09-20');
		health.finish('2026-09-20', false);
		release();
		await flush;
		expect(transaction).toHaveBeenCalledTimes(1);
		setBeforeCommit(async () => {});
		await health.heartbeat();
		expect(committed.map(batch => batch[0][1])).toEqual([[['2026-09-20']], [['2026-09-20']]]);
		await health.heartbeat();
		expect(committed[2][0][1]).toEqual([[]]);
		await health.onApplicationShutdown();
	});

	test('a transaction crossing midnight cannot verify its still-active captured day', async () => {
		const { health, committed, setBeforeCommit } = harness();
		await health.onModuleInit();
		setBeforeCommit(async () => {
			health.begin('2026-09-20');
			jest.setSystemTime(new Date('2026-09-20T15:00:00Z'));
		});
		await health.heartbeat();
		expect(committed[0][2][1][1]).toBe('2026-09-19');
		setBeforeCommit(async () => {});
		await health.heartbeat();
		expect(committed[1][2][1][1]).toBeNull();
		health.finish('2026-09-20', false);
		await health.onApplicationShutdown();
	});

	test('abandoned OTHER sessions close conservatively with durable interval gaps, never changing their watermark', async () => {
		const { health, query, committed } = harness();
		await health.onModuleInit();
		await health.heartbeat();
		const [sql, params] = committed[0][1];
		expect(params).toEqual([query.mock.calls[0][1][0]]);
		expect(sql).toContain('"id" <> $1::uuid AND "stoppedAt" IS NULL');
		expect(sql).toContain('"lastSeenAt" < now() - interval \'2 minutes\'');
		expect(sql).toContain('SET "stoppedAt" = now()');
		expect(sql).toContain('generate_series("verifiedThrough" + 1,');
		expect(sql).toContain('(now() AT TIME ZONE \'Asia/Tokyo\')::date');
		expect(sql).toContain('INSERT INTO "hanami_metrics_gap"');
		expect(sql).not.toContain('SET "verifiedThrough"');
		await health.onApplicationShutdown();
	});

	test('shutdown waits for an active heartbeat then commits a fresh stopped snapshot', async () => {
		const { health, committed, setBeforeCommit } = harness();
		await health.onModuleInit();
		let release!: () => void;
		setBeforeCommit(() => new Promise<void>(resolve => { release = resolve; }));
		const tick = health.heartbeat();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		const shutdown = health.onApplicationShutdown();
		expect(jest.getTimerCount()).toBe(0);
		health.begin('2026-09-20');
		health.finish('2026-09-20', false);
		setBeforeCommit(async () => {});
		release();
		await Promise.all([tick, shutdown]);
		expect(committed).toHaveLength(2);
		expect(committed[0][2][1][2]).toBe(false);
		expect(committed[1][0][1]).toEqual([['2026-09-20']]);
		expect(committed[1][2][1][2]).toBe(true);
	});

	test('shutdown gaps unfinished attempts before stopping; failed shutdown leaves the collector unclosed', async () => {
		for (const fail of [false, true]) {
			const { health, committed, setBeforeCommit } = harness();
			await health.onModuleInit();
			health.begin('2026-09-20');
			if (fail) setBeforeCommit(async () => { throw new Error('offline'); });
			await health.onApplicationShutdown();
			expect(jest.getTimerCount()).toBe(0);
			if (fail) expect(committed).toEqual([]);
			else {
				expect(committed[0][0][1]).toEqual([['2026-09-20']]);
				expect(committed[0][2][1][2]).toBe(true);
			}
			await jest.advanceTimersByTimeAsync(90_000);
			expect(committed).toHaveLength(fail ? 0 : 1);
		}
	});
});
