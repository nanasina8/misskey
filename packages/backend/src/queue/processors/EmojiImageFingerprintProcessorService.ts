/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import * as Bull from 'bullmq';
import { IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { EmojisRepository } from '@/models/_.js';
import { AppLockService } from '@/core/AppLockService.js';
import { EmojiImageFingerprintError, EmojiImageFingerprintService } from '@/core/EmojiImageFingerprintService.js';
import { EmojiImageFingerprintSourceService } from '@/core/EmojiImageFingerprintSourceService.js';
import type { EmojiImageFingerprintBackfillJobData, EmojiImageFingerprintJobData } from '../types.js';
import { QueueService } from '@/core/QueueService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

@Injectable()
export class EmojiImageFingerprintProcessorService {
	constructor(
		@Inject(DI.emojisRepository) private emojisRepository: EmojisRepository,
		private sourceService: EmojiImageFingerprintSourceService,
		private fingerprintService: EmojiImageFingerprintService,
		private appLockService: AppLockService,
		private queueService: QueueService,
		private queueLoggerService: QueueLoggerService,
	) {}

	public async process(job: Bull.Job<EmojiImageFingerprintJobData>): Promise<void> {
		const unlock = await this.appLockService.getEmojiImageFingerprintLock(job.data.emojiId);
		try {
			const expected = { id: job.data.emojiId, publicUrl: job.data.sourceUrl, host: job.data.host === null ? IsNull() : job.data.host };
			const emoji = await this.emojisRepository.findOneBy({ id: job.data.emojiId });
			if (emoji == null || emoji.publicUrl !== job.data.sourceUrl || emoji.host !== job.data.host) return;
			try {
				const fingerprint = await this.fingerprintService.compute(await this.sourceService.read(emoji));
				await this.emojisRepository.update(expected, { imageFingerprint: fingerprint, imageFingerprintAttemptedAt: new Date(), imageFingerprintErrorCode: null });
			} catch (error) {
				if (error instanceof EmojiImageFingerprintError) {
					// 恒久的に指紋を取れない画像。attemptedAtを立てて、バックフィルが起動のたびに
					// 取得し直さないようにする。一過性の失敗はここには来ず、ジョブのリトライに任せる。
					await this.emojisRepository.update(expected, { imageFingerprint: null, imageFingerprintAttemptedAt: new Date(), imageFingerprintErrorCode: error.code });
					return;
				}
				throw error;
			}
		} finally { unlock(); }
	}

	public async processBackfill(job: Bull.Job<EmojiImageFingerprintBackfillJobData>): Promise<void> {
		const startedAt = Date.now();
		const scope = job.data.scope ?? 'all';
		const builder = this.emojisRepository.createQueryBuilder('emoji')
			.where('emoji."imageFingerprint" IS NULL')
			.andWhere('emoji."imageFingerprintAttemptedAt" IS NULL');
		if (scope === 'local') builder.andWhere('emoji.host IS NULL');
		if (job.data.host != null) builder.andWhere('emoji.host = :host', { host: job.data.host });
		const rows = await builder
			.andWhere(job.data.cursor ? 'emoji.id > :cursor' : '1=1', job.data.cursor ? { cursor: job.data.cursor } : {})
			.orderBy('emoji.id', 'ASC').take(100).getMany();
		for (const emoji of rows) await this.queueService.createEmojiImageFingerprintJob({ emojiId: emoji.id, sourceUrl: emoji.publicUrl, host: emoji.host });
		if (rows.length === 100) await this.queueService.createEmojiImageFingerprintBackfillJob({ scope, host: job.data.host, cursor: rows.at(-1)!.id });
		this.queueLoggerService.logger.info('emoji-image-fingerprint-backfill', {
			status: 'seeded', scope, host: job.data.host ?? null, count: rows.length, pending: rows.length === 100 ? 'more' : 0,
			cursor: job.data.cursor ?? null, durationMs: Date.now() - startedAt,
		});
	}
}
