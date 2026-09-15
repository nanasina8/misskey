<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkContainer :showHeader="widgetProps.showHeader">
	<template #icon><i class="ti ti-trending-up"></i></template>
	<template #header>{{ i18n.ts._widgets.hanamiTrends }}</template>
	<template #func="{ buttonStyleClass }"><button class="_button" :class="buttonStyleClass" :disabled="fetching" :aria-label="i18n.ts.reload" @click="fetchTrends"><i class="ti ti-refresh"></i></button></template>
	<MkLoading v-if="fetching"/>
	<div v-else-if="failed" :class="$style.status" role="alert">{{ i18n.ts.somethingHappened }}</div>
	<div v-else-if="items.length === 0" :class="$style.status">{{ i18n.ts._hana._trends.empty }}</div>
	<div v-else>
		<HanamiTrendRow v-for="(item, index) in items" :key="item.trendEntryId" :item="item" :rank="index + 1"/>
	</div>
	<div :class="$style.footer">
		<span v-if="items[0]" :class="$style.snapshot" :title="dateString(items[0].snapshotGeneratedAt)">{{ i18n.tsx._hana._trends.snapshot({ time: timeFormat.format(new Date(items[0].snapshotGeneratedAt)) }) }}</span>
		<span v-else></span>
		<MkA :class="$style.link" to="/hanami/trends/history">{{ i18n.ts._hana._trends.history }} →</MkA>
	</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import { useInterval } from '@@/js/use-interval.js';
import { versatileLang } from '@@/js/intl-const.js';
import type * as Misskey from 'misskey-js';
import { useWidgetPropsManager } from './widget.js';
import type { WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps } from './widget.js';
import type { FormWithDefault, GetFormResultType } from '@/utility/form.js';
import MkContainer from '@/components/MkContainer.vue';
import HanamiTrendRow from '@/components/HanamiTrendRow.vue';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { dateString } from '@/filters/date.js';
import { i18n } from '@/i18n.js';

const name = 'hanamiTrends';
const widgetPropsDef = {
	showHeader: { type: 'boolean', default: true },
} satisfies FormWithDefault;
type WidgetProps = GetFormResultType<typeof widgetPropsDef>;
const props = defineProps<WidgetComponentProps<WidgetProps>>();
const emit = defineEmits<WidgetComponentEmits<WidgetProps>>();
const { widgetProps, configure } = useWidgetPropsManager(name, widgetPropsDef, props, emit);
const items = ref<Misskey.entities.NotesHanamiTrendsResponse['items']>([]);
const fetching = ref(false);
const failed = ref(false);
const timeFormat = new Intl.DateTimeFormat(versatileLang, { hour: '2-digit', minute: '2-digit', hour12: false });

async function fetchTrends() {
	if (fetching.value) return;
	fetching.value = true;
	failed.value = false;
	try {
		const res = await misskeyApiGet('notes/hanami-trends', { history: false, limit: 10 });
		items.value = res.items;
	} catch {
		failed.value = true;
	} finally {
		fetching.value = false;
	}
}

useInterval(fetchTrends, 1000 * 60 * 10, { immediate: true, afterMounted: true });
defineExpose<WidgetComponentExpose>({ name, configure, id: props.widget ? props.widget.id : null });
</script>

<style lang="scss" module>
.status {
	padding: 16px;
	font-size: 0.85em;
	opacity: 0.7;
}

.footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 10px 14px;
	border-top: solid 0.5px var(--MI_THEME-divider);
	font-size: 0.75em;
}

.snapshot {
	min-width: 0;
	opacity: 0.6;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.link {
	flex-shrink: 0;
	color: var(--MI_THEME-accent);
	text-decoration: none;
}
</style>
