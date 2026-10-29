<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer" style="--MI_SPACER-w: 1280px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<SearchMarker path="/admin/hanami" :label="i18n.ts._hana.hanamiTimeline" :keywords="['hanami', 'recommendation', 'おすすめ', 'axes', 'judge', 'taste', 'rebuild', 'metrics', 'statistics']" icon="ti ti-flower-filled">
			<div ref="rootEl" :class="[$style.shell, { [$style.side]: !narrow }]">
				<nav v-if="!narrow" :class="$style.nav" :aria-label="i18n.ts._hana.hanamiTimeline">
					<div v-for="group in groups" :key="group.key" :class="$style.group" role="group" :aria-labelledby="`hanami-admin-group-${group.key}`">
						<div :id="`hanami-admin-group-${group.key}`" :class="$style.groupTitle">{{ group.title }}</div>
						<button v-for="item in group.items" :key="item.key" type="button" class="_button" :class="[$style.navItem, { [$style.current]: tab === item.key }]" :aria-current="tab === item.key ? 'page' : undefined" @click="tab = item.key">
							<i :class="item.icon" aria-hidden="true"></i>
							<span :class="$style.navLabel">{{ item.title }}</span>
							<span v-if="item.attention" v-tooltip="t.attention" :class="$style.dot"><span :class="$style.srOnly">{{ t.attention }}</span></span>
						</button>
					</div>
				</nav>
				<nav v-else :class="$style.bar" :aria-label="i18n.ts._hana.hanamiTimeline">
					<button v-for="item in viewItems" :key="item.key" type="button" class="_button" :class="[$style.barItem, { [$style.current]: tab === item.key }]" :aria-current="tab === item.key ? 'page' : undefined" @click="tab = item.key">
						{{ item.title }}<span v-if="item.attention" :class="$style.dot"><span :class="$style.srOnly">{{ t.attention }}</span></span>
					</button>
					<button type="button" class="_button" :class="[$style.barItem, { [$style.current]: tuneCurrent }]" :aria-current="tuneCurrent ? 'page' : undefined" aria-haspopup="menu" :aria-expanded="tuneMenuOpen" @click="openTuneMenu">
						{{ t.tune }}<i class="ti ti-chevron-down" aria-hidden="true"></i>
					</button>
				</nav>
				<div :class="[$style.content, { [$style.readable]: !wideTabs.has(tab) }]">
					<h2 v-if="tab !== 'overview'" :class="$style.title">{{ currentTitle }}</h2>
					<Suspense :key="tab">
						<div>
							<XOverview v-if="tab === 'overview'" :jobsStatus="jobsStatus" :narrow="narrow" @navigate="key => tab = key"/>
							<XStats v-else-if="tab === 'stats'"/>
							<XAxes v-else-if="tab === 'axes'"/>
							<XJudge v-else-if="tab === 'judge'"/>
							<XJobs v-else-if="tab === 'jobs'"/>
							<XTrends v-else-if="tab === 'trends'"/>
							<XTaste v-else-if="tab === 'taste'"/>
						</div>
						<template #fallback><MkLoading/></template>
					</Suspense>
				</div>
			</div>
		</SearchMarker>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import type { entities } from 'misskey-js';
import { useInterval } from '@@/js/use-interval.js';
import XOverview from './hanami.overview.vue';
import XStats from './hanami.stats.vue';
import XAxes from './hanami.axes.vue';
import XJudge from './hanami.judge.vue';
import XJobs from './hanami.jobs.vue';
import XTrends from './hanami.trends.vue';
import XTaste from './hanami.taste.vue';
import type { HanamiAdminTab } from '@/scripts/hanami-admin-overview.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';

const t = i18n.ts._hana._admin;
// Below this width the section list moves from the left column to a bar above the content.
const SIDE_NAV_MIN_WIDTH = 900;
const tab = ref<HanamiAdminTab>('overview');
const narrow = ref(false);
const rootEl = useTemplateRef('rootEl');
const jobsStatus = ref<entities.AdminHanamiJobsStatusResponse | null>(null);
const tuneMenuOpen = ref(false);
// Dashboards use the full width; settings forms stay at a readable line length.
const wideTabs = new Set<HanamiAdminTab>(['overview', 'jobs', 'stats']);

const viewItems = computed(() => [
	{ key: 'overview' as const, title: t.overview, icon: 'ti ti-layout-dashboard', attention: false },
	{ key: 'stats' as const, title: t.stats, icon: 'ti ti-chart-bar', attention: false },
	{ key: 'jobs' as const, title: t.jobs, icon: 'ti ti-cpu', attention: (jobsStatus.value?.warnings.length ?? 0) > 0 },
	{ key: 'trends' as const, title: t.trends, icon: 'ti ti-trending-up', attention: false },
]);
const tuneItems = computed(() => [
	{ key: 'axes' as const, title: t.axes, icon: 'ti ti-adjustments', attention: false },
	{ key: 'judge' as const, title: t.judge, icon: 'ti ti-scale', attention: false },
	{ key: 'taste' as const, title: t.taste, icon: 'ti ti-database', attention: false },
]);
const groups = computed(() => [
	{ key: 'view', title: t.sectionView, items: viewItems.value },
	{ key: 'tune', title: t.sectionTune, items: tuneItems.value },
]);
const tuneCurrent = computed(() => tuneItems.value.some(item => item.key === tab.value));
const currentTitle = computed(() => [...viewItems.value, ...tuneItems.value].find(item => item.key === tab.value)?.title ?? '');

function openTuneMenu(ev: MouseEvent) {
	tuneMenuOpen.value = true;
	os.popupMenu(tuneItems.value.map(item => ({
		text: item.title,
		icon: item.icon,
		active: tab.value === item.key,
		action: () => { tab.value = item.key; },
	})), ev.currentTarget ?? ev.target, { onClosing: () => { tuneMenuOpen.value = false; } });
}

let statusController: AbortController | undefined;
let unmounted = false;

// Feeds the attention dot and the overview status strip; failures keep the last known status.
async function fetchJobsStatus() {
	if (statusController != null || unmounted) return;
	const request = new AbortController();
	statusController = request;
	try {
		const result = await misskeyApi('admin/hanami/jobs-status', { eventsLimit: 1 }, undefined, request.signal);
		if (!unmounted) jobsStatus.value = result;
	} catch {
		// The jobs tab shows the error itself.
	} finally {
		if (statusController === request) statusController = undefined;
	}
}

useInterval(() => { void fetchJobsStatus(); }, 60_000, { immediate: true, afterMounted: true });

const ro = new ResizeObserver(entries => {
	narrow.value = entries[0].borderBoxSize[0].inlineSize < SIDE_NAV_MIN_WIDTH;
});
onMounted(() => {
	if (rootEl.value) {
		narrow.value = rootEl.value.offsetWidth < SIDE_NAV_MIN_WIDTH;
		ro.observe(rootEl.value);
	}
});
onUnmounted(() => {
	unmounted = true;
	statusController?.abort();
	ro.disconnect();
});

definePage(() => ({
	title: i18n.ts._hana.hanamiTimeline,
	icon: 'ti ti-flower-filled',
	// Hides the widget column so the dashboard gets the full page width.
	needWideArea: true,
}));
</script>

<style lang="scss" module>
.shell {
	display: flex;
	flex-direction: column;
	gap: 16px;
	min-width: 0;
}

.side {
	flex-direction: row;
	align-items: flex-start;
	gap: 24px;
}

.nav {
	position: sticky;
	top: calc(var(--MI-stickyTop, 0px) + 16px);
	flex: 0 0 200px;
	display: flex;
	flex-direction: column;
	gap: 18px;
}

.group {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.groupTitle {
	padding: 0 12px 4px;
	font-size: .8em;
	opacity: .7;
}

.navItem {
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 40px;
	padding: 0 12px;
	border-radius: calc(var(--MI-radius) - 4px);
	text-align: start;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.current {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		font-weight: bold;
	}
}

.navLabel {
	flex: 1;
	min-width: 0;
}

.bar {
	display: flex;
	gap: 4px;
	padding: 4px;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-buttonBg);
	overflow-x: auto;
}

.barItem {
	flex: 1 0 auto;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	min-height: 40px;
	padding: 0 12px;
	border-radius: calc(var(--MI-radius) - 4px);
	font-size: .9em;
	white-space: nowrap;

	&.current {
		background: var(--MI_THEME-panel);
		color: var(--MI_THEME-accent);
		font-weight: bold;
	}
}

.dot {
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--MI_THEME-warn);
}

.srOnly {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}

.content {
	flex: 1;
	min-width: 0;
}

.readable {
	max-width: 760px;
}

.title {
	margin: 0 0 16px;
	font-size: 1.3em;
}
</style>
