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

describe('UserService.updateLastActiveDate', () => {
	const em = {
		findOne: jest.fn<() => Promise<{ id: string; isHibernated: boolean; lastActiveDate: Date | null } | null>>(),
		update: jest.fn(async () => undefined),
	};
	const db = {
		transaction: jest.fn(async (callback: (entityManager: typeof em) => Promise<unknown>) => callback(em)),
	};
	const globalEventService = {
		publishInternalEvent: jest.fn(),
	};
	const service = new UserService(db as never, {} as never, {} as never, globalEventService as never);

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(now);
		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('does not access the database again inside the five-minute window', async () => {
		const user = {
			id: 'user',
			isHibernated: false,
			lastActiveDate: new Date(now.getTime() - USER_ACTIVITY_UPDATE_INTERVAL + 1),
		} as MiUser;

		await service.updateLastActiveDate(user);

		expect(db.transaction).not.toHaveBeenCalled();
	});

	it('updates an old active user without touching following rows', async () => {
		const oldDate = new Date(now.getTime() - USER_ACTIVITY_UPDATE_INTERVAL - 1);
		const user = { id: 'user', isHibernated: false, lastActiveDate: oldDate } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: false, lastActiveDate: oldDate });

		await service.updateLastActiveDate(user);

		expect(em.update).toHaveBeenCalledTimes(1);
		expect(em.update).toHaveBeenCalledWith(MiUser, user.id, {
			lastActiveDate: now,
			isHibernated: false,
		});
		expect(user.lastActiveDate).toEqual(now);
	});

	it('atomically clears user and following hibernation flags', async () => {
		const user = { id: 'user', isHibernated: true, lastActiveDate: new Date(0) } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: true, lastActiveDate: user.lastActiveDate });

		await service.updateLastActiveDate(user);

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
		expect(globalEventService.publishInternalEvent).toHaveBeenCalledWith('localUserUpdated', { id: user.id });
	});

	it('refreshes a stale cached user when another worker already recorded activity', async () => {
		const currentDate = new Date(now.getTime() - 1000);
		const user = { id: 'user', isHibernated: true, lastActiveDate: new Date(0) } as MiUser;
		em.findOne.mockResolvedValue({ id: user.id, isHibernated: false, lastActiveDate: currentDate });

		await service.updateLastActiveDate(user);

		expect(em.update).not.toHaveBeenCalled();
		expect(user.isHibernated).toBe(false);
		expect(user.lastActiveDate).toEqual(currentDate);
	});
});
