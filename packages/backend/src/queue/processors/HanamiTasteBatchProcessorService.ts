/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { HanamiTasteClusterBatchService, type HanamiTasteRebuildJobData } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { QueueService } from '@/core/QueueService.js';
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
		private queueService: QueueService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-taste-batch');
	}

	@bindThis
	public async processSweep(job: Bull.Job<Record<string, unknown>>): Promise<void> {
		// 埋め込みスイープ→興味マッチ事前計算（reactionSimilar 軸）。1ロックの下で順に実行され、
		// 個別の失敗は tick 内部で警告に留まる（sweep 失敗でも match は既存埋め込みで動く）。
		await this.hanamiTasteClusterBatchService.runTasteTick(this.logger);
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

	@bindThis
	public async processRebuild(job: Bull.Job<HanamiTasteRebuildJobData>): Promise<void> {
		const res = await this.hanamiTasteClusterBatchService.runTasteRebuildChunk(job.data, this.logger);
		if (res.action === 'cluster') {
			await this.queueService.enqueueHanamiTasteClusterNow();
			this.logger.succ('hanami taste rebuild: done; enqueued cluster rebuild');
		} else {
			await this.queueService.enqueueHanamiTasteRebuild(res.data, res.delayMs);
		}
		job.updateProgress(100);
	}
}
