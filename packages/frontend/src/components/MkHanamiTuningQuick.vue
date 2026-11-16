<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<div :class="$style.header">
		<h2 :class="$style.title">{{ t.title }}</h2>
		<button type="button" class="_button" :class="$style.close" :aria-label="i18n.ts.close" @click="emit('close')"><i class="ti ti-x"></i></button>
	</div>

	<div role="group" :aria-label="t.mode" :class="$style.modes">
		<button
			v-for="mode in HANAMI_TUNING_MODES" :key="mode" type="button" class="_button"
			:class="[$style.mode, { [$style.selected]: tuning.mode === mode }]" :aria-pressed="tuning.mode === mode" :title="t._modes[mode]"
			:data-mode="mode" @click="setMode(mode)"
		>{{ t._modeShort[mode] }}</button>
	</div>

	<p v-if="tuning.mode === 'auto'" :class="$style.text">{{ t.autoDescription }}</p>
	<MkHanamiTuningDirection v-else-if="tuning.mode === 'direction'" :modelValue="tuning.direction" compact @update:modelValue="setTuning({ ...tuning, direction: $event })"/>
	<MkHanamiTuningGroupSliders v-else-if="tuning.mode === 'recommend'" :modelValue="tuning.groups" compact @update:modelValue="setTuning({ ...tuning, groups: $event })"/>
	<div v-else :class="$style.manual">
		<p :class="$style.text">{{ t.manualDescription }}</p>
		<MkA to="/settings/hanamode" :class="$style.manualLink" class="_button" @click="emit('close')">
			<span>{{ t.openManual }}</span><i class="ti ti-chevron-right" aria-hidden="true"></i>
		</MkA>
	</div>

	<MkHanamiTuningTiles :counts="tiles.counts" :note="t.popupNote" compact/>

	<MkA to="/settings/hanamode" :class="$style.settingsLink" @click="emit('close')">
		<span>{{ t.openSettings }}</span><i class="ti ti-chevron-right" aria-hidden="true"></i>
	</MkA>
</div>
</template>

<script lang="ts" setup>
import { computed, onMounted } from 'vue';
import MkHanamiTuningDirection from '@/components/MkHanamiTuningDirection.vue';
import MkHanamiTuningGroupSliders from '@/components/MkHanamiTuningGroupSliders.vue';
import MkHanamiTuningTiles from '@/components/MkHanamiTuningTiles.vue';
import { i18n } from '@/i18n.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { useHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import { HANAMI_TUNING_MODES, hanamiTilesSummary, switchHanamiModeWithSuggestion } from '@/utility/hanami-tuning.js';
import type { HanamiTuning, HanamiTuningMode } from '@/utility/hanami-tuning.js';

const emit = defineEmits<{
	(ev: 'close'): void;
}>();

const { state, config, update } = useHanamiTuning();
const { suggestion, factors, load } = useHanamiTuningSuggestion();
const t = i18n.ts._hana._tuning;
const tuning = computed(() => state.value!.hanamiTuning);
const tiles = computed(() => hanamiTilesSummary(tuning.value, config, factors.value));

// 「いま」の件数と、おすすめへ切り替えたときの初めの値に使う。
onMounted(() => { void load(); });

function setTuning(value: HanamiTuning): void { update({ ...state.value!, hanamiTuning: value }); }

function setMode(mode: HanamiTuningMode): void {
	if (mode === tuning.value.mode) return;
	setTuning(switchHanamiModeWithSuggestion(tuning.value, mode, config, suggestion.value));
}
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: 12px;
	min-width: 0;
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.title {
	margin: 0;
	font-size: 1em;
	font-weight: 700;
}

.close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	margin: -8px -8px -8px 0;
}

.modes {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 4px;
	padding: 4px;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-buttonBg);
}

.mode {
	min-height: 40px;
	padding: 0 2px;
	border-radius: 8px;
	font-size: 0.85em;

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 1px;
	}

	&.selected {
		background: var(--MI_THEME-accent);
		color: var(--MI_THEME-fgOnAccent);
		font-weight: 700;
	}
}

.text {
	margin: 0;
	font-size: 0.9em;
	line-height: 1.7;
}

.manual {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.manualLink {
	display: flex;
	align-items: center;
	justify-content: space-between;
	min-height: 44px;
	padding: 0 16px;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
	font-weight: 700;
	text-decoration: none;
}

.settingsLink {
	display: flex;
	align-items: center;
	justify-content: space-between;
	min-height: 44px;
	border-top: solid 1px var(--MI_THEME-divider);
	color: inherit;
	text-decoration: none;
}
</style>
