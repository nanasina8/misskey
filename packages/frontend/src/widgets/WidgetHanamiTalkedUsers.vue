<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkContainer :showHeader="widgetProps.showHeader" class="mkw-hanamiTalkedUsers">
	<template #icon><i class="ti ti-messages"></i></template>
	<template #header>{{ i18n.ts._widgets.hanamiTalkedUsers }}</template>
	<template #func="{ buttonStyleClass }"><button class="_button" :class="buttonStyleClass" :disabled="fetching" :aria-label="i18n.ts.reload" @click="fetchItems"><i class="ti ti-refresh"></i></button></template>

	<MkLoading v-if="fetching && items.length === 0"/>
	<div v-else-if="failed" :class="$style.status" role="alert">{{ i18n.ts.somethingHappened }}</div>
	<div v-else-if="items.length === 0" :class="$style.status">{{ i18n.ts._hana._affinity.talkedEmpty }}</div>
	<div v-else :class="$style.list">
		<div v-for="item in items" :key="item.user.id" :class="$style.row">
			<span :class="$style.rank">{{ item.rank }}</span>
			<MkAvatar :class="$style.avatar" :user="item.user" link preview/>
			<div :class="$style.mid">
				<MkA :class="$style.name" :to="userPage(item.user)"><MkUserName :user="item.user"/></MkA>
				<div :class="$style.track" :title="countsTitle(item)"><div :class="$style.fill" :style="{ width: `${barWidth(item)}%` }"></div></div>
			</div>
			<div :class="$style.side">
				<b v-if="item.rankDelta == null" :class="[$style.delta, $style.up]">{{ i18n.ts._hana._affinity.rankNew }}</b>
				<b v-else-if="item.rankDelta > 0" :class="[$style.delta, $style.up]">↑ {{ item.rankDelta }}</b>
				<b v-else-if="item.rankDelta < 0" :class="[$style.delta, $style.down]">↓ {{ -item.rankDelta }}</b>
				<b v-else :class="$style.delta">—</b>
				<MkTime v-if="item.lastInteractionAt" :class="$style.time" :time="item.lastInteractionAt"/>
			</div>
		</div>
	</div>
	<div :class="$style.footer">{{ i18n.ts._hana._affinity.talkedFooter }}</div>
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

const name = 'hanamiTalkedUsers';

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

function barWidth(item: Item): number {
	const top = items.value[0]?.score ?? 0;
	if (top <= 0 || item.score == null) return 0;
	return Math.max(6, Math.round((item.score / top) * 100));
}

function countsTitle(item: Item): string {
	const c = item.counts;
	if (c == null) return '';
	return i18n.tsx._hana._affinity.counts({
		reply: c.reply.out + c.reply.in,
		mention: c.mention.out + c.mention.in,
		renote: c.renote.out + c.renote.in,
		reaction: c.reaction.out + c.reaction.in,
	});
}

async function fetchItems() {
	if (fetching.value) return;
	fetching.value = true;
	failed.value = false;
	try {
		const res = await misskeyApi('users/hanami-affinity', { mode: 'top', limit: 5 });
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

.list {
	padding: 4px 0;
}

.row {
	display: grid;
	grid-template-columns: 20px 30px minmax(0, 1fr) auto;
	gap: 8px;
	align-items: center;
	padding: 7px 14px;
}

.rank {
	font-size: 0.8em;
	opacity: 0.7;
	font-variant-numeric: tabular-nums;
	text-align: center;
}

.avatar {
	width: 30px;
	height: 30px;
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

.track {
	height: 4px;
	margin-top: 4px;
	border-radius: 2px;
	background: color-mix(in srgb, var(--MI_THEME-fg) 12%, transparent);
	overflow: hidden;
}

.fill {
	height: 100%;
	border-radius: 2px;
	background: var(--MI_THEME-accent);
}

.side {
	text-align: right;
	font-size: 0.75em;
	line-height: 1.3;
	opacity: 0.8;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.delta {
	display: block;
	font-weight: bold;
}

.up {
	color: var(--MI_THEME-accent);
}

.down {
	color: var(--MI_THEME-warn);
}

.time {
	display: block;
}

.footer {
	padding: 6px 14px 12px;
	font-size: 0.75em;
	opacity: 0.6;
}
</style>
