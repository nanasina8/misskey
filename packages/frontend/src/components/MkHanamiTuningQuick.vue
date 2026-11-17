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

	<MkHanamiTuningModes :modelValue="tuning.mode" compact @update:modelValue="setMode"/>

	<p v-if="tuning.mode === 'auto'" :class="$style.text">{{ t.autoDescription }}</p>
	<MkHanamiTuningDirection v-else-if="tuning.mode === 'direction'" :modelValue="tuning.direction" :previews="directionPreviews" compact @update:modelValue="setTuning({ ...tuning, direction: $event })"/>
	<MkHanamiTuningGroupSliders v-else-if="tuning.mode === 'recommend'" :modelValue="tuning.groups" compact @update:modelValue="setTuning({ ...tuning, groups: $event })"/>
	<div v-else :class="$style.manual">
		<p :class="$style.text">{{ t.manualDescription }}</p>
		<MkA to="/settings/hanamode" :class="$style.manualLink" class="_button" @click="emit('close')">
			<span>{{ t.openManual }}</span><i class="ti ti-chevron-right" aria-hidden="true"></i>
		</MkA>
	</div>

	<MkHanamiTuningBar :counts="tiles.counts" :shares="shares" :note="t.popupNote" compact/>

	<MkA to="/settings/hanamode" :class="$style.settingsLink" @click="emit('close')">
		<span>{{ t.openSettings }}</span><i class="ti ti-chevron-right" aria-hidden="true"></i>
	</MkA>
</div>
</template>

<script lang="ts" setup>
import { computed, onMounted } from 'vue';
import MkHanamiTuningBar from '@/components/MkHanamiTuningBar.vue';
import MkHanamiTuningDirection from '@/components/MkHanamiTuningDirection.vue';
import MkHanamiTuningGroupSliders from '@/components/MkHanamiTuningGroupSliders.vue';
import MkHanamiTuningModes from '@/components/MkHanamiTuningModes.vue';
import { i18n } from '@/i18n.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { useHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import { hanamiDirectionPreviews, hanamiGroupComposition, hanamiTilesSummary, switchHanamiModeWithSuggestion } from '@/utility/hanami-tuning.js';
import type { HanamiTuning, HanamiTuningMode } from '@/utility/hanami-tuning.js';

const emit = defineEmits<{
	(ev: 'close'): void;
}>();

const { state, config, update } = useHanamiTuning();
const { suggestion, factors, load } = useHanamiTuningSuggestion();
const t = i18n.ts._hana._tuning;
const tuning = computed(() => state.value!.hanamiTuning);
const tiles = computed(() => hanamiTilesSummary(tuning.value, config, factors.value));
const shares = computed(() => hanamiGroupComposition(tuning.value, config, factors.value));
const directionPreviews = computed(() => hanamiDirectionPreviews(tuning.value, config));

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
	background: var(--MI_THEME-fg);
	color: var(--MI_THEME-panel);
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
