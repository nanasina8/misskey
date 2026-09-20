/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type HanamiMetricsFailureKind = 'emptyResult' | 'candidateLimit' | 'lockTimeout' | 'exception' | 'unknown';

export type HanamiMetricsFailure = {
	readonly failureKind: Exclude<HanamiMetricsFailureKind, 'unknown'>;
	readonly failureMessage: string;
};

const SAFE_MESSAGES = {
	emptyResult: 'produced an empty result',
	candidateLimit: 'candidate limit exceeded',
	lockTimeout: 'generation lock, lease or deadline timed out',
	exception: 'generation failed with an exception',
} satisfies Record<HanamiMetricsFailure['failureKind'], string>;

/**
 * Only classify diagnostics; this must never decide whether a claim is failed.
 * Canonical messages deliberately discard ALL exception text, not just known ID
 * patterns: SQL parameters, arbitrary identifiers and note text are not metrics.
 */
export function classifyHanamiMetricsFailure(error: unknown): HanamiMetricsFailure {
	const diagnostic = error != null && typeof error === 'object'
		? error as { message?: unknown; code?: unknown; driverError?: { message?: unknown; code?: unknown } }
		: undefined;
	const message = typeof diagnostic?.message === 'string' ? diagnostic.message : '';
	// TypeORM QueryFailedError carries the original PostgreSQL diagnostic here.
	const pg = diagnostic?.driverError ?? diagnostic;
	const pgMessage = typeof pg?.message === 'string' ? pg.message : '';
	let failureKind: HanamiMetricsFailure['failureKind'] = 'exception';
	if (message.includes('produced an empty result')) {
		failureKind = 'emptyResult';
	} else if (error instanceof RangeError && /\bexceed(?:ed|s)\b/i.test(message)) {
		failureKind = 'candidateLimit';
	} else if ((pg?.code === '55P03' && /\block timeout\b/i.test(pgMessage))
		|| (pg?.code === '57014' && /\bstatement timeout\b/i.test(pgMessage))
		|| /^Hanami user feed generation .+ exceeded its worker timeout$/.test(message)
		|| message === 'Hanami personal-generation database deadline expired'
		|| message === 'Hanami user feed generation lease is no longer current') {
		failureKind = 'lockTimeout';
	}
	return { failureKind, failureMessage: SAFE_MESSAGES[failureKind].slice(0, 512) };
}
