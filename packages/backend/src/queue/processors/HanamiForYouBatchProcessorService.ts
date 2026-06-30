/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

/**
 * はなみ For You オフラインバッチの system queue 処理（canonical spec §3/§10 = 既定1時間ごと）。
 * 関係値(純SQL) / ALS(Python orchestration) / event cleanup を順に走らせる。各ステップは service 側で独立 guard。
 */
@Injectable()
export class HanamiForYouBatchProcessorService {
	private logger: Logger;

	constructor(
		private hanamiForYouBatchService: HanamiForYouBatchService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-foryou-batch');
	}

	@bindThis
	public async process(job: Bull.Job<Record<string, unknown>>): Promise<void> {
		this.logger.info('hanami foryou: batch start');
		await this.hanamiForYouBatchService.runAll(this.logger);
		this.logger.succ('hanami foryou: batch done');
		job.updateProgress(100);
	}
}
