<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkContainer :showHeader="widgetProps.showHeader" class="mkw-hanamiConnectionRing">
	<template #icon><i class="ti ti-users"></i></template>
	<template #header>{{ i18n.ts._widgets.hanamiConnectionRing }}</template>
	<template #func="{ buttonStyleClass }"><button class="_button" :class="buttonStyleClass" :disabled="fetching" :aria-label="i18n.ts.reload" @click="fetchItems"><i class="ti ti-refresh"></i></button></template>

	<div :class="$style.body">
		<div :class="{ [$style.empty]: items.length === 0 }" :inert="items.length === 0">
			<HanamiConnectionCloud :items="shownItems" :self="$i ?? undefined"/>
		</div>
		<div v-if="items.length === 0" :class="$style.status">
			<MkLoading v-if="fetching"/>
			<span v-else-if="failed" role="alert">{{ i18n.ts.somethingHappened }}</span>
			<span v-else>{{ i18n.ts._hana._affinity.ringEmpty }}</span>
		</div>
		<div v-else-if="failed" :class="$style.error" role="alert">{{ i18n.ts.somethingHappened }}</div>
	</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { useInterval } from '@@/js/use-interval.js';
import { useWidgetPropsManager } from './widget.js';
import type * as Misskey from 'misskey-js';
import type { WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps } from './widget.js';
import type { FormWithDefault, GetFormResultType } from '@/utility/form.js';
import MkContainer from '@/components/MkContainer.vue';
import HanamiConnectionCloud from '@/components/HanamiConnectionCloud.vue';
import { CONNECTION_COUNT_DEFAULT, CONNECTION_COUNT_MIN, CONNECTION_COUNT_MAX, selectConnectionItems } from '@/utility/hanami-connection-layout.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';

// Preserve the stored widget ID so existing installations upgrade in place.
const name = 'hanamiConnectionRing';

const widgetPropsDef = {
	showHeader: { type: 'boolean', default: true },
	count: {
		type: 'range',
		label: i18n.ts._hana._affinity._cloud.count,
		default: CONNECTION_COUNT_DEFAULT,
		min: CONNECTION_COUNT_MIN,
		max: CONNECTION_COUNT_MAX,
		step: 1,
	},
} satisfies FormWithDefault;

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;
type Item = Misskey.entities.UsersHanamiAffinityResponse['items'][number];

const props = defineProps<WidgetComponentProps<WidgetProps>>();
const emit = defineEmits<WidgetComponentEmits<WidgetProps>>();
const { widgetProps, configure } = useWidgetPropsManager(name, widgetPropsDef, props, emit);

const items = ref<Item[]>([]);
const shownItems = computed(() => selectConnectionItems(items.value, widgetProps.count));
const fetching = ref(true);
const failed = ref(false);
let inFlight = false;
const disposed = ref(false);
const isDisposed = (): boolean => disposed.value;

async function fetchItems() {
	if (inFlight || isDisposed()) return;
	inFlight = true;
	fetching.value = true;
	failed.value = false;
	try {
		// Keep a fixed candidate pool. Count changes only select from this response;
		// they do not refetch or alter a person's score or normalized distance.
		const res = await misskeyApi('users/hanami-affinity', { mode: 'top', limit: CONNECTION_COUNT_MAX });
		if (!disposed.value) items.value = res.items;
	} catch {
		if (!disposed.value) failed.value = true;
	} finally {
		inFlight = false;
		if (!disposed.value) fetching.value = false;
	}
}

useInterval(fetchItems, 1000 * 60 * 10, { immediate: true, afterMounted: true });
onBeforeUnmount(() => { disposed.value = true; });

defineExpose<WidgetComponentExpose>({ name, configure, get id() { return props.widget?.id ?? null; } });
</script>

<style lang="scss" module>
.body { position: relative; }
.empty { visibility: hidden; }
.status { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; font-size: 0.85em; color: var(--MI_THEME-fgTransparentWeak); }
.error { position: absolute; top: 0; left: 0; right: 0; padding: 8px 14px; background: var(--MI_THEME-panel); font-size: 0.75em; }
</style>
