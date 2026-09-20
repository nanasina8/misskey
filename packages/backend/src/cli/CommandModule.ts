/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Module } from '@nestjs/common';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CommandService } from './CommandService.js';
import { HanamiSeedRecentService } from './HanamiSeedRecentService.js';

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
