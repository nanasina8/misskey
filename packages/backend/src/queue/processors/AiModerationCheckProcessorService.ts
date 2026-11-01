/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import { AiModerationService } from '@/core/AiModerationService.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';

@Injectable()
export class AiModerationCheckProcessorService {
	constructor(
		private aiModerationService: AiModerationService,
		private aiModerationScanService: AiModerationScanService,
	) {
	}

	@bindThis
	public async process(): Promise<void> {
		// いつもの判定を先に済ませ、空いた時間で全体スキャンを進める
		await this.aiModerationService.processPending();
		await this.aiModerationScanService.processScan();
	}
}
