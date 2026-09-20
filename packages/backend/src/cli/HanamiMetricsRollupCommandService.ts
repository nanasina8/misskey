/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type HanamiMetricsRollupRange = {
	from: string;
	to: string;
	days: readonly string[];
};

type RollupDayService = {
	rollupDay(day: string, options: { recompute: boolean }): Promise<unknown>;
};

function parseDay(value: string, option: string): number {
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')
		|| !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
		throw new Error(`${option} must be a valid YYYY-MM-DD date`);
	}
	return timestamp;
}

/** Pure parser: no config, Nest context, database, or Redis startup on import.
 * --from is required; --to defaults to yesterday in JST. Both bounds are inclusive.
 * For a 14-day backfill, pass --from <today in JST minus 14 days>.
 */
export function parseHanamiMetricsRollupArgs(args: readonly string[], now: Date = new Date()): HanamiMetricsRollupRange {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const option = args[i];
		if (option !== '--from' && option !== '--to') throw new Error(`Unknown option: ${option}`);
		if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
		const value = args[i + 1];
		if (value == null || value.startsWith('--')) throw new Error(`${option} requires a YYYY-MM-DD date`);
		values.set(option, value);
	}

	const from = values.get('--from');
	if (from == null) throw new Error('--from is required (YYYY-MM-DD)');
	const to = values.get('--to') ?? new Date(now.getTime() + JST_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
	const start = parseDay(from, '--from');
	const end = parseDay(to, '--to');
	if (end < start) throw new Error('--to must not be before --from');
	const count = (end - start) / DAY_MS + 1;
	if (count > 90) throw new Error('Date range must not exceed 90 days (inclusive)');

	// UTC arithmetic is used only to enumerate calendar labels; rollupDay interprets them as JST days.
	const days = Array.from({ length: count }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
	return { from, to, days };
}

// Factory-provided by CommandModule so importing the parser never loads the core service graph.
export class HanamiMetricsRollupCommandService {
	constructor(
		private hanamiMetricsRollupService: RollupDayService,
	) {}

	public async run(args: readonly string[], now: Date = new Date()): Promise<HanamiMetricsRollupRange> {
		const range = parseHanamiMetricsRollupArgs(args, now);
		for (const day of range.days) {
			await this.hanamiMetricsRollupService.rollupDay(day, { recompute: true });
		}
		return range;
	}
}
