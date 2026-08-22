/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import { HibernationSweepProcessorService } from '@/queue/processors/HibernationSweepProcessorService.js';

const now = new Date('2026-08-16T12:00:00.000Z');
const DAY_MS = 86_400_000;

describe('HibernationSweepProcessorService', () => {
	const em = {
		query: jest.fn<(sql: string, values?: unknown[]) => Promise<Array<{ id: string }>>>(),
		update: jest.fn<(entity: unknown, criteria?: unknown, patch?: unknown) => Promise<{ affected: number }>>(async () => ({ affected: 0 })),
	};
	const db = {
		transaction: jest.fn(async (callback: (entityManager: typeof em) => Promise<string[]>) => callback(em)),
	};
	const logger = { succ: jest.fn() };
	const queueLoggerService = { logger: { createSubLogger: () => logger } };
	const hanamiFeedLifecycleService = {
		hibernateUsers: jest.fn(async () => undefined),
	};
	const globalEventService = {
		publishInternalEvent: jest.fn<(type: string, body: { id: string }) => void>(),
	};
	const config = { userHibernationDays: 17 };
	const service = new HibernationSweepProcessorService(
		db as never,
		config as never,
		queueLoggerService as never,
		hanamiFeedLifecycleService as never,
		globalEventService as never,
	);

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(now);
		jest.clearAllMocks();
		em.query.mockResolvedValue([]);
		em.update.mockResolvedValue({ affected: 0 });
		db.transaction.mockImplementation(async callback => callback(em));
		hanamiFeedLifecycleService.hibernateUsers.mockResolvedValue(undefined);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('uses configured days and strict local, nonnull, pre-cutoff candidate SQL', async () => {
		await service.process();

		const [sql, values] = em.query.mock.calls[0]!;
		expect(sql).toContain('"host" IS NULL');
		expect(sql).toContain('"isHibernated" = false');
		expect(sql).toContain('"lastActiveDate" IS NOT NULL');
		expect(sql).toContain('"lastActiveDate" < $1');
		expect(sql).not.toContain('"lastActiveDate" <= $1');
		expect(sql).toContain('ORDER BY "lastActiveDate" ASC, "id" ASC');
		expect(sql).toContain('FOR UPDATE SKIP LOCKED');
		expect(values).toEqual([
			new Date(now.getTime() - (config.userHibernationDays * DAY_MS)),
			1000,
		]);
		const [tailSql, tailValues] = em.query.mock.calls[1]!;
		expect(tailSql).toContain('FOR UPDATE');
		expect(tailSql).not.toContain('SKIP LOCKED');
		expect(tailValues).toEqual(values);
	});

	it('uses one blocking tail pass after a short nonblocking chunk', async () => {
		em.query
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: 'locked-tail' }]);
		em.update.mockImplementation(async entity => ({ affected: entity === MiUser ? 1 : 0 }));

		await service.process();

		expect(em.query).toHaveBeenCalledTimes(2);
		expect(em.query.mock.calls[0]?.[0]).toContain('FOR UPDATE SKIP LOCKED');
		expect(em.query.mock.calls[1]?.[0]).toContain('FOR UPDATE\n');
		expect(em.query.mock.calls[1]?.[0]).not.toContain('SKIP LOCKED');
		expect(hanamiFeedLifecycleService.hibernateUsers).toHaveBeenCalledWith(em, ['locked-tail'], now);
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledTimes(1);
	});

	it('runs lifecycle before user and following flags and succeeds without a common feed', async () => {
		const operations: string[] = [];
		em.query.mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
		hanamiFeedLifecycleService.hibernateUsers.mockImplementationOnce(async () => {
			operations.push('lifecycle');
		});
		em.update.mockImplementation(async entity => {
			operations.push(entity === MiUser ? 'user' : 'following');
			return { affected: entity === MiUser ? 2 : 0 };
		});

		await service.process();

		expect(operations).toEqual(['lifecycle', 'user', 'following']);
		expect(hanamiFeedLifecycleService.hibernateUsers).toHaveBeenCalledWith(em, ['user-1', 'user-2'], now);
		expect(em.update).toHaveBeenNthCalledWith(1, MiUser, {
			id: expect.anything(),
			isHibernated: false,
		}, {
			isHibernated: true,
		});
		expect(em.update).toHaveBeenNthCalledWith(2, MiFollowing, {
			followerId: expect.anything(),
			isFollowerHibernated: false,
		}, {
			isFollowerHibernated: true,
		});
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledTimes(2);
		expect(logger.succ).toHaveBeenCalledWith('Hibernated 2 inactive users.');
	});

	it('publishes every invalidation only after the chunk transaction commits', async () => {
		const operations: string[] = [];
		em.query.mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
		em.update.mockImplementation(async entity => ({ affected: entity === MiUser ? 2 : 0 }));
		db.transaction.mockImplementationOnce(async callback => {
			const ids = await callback(em);
			expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
			operations.push('commit');
			return ids;
		});
		globalEventService.publishInternalEvent.mockImplementation((_type, body) => {
			operations.push(`event:${body.id}`);
		});

		await service.process();

		expect(operations).toEqual(['commit', 'event:user-1', 'event:user-2']);
	});

	it('propagates lifecycle failure without flag writes or invalidation events', async () => {
		const failure = new Error('lifecycle failed');
		em.query.mockResolvedValueOnce([{ id: 'user-1' }]);
		hanamiFeedLifecycleService.hibernateUsers.mockRejectedValueOnce(failure);

		await expect(service.process()).rejects.toBe(failure);

		expect(em.update).not.toHaveBeenCalled();
		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});

	it('does not publish if a flag write rolls the chunk back', async () => {
		const failure = new Error('user update failed');
		em.query.mockResolvedValueOnce([{ id: 'user-1' }]);
		em.update.mockRejectedValueOnce(failure);

		await expect(service.process()).rejects.toBe(failure);

		expect(hanamiFeedLifecycleService.hibernateUsers).toHaveBeenCalledTimes(1);
		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});

	it('rolls back when not every locked user flag transitions', async () => {
		em.query.mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
		em.update.mockResolvedValueOnce({ affected: 1 });

		await expect(service.process()).rejects.toThrow('updated 1 of 2 locked users');

		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});

	it('continues one transaction per chunk until a partial chunk is committed', async () => {
		const fullChunk = Array.from({ length: 1000 }, (_, i) => ({ id: `user-${i}` }));
		em.query
			.mockResolvedValueOnce(fullChunk)
			.mockResolvedValueOnce([{ id: 'user-1000' }]);
		em.update.mockImplementation(async entity => {
			if (entity === MiFollowing) return { affected: 0 };
			return { affected: em.query.mock.calls.length === 1 ? 1000 : 1 };
		});

		await service.process();

		expect(db.transaction).toHaveBeenCalledTimes(3);
		expect(hanamiFeedLifecycleService.hibernateUsers).toHaveBeenCalledTimes(2);
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledTimes(1001);
		expect(logger.succ).toHaveBeenCalledWith('Hibernated 1001 inactive users.');
	});

	it('is idempotent when rerun after all candidates transitioned', async () => {
		em.query
			.mockResolvedValueOnce([{ id: 'user-1' }])
			.mockResolvedValueOnce([]);
		em.update.mockImplementation(async entity => ({ affected: entity === MiUser ? 1 : 0 }));

		await service.process();
		await service.process();

		expect(hanamiFeedLifecycleService.hibernateUsers).toHaveBeenCalledTimes(1);
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledTimes(1);
		expect(logger.succ).toHaveBeenNthCalledWith(1, 'Hibernated 1 inactive users.');
		expect(logger.succ).toHaveBeenNthCalledWith(2, 'Hibernated 0 inactive users.');
	});
});
