/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { HanamiTasteClusterBatchService } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

/**
 * taste-clustered popular のバッチ（spec v0.2 §1）。
 * - sweep（10分間隔）: ノート埋め込み。新しい順・時間予算。
 * - cluster（日次）: evidence 追記→整理→mean_vec→k-means→クラスタ全置換。
 */
@Injectable()
export class HanamiTasteBatchProcessorService {
	private logger: Logger;

	constructor(
		private hanamiTasteClusterBatchService: HanamiTasteClusterBatchService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-taste-batch');
	}

	@bindThis
	public async processSweep(job: Bull.Job<Record<string, unknown>>): Promise<void> {
		try {
			await this.hanamiTasteClusterBatchService.runTasteSweep(this.logger);
		} catch (err) {
			// python 不在などの環境では警告に留めて次回に任せる（serve は general 縮退で壊れない）。
			this.logger.warn(`hanami taste sweep failed: ${(err as Error).message}`);
		}
		job.updateProgress(100);
	}

	@bindThis
	public async processCluster(job: Bull.Job<Record<string, unknown>>): Promise<void> {
		try {
			const res = await this.hanamiTasteClusterBatchService.runTasteClusterBatch(this.logger);
			this.logger.succ(`hanami taste cluster: done (${res.users} users)`);
		} catch (err) {
			this.logger.warn(`hanami taste cluster failed: ${(err as Error).message}`);
		}
		job.updateProgress(100);
	}
}
