/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import { USER_HIBERNATION_THRESHOLD } from '@/const.js';
import { HibernationSweepProcessorService } from '@/queue/processors/HibernationSweepProcessorService.js';

const now = new Date('2026-08-16T12:00:00.000Z');

describe('HibernationSweepProcessorService', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('hibernates deterministic chunks of inactive local users', async () => {
		jest.useFakeTimers();
		jest.setSystemTime(now);

		const em = {
			query: jest.fn<() => Promise<Array<{ id: string }>>>()
				.mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }])
				.mockResolvedValueOnce([]),
			update: jest.fn(async () => undefined),
		};
		const db = {
			transaction: jest.fn(async (callback: (entityManager: typeof em) => Promise<number>) => callback(em)),
		};
		const logger = { succ: jest.fn() };
		const queueLoggerService = { logger: { createSubLogger: () => logger } };
		const service = new HibernationSweepProcessorService(db as never, queueLoggerService as never);

		await service.process();

		expect(em.query).toHaveBeenCalledWith(expect.stringContaining('"host" IS NULL'), [
			new Date(now.getTime() - USER_HIBERNATION_THRESHOLD),
			1000,
		]);
		expect(em.query).toHaveBeenCalledWith(expect.stringContaining('"lastActiveDate" IS NOT NULL'), expect.any(Array));
		expect(em.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'), expect.any(Array));
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
		expect(logger.succ).toHaveBeenCalledWith('Hibernated 2 inactive users.');
	});

	it('continues until a full chunk is exhausted', async () => {
		const em = {
			query: jest.fn<() => Promise<Array<{ id: string }>>>()
				.mockResolvedValueOnce(Array.from({ length: 1000 }, (_, i) => ({ id: `user-${i}` })))
				.mockResolvedValueOnce([]),
			update: jest.fn(async () => undefined),
		};
		const db = {
			transaction: jest.fn(async (callback: (entityManager: typeof em) => Promise<number>) => callback(em)),
		};
		const logger = { succ: jest.fn() };
		const queueLoggerService = { logger: { createSubLogger: () => logger } };
		const service = new HibernationSweepProcessorService(db as never, queueLoggerService as never);

		await service.process();

		expect(db.transaction).toHaveBeenCalledTimes(2);
		expect(logger.succ).toHaveBeenCalledWith('Hibernated 1000 inactive users.');
	});
});
