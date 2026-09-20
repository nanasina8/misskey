/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { NestFactory } from '@nestjs/core';
import { CommandModule } from '@/cli/CommandModule.js';
import { NestLogger } from '@/NestLogger.js';
import { CommandService } from '@/cli/CommandService.js';

process.title = 'Misskey Cli';

Error.stackTraceLimit = Infinity;
EventEmitter.defaultMaxListeners = 128;

const app = await NestFactory.createApplicationContext(CommandModule, {
	logger: new NestLogger(),
});

const commandService = app.get(CommandService);

const command = process.argv[2] ?? 'help';

switch (command) {
	case 'help': {
		console.log('Available commands:');
		console.log('  help - Displays this help message');
		console.log('  reset-captcha - Resets the captcha');
		console.log('  hanami-seed-recent [--days N] [--replay] [--cleanup] - (dev) clone the newest N days of notes/reactions into the present and replay the trend index');
		break;
	}
	case 'ping': {
		await commandService.ping();
		break;
	}
	case 'hanami-seed-recent': {
		const { HanamiSeedRecentService } = await import('@/cli/HanamiSeedRecentService.js');
		const seed = app.get(HanamiSeedRecentService);
		if (process.argv.includes('--cleanup')) {
			await seed.cleanup();
		} else if (process.argv.includes('--replay')) {
			await seed.replayOnly();
		} else {
			const daysArg = process.argv.indexOf('--days');
			const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 14;
			if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error('--days must be 1..90');
			await seed.seed(days);
		}
		break;
	}
	case 'reset-captcha': {
		await commandService.resetCaptcha();
		console.log('Captcha has been reset.');
		break;
	}
	default: {
		console.error(`Unrecognized command: ${command}`);
		console.error('Use "help" to see available commands.');
		process.exit(1);
	}
}

process.exit(0);
