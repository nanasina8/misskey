<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<div :class="$style.head">
		<h2 :class="$style.title">{{ t.overview }}</h2>
		<div role="group" :aria-label="t.period" :class="$style.period">
			<button v-for="item in periodItems" :key="item.days" type="button" class="_button" :class="[$style.periodButton, { [$style.current]: days === item.days }]" :aria-pressed="days === item.days" @click="days = item.days">{{ item.label }}</button>
		</div>
	</div>
	<small v-for="notice in coverageNotices" :key="notice" :class="$style.muted">{{ notice }}</small>

	<MkInfo v-if="jobsStatus && jobsStatus.warnings.length > 0" warn>
		<div class="_gaps_s">
			<div v-for="warning in jobsStatus.warnings" :key="warning">{{ j._warning[warning] }}</div>
			<button type="button" class="_textButton" :class="$style.inlineLink" @click="emit('navigate', 'jobs')">{{ o.openJobs }}</button>
		</div>
	</MkInfo>

	<section :class="$style.strip" :aria-label="o.status">
		<button v-for="item in statusItems" :key="item.key" type="button" class="_button" :class="[$style.status, $style[item.tone]]" @click="item.action()">
			<span :class="$style.statusDot" aria-hidden="true"></span>
			<span :class="$style.statusText">
				<span :class="$style.statusLabel">{{ item.label }}</span>
				<strong :class="$style.statusValue">{{ item.value }}<template v-if="item.time"> · <MkTime :key="item.time" :time="item.time" :allowOverrideByUser="false"/></template></strong>
			</span>
		</button>
	</section>

	<p v-if="summaryLoading && !summary" role="status">{{ t.loading }}</p>
	<div v-if="summaryFailed" role="alert" class="_gaps_s"><span>{{ t.error }} — {{ t.overview }}</span><MkButton @click="reloadSummary">{{ t.retry }}</MkButton></div>

	<template v-if="summary">
		<section :class="$style.tiles" :aria-label="o.numbers">
			<button v-for="tile in chartTiles" :key="tile.key" type="button" class="_button _panel" :class="[$style.tile, { [$style.selected]: chartKey === tile.key }]" :aria-pressed="chartKey === tile.key" @click="selectChart(tile.key)">
				<span :class="$style.tileText">
					<span :class="$style.tileLabel">{{ tile.label }}</span>
					<span :class="$style.tileValue"><strong>{{ tile.value }}</strong><span v-if="tile.unit" :class="$style.unit">{{ tile.unit }}</span></span>
					<span :class="$style.tileSub">{{ tile.sub }}</span>
				</span>
				<svg :class="[$style.spark, { [$style.sparkWarn]: tile.warn }]" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true">
					<polyline v-for="(points, index) in tile.spark" :key="index" :points="points"/>
				</svg>
			</button>
			<div class="_panel" :class="$style.tile">
				<span :class="$style.tileText">
					<span :class="$style.tileLabel">{{ j._job.noteJudge }}</span>
					<span :class="$style.tileValue"><strong>{{ fmt(summary.generation.judge.runs) }}</strong><span :class="$style.unit">{{ o.timesUnit }}</span></span>
					<span :class="$style.tileSub">{{ judgeSub }}</span>
				</span>
			</div>
		</section>
		<small :class="$style.muted">{{ o.chartHint }}</small>

		<div :class="$style.main">
			<section ref="chartEl" class="_panel" :class="$style.card" :aria-labelledby="chartTitleId">
				<h3 :id="chartTitleId" :class="$style.cardTitle">{{ chart.label }}</h3>
				<MkHanamiSeriesChart :days="chart.days" :values="chart.values" :label="chart.label" :percent="chart.percent" :warn="chart.warn"/>
			</section>
			<div :class="$style.sideCards">
				<section class="_panel" :class="$style.card" :aria-label="o.funnel">
					<h3 :class="$style.cardTitle">{{ o.funnel }}</h3>
					<div v-for="step in funnel" :key="step.key" :class="$style.funnelStep">
						<div :class="$style.funnelRow"><span>{{ step.label }}</span><strong>{{ step.value }}</strong></div>
						<div :class="$style.funnelTrack" aria-hidden="true"><div :class="$style.funnelBar" :style="{ width: step.width }"></div></div>
					</div>
				</section>
				<section class="_panel" :class="$style.card" :aria-label="o.timings">
					<h3 :class="$style.cardTitle">{{ o.timings }}</h3>
					<table :class="$style.table">
						<thead><tr><th scope="col"><span :class="$style.srOnly">{{ j.jobName }}</span></th><th scope="col">{{ o.typical }}</th><th scope="col">{{ o.slow }}</th></tr></thead>
						<tbody><tr v-for="row in timings" :key="row.key"><th scope="row">{{ row.label }}</th><td>{{ row.p50 }}</td><td>{{ row.p95 }}</td></tr></tbody>
					</table>
				</section>
			</div>
		</div>
	</template>

	<div class="_gaps_s">
		<MkFolder>
			<template #label>{{ t.engagement }}</template>
			<div class="_gaps">
				<MkInfo>{{ t.perTypeEngagement }}</MkInfo>
				<table v-if="summary" :class="$style.table">
					<tbody><tr v-for="metric in engagementKinds" :key="metric.key"><th scope="row">{{ metric.label }}</th><td>{{ display(metric.value) }}</td></tr></tbody>
				</table>
				<p v-if="breakdownLoading" role="status">{{ t.loading }}</p>
				<div v-if="breakdownFailed" role="alert">{{ t.error }} — {{ t.breakdown }}<MkButton @click="reloadBreakdown">{{ t.retry }}</MkButton></div>
				<template v-if="breakdown">
					<strong>{{ t.source }}</strong>
					<MkHanamiShareBars :rows="shareRows"/>
				</template>
			</div>
		</MkFolder>
		<MkFolder>
			<template #label>{{ t.usage }}</template>
			<div v-if="summary" class="_gaps">
				<strong>{{ t.tlShare }}</strong>
				<div :class="$style.tlBand" aria-hidden="true">
					<span v-for="(row, index) in timelineShares" :key="row.key" :style="{ width: shareWidth(row.value) ?? undefined, background: timelineColors[index] }"></span>
				</div>
				<table :class="$style.table">
					<tbody>
						<tr v-for="(row, index) in timelineShares" :key="row.key"><th scope="row"><span :class="$style.swatch" :style="{ background: timelineColors[index] }" aria-hidden="true"></span>{{ row.label }}</th><td>{{ display(row.value, 'percent') }}</td></tr>
						<tr><th scope="row">{{ t.manualRefresh }} / {{ t.users }} / {{ i18n.ts._time.day }}</th><td>{{ display(summary.usage.manualRefreshPerUserDay) }}</td></tr>
						<tr><th scope="row">{{ t.rateLimited }}</th><td>{{ display(summary.usage.rateLimited429) }}</td></tr>
					</tbody>
				</table>
			</div>
			<p v-else>{{ summaryLoading ? t.loading : t.unavailable }}</p>
		</MkFolder>
		<MkFolder>
			<template #label>{{ t.generationErrors }}</template>
			<div class="_gaps">
				<p v-if="errorsLoading" role="status">{{ t.loading }}</p>
				<div v-if="errorsFailed" role="alert">{{ t.error }} — {{ t.generationErrors }}<MkButton @click="reloadErrors">{{ t.retry }}</MkButton></div>
				<template v-if="errors">
					<table :class="$style.table">
						<tbody><tr v-for="(count, kind) in errors.personal.byKind" :key="kind"><th scope="row">{{ failureKindLabel(kind) }}</th><td>{{ display(count) }}</td></tr></tbody>
					</table>
					<div :class="$style.tableScroll" tabindex="0" role="region" :aria-label="t.generationErrors">
						<table :class="[$style.table, $style.errorTable]">
							<thead><tr><th scope="col">{{ t.date }}</th><th scope="col">{{ t.source }}</th><th scope="col">{{ t.failed }}</th><th scope="col">{{ t.attempts }}</th><th scope="col">{{ t.message }}</th><th scope="col">{{ t.userBucket }}</th></tr></thead>
							<tbody><tr v-for="(row, index) in recentErrors" :key="index"><td>{{ row.at }}</td><td>{{ row.source }}</td><td>{{ failureKindLabel(row.kind) }}</td><td>{{ display(row.attempts) }}</td><td :class="$style.message">{{ row.message }}</td><td>{{ row.userBucket ?? t.unavailable }}</td></tr></tbody>
						</table>
					</div>
					<p v-if="recentErrors.length === 0">{{ errors.coverage.status === 'unavailable' ? t.unavailable : t.noData }}</p>
				</template>
			</div>
		</MkFolder>
	</div>

	<section v-if="narrow" class="_gaps_s" :aria-labelledby="tuneTitleId">
		<strong :id="tuneTitleId" :class="$style.muted">{{ t.sectionTune }}</strong>
		<div class="_panel" :class="$style.tuneList">
			<button v-for="item in tuneLinks" :key="item.key" type="button" class="_button" :class="$style.tuneItem" @click="emit('navigate', item.key)">
				<span>{{ item.label }}</span><i class="ti ti-chevron-right" aria-hidden="true"></i>
			</button>
		</div>
	</section>
</div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue';
import type { entities } from 'misskey-js';
import type { Metric, MetricsDays } from '@/scripts/hanami-metrics.js';
import type { HanamiAdminTab, StatusTone } from '@/scripts/hanami-admin-overview.js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkHanamiSeriesChart from '@/components/MkHanamiSeriesChart.vue';
import MkHanamiShareBars from '@/components/MkHanamiShareBars.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { engagementTotal, finiteMetric, formatMetric, partialNotice, failureKindLabel, safeUserBucket, shareWidth, sourceLabel, useMetricsResource } from '@/scripts/hanami-metrics.js';
import { funnelWidth, secondsFromMs, sparklineSegments, topicJudgeTone } from '@/scripts/hanami-admin-overview.js';

const props = defineProps<{
	jobsStatus: entities.AdminHanamiJobsStatusResponse | null;
	narrow: boolean;
}>();

const emit = defineEmits<{
	(ev: 'navigate', tab: HanamiAdminTab): void;
}>();

type ChartKey = 'users' | 'engagement' | 'failures';

const t = i18n.ts._hana._admin;
const o = t._overview;
const j = t._jobs;
const chartTitleId = useId();
const tuneTitleId = useId();
const chartEl = useTemplateRef('chartEl');
const days = ref<MetricsDays>(14);
const periodItems: { days: MetricsDays; label: string }[] = [{ days: 7, label: t.days7 }, { days: 14, label: t.days14 }, { days: 30, label: t.days30 }, { days: 90, label: t.days90 }];
const chartKey = ref<ChartKey>('users');
const params = () => ({ range: { days: days.value } });
const jobLabel = (kind: string) => (({ ...j._job, 'note-judge': j._job.noteJudge, embedding: j._job.tasteTick } as Record<string, string>)[kind] ?? kind);
const { data: summary, loading: summaryLoading, failed: summaryFailed, reload: reloadSummary } = useMetricsResource(params, (p, signal) => misskeyApi('admin/hanami/metrics/summary', p, undefined, signal));
const { data: errors, loading: errorsLoading, failed: errorsFailed, reload: reloadErrors } = useMetricsResource(params, (p, signal) => misskeyApi('admin/hanami/metrics/errors', p, undefined, signal));
const { data: breakdown, loading: breakdownLoading, failed: breakdownFailed, reload: reloadBreakdown } = useMetricsResource(params, (p, signal) => misskeyApi('admin/hanami/metrics/breakdown', { ...p, dimension: 'source' }, undefined, signal));
const fmt = (value: Metric, kind: 'number' | 'percent' = 'number') => formatMetric(value, t.unavailable, kind);
const display = (value: Metric, kind: 'number' | 'percent' = 'number') => fmt(value, kind);
const seconds = (ms: Metric) => {
	const value = secondsFromMs(ms);
	return value == null ? t.unavailable : i18n.tsx._hana._admin._overview.seconds({ seconds: value });
};

const coverageWarnings = computed(() => [summary.value?.coverage, breakdown.value?.coverage, errors.value?.coverage]
	.flatMap(coverage => coverage && (coverage.status !== 'complete' || coverage.unavailable.length > 0) ? [coverage] : []));
// The summary, breakdown and error panels usually share one measurement start, so identical notices are shown once.
const coverageNotices = computed(() => [...new Set(coverageWarnings.value.map(coverage => partialNotice(coverage)))]);

const statusItems = computed(() => {
	const status = props.jobsStatus;
	const gpuOk = status != null && status.gpu.available && status.gpu.device === 'cuda';
	const topic = status?.topicJudge ?? null;
	const items: { key: string; label: string; value: string; time?: string; tone: StatusTone; action: () => void }[] = [
		{
			key: 'gpu', label: j.gpu,
			value: status == null ? t.unavailable : !gpuOk ? j.gpuUnavailable : status.gpu.deviceName ? i18n.tsx._hana._admin._overview.gpuOkWithDevice({ device: status.gpu.deviceName }) : o.gpuOk,
			tone: status == null ? 'neutral' : gpuOk ? 'ok' : 'warn',
			action: () => emit('navigate', 'jobs'),
		},
		{
			key: 'backlog', label: o.noteJudgeBacklog,
			value: status?.noteJudge.backlog == null ? t.unavailable : i18n.tsx._hana._admin._jobs.processed({ count: fmt(status.noteJudge.backlog) }),
			tone: 'neutral',
			action: () => emit('navigate', 'jobs'),
		},
		{
			key: 'topic', label: j._job.topicJudge,
			value: topic ? t._trendTopicJudgeOutcome[topic.outcome] : o.notRecorded,
			time: topic?.at,
			tone: topicJudgeTone(topic?.outcome),
			action: () => emit('navigate', 'jobs'),
		},
		{
			key: 'lock', label: j.lock,
			value: status == null ? t.unavailable : !status.lock.held ? j.lockFree : i18n.tsx._hana._admin._overview.lockHeldBy({ job: status.lock.kind ? jobLabel(status.lock.kind) : j.unknownOwner }),
			tone: status == null ? 'neutral' : status.warnings.includes('lockLong') ? 'warn' : 'neutral',
			action: () => emit('navigate', 'jobs'),
		},
	];
	return items;
});

const chartTiles = computed(() => {
	const s = summary.value;
	if (!s) return [];
	const personal = s.generation.personal;
	const engaged = engagementTotal(s.engagement);
	return [
		{
			key: 'users' as const, label: t.activeUsersDay, value: fmt(s.usage.hanamiUsers.day), unit: o.peopleUnit,
			sub: i18n.tsx._hana._admin._overview.usersSub({ week: fmt(s.usage.hanamiUsers.week), month: fmt(s.usage.hanamiUsers.month) }),
			spark: sparklineSegments(s.series.hanamiUsers, 120, 28), warn: false,
		},
		{
			key: 'engagement' as const, label: t.engagementRate, value: fmt(s.engagement.engagementRate, 'percent'), unit: '',
			sub: i18n.tsx._hana._admin._overview.engagementSub({ served: fmt(s.engagement.served), engaged: fmt(engaged) }),
			spark: sparklineSegments(s.series.engagementRate, 120, 28), warn: false,
		},
		{
			key: 'failures' as const, label: o.personalFailures, value: fmt(personal.failed), unit: o.timesUnit,
			sub: i18n.tsx._hana._admin._overview.failedOf({ total: fmt(personal.batches), rate: fmt(personal.failedRate, 'percent') }),
			spark: sparklineSegments(s.series.failedBatches, 120, 28), warn: finiteMetric(personal.failed) && personal.failed > 0,
		},
	];
});

const judgeSub = computed(() => {
	const judge = summary.value?.generation.judge;
	if (!judge) return '';
	const perNote = finiteMetric(judge.secPerNote) ? judge.secPerNote.toLocaleString(undefined, { maximumFractionDigits: 2 }) : t.unavailable;
	return i18n.tsx._hana._admin._overview.judgeSub({ count: fmt(judge.failed), seconds: perNote });
});

const chart = computed(() => {
	const s = summary.value;
	const days = s?.series.day ?? [];
	switch (chartKey.value) {
		case 'engagement': return { label: t.engagementRate, days, values: s?.series.engagementRate ?? [], percent: true, warn: false };
		case 'failures': return { label: o.personalFailures, days, values: s?.series.failedBatches ?? [], percent: false, warn: true };
		default: return { label: t.activeUsersDay, days, values: s?.series.hanamiUsers ?? [], percent: false, warn: false };
	}
});

async function selectChart(key: ChartKey) {
	chartKey.value = key;
	// In the one-column layout the chart sits below the tiles, so bring it into view.
	if (props.narrow) {
		await nextTick();
		chartEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}
}

const funnel = computed(() => {
	const e = summary.value?.engagement;
	if (!e) return [];
	const engaged = engagementTotal(e);
	return [
		{ key: 'served', label: t.served, value: fmt(e.served), width: funnelWidth(e.served, e.served) },
		{ key: 'seen', label: t.seen, value: finiteMetric(e.seenRate) ? i18n.tsx._hana._admin._overview.countWithRate({ count: fmt(e.seen), rate: fmt(e.seenRate, 'percent') }) : fmt(e.seen), width: funnelWidth(e.seen, e.served) },
		{ key: 'engaged', label: o.engaged, value: finiteMetric(e.engagementRate) ? i18n.tsx._hana._admin._overview.countWithRate({ count: fmt(engaged), rate: fmt(e.engagementRate, 'percent') }) : fmt(engaged), width: funnelWidth(engaged, e.served) },
	];
});

const timings = computed(() => {
	const g = summary.value?.generation;
	if (!g) return [];
	return [
		{ key: 'personal', label: o.personalGeneration, p50: seconds(g.personal.p50Ms), p95: seconds(g.personal.p95Ms) },
		{ key: 'common', label: j._job.generation, p50: seconds(g.common.p50Ms), p95: seconds(g.common.p95Ms) },
		{ key: 'judge', label: j._job.noteJudge, p50: seconds(g.judge.p50Ms), p95: seconds(g.judge.p95Ms) },
	];
});

const engagementKinds = computed(() => {
	const e = summary.value?.engagement;
	return e ? [
		{ key: 'served', label: t.served, value: e.served }, { key: 'seen', label: t.seen, value: e.seen },
		{ key: 'reaction', label: t.reaction, value: e.reaction }, { key: 'reply', label: t.reply, value: e.reply }, { key: 'renote', label: t.renote, value: e.renote },
	] : [];
});

const axisLabel = (key: string) => sourceLabel(key, i18n.ts._hana._recommendation._reason);
const shareRows = computed(() => breakdown.value?.rows.map(row => ({ ...row, label: axisLabel(row.key) })) ?? []);
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

const recentErrors = computed(() => {
	const data = errors.value;
	if (!data) return [];
	return [
		...data.personal.recent.map(row => ({ ...row, source: t.personal, userBucket: safeUserBucket(row.userBucket) })),
		...data.common.recent.map(row => ({ ...row, source: t.common, kind: row.status, attempts: null, userBucket: null })),
		...data.judge.recent.map(row => ({ ...row, source: t.judge, kind: row.status, attempts: null, userBucket: null })),
	].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
});

const tuneLinks = [
	{ key: 'axes' as const, label: t.axes },
	{ key: 'judge' as const, label: t.judge },
	{ key: 'taste' as const, label: t.taste },
];
</script>

<style module lang="scss">
.root {
	container-type: inline-size;
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
}

.head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 16px;
}

.title {
	margin: 0;
	font-size: 1.3em;
}

.period {
	display: flex;
	gap: 2px;
	margin-left: auto;
	padding: 3px;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-buttonBg);
}

.periodButton {
	min-width: 52px;
	min-height: 36px;
	padding: 0 12px;
	border-radius: calc(var(--MI-radius) - 3px);
	font-size: .9em;

	&.current {
		background: var(--MI_THEME-panel);
		color: var(--MI_THEME-accent);
		font-weight: bold;
	}
}

.muted {
	opacity: .75;
}

.inlineLink {
	align-self: flex-start;
}

.strip {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px;

	@container (min-width: 760px) {
		grid-template-columns: repeat(4, minmax(0, 1fr));
	}
}

.status {
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 52px;
	padding: 8px 12px;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
	text-align: start;

	--hanamiStatusColor: var(--MI_THEME-fg);

	&.ok {
		--hanamiStatusColor: var(--MI_THEME-success);
	}

	&.warn {
		--hanamiStatusColor: var(--MI_THEME-warn);
		background: color(from var(--MI_THEME-warn) srgb r g b / 0.12);
	}

	&.neutral .statusDot {
		opacity: .4;
	}
}

.statusDot {
	flex: none;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: var(--hanamiStatusColor);
}

.statusText {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.statusLabel {
	font-size: .8em;
	opacity: .75;
}

.statusValue {
	overflow-wrap: anywhere;
}

.tiles {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 10px;

	@container (min-width: 760px) {
		grid-template-columns: repeat(4, minmax(0, 1fr));
	}

	@container (max-width: 420px) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.tile {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
	padding: 12px 14px;
	border: solid 2px transparent;
	border-radius: var(--MI-radius);
	text-align: start;

	&.selected {
		border-color: var(--MI_THEME-accent);
	}

	// One tile per row on phones: numbers on the left, the sparkline on the right.
	@container (max-width: 420px) {
		flex-direction: row;
		align-items: center;
		gap: 12px;
	}
}

.tileText {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.tileLabel {
	font-size: .8em;
	opacity: .75;
}

.tileValue {
	display: flex;
	align-items: baseline;
	gap: 4px;
	font-size: 1.6em;
}

.unit {
	font-size: .55em;
	opacity: .75;
}

.tileSub {
	font-size: .8em;
	overflow-wrap: anywhere;
}

.spark {
	flex: none;
	width: 100%;
	height: 28px;
	fill: none;
	stroke: var(--MI_THEME-accent);
	stroke-width: 2;

	@container (max-width: 420px) {
		width: 96px;
		height: 36px;
	}

	polyline {
		vector-effect: non-scaling-stroke;
	}
}

.sparkWarn {
	stroke: var(--MI_THEME-warn);
}

.main {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: 12px;

	@container (min-width: 860px) {
		grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr);
	}
}

.sideCards {
	display: flex;
	flex-direction: column;
	gap: 12px;
	min-width: 0;
}

.card {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-width: 0;
	padding: 14px 16px;
	border-radius: var(--MI-radius);
}

.cardTitle {
	margin: 0;
	font-size: 1em;
}

.funnelStep {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.funnelRow {
	display: flex;
	justify-content: space-between;
	gap: 8px;
	font-size: .9em;
}

.funnelTrack {
	height: 8px;
	border-radius: 4px;
	background: var(--MI_THEME-buttonBg);
}

.funnelBar {
	height: 8px;
	min-width: 2px;
	border-radius: 4px;
	background: var(--MI_THEME-accent);
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: .9em;

	th, td {
		padding: 6px 4px;
		border-top: solid 1px var(--MI_THEME-divider);
		text-align: end;
	}

	th:first-child {
		text-align: start;
		font-weight: normal;
	}

	thead th {
		border-top: none;
		font-weight: normal;
		opacity: .75;
	}
}

.errorTable {
	th, td {
		text-align: start;
	}
}

.tableScroll {
	max-width: 100%;
	overflow-x: auto;
}

.message {
	min-width: 180px;
	max-width: 320px;
	overflow-wrap: anywhere;
	white-space: pre-wrap;
}

.tlBand {
	display: flex;
	height: 18px;
	border-radius: 6px;
	overflow: hidden;
	background: var(--MI_THEME-buttonBg);

	> span {
		flex: 0 0 auto;
	}
}

.swatch {
	display: inline-block;
	width: 10px;
	height: 10px;
	margin-right: 6px;
	border-radius: 2px;
}

.tuneList {
	display: flex;
	flex-direction: column;
	border-radius: var(--MI-radius);
}

.tuneItem {
	display: flex;
	align-items: center;
	justify-content: space-between;
	min-height: 48px;
	padding: 0 14px;

	& + & {
		border-top: solid 1px var(--MI_THEME-divider);
	}
}

.srOnly {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}
</style>
