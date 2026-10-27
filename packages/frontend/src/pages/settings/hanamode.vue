<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/settings/hanamode" :label="i18n.ts._hana.hanamiTimelineShort" :keywords="['はなみTL', 'おすすめ', '調整', 'For You', 'hanami']" icon="ti ti-flower-filled">
	<div class="_gaps">
		<FormSection first>
			<template #label>{{ i18n.ts._hana._tuning.settingsTitle }}</template>
			<div class="_gaps_m">
				<p v-if="!enabled" :class="$style.description">{{ i18n.ts._hana._tuning.enableForYou }}</p>
				<MkHanamiTuningPanel :showTitle="false" :disabled="!enabled || flagsSaving"/>
			</div>
		</FormSection>

		<FormSection>
			<template #label>{{ tasteI18n.title }}</template>
			<template #description>{{ tasteI18n.description }}</template>

			<div class="_gaps_m">
				<MkLoading v-if="tasteClustersFetching"/>
				<div v-else-if="tasteClusters.length === 0" :class="$style.tasteEmpty">{{ tasteI18n.empty }}</div>
				<div v-else class="_gaps_s">
					<div v-for="cluster in tasteClusters" :key="cluster.clusterId" :class="$style.tasteCluster">
						<div :class="$style.tasteClusterHeader">
							<span :class="$style.tasteClusterTitle">{{ tasteClusterTitle(cluster) }}</span>
							<span v-if="cluster.isMention" :class="$style.tasteClusterBadge">{{ tasteI18n.mentionBadge }}</span>
							<span :class="$style.tasteClusterSize">{{ tasteTsx.count({ n: cluster.size }) }}</span>
						</div>
						<div v-if="cluster.examples.length > 0" :class="$style.tasteClusterExamples">
							<div v-for="example in cluster.examples.slice(0, 2)" :key="example.noteId" :class="$style.tasteClusterExample">「{{ example.snippet }}」</div>
						</div>
						<MkRadios :modelValue="cluster.weight" :options="[{ value: 'normal', label: tasteI18n.weightNormal, disabled: tasteClustersSaving.has(cluster.clusterId) }, { value: 'reduce', label: tasteI18n.weightReduce, disabled: tasteClustersSaving.has(cluster.clusterId) }, { value: 'hide', label: tasteI18n.weightHide, disabled: tasteClustersSaving.has(cluster.clusterId) }]" @update:modelValue="v => setTasteClusterWeight(cluster, v)">
						</MkRadios>
					</div>
				</div>
			</div>
		</FormSection>

		<FormSection>
			<template #label>{{ i18n.ts.explore }}</template>
			<template #description>{{ exploreI18n.mediaFilterDescription }}</template>

			<MkRadios v-model="exploreMediaFilter" :options="[{ value: 'all', label: exploreI18n.mediaFilterAll, disabled: exploreMediaFilterSaving }, { value: 'hideSensitive', label: exploreI18n.mediaFilterHideSensitive, disabled: exploreMediaFilterSaving }, { value: 'hideMedia', label: exploreI18n.mediaFilterHideMedia, disabled: exploreMediaFilterSaving }]" @update:modelValue="saveExploreMediaFilter">
			</MkRadios>
		</FormSection>

		<FormSection>
			<template #label>{{ i18n.ts.display }}</template>
			<template #description>{{ i18n.ts._hana._recommendation.description }}</template>
			<div class="_gaps_m">
				<MkSwitch v-model="enabled" :disabled="flagsSaving" @update:modelValue="saveFlags">
					<template #label>{{ i18n.ts._hana._recommendation.enable }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.enableDescription }}</template>
				</MkSwitch>
				<MkSwitch v-model="showReason" :disabled="flagsSaving" @update:modelValue="saveFlags">
					<template #label>{{ i18n.ts._hana._recommendation.showReason }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.showReasonDescription }}</template>
				</MkSwitch>
				<MkPreferenceContainer k="showHanamiTimelineDateSeparators">
					<MkSwitch v-model="showHanamiTimelineDateSeparators">
						<template #label>{{ i18n.ts._hana.showHanamiTimelineDateSeparators }}</template>
						<template #caption>{{ i18n.ts._hana.showHanamiTimelineDateSeparatorsDescription }}</template>
					</MkSwitch>
				</MkPreferenceContainer>
			</div>
		</FormSection>
	</div>
</SearchMarker>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import FormSection from '@/components/form/section.vue';
import MkHanamiTuningPanel from '@/components/MkHanamiTuningPanel.vue';
import { refreshHanamiTuning } from '@/utility/hanami-tuning-client.js';
import MkSwitch from '@/components/MkSwitch.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkPreferenceContainer from '@/components/MkPreferenceContainer.vue';
import { ensureSignin } from '@/i.js';
import { updateCurrentAccount } from '@/accounts.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { prefer } from '@/preferences.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const $i = ensureSignin();
const showHanamiTimelineDateSeparators = prefer.model('showHanamiTimelineDateSeparators');

type ExploreMediaFilter = 'all' | 'hideSensitive' | 'hideMedia';

type TasteClusterWeight = 'normal' | 'reduce' | 'hide';
type HanamiTasteCluster = {
	clusterId: number;
	labelTerms: string[];
	size: number;
	ownRate: number;
	weight: TasteClusterWeight;
	isMention: boolean;
	examples: { noteId: string; snippet: string }[];
};
type TasteClustersI18n = {
	title: string;
	description: string;
	empty: string;
	noLabel: string;
	mentionBadge: string;
	weightNormal: string;
	weightReduce: string;
	weightHide: string;
};

const exploreI18n = i18n.ts._hana._explore;
const tasteI18n = (i18n.ts._hana as typeof i18n.ts._hana & { _tasteClusters: TasteClustersI18n })._tasteClusters;
const tasteTsx = (i18n.tsx._hana as unknown as { _tasteClusters: { count: (args: { n: number }) => string } })._tasteClusters;

const exploreMediaFilter = ref<ExploreMediaFilter>($i.exploreMediaFilter ?? 'all');
const enabled = ref($i.hanamiRecommendationEnabled ?? true);
const showReason = ref($i.hanamiShowRecommendationReason ?? false);
const flagsSaving = ref(false);
const exploreMediaFilterSaving = ref(false);

function showSaveError(error: unknown): void {
	const message = error != null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
	void os.alert({ type: 'error', text: message });
}

async function saveFlags(): Promise<void> {
	if (flagsSaving.value) return;
	flagsSaving.value = true;
	const patch = { hanamiRecommendationEnabled: enabled.value, hanamiShowRecommendationReason: showReason.value };
	try {
		await misskeyApi('i/update', patch);
		updateCurrentAccount(patch);
		refreshHanamiTuning();
	} catch (error) {
		enabled.value = $i.hanamiRecommendationEnabled ?? true;
		showReason.value = $i.hanamiShowRecommendationReason ?? false;
		showSaveError(error);
	} finally {
		flagsSaving.value = false;
	}
}

const tasteClusters = ref<HanamiTasteCluster[]>([]);
const tasteClustersFetching = ref(true);
const tasteClustersSaving = ref(new Set<number>());

misskeyApi<HanamiTasteCluster[]>('i/hanami-taste-clusters' as never).then(res => {
	tasteClusters.value = res ?? [];
}).catch(() => {
	tasteClusters.value = [];
}).finally(() => {
	tasteClustersFetching.value = false;
});

function tasteClusterTitle(cluster: HanamiTasteCluster): string {
	return cluster.labelTerms.length > 0 ? cluster.labelTerms.join('・') : tasteI18n.noLabel;
}

function setTasteClusterWeight(cluster: HanamiTasteCluster, weight: unknown) {
	if (weight !== 'normal' && weight !== 'reduce' && weight !== 'hide') return;
	if (cluster.weight === weight || tasteClustersSaving.value.has(cluster.clusterId)) return;
	const prev = cluster.weight;
	cluster.weight = weight;
	tasteClustersSaving.value.add(cluster.clusterId);
	misskeyApi('i/update-hanami-taste-cluster' as never, { clusterId: cluster.clusterId, weight } as never).catch(error => {
		cluster.weight = prev;
		showSaveError(error);
	}).finally(() => {
		tasteClustersSaving.value.delete(cluster.clusterId);
	});
}

async function saveExploreMediaFilter() {
	if (exploreMediaFilterSaving.value) return;
	exploreMediaFilterSaving.value = true;
	const patch = { exploreMediaFilter: exploreMediaFilter.value };
	try {
		await misskeyApi('i/update', patch);
		updateCurrentAccount(patch);
	} catch (error) {
		exploreMediaFilter.value = $i.exploreMediaFilter ?? 'all';
		showSaveError(error);
	} finally {
		exploreMediaFilterSaving.value = false;
	}
}

</script>

<style lang="scss" module>
.description {
	margin: 0;
	line-height: 1.6;
}

.tasteEmpty {
	font-size: 0.9em;
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.7);
}

.tasteCluster {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px;
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: 8px;
}

.tasteClusterHeader {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
	min-width: 0;
}

.tasteClusterTitle {
	font-weight: 700;
	overflow-wrap: anywhere;
}

.tasteClusterBadge {
	padding: 1px 6px;
	border-radius: 999px;
	background: color(from var(--MI_THEME-accent) srgb r g b / 0.12);
	color: var(--MI_THEME-accent);
	font-size: 0.78em;
}

.tasteClusterSize {
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.7);
	font-size: 0.85em;
	font-variant-numeric: tabular-nums;
}

.tasteClusterExamples {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.tasteClusterExample {
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.6);
	font-size: 0.85em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

</style>
