/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { MiFollowing } from '@/models/Following.js';
import { MiUser } from '@/models/User.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { SystemWebhookService } from '@/core/SystemWebhookService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { USER_ACTIVITY_UPDATE_INTERVAL } from '@/const.js';

@Injectable()
export class UserService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,
		private systemWebhookService: SystemWebhookService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
	) {
	}

	@bindThis
	public async updateLastActiveDate(user: MiUser): Promise<void> {
		const now = new Date();
		const cutoff = new Date(now.getTime() - USER_ACTIVITY_UPDATE_INTERVAL);
		if (!user.isHibernated && user.lastActiveDate != null && user.lastActiveDate >= cutoff) return;

		const result = await this.db.transaction(async em => {
			const current = await em.findOne(MiUser, {
				where: { id: user.id },
				select: ['id', 'isHibernated', 'lastActiveDate'],
				lock: { mode: 'pessimistic_write' },
			});
			if (current == null) return null;
			if (!current.isHibernated && current.lastActiveDate != null && current.lastActiveDate >= cutoff) {
				return { lastActiveDate: current.lastActiveDate, wasHibernated: false };
			}

			await em.update(MiUser, user.id, {
				lastActiveDate: now,
				isHibernated: false,
			});

			if (current.isHibernated) {
				await em.update(MiFollowing, {
					followerId: user.id,
					isFollowerHibernated: true,
				}, {
					isFollowerHibernated: false,
				});
			}

			return { lastActiveDate: now, wasHibernated: current.isHibernated };
		});

		if (result == null) return;
		user.lastActiveDate = result.lastActiveDate;
		user.isHibernated = false;
		if (result.wasHibernated) {
			this.globalEventService.publishInternalEvent('localUserUpdated', { id: user.id });
		}
	}

	/**
	 * SystemWebhookを用いてユーザに関する操作内容を管理者各位に通知する.
	 * ここではJobQueueへのエンキューのみを行うため、即時実行されない.
	 *
	 * @see SystemWebhookService.enqueueSystemWebhook
	 */
	@bindThis
	public async notifySystemWebhook(user: MiUser, type: 'userCreated') {
		const packedUser = await this.userEntityService.pack(user, null, { schema: 'UserLite' });
		return this.systemWebhookService.enqueueSystemWebhook(type, packedUser);
	}
}
