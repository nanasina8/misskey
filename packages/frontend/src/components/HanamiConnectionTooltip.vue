<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkTooltip :showing="showing" :anchorElement="anchorElement" :maxWidth="260" @closed="emit('closed')">
	<div :class="$style.root">
		<div :class="$style.user">
			<MkAvatar :class="$style.avatar" :user="item.user"/>
			<MkUserName :user="item.user" :nowrap="true"/>
		</div>
		<div :class="$style.acct"><MkAcct :user="item.user"/></div>
		<div :class="$style.distanceLabel">{{ distanceLabel }}</div>
		<div v-if="item.counts" :class="$style.status">
			<div v-for="[kind, label] in kinds" :key="kind" :class="$style.statusItem">
				<div :class="$style.statusItemLabel">{{ label }}</div>
				{{ item.counts[kind].out + item.counts[kind].in }}
			</div>
		</div>
		<div>{{ item.mutualInteraction ? text.both : text.oneWay }}<template v-if="item.lastInteractionAt"> · <MkTime :time="item.lastInteractionAt" mode="relative"/></template></div>
	</div>
</MkTooltip>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import MkTooltip from './MkTooltip.vue';
import type * as Misskey from 'misskey-js';
import { connectionDistanceBand } from '@/utility/hanami-connection-layout.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{
	showing: boolean;
	anchorElement: HTMLElement;
	item: Misskey.entities.UsersHanamiAffinityResponse['items'][number];
	closeness: number;
	mock?: boolean;
}>();
const emit = defineEmits<{
	(ev: 'closed'): void;
}>();
const text = i18n.ts._hana._affinity._cloud;
const distanceLabel = computed(() => [text.close, text.middle, text.outer][connectionDistanceBand(props.closeness)]);
// Static key access keeps the locale inliner able to resolve each label at build time.
const kinds = [['reply', i18n.ts.reply], ['mention', i18n.ts.mention], ['renote', i18n.ts.renote], ['reaction', i18n.ts.reaction]] as const;
</script>

<style lang="scss" module>
.root { width: 236px; text-align: left; }
.user { line-height: 24px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }
.avatar { width: 24px; height: 24px; margin-right: 3px; }
.acct { opacity: 0.7; overflow: hidden; text-overflow: ellipsis; }
.distanceLabel { margin-top: 8px; color: var(--MI_THEME-fgTransparentWeak); }
.status { display: flex; padding: 16px 0; }
.statusItem { width: 25%; text-align: center; }
.statusItemLabel { white-space: nowrap; font-size: 0.7em; color: color(from var(--MI_THEME-fg) srgb r g b / 0.75); }
</style>
