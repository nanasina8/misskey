/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { entities } from 'misskey-js';
import type { Metric } from '@/scripts/hanami-metrics.js';
import { finiteMetric } from '@/scripts/hanami-metrics.js';

export type HanamiAdminTab = 'overview' | 'stats' | 'axes' | 'judge' | 'jobs' | 'trends' | 'taste';
export type StatusTone = 'ok' | 'warn' | 'neutral';
type TopicJudgeOutcome = NonNullable<entities.AdminHanamiJobsStatusResponse['topicJudge']>['outcome'];

/** `2026-10-16` → `10/16`, so chart axes stay horizontal. */
export function shortDay(day: string): string {
	const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
	return match ? `${Number(match[1])}/${Number(match[2])}` : day;
}

/**
 * Polyline segments for a sparkline. Missing values split the line instead of being drawn as zero,
 * and a single point becomes a short flat segment so it stays visible.
 */
export function sparklineSegments(values: readonly Metric[], width: number, height: number): string[] {
	const finite = values.filter(finiteMetric);
	if (finite.length === 0) return [];
	const max = Math.max(...finite);
	const min = Math.min(0, ...finite);
	const span = max - min || 1;
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	const segments: string[][] = [];
	let current: string[] = [];
	values.forEach((value, index) => {
		if (!finiteMetric(value)) {
			if (current.length > 0) segments.push(current);
			current = [];
			return;
		}
		const x = (index * step).toFixed(1);
		const y = (height - 2 - (value - min) / span * (height - 4)).toFixed(1);
		current.push(`${x},${y}`);
	});
	if (current.length > 0) segments.push(current);
	return segments.map(points => {
		if (points.length > 1) return points.join(' ');
		// Extend a lone point by 2 units, leftwards at the right edge so it stays inside the viewBox.
		const [x, y] = points[0].split(',');
		const start = Math.min(Number(x), width - 2);
		return `${start.toFixed(1)},${y} ${(start + 2).toFixed(1)},${y}`;
	});
}

export function topicJudgeTone(outcome: TopicJudgeOutcome | null | undefined): StatusTone {
	if (outcome == null) return 'neutral';
	return outcome === 'ok' || outcome === 'partial' || outcome === 'nothingToDo' ? 'ok' : outcome === 'waiting' ? 'neutral' : 'warn';
}

/** Milliseconds to seconds with one decimal, or null when the metric is missing. */
export function secondsFromMs(ms: Metric): string | null {
	return finiteMetric(ms) ? (ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) : null;
}

/** Bar width for the served → seen → engaged funnel, relative to the first step. */
export function funnelWidth(value: Metric, base: Metric): string {
	if (!finiteMetric(value) || !finiteMetric(base) || base <= 0) return '0%';
	return `${Math.max(0, Math.min(1, value / base)) * 100}%`;
}
