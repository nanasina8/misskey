<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- The owning hanami container supplies the 700px _spacer. -->
<div class="_gaps">
	<MkSelect v-model="days" :items="periodItems">
		<template #label>{{ t.period }}</template>
	</MkSelect>
	<p v-if="summaryLoading" role="status">{{ t.loading }}</p>
	<div v-if="summaryFailed" role="alert" class="_gaps_s"><span>{{ t.error }} — {{ t.overview }}</span><MkButton @click="reloadSummary">{{ t.retry }}</MkButton></div>
	<template v-if="summary">
		<div :class="$style.stats">
			<div v-for="card in cards" :key="card.path" class="_panel" :class="$style.card">
				<i :class="['ti', card.icon, $style.icon]"></i>
				<div><div :class="$style.value">
					<template v-if="finiteMetric(card.value)">
						<span v-if="card.percent">{{ display(card.value, card.path, 'percent') }}</span>
						<MkNumber v-else :value="card.value"/>
						<MkNumberDiff v-if="card.diff !== null" v-tooltip="i18n.ts.dayOverDayChanges" :value="card.diff" :class="$style.diff"/>
					</template>
					<span v-else>{{ display(card.value, card.path) }}</span>
				</div><div :class="$style.label">{{ card.label }}</div></div>
			</div>
		</div>
		<small>{{ summary.range.from }} — {{ summary.range.to }}</small>
	</template>
	<MkInfo v-for="entry in coverageWarnings" :key="entry.name" warn>
		{{ entry.name }}: {{ entry.coverage.status === 'unavailable' ? t.unavailable : t.partialData }}
		<div v-if="entry.coverage.unavailable.length">{{ entry.coverage.unavailable.join(', ') }}</div>
		<small>retainedFrom: {{ entry.coverage.retainedFrom }} · outcomesThrough: {{ entry.coverage.outcomesThrough }}</small>
	</MkInfo>
	<MkInfo v-if="summary?.suppressed.length" warn>{{ t.suppressedFewUsers }}: {{ summary.suppressed.join(', ') }}</MkInfo>
	<MkFolder :defaultOpen="true">
		<template #label>{{ t.usage }}</template>
		<div v-if="summary" class="_gaps">
			<MkHanamiSeriesChart :days="summary.series.day" :values="summary.series.hanamiUsers" :label="t.activeUsersDay"/>
			<h3>{{ t.tlShare }}</h3>
			<div :class="$style.tlBand" aria-hidden="true">
				<span v-for="(row, index) in timelineShares" :key="row.key" :style="{ width: shareWidth(row.value) ?? undefined, background: timelineColors[index] }"></span>
			</div>
			<div :class="$style.chips">
				<span v-for="row in timelineShares" :key="row.key" :class="$style.chip">{{ row.label }}: {{ display(row.value, `usage.tlShare.${row.key}`, 'percent') }}</span>
			</div>
			<div>{{ t.manualRefresh }} / {{ t.users }} / {{ i18n.ts._time.day }}: {{ display(summary.usage.manualRefreshPerUserDay, 'usage.manualRefreshPerUserDay') }}</div>
			<div>{{ t.rateLimited }} (429): {{ display(summary.usage.rateLimited429, 'usage.rateLimited429') }}</div>
		</div>
		<p v-else>{{ summaryLoading ? t.loading : t.unavailable }}</p>
	</MkFolder>
	<MkFolder :defaultOpen="true">
		<template #label>{{ t.engagement }}</template>
		<div class="_gaps">
			<MkInfo>{{ t.perTypeEngagement }}</MkInfo>
			<template v-if="summary">
				<MkHanamiSeriesChart :days="summary.series.day" :values="summary.series.engagementRate" :label="t.engagementRate" percent/>
				<div :class="$style.chips"><span v-for="metric in engagementMetrics" :key="metric.key" :class="$style.chip">{{ metric.label }}: {{ display(metric.value, `engagement.${metric.key}`) }}</span></div>
			</template>
			<p v-if="breakdownLoading" role="status">{{ t.loading }}</p>
			<div v-if="breakdownFailed" role="alert">{{ t.error }} — {{ t.breakdown }}<MkButton @click="reloadBreakdown">{{ t.retry }}</MkButton></div>
			<MkHanamiShareBars v-if="breakdown" :rows="shareRows" :suppressed="breakdown.suppressed" :labelForKey="axisLabel"/>
		</div>
	</MkFolder>
	<MkFolder :defaultOpen="true">
		<template #label>{{ t.generationErrors }}</template>
		<div class="_gaps">
			<MkHanamiSeriesChart v-if="errors" :days="errors.personal.byDay.map(row => row.day)" :values="errors.personal.byDay.map(row => row.failed)" :label="`${t.generationErrors} (personal)`"/>
			<p v-if="errorsLoading" role="status">{{ t.loading }}</p>
			<div v-if="errorsFailed" role="alert">{{ t.error }} — {{ t.generationErrors }}<MkButton @click="reloadErrors">{{ t.retry }}</MkButton></div>
			<template v-if="errors">
				<MkInfo v-if="errors.suppressed.length" warn>{{ t.suppressedFewUsers }}: {{ errors.suppressed.join(', ') }}</MkInfo>
				<div :class="$style.chips"><span v-for="(count, kind) in errors.personal.byKind" :key="kind" :class="$style.chip">{{ kind }}: {{ errorCount(count, kind) }}</span></div>
				<div class="_panel" :class="$style.tableScroll">
					<table :class="$style.table">
						<thead><tr><th>{{ t.date }}</th><th>{{ t.source }}</th><th>{{ t.failed }}</th><th>{{ t.attempts }}</th><th>{{ t.message }}</th><th>{{ t.userBucket }}</th></tr></thead>
						<tbody><tr v-for="(row, index) in recentErrors" :key="index"><td>{{ row.at }}</td><td>{{ row.source }}</td><td>{{ row.kind }}</td><td>{{ fmt(row.attempts) }}</td><td :class="$style.message">{{ row.message }}</td><td>{{ row.userBucket ?? t.unavailable }}</td></tr></tbody>
					</table>
				</div>
				<p v-if="recentErrors.length === 0">{{ errors.coverage.status === 'unavailable' ? t.unavailable : errors.suppressed.includes('personal.recent') ? t.suppressedFewUsers : t.noData }}</p>
			</template>
		</div>
	</MkFolder>
</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Metric, MetricsDays } from '@/scripts/hanami-metrics.js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkNumber from '@/components/MkNumber.vue';
import MkNumberDiff from '@/components/MkNumberDiff.vue';
import MkHanamiSeriesChart from '@/components/MkHanamiSeriesChart.vue';
import MkHanamiShareBars from '@/components/MkHanamiShareBars.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { finiteMetric, formatMetric, isMetricSuppressed, metricDifference, safeUserBucket, shareWidth, sourceLabel, sumMetrics, useMetricsResource } from '@/scripts/hanami-metrics.js';

const t = i18n.ts._hana._admin;
const days = ref<MetricsDays>(30);
const periodItems = [{ value: 7, label: t.days7 }, { value: 30, label: t.days30 }, { value: 90, label: t.days90 }];
const params = () => ({ range: { days: days.value } });
const { data: summary, loading: summaryLoading, failed: summaryFailed, reload: reloadSummary } = useMetricsResource(params, (p, signal) => misskeyApi('admin/hanami/metrics/summary', p, undefined, signal));
const { data: errors, loading: errorsLoading, failed: errorsFailed, reload: reloadErrors } = useMetricsResource(params, (p, signal) => misskeyApi('admin/hanami/metrics/errors', p, undefined, signal));
const { data: breakdown, loading: breakdownLoading, failed: breakdownFailed, reload: reloadBreakdown } = useMetricsResource(params, (p, signal) => misskeyApi('admin/hanami/metrics/breakdown', { ...p, dimension: 'source' }, undefined, signal));
const fmt = (value: Metric, kind: 'number' | 'percent' = 'number') => formatMetric(value, t.unavailable, kind);
const display = (value: Metric, path: string, kind: 'number' | 'percent' = 'number') => value === null && isMetricSuppressed(path, summary.value?.suppressed ?? []) ? t.suppressedFewUsers : fmt(value, kind);
const axisLabel = (key: string) => sourceLabel(key, i18n.ts._hana._recommendation._reason);
const shareRows = computed(() => breakdown.value?.rows.map(row => ({ ...row, label: axisLabel(row.key) })) ?? []);
const cards = computed(() => {
	const s = summary.value;
	if (!s) return [];
	return [
		{ label: t.activeUsersDay, path: 'usage.hanamiUsers.day', value: s.usage.hanamiUsers.day, icon: 'ti-users', diff: metricDifference(s.usage.hanamiUsers.day, s.series.hanamiUsers.at(-2) ?? null), percent: false },
		{ label: t.activeUsersWeek, path: 'usage.hanamiUsers.week', value: s.usage.hanamiUsers.week, icon: 'ti-users-group', diff: null, percent: false },
		{ label: t.engagementRate, path: 'engagement.engagementRate', value: s.engagement.engagementRate, icon: 'ti-heart', diff: null, percent: true },
		{ label: t.generationErrors, path: 'generation.personal.failed', value: sumMetrics([s.generation.personal.failed, s.generation.common.failed, s.generation.judge.failed]), icon: 'ti-alert-triangle', diff: null, percent: false },
	];
});
const coverageWarnings = computed(() => [
	{ name: t.overview, coverage: summary.value?.coverage },
	{ name: t.breakdown, coverage: breakdown.value?.coverage },
	{ name: t.generationErrors, coverage: errors.value?.coverage },
].flatMap(entry => entry.coverage && (entry.coverage.status !== 'complete' || entry.coverage.unavailable.length > 0) ? [{ name: entry.name, coverage: entry.coverage }] : []));
const timelineColors = ['#888', '#58a65c', '#548cc5', '#a582c9', 'var(--MI_THEME-accent)'];
const timelineShares = computed(() => {
	const shares = summary.value?.usage.tlShare;
	return shares ? [
		{ key: 'home', label: i18n.ts._timelines.home, value: shares.home },
		{ key: 'local', label: i18n.ts._timelines.local, value: shares.local },
		{ key: 'social', label: i18n.ts._timelines.social, value: shares.social },
		{ key: 'global', label: i18n.ts._timelines.global, value: shares.global },
		{ key: 'hanami', label: i18n.ts._hana.hanamiTimeline, value: shares.hanami },
	] : [];
});
const engagementMetrics = computed(() => {
	const engagement = summary.value?.engagement;
	return engagement ? [
		{ key: 'served', label: t.served, value: engagement.served }, { key: 'seen', label: t.seen, value: engagement.seen },
		{ key: 'reaction', label: t.reaction, value: engagement.reaction }, { key: 'reply', label: t.reply, value: engagement.reply }, { key: 'renote', label: t.renote, value: engagement.renote },
	] : [];
});

function errorCount(value: Metric, kind: string) {
	const suppressed = errors.value?.suppressed ?? [];
	return value === null && (isMetricSuppressed(`generation.personal.failedByKind.${kind}`, suppressed) || isMetricSuppressed(`personal.byKind.${kind}`, suppressed)) ? t.suppressedFewUsers : fmt(value);
}

const recentErrors = computed(() => {
	const data = errors.value;
	if (!data) return [];
	return [
		...data.personal.recent.map(row => ({ ...row, source: 'personal', userBucket: safeUserBucket(row.userBucket) })),
		...data.common.recent.map(row => ({ ...row, source: 'common', kind: row.status, attempts: null, userBucket: null })),
		...data.judge.recent.map(row => ({ ...row, source: t.judge, kind: row.status, attempts: null, userBucket: null })),
	].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
});
</script>

<style module lang="scss">
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.card { display: flex; align-items: center; gap: 12px; padding: 16px; }
.icon { padding: 12px; border-radius: 10px; background: var(--MI_THEME-accentedBg); color: var(--MI_THEME-accent); }
.value { font-size: 1.2em; font-weight: bold; }
.diff { margin-left: .5em; font-size: .65em; font-weight: normal; }
.label { font-size: .8em; opacity: .7; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 6px 10px; border-radius: 8px; background: var(--MI_THEME-buttonBg); overflow-wrap: anywhere; }
.tlBand { display: flex; height: 18px; border-radius: 6px; overflow: hidden; background: var(--MI_THEME-buttonBg); > span { flex: 0 0 auto; } }
.tableScroll { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; font-size: .85em; th, td { padding: 10px; text-align: left; border-bottom: 1px solid var(--MI_THEME-divider); } }
.message { min-width: 180px; max-width: 320px; overflow-wrap: anywhere; white-space: pre-wrap; }
</style>
