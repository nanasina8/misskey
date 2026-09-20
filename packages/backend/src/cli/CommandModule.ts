/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { type Config, loadConfig } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { createPostgresDataSource } from '@/postgres.js';
import { HanamiMetricsRollupService } from '@/core/hanami/HanamiMetricsRollupService.js';
import { CommandService } from './CommandService.js';
import { HanamiSeedRecentService } from './HanamiSeedRecentService.js';
import { HanamiMetricsRollupCommandService } from './HanamiMetricsRollupCommandService.js';

@Module({
	imports: [
		GlobalModule,
		CoreModule,
	],
	providers: [
		CommandService,
		HanamiSeedRecentService,
	],
	exports: [
		CommandService,
		HanamiSeedRecentService,
	],
})
export class CommandModule {}

// Do not import CoreModule/GlobalModule here: their lifecycle/providers enqueue
// generation and fingerprint jobs, register schedulers, and may create a meta row.
@Module({
	providers: [
		{ provide: DI.config, useFactory: loadConfig },
		{
			provide: DI.db,
			inject: [DI.config],
			useFactory: async (config: Config) => {
				const db = createPostgresDataSource(config);
				// Even under NODE_ENV=test this command must never synchronize/drop schema.
				db.setOptions({ synchronize: false, dropSchema: false, migrationsRun: false, installExtensions: false, cache: false });
				return await db.initialize();
			},
		},
		{
			provide: DI.redis,
			inject: [DI.config],
			useFactory: (config: Config) => new Redis.Redis(config.redis),
		},
		HanamiMetricsRollupService,
		{
			provide: HanamiMetricsRollupCommandService,
			inject: [HanamiMetricsRollupService],
			useFactory: (service: HanamiMetricsRollupService) => new HanamiMetricsRollupCommandService(service),
		},
	],
	exports: [HanamiMetricsRollupCommandService],
})
export class HanamiMetricsRollupCommandModule implements OnApplicationShutdown {
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redisClient: Redis.Redis,
	) {}

	public async onApplicationShutdown(): Promise<void> {
		this.redisClient.disconnect();
		if (this.db.isInitialized) await this.db.destroy();
	}
}
