/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { HanamiTimelinePartitionService } from '@/core/hanami/HanamiTimelinePartitionService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

function normalizeBullRejection(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error('Hanami timeline partition processor rejected with a non-Error value', { cause: error });
}

@Injectable()
export class HanamiTimelinePartitionMaintenanceProcessorService {
	private logger: Logger;

	constructor(
		private hanamiTimelinePartitionService: HanamiTimelinePartitionService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('hanami-timeline-partitions');
	}

	@bindThis
	public async process(): Promise<void> {
		try {
			this.logger.info('hanami timeline partitions: maintenance start');
			await this.hanamiTimelinePartitionService.maintainCurrentAndNextTwoMonths();
			this.logger.succ('hanami timeline partitions: maintenance done');
		} catch (error) {
			throw normalizeBullRejection(error);
		}
	}
}
