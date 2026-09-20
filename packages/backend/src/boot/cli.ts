/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { NestFactory } from '@nestjs/core';
import { NestLogger } from '@/NestLogger.js';
import { HanamiMetricsRollupCommandService, parseHanamiMetricsRollupArgs } from '@/cli/HanamiMetricsRollupCommandService.js';

process.title = 'Misskey Cli';

Error.stackTraceLimit = Infinity;
EventEmitter.defaultMaxListeners = 128;

const command = process.argv[2] ?? 'help';
const metricsArgs = process.argv.slice(3);
// Validate before importing configuration or initializing any application context.
const metricsNow = new Date();
if (command === 'hanami:metrics-rollup') parseHanamiMetricsRollupArgs(metricsArgs, metricsNow);

const { CommandModule, HanamiMetricsRollupCommandModule } = await import('@/cli/CommandModule.js');
const app = await NestFactory.createApplicationContext(command === 'hanami:metrics-rollup' ? HanamiMetricsRollupCommandModule : CommandModule, {
	logger: new NestLogger(),
});

switch (command) {
	case 'help': {
		console.log('Available commands:');
		console.log('  help - Displays this help message');
		console.log('  reset-captcha - Resets the captcha');
		console.log('  hanami-seed-recent [--days N] [--replay] [--cleanup] - (dev) clone the newest N days of notes/reactions into the present and replay the trend index');
		console.log('  hanami:metrics-rollup --from YYYY-MM-DD [--to YYYY-MM-DD] - recompute inclusive JST dates (max 90; --to defaults to yesterday JST; use --from 14 days ago for 14 days)');
		break;
	}
	case 'ping': {
		const { CommandService } = await import('@/cli/CommandService.js');
		await app.get(CommandService).ping();
		break;
	}
	case 'hanami:metrics-rollup': {
		try {
			const range = await app.get(HanamiMetricsRollupCommandService).run(metricsArgs, metricsNow);
			console.log(`Hanami metrics rolled up: ${range.from} through ${range.to} (${range.days.length} days, JST).`);
		} finally {
			await app.close();
		}
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
		const { CommandService } = await import('@/cli/CommandService.js');
		await app.get(CommandService).resetCaptcha();
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
