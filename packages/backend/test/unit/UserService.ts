/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import { UserService } from '@/core/UserService.js';
import { USER_ACTIVITY_UPDATE_INTERVAL } from '@/const.js';

const now = new Date('2026-08-16T12:00:00.000Z');

type LockedUser = {
	id: string;
	isHibernated: boolean;
	lastActiveDate: Date | null;
};

describe('UserService.updateLastActiveDate', () => {
	const em = {
		findOne: jest.fn<() => Promise<LockedUser | null>>(),
		update: jest.fn<(entity: unknown, criteria?: unknown, patch?: unknown) => Promise<{ affected: number }>>(async () => ({ affected: 1 })),
	};
	const db = {
		transaction: jest.fn(async (callback: (entityManager: typeof em) => Promise<unknown>) => callback(em)),
	};
	const globalEventService = {
		publishInternalEvent: jest.fn(),
	};
	const hanamiFeedLifecycleService = {
		reviveUser: jest.fn(async () => undefined),
	};
	const service = new UserService(
		db as never,
		{} as never,
		{} as never,
		globalEventService as never,
		hanamiFeedLifecycleService as never,
	);

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(now);
		jest.clearAllMocks();
		em.findOne.mockResolvedValue(null);
		em.update.mockResolvedValue({ affected: 1 });
		db.transaction.mockImplementation(async callback => callback(em));
		hanamiFeedLifecycleService.reviveUser.mockResolvedValue(undefined);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('uses the cached fast path at exact five-minute equality', async () => {
		const user = {
			id: 'user',
			isHibernated: false,
			lastActiveDate: new Date(now.getTime() - USER_ACTIVITY_UPDATE_INTERVAL),
		} as MiUser;

		await service.updateLastActiveDate(user);

		expect(db.transaction).not.toHaveBeenCalled();
	});

	it('conditionally updates only the timestamp for a cached active user just outside five minutes', async () => {
		const oldDate = new Date(now.getTime() - USER_ACTIVITY_UPDATE_INTERVAL - 1);
		const user = { id: 'user', isHibernated: false, lastActiveDate: oldDate } as MiUser;

		await service.updateLastActiveDate(user);

		expect(em.findOne).not.toHaveBeenCalled();
		expect(em.update).toHaveBeenCalledTimes(1);
		expect(em.update).toHaveBeenCalledWith(MiUser, {
			id: user.id,
			isHibernated: false,
		}, {
			lastActiveDate: now,
		});
		expect(hanamiFeedLifecycleService.reviveUser).not.toHaveBeenCalled();
		expect(user.lastActiveDate).toEqual(now);
		expect(user.isHibernated).toBe(false);
		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});

	it('falls back to locked DB authority when the active conditional update loses to hibernation', async () => {
		const oldDate = new Date(0);
		const user = { id: 'user', isHibernated: false, lastActiveDate: oldDate } as MiUser;
		em.update
			.mockResolvedValueOnce({ affected: 0 })
			.mockResolvedValue({ affected: 1 });
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: true, lastActiveDate: oldDate });

		await service.updateLastActiveDate(user);

		expect(em.findOne).toHaveBeenCalledWith(MiUser, {
			where: { id: user.id },
			select: ['id', 'isHibernated', 'lastActiveDate'],
			lock: { mode: 'pessimistic_write' },
		});
		expect(hanamiFeedLifecycleService.reviveUser).toHaveBeenCalledWith(em, user.id, now);
		expect(em.update).toHaveBeenNthCalledWith(2, MiUser, user.id, {
			lastActiveDate: now,
			isHibernated: false,
		});
		expect(em.update).toHaveBeenNthCalledWith(3, MiFollowing, {
			followerId: user.id,
			isFollowerHibernated: true,
		}, {
			isFollowerHibernated: false,
		});
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledWith('localUserUpdated', { id: user.id });
	});

	it('copies an active locked row at exact equality over stale cached values', async () => {
		const lockedDate = new Date(now.getTime() - USER_ACTIVITY_UPDATE_INTERVAL);
		const user = { id: 'user', isHibernated: true, lastActiveDate: new Date(0) } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: false, lastActiveDate: lockedDate });

		await service.updateLastActiveDate(user);

		expect(em.update).not.toHaveBeenCalled();
		expect(hanamiFeedLifecycleService.reviveUser).not.toHaveBeenCalled();
		expect(user.isHibernated).toBe(false);
		expect(user.lastActiveDate).toEqual(lockedDate);
		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});

	it('uses the locked hibernated state and revives lifecycle before clearing flags', async () => {
		const operations: string[] = [];
		const oldDate = new Date(0);
		const user = { id: 'user', isHibernated: true, lastActiveDate: oldDate } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: true, lastActiveDate: oldDate });
		hanamiFeedLifecycleService.reviveUser.mockImplementationOnce(async () => {
			operations.push('lifecycle');
		});
		em.update.mockImplementation(async entity => {
			operations.push(entity === MiUser ? 'user' : 'following');
			return { affected: 1 };
		});

		await service.updateLastActiveDate(user);

		expect(operations).toEqual(['lifecycle', 'user', 'following']);
		expect(hanamiFeedLifecycleService.reviveUser).toHaveBeenCalledWith(em, user.id, now);
		expect(em.update).toHaveBeenNthCalledWith(1, MiUser, user.id, {
			lastActiveDate: now,
			isHibernated: false,
		});
		expect(em.update).toHaveBeenNthCalledWith(2, MiFollowing, {
			followerId: user.id,
			isFollowerHibernated: true,
		}, {
			isFollowerHibernated: false,
		});
		expect(user.isHibernated).toBe(false);
		expect(user.lastActiveDate).toEqual(now);
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledWith('localUserUpdated', { id: user.id });
	});

	it('does not mutate the caller or publish before the revival transaction commits', async () => {
		const oldDate = new Date(0);
		const user = { id: 'user', isHibernated: true, lastActiveDate: oldDate } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: true, lastActiveDate: oldDate });
		db.transaction.mockImplementationOnce(async callback => {
			const result = await callback(em);
			expect(user.isHibernated).toBe(true);
			expect(user.lastActiveDate).toBe(oldDate);
			expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
			return result;
		});

		await service.updateLastActiveDate(user);

		expect(user.isHibernated).toBe(false);
		expect(user.lastActiveDate).toEqual(now);
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledTimes(1);
	});

	it('propagates lifecycle failure without flag writes, events, or caller mutation', async () => {
		const oldDate = new Date(0);
		const user = { id: 'user', isHibernated: true, lastActiveDate: oldDate } as MiUser;
		const failure = new Error('lifecycle failed');
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: true, lastActiveDate: oldDate });
		hanamiFeedLifecycleService.reviveUser.mockRejectedValueOnce(failure);

		await expect(service.updateLastActiveDate(user)).rejects.toBe(failure);

		expect(em.update).not.toHaveBeenCalled();
		expect(user.isHibernated).toBe(true);
		expect(user.lastActiveDate).toBe(oldDate);
		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});

	it('revives a hibernated user with no feed state without creating or enqueueing work', async () => {
		const user = { id: 'unused', isHibernated: true, lastActiveDate: null } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: true, lastActiveDate: null });

		await service.updateLastActiveDate(user);

		expect(hanamiFeedLifecycleService.reviveUser).toHaveBeenCalledTimes(1);
		expect(em.update).toHaveBeenCalledTimes(2);
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledTimes(1);
	});

	it('leaves the caller unchanged when the locked user row was deleted', async () => {
		const oldDate = new Date(0);
		const user = { id: 'deleted', isHibernated: true, lastActiveDate: oldDate } as MiUser;
		em.findOne.mockResolvedValue(null);

		await service.updateLastActiveDate(user);

		expect(hanamiFeedLifecycleService.reviveUser).not.toHaveBeenCalled();
		expect(em.update).not.toHaveBeenCalled();
		expect(user.isHibernated).toBe(true);
		expect(user.lastActiveDate).toBe(oldDate);
		expect(globalEventService.publishInternalEvent).not.toHaveBeenCalled();
	});
});
