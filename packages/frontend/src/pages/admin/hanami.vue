<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<SearchMarker path="/admin/hanami" :label="i18n.ts._hana.hanamiTimeline" :keywords="['hanami', 'recommendation', 'おすすめ', 'axes', 'judge', 'taste', 'rebuild', 'metrics', 'statistics']" icon="ti ti-flower-filled">
			<Suspense :key="tab">
				<div>
					<XOverview v-if="tab === 'overview'"/>
					<XStats v-else-if="tab === 'stats'"/>
					<XAxes v-else-if="tab === 'axes'"/>
					<XJudge v-else-if="tab === 'judge'"/>
					<XTrends v-else-if="tab === 'trends'"/>
					<XTaste v-else-if="tab === 'taste'"/>
				</div>
				<template #fallback><MkLoading/></template>
			</Suspense>
		</SearchMarker>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import XOverview from './hanami.overview.vue';
import XStats from './hanami.stats.vue';
import XAxes from './hanami.axes.vue';
import XJudge from './hanami.judge.vue';
import XTrends from './hanami.trends.vue';
import XTaste from './hanami.taste.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

const tab = ref('overview');
const headerTabs = computed(() => [
	{ key: 'overview', title: i18n.ts._hana._admin.overview, icon: 'ti ti-layout-dashboard' },
	{ key: 'stats', title: i18n.ts._hana._admin.stats, icon: 'ti ti-chart-bar' },
	{ key: 'axes', title: i18n.ts._hana._admin.axes, icon: 'ti ti-adjustments' },
	{ key: 'judge', title: i18n.ts._hana._admin.judge, icon: 'ti ti-scale' },
	{ key: 'trends', title: i18n.ts._hana._admin.trends, icon: 'ti ti-trending-up' },
	{ key: 'taste', title: i18n.ts._hana._admin.taste, icon: 'ti ti-database' },
]);

definePage(() => ({
	title: i18n.ts._hana.hanamiTimeline,
	icon: 'ti ti-flower-filled',
}));
</script>
