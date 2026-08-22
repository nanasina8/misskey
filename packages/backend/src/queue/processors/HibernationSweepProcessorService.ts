/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { HanamiFeedLifecycleService } from '@/core/hanami/HanamiFeedLifecycleService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

const HIBERNATION_SWEEP_CHUNK_SIZE = 1000;
const DAY_MS = 86_400_000;

@Injectable()
export class HibernationSweepProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.db)
		private db: DataSource,
		@Inject(DI.config)
		private config: Config,
		private queueLoggerService: QueueLoggerService,
		private hanamiFeedLifecycleService: HanamiFeedLifecycleService,
		private globalEventService: GlobalEventService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hibernation-sweep');
	}

	@bindThis
	public async process(): Promise<void> {
		const transitionedAt = new Date();
		const cutoff = new Date(transitionedAt.getTime() - (this.config.userHibernationDays * DAY_MS));
		let total = 0;

		for (;;) {
			const transitionedUserIds = await this.transitionChunk(cutoff, transitionedAt, true);
			this.publishInvalidations(transitionedUserIds);
			total += transitionedUserIds.length;
			if (transitionedUserIds.length < HIBERNATION_SWEEP_CHUNK_SIZE) break;
		}

		for (;;) {
			const transitionedUserIds = await this.transitionChunk(cutoff, transitionedAt, false);
			this.publishInvalidations(transitionedUserIds);
			total += transitionedUserIds.length;
			if (transitionedUserIds.length < HIBERNATION_SWEEP_CHUNK_SIZE) break;
		}

		this.logger.succ(`Hibernated ${total} inactive users.`);
	}

	private async transitionChunk(cutoff: Date, transitionedAt: Date, skipLocked: boolean): Promise<MiUser['id'][]> {
		return await this.db.transaction(async (em: EntityManager) => {
			const candidates = await em.query<Array<{ id: MiUser['id'] }>>(`
				SELECT "id"
				FROM "user"
				WHERE "host" IS NULL
					AND "isHibernated" = false
					AND "lastActiveDate" IS NOT NULL
					AND "lastActiveDate" < $1
				ORDER BY "lastActiveDate" ASC, "id" ASC
				LIMIT $2
				FOR UPDATE${skipLocked ? ' SKIP LOCKED' : ''}
			`, [cutoff, HIBERNATION_SWEEP_CHUNK_SIZE]);

			if (candidates.length === 0) return [];
			const userIds = candidates.map(user => user.id);

			await this.hanamiFeedLifecycleService.hibernateUsers(em, userIds, transitionedAt);

			// The candidate rows stay write-locked until commit, so activity cannot invalidate
			// their local/active/stale predicates between selection and this update.
			const updated = await em.update(MiUser, {
				id: In(userIds),
				isHibernated: false,
			}, {
				isHibernated: true,
			});
			if (updated.affected !== userIds.length) {
				throw new Error(`Hibernation sweep updated ${updated.affected ?? 0} of ${userIds.length} locked users`);
			}
			await em.update(MiFollowing, {
				followerId: In(userIds),
				isFollowerHibernated: false,
			}, {
				isFollowerHibernated: true,
			});

			return userIds;
		});
	}

	private publishInvalidations(userIds: readonly MiUser['id'][]): void {
		for (const userId of userIds) {
			this.globalEventService.publishInternalEvent('localUserUpdated', { id: userId });
		}
	}
}
