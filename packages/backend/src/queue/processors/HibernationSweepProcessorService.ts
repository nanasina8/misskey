/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import { USER_HIBERNATION_THRESHOLD } from '@/const.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

const HIBERNATION_SWEEP_CHUNK_SIZE = 1000;

@Injectable()
export class HibernationSweepProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.db)
		private db: DataSource,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hibernation-sweep');
	}

	@bindThis
	public async process(): Promise<void> {
		const cutoff = new Date(Date.now() - USER_HIBERNATION_THRESHOLD);
		let total = 0;

		for (;;) {
			const count = await this.db.transaction(async em => {
				const candidates = await em.query<Array<{ id: string }>>(`
					SELECT "id"
					FROM "user"
					WHERE "host" IS NULL
						AND "isHibernated" = false
						AND "lastActiveDate" IS NOT NULL
						AND "lastActiveDate" < $1
					ORDER BY "lastActiveDate" ASC, "id" ASC
					LIMIT $2
					FOR UPDATE SKIP LOCKED
				`, [cutoff, HIBERNATION_SWEEP_CHUNK_SIZE]);

				if (candidates.length === 0) return 0;
				const userIds = candidates.map(user => user.id);

				await em.update(MiUser, {
					id: In(userIds),
					isHibernated: false,
				}, {
					isHibernated: true,
				});
				await em.update(MiFollowing, {
					followerId: In(userIds),
					isFollowerHibernated: false,
				}, {
					isFollowerHibernated: true,
				});

				return candidates.length;
			});

			total += count;
			if (count < HIBERNATION_SWEEP_CHUNK_SIZE) break;
		}

		this.logger.succ(`Hibernated ${total} inactive users.`);
	}
}
