/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { Endpoints } from 'misskey-js';

export type Metric = number | null;
export type MetricsSummary = Endpoints['admin/hanami/metrics/summary']['res'];
export type MetricsErrors = Endpoints['admin/hanami/metrics/errors']['res'];
export type MetricsBreakdown = Endpoints['admin/hanami/metrics/breakdown']['res'];
export type MetricsDimension = Endpoints['admin/hanami/metrics/breakdown']['req']['dimension'];
export type MetricsRange = NonNullable<Endpoints['admin/hanami/metrics/summary']['req']['range']>;
export type MetricsDays = 7 | 14 | 30 | 90;
export const metricsDimensions = ['source', 'contentType', 'relationshipClass', 'media', 'freshness', 'authorLocality', 'trendTerm', 'cluster'] as const satisfies readonly MetricsDimension[];

export type MetricsOpportunities = Endpoints['admin/hanami/metrics/opportunities']['res'];
export type MetricsNotes = Endpoints['admin/hanami/metrics/notes']['res'];

export function finiteMetric(value: number | null | undefined): value is number {
	return value != null && Number.isFinite(value);
}
export function metricRatio(numerator: Metric, denominator: Metric): Metric {
	return !finiteMetric(numerator) || !finiteMetric(denominator) || denominator <= 0 ? null : numerator / denominator;
}
/** Approved per-type distinct sum: reaction + reply on one served note counts as 2. */
export function engagementTotal(counts: { reaction: Metric; reply: Metric; renote: Metric }): Metric {
	return sumMetrics([counts.reaction, counts.reply, counts.renote]);
}
export function sumMetrics(values: readonly Metric[]): Metric {
	return values.every(finiteMetric) ? values.reduce((sum, value) => sum + value, 0) : null;
}
export function metricDifference(current: Metric, previous: Metric): Metric {
	return finiteMetric(current) && finiteMetric(previous) ? current - previous : null;
}
export function isMetricSuppressed(path: string, suppressed: readonly string[]): boolean {
	return suppressed.some(key => path === key || path.startsWith(`${key}.`));
}
export function formatMetric(value: Metric | undefined, unavailable: string, kind: 'number' | 'percent' | 'ratio' = 'number'): string {
	if (!finiteMetric(value)) return unavailable;
	if (kind === 'percent') return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
	return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${kind === 'ratio' ? '×' : ''}`;
}
/** Clamp only geometry, never the displayed metric (engagement rates may exceed 100%). */
export function shareWidth(value: Metric): string | null {
	return finiteMetric(value) ? `${Math.max(0, Math.min(1, value)) * 100}%` : null;
}
export function seriesValues(days: readonly string[], values: readonly Metric[], percent = false): Metric[] {
	return days.map((_, index) => {
		const value = values[index];
		return finiteMetric(value) ? value * (percent ? 100 : 1) : null;
	});
}
export function safeUserBucket(value: string): string | null {
	return /^u#[0-9a-f]{4}$/.test(value) ? value : null;
}

type SourceReasons = Record<'popular' | 'globalPopular' | 'exploration' | 'neighborTrending' | 'reactionSimilar' | 'catchup' | 'trending' | 'fof', string>;
export function sourceLabel(key: string, reasons: SourceReasons): string {
	// Never index locale objects with server-provided keys (including trend terms).
	switch (key) {
		case 'popular': return reasons.popular;
		case 'globalPopular': return reasons.globalPopular;
		case 'exploration': return reasons.exploration;
		case 'neighborTrending': return reasons.neighborTrending;
		case 'reactionSimilar': return reasons.reactionSimilar;
		case 'catchup': return reasons.catchup;
		case 'trending': return reasons.trending;
		case 'fof': return reasons.fof;
		default: return key;
	}
}

/** Each panel fails independently; late responses cannot overwrite a newer selection. */
export function useMetricsResource<P, T>(parameters: () => P, fetcher: (params: P, signal: AbortSignal) => Promise<T>) {
	const data = shallowRef<T | null>(null);
	const loading = ref(false);
	const failed = ref(false);
	let version = 0;
	let controller: AbortController | undefined;

	async function reload() {
		const requestVersion = ++version;
		controller?.abort();
		controller = new AbortController();
		data.value = null;
		loading.value = true;
		failed.value = false;
		try {
			const result = await fetcher(parameters(), controller.signal);
			if (requestVersion === version) data.value = result;
		} catch {
			if (requestVersion === version) failed.value = true;
		} finally {
			if (requestVersion === version) loading.value = false;
		}
	}

	watch(parameters, reload, { immediate: true, deep: true });
	onScopeDispose(() => { version++; controller?.abort(); });
	return { data, loading, failed, reload };
}
