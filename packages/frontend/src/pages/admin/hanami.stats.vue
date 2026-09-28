<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- The owning hanami container supplies the 700px _spacer. -->
<div class="_gaps">
	<MkFolder :defaultOpen="true">
		<template #label>{{ t.breakdown }}</template>
		<div class="_gaps">
			<div :class="$style.selectors">
				<MkSelect v-model="dimension" :items="dimensionItems"><template #label>{{ t.dimension }}</template></MkSelect>
				<MkSelect v-model="filterKey" :items="filterItems" :disabled="filterLoading || filterFailed"><template #label>{{ t.filter }} ({{ dimensionLabels[filterDimension] }})</template></MkSelect>
				<MkSelect v-model="days" :items="periodItems"><template #label>{{ t.period }}</template></MkSelect>
			</div>
			<div v-if="filterFailed" role="alert">{{ t.error }} — {{ t.filter }}<MkButton @click="reloadFilter">{{ t.retry }}</MkButton></div>
			<MkInfo>{{ t.perTypeEngagement }}</MkInfo>
			<p v-if="breakdownLoading" role="status">{{ t.loading }}</p>
			<div v-if="breakdownFailed" role="alert">{{ t.error }}<MkButton @click="reloadBreakdown">{{ t.retry }}</MkButton></div>
			<template v-if="breakdown">
				<small>{{ breakdown.range.from }} — {{ breakdown.range.to }}</small>
				<MkInfo v-if="breakdown.coverage.status !== 'complete' || breakdown.coverage.unavailable.length" warn>{{ partialNotice(breakdown.coverage) }}</MkInfo>
				<MkHanamiShareBars :rows="shareRows"/>
				<div class="_panel" :class="$style.tableScroll">
					<table :class="$style.table">
						<thead><tr><th>{{ dimensionLabels[dimension] }}</th><th>{{ t.served }}</th><th>{{ t.share }}</th><th>{{ t.engagementShare }}</th><th>{{ t.engagementRate }}</th><th>{{ t.lift }}</th><th>{{ t.users }}</th><th>{{ t.topReactedNotes }}</th></tr></thead>
						<tbody>
							<tr v-for="row in breakdown.rows" :key="row.key">
								<th scope="row">{{ rowLabel(row.key) }}</th><td><span v-tooltip="row.served == null ? t.noValueYet : undefined">{{ fmt(row.served) }}</span></td><td><span v-tooltip="row.share == null ? t.noValueYet : undefined">{{ fmt(row.share, 'percent') }}</span></td><td><span v-tooltip="row.engagementShare == null ? t.noValueYet : undefined">{{ fmt(row.engagementShare, 'percent') }}</span></td><td><span v-tooltip="row.engagementRate == null ? t.noValueYet : undefined">{{ fmt(row.engagementRate, 'percent') }}</span></td><td><span v-tooltip="row.lift == null ? t.noValueYet : undefined">{{ fmt(row.lift, 'ratio') }}</span></td><td><span v-tooltip="row.users == null ? t.noValueYet : undefined">{{ fmt(row.users) }}</span></td>
								<td><button type="button" class="_textButton" @click="selectNotes(row.key)">{{ t.topReactedNotes }}</button></td>
							</tr>
						</tbody>
					</table>
				</div>
			</template>
		</div>
	</MkFolder>
	<MkFolder :defaultOpen="true">
		<template #label>{{ t.opportunities }}</template>
		<div class="_gaps">
			<p v-if="opportunitiesLoading" role="status">{{ t.loading }}</p>
			<div v-if="opportunitiesFailed" role="alert">{{ t.error }}<MkButton @click="reloadOpportunities">{{ t.retry }}</MkButton></div>
			<template v-if="opportunities">
				<MkInfo v-if="opportunities.unavailable.length" warn>{{ partialNotice() }}</MkInfo>
				<section v-for="panel in opportunityPanels" :key="panel.key" class="_gaps_s">
					<h3>{{ panel.label }}</h3>
					<div v-if="panel.rows.length" class="_panel" :class="$style.tableScroll">
						<table :class="$style.table">
							<thead><tr><th v-for="(heading, index) in panel.headings" :key="index">{{ heading }}</th></tr></thead>
							<tbody><tr v-for="(row, index) in panel.rows" :key="index"><td v-for="(cell, cellIndex) in row" :key="cellIndex"><span v-tooltip="cell.includes(t.unavailable) ? t.noValueYet : undefined" :class="cellIndex === panel.badgeColumn ? $style.badge : undefined">{{ cell }}</span></td></tr></tbody>
						</table>
					</div>
					<p v-else v-tooltip="panelEmpty(panel.key) === t.unavailable ? t.noValueYet : undefined">{{ panelEmpty(panel.key) }}</p>
				</section>
			</template>
		</div>
	</MkFolder>
	<section ref="notesSection" tabindex="-1">
		<MkFolder :defaultOpen="true">
			<template #label>{{ t.topReactedNotes }}</template>
			<div class="_gaps">
				<MkSelect v-model="notesDays" :items="notesPeriodItems"><template #label>{{ t.topReactedNotes }} — {{ t.period }}</template></MkSelect>
				<MkInfo v-if="notesDays !== days" warn>{{ t.partialData }} — {{ t.topReactedNotes }}: {{ notesPeriodLabel }}</MkInfo>
				<div>{{ t.filter }}: {{ noteKey === null ? t.all : `${dimensionLabels[dimension]} / ${rowLabel(noteKey)}` }}</div>
				<MkButton v-if="noteKey !== null" @click="noteKey = null">{{ t.all }}</MkButton>
				<p v-if="notesLoading" role="status">{{ t.loading }}</p>
				<div v-if="notesFailed" role="alert">{{ t.error }}<MkButton @click="reloadNotes">{{ t.retry }}</MkButton></div>
				<template v-if="notes">
					<small>{{ t.topReactedNotes }} — {{ notes.range.from }} — {{ notes.range.to }}</small>
					<MkInfo v-if="notes.unavailable.length" warn>{{ partialNotice() }}</MkInfo>
					<article v-for="note in notes.notes" :key="note.noteId" class="_panel" :class="$style.note">
						<p :class="$style.snippet">{{ note.text.slice(0, 160) }}</p>
						<div :class="$style.metadata">{{ axisLabel(note.source) }} · {{ t.authorLocality }}: {{ dimensionValueLabel('authorLocality', note.authorLocality) }} · {{ t.contentType }}: <span v-tooltip="note.contentType === null ? t.noValueYet : undefined">{{ dimensionValueLabel('contentType', note.contentType) }}</span></div>
						<div :class="$style.metadata">{{ t.served }}: <span v-tooltip="note.served == null ? t.noValueYet : undefined">{{ fmt(note.served) }}</span> · {{ t.reaction }}: <span v-tooltip="note.reaction == null ? t.noValueYet : undefined">{{ fmt(note.reaction) }}</span> · {{ t.reply }}: <span v-tooltip="note.reply == null ? t.noValueYet : undefined">{{ fmt(note.reply) }}</span> · {{ t.renote }}: <span v-tooltip="note.renote == null ? t.noValueYet : undefined">{{ fmt(note.renote) }}</span> · {{ t.engagementRate }}: <span v-tooltip="note.engagementRate == null ? t.noValueYet : undefined">{{ fmt(note.engagementRate, 'percent') }}</span></div>
					</article>
					<p v-if="notes.notes.length === 0" v-tooltip="notes.unavailable.length ? t.noValueYet : undefined">{{ notes.unavailable.length ? t.unavailable : t.noData }}</p>
				</template>
			</div>
		</MkFolder>
	</section>
</div>
</template>

<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';
import type { Metric, MetricsDays, MetricsDimension, MetricsOpportunities } from '@/scripts/hanami-metrics.js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkHanamiShareBars from '@/components/MkHanamiShareBars.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { formatMetric, partialNotice, dimensionValueLabel, metricsDimensions, sourceLabel, useMetricsResource } from '@/scripts/hanami-metrics.js';

const t = i18n.ts._hana._admin;
const days = ref<MetricsDays>(30);
// Raw-note queries support at most 30 days, independently of the aggregate range.
const notesDays = ref<7 | 14 | 30>(30);
const dimension = ref<MetricsDimension>('source');
const filterKey = ref('');
const noteKey = ref<string | null>(null);
const notesSection = useTemplateRef('notesSection');
const dimensionLabels: Record<MetricsDimension, string> = {
	source: t.source, contentType: t.contentType, relationshipClass: t.relationshipClass, media: t.media,
	freshness: t.freshness, authorLocality: t.authorLocality, trendTerm: t.trendTerm, cluster: t.cluster,
};
const dimensionItems = metricsDimensions.map(value => ({ value, label: dimensionLabels[value] }));
const periodItems = [{ value: 7, label: t.days7 }, { value: 14, label: t.days14 }, { value: 30, label: t.days30 }, { value: 90, label: t.days90 }];
const notesPeriodItems = [{ value: 7, label: t.days7 }, { value: 14, label: t.days14 }, { value: 30, label: t.days30 }];
const notesPeriodLabel = computed(() => notesDays.value === 7 ? t.days7 : notesDays.value === 14 ? t.days14 : t.days30);
const filterDimension = computed<MetricsDimension>(() => dimension.value === 'source' ? 'media' : 'source');
const axisLabel = (key: string) => sourceLabel(key, i18n.ts._hana._recommendation._reason);
const rowLabel = (key: string) => dimensionValueLabel(dimension.value, key);
const fmt = (value: Metric | undefined, kind: 'number' | 'percent' | 'ratio' = 'number') => formatMetric(value, t.unavailable, kind);

// Never send a same-dimension filter or retain a stale row selection after changing scope.
watch([dimension, days], () => { filterKey.value = ''; noteKey.value = null; }, { flush: 'sync' });
watch(days, value => { notesDays.value = value === 90 ? 30 : value; }, { flush: 'sync' });
watch(filterKey, () => { noteKey.value = null; }, { flush: 'sync' });
const rangeParams = () => ({ range: { days: days.value } });
const { data: filterData, loading: filterLoading, failed: filterFailed, reload: reloadFilter } = useMetricsResource(
	() => ({ ...rangeParams(), dimension: filterDimension.value }),
	(p, signal) => misskeyApi('admin/hanami/metrics/breakdown', p, undefined, signal),
);
const filterItems = computed(() => [{ value: '', label: t.all }, ...(filterData.value?.rows.map(row => ({ value: row.key, label: dimensionValueLabel(filterDimension.value, row.key) })) ?? [])]);
const { data: breakdown, loading: breakdownLoading, failed: breakdownFailed, reload: reloadBreakdown } = useMetricsResource(
	() => ({ ...rangeParams(), dimension: dimension.value, ...(filterKey.value ? { filter: { [filterDimension.value]: filterKey.value } } : {}) }),
	(p, signal) => misskeyApi('admin/hanami/metrics/breakdown', p, undefined, signal),
);
const shareRows = computed(() => breakdown.value?.rows.map(row => ({ ...row, label: rowLabel(row.key) })) ?? []);
const { data: opportunities, loading: opportunitiesLoading, failed: opportunitiesFailed, reload: reloadOpportunities } = useMetricsResource(rangeParams, (p, signal) => misskeyApi('admin/hanami/metrics/opportunities', p, undefined, signal));
const { data: notes, loading: notesLoading, failed: notesFailed, reload: reloadNotes } = useMetricsResource(
	() => ({ range: { days: notesDays.value }, ...(noteKey.value !== null ? { dimension: dimension.value, key: noteKey.value } : {}) }),
	(p, signal) => misskeyApi('admin/hanami/metrics/notes', p, undefined, signal),
);

function selectNotes(key: string) {
	noteKey.value = key;
	notesSection.value?.scrollIntoView({ block: 'start' });
	notesSection.value?.focus({ preventScroll: true });
}

function caps(value: MetricsOpportunities['allocation'][number]['capNow']) {
	if (!value) return t.unavailable;
	const r = i18n.ts._hana._recommendation;
	return `${r.axisConfidenceHigh}: ${fmt(value.high, 'percent')} / ${r.axisConfidenceLow}: ${fmt(value.low, 'percent')} / ${r.axisConfidenceNone}: ${fmt(value.none, 'percent')}`;
}

const verdictLabels = { under: t.under, over: t.over, balanced: t.balanced };
type OpportunityPanel = { key: string; label: string; headings: string[]; rows: string[][]; badgeColumn?: number };
const opportunityPanels = computed<OpportunityPanel[]>(() => {
	const o = opportunities.value;
	if (!o) return [];
	return [
		{ key: 'allocation', label: t.allocation, headings: [t.source, t.share, t.engagementShare, 'engagementShare / share', t.current, t.suggested, t.allocation], badgeColumn: 6,
				rows: o.allocation.map(row => [axisLabel(row.axis), fmt(row.share, 'percent'), fmt(row.engagementShare, 'percent'), fmt(row.ratio, 'ratio'), caps(row.capNow), caps(row.suggestedCap), verdictLabels[row.verdict]]) },
		{ key: 'content', label: t.contentOpportunities, headings: [t.contentType, t.media, t.relationshipClass, t.served, t.engagementRate, t.lift, t.share, t.opportunities],
				rows: o.content.map(row => [dimensionValueLabel('contentType', row.contentType), dimensionValueLabel('media', row.media), dimensionValueLabel('relationshipClass', row.relationshipClass), fmt(row.served), fmt(row.engagementRate, 'percent'), fmt(row.lift, 'ratio'), fmt(row.share, 'percent'), fmt(row.opportunity)]) },
		{ key: 'supplyWalls', label: t.supplyWalls, headings: [t.source, 'dropped', 'passed'],
				rows: o.supplyWalls.map(row => [axisLabel(row.axis), Object.entries(row.dropped).map(([key, value]) => `${key}: ${fmt(value)}`).join(' · '), fmt(row.passed)]) },
		{ key: 'demand', label: t.demand, headings: [t.source, 'usersHigh', 'avgServedPerPageHigh', 'avgServedPerPageNormal'],
				rows: o.demand.map(row => [axisLabel(row.axis), fmt(row.usersHigh), fmt(row.avgServedPerPageHigh), fmt(row.avgServedPerPageNormal)]) },
		{ key: 'hiddenCost', label: t.hiddenCost, headings: [t.source, 'hidden', 'normalEngagementOfHidden', 'normalEngagementOfShown'],
				rows: o.hiddenCost.map(row => [axisLabel(row.axis), fmt(row.hidden), fmt(row.normalEngagementOfHidden, 'percent'), fmt(row.normalEngagementOfShown, 'percent')]) },
		{ key: 'tuningDrift', label: t.tuningDrift, headings: [t.source, t.users],
				rows: Object.entries(o.tuningDrift).map(([axis, levels]) => [axisLabel(axis), Object.entries(levels).map(([level, users]) => `${level}: ${fmt(users)}`).join(' · ')]) },
	];
});

function panelEmpty(key: string) {
	const o = opportunities.value;
	if (o?.unavailable.some(path => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}:`))) return t.unavailable;
	return t.noData;
}
</script>

<style module lang="scss">
.selectors { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.tableScroll { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; font-size: .85em; th, td { padding: 10px; text-align: left; border-bottom: 1px solid var(--MI_THEME-divider); overflow-wrap: anywhere; min-width: 65px; } }
.badge { display: inline-block; border-radius: 6px; padding: 4px 8px; background: var(--MI_THEME-accentedBg); color: var(--MI_THEME-accent); }
.note { padding: 16px; }
.snippet { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 0; }
.metadata { font-size: .85em; margin-top: 8px; overflow-wrap: anywhere; }
</style>
