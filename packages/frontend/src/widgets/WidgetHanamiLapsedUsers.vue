<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkContainer :showHeader="widgetProps.showHeader" class="mkw-hanamiLapsedUsers">
	<template #icon><i class="ti ti-mail"></i></template>
	<template #header>{{ i18n.ts._widgets.hanamiLapsedUsers }}</template>
	<template #func="{ buttonStyleClass }"><button class="_button" :class="buttonStyleClass" :disabled="fetching" :aria-label="i18n.ts.reload" @click="fetchItems"><i class="ti ti-refresh"></i></button></template>

	<MkLoading v-if="fetching && items.length === 0"/>
	<div v-else-if="failed" :class="$style.status" role="alert">{{ i18n.ts.somethingHappened }}</div>
	<div v-else-if="items.length === 0" :class="$style.status">{{ i18n.ts._hana._affinity.lapsedEmpty }}</div>
	<div v-else>
		<div v-for="item in items" :key="item.user.id" :class="$style.row">
			<MkAvatar :class="$style.avatar" :user="item.user" link preview/>
			<div :class="$style.mid">
				<MkA :class="$style.name" :to="userPage(item.user)"><MkUserName :user="item.user"/></MkA>
				<div :class="$style.meta">
					{{ i18n.ts._hana._affinity.lastInteraction }} <b>{{ i18n.tsx._hana._affinity.daysAgo({ n: item.daysSinceLast ?? 0 }) }}</b>
					<span> · {{ frequency(item) }}</span>
					<span v-if="postedRecently(item)"> · {{ i18n.ts._hana._affinity.recentlyPosted }}</span>
					<span v-if="item.birthdayWithin14d"> · {{ i18n.ts._hana._affinity.birthdaySoon }}</span>
				</div>
			</div>
			<MkA :class="$style.button" :to="userPage(item.user)">{{ i18n.ts._hana._affinity.viewNotes }}</MkA>
		</div>
	</div>
	<div :class="$style.footer">{{ i18n.ts._hana._affinity.lapsedFooter }}</div>
</MkContainer>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import { useInterval } from '@@/js/use-interval.js';
import { useWidgetPropsManager } from './widget.js';
import type * as Misskey from 'misskey-js';
import type { WidgetComponentEmits, WidgetComponentExpose, WidgetComponentProps } from './widget.js';
import type { FormWithDefault, GetFormResultType } from '@/utility/form.js';
import MkContainer from '@/components/MkContainer.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { userPage } from '@/filters/user.js';
import { i18n } from '@/i18n.js';

const name = 'hanamiLapsedUsers';

const widgetPropsDef = {
	showHeader: { type: 'boolean', default: true },
} satisfies FormWithDefault;

type WidgetProps = GetFormResultType<typeof widgetPropsDef>;
type Item = Misskey.entities.UsersHanamiAffinityResponse['items'][number];

const props = defineProps<WidgetComponentProps<WidgetProps>>();
const emit = defineEmits<WidgetComponentEmits<WidgetProps>>();
const { widgetProps, configure } = useWidgetPropsManager(name, widgetPropsDef, props, emit);

const items = ref<Item[]>([]);
const fetching = ref(false);
const failed = ref(false);

function frequency(item: Item): string {
	const perWeek = item.pastPerWeek ?? 0;
	if (perWeek < 1) return i18n.ts._hana._affinity.fewPerMonth;
	return i18n.tsx._hana._affinity.perWeek({ n: Math.round(perWeek * 2) / 2 });
}

function postedRecently(item: Item): boolean {
	if (item.latestNoteAt == null) return false;
	return Date.now() - new Date(item.latestNoteAt).getTime() <= 7 * 24 * 60 * 60 * 1000;
}

async function fetchItems() {
	if (fetching.value) return;
	fetching.value = true;
	failed.value = false;
	try {
		const res = await misskeyApi('users/hanami-affinity', { mode: 'lapsed', limit: 3 });
		items.value = res.items;
	} catch {
		failed.value = true;
	} finally {
		fetching.value = false;
	}
}

useInterval(fetchItems, 1000 * 60 * 10, { immediate: true, afterMounted: true });

defineExpose<WidgetComponentExpose>({ name, configure, id: props.widget ? props.widget.id : null });
</script>

<style lang="scss" module>
.status {
	padding: 16px;
	font-size: 0.85em;
	opacity: 0.7;
}

.row {
	display: grid;
	grid-template-columns: 32px minmax(0, 1fr) auto;
	gap: 10px;
	align-items: center;
	padding: 9px 14px;
	border-bottom: solid 0.5px var(--MI_THEME-divider);

	&:last-child {
		border-bottom: none;
	}
}

.avatar {
	width: 32px;
	height: 32px;
}

.mid {
	min-width: 0;
}

.name {
	display: block;
	font-size: 0.85em;
	font-weight: bold;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.meta {
	font-size: 0.75em;
	opacity: 0.75;
	line-height: 1.4;

	> b {
		color: var(--MI_THEME-warn);
	}
}

.button {
	display: inline-block;
	padding: 4px 9px;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: 999px;
	font-size: 0.75em;
	white-space: nowrap;
	text-decoration: none;
}

.footer {
	padding: 8px 14px 12px;
	font-size: 0.75em;
	opacity: 0.6;
}
</style>
