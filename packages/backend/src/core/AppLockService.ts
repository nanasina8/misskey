/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { acquireDistributedLock } from '@/misc/distributed-lock.js';

@Injectable()
export class AppLockService {
	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,
	) {
	}

	/**
	 * Get AP Object lock
	 * @param uri AP object ID
	 * @param timeout Lock timeout (ms), The timeout releases previous lock.
	 * @returns Unlock function
	 */
	@bindThis
	public getApLock(uri: string, timeout = 30 * 1000): Promise<() => Promise<void>> {
		return acquireDistributedLock(this.redisClient, `ap-object:${uri}`, timeout, 50, 100);
	}

	@bindThis
	public getChartInsertLock(lockKey: string, timeout = 30 * 1000): Promise<() => Promise<void>> {
		return acquireDistributedLock(this.redisClient, `chart-insert:${lockKey}`, timeout, 50, 500);
	}

	@bindThis
	public getEmojiImageFingerprintLock(emojiId: string, timeout = 30 * 1000): Promise<() => Promise<void>> {
		return acquireDistributedLock(this.redisClient, `emoji-image-fingerprint:${emojiId}`, timeout, 50, 100);
	}
}
