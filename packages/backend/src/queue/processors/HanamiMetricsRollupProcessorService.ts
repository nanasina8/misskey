/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { HanamiMetricsRollupService } from '@/core/hanami/HanamiMetricsRollupService.js';
import { HanamiMetricsDiagnosticsService } from '@/core/hanami/HanamiMetricsDiagnosticsService.js';
import { HanamiMetricsRetentionService } from '@/core/hanami/HanamiMetricsRetentionService.js';
import { jstDay } from '@/core/hanami/HanamiMetricsContracts.js';
import { bindThis } from '@/decorators.js';

@Injectable()
export class HanamiMetricsRollupProcessorService {
	constructor(
		private hanamiMetricsRollupService: HanamiMetricsRollupService,
		private diagnostics: HanamiMetricsDiagnosticsService,
		private retention: HanamiMetricsRetentionService,
	) {}

	@bindThis
	public async process(): Promise<void> {
		await this.diagnostics.capture(jstDay());
		await this.hanamiMetricsRollupService.rollupRecent();
		await this.retention.prune();
	}
}
