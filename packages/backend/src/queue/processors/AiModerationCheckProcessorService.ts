/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { AI_MODERATION_LAST_TICK_KEY, AiModerationService } from '@/core/AiModerationService.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';

@Injectable()
export class AiModerationCheckProcessorService {
	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		private aiModerationService: AiModerationService,
		private aiModerationScanService: AiModerationScanService,
	) {
	}

	@bindThis
	public async process(): Promise<void> {
		// 定期実行が動いているかを管理画面で見られるように、時刻を残す
		await this.redis.set(AI_MODERATION_LAST_TICK_KEY, new Date().toISOString(), 'EX', 7 * 24 * 60 * 60);
		// いつもの判定を先に済ませ、空いた時間で全体スキャンを進める
		await this.aiModerationService.processPending();
		await this.aiModerationScanService.processScan();
	}
}
