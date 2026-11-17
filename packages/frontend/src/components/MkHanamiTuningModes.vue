<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.compact]: compact }]">
	<div v-if="!compact" :class="$style.ends" aria-hidden="true"><span>{{ t.automatic }}</span><span>{{ t.manualSide }}</span></div>
	<!-- 右へ行くほど、自分で決める量が増える。選んでいるしかたの所だけ色を付ける。 -->
	<svg aria-hidden="true" viewBox="0 0 100 14" preserveAspectRatio="none" :class="$style.wedge">
		<polygon points="0,14 100,0 100,14" :class="$style.wedgeAll"/>
		<polygon :points="selectedWedge" :class="$style.wedgeSelected"/>
	</svg>
	<div role="group" :aria-label="t.mode" :class="$style.segments">
		<button
			v-for="mode in HANAMI_TUNING_MODES" :key="mode" type="button" class="_button"
			:class="[$style.segment, { [$style.selected]: modelValue === mode }]" :aria-pressed="modelValue === mode" :aria-label="t._modes[mode]" :title="t._modes[mode]"
			:disabled="disabled" :data-mode="mode" @click="select(mode)"
		>{{ t._modeShort[mode] }}</button>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { HANAMI_TUNING_MODES } from '@/utility/hanami-tuning.js';
import type { HanamiTuningMode } from '@/utility/hanami-tuning.js';

const props = withDefaults(defineProps<{
	modelValue: HanamiTuningMode;
	disabled?: boolean;
	/** ポップアップ用の小さい表示。 */
	compact?: boolean;
}>(), { disabled: false, compact: false });

const emit = defineEmits<{
	(ev: 'update:modelValue', value: HanamiTuningMode): void;
}>();

const t = i18n.ts._hana._tuning;

// くさび形のうち、選んでいるしかたの幅のぶん。
const selectedWedge = computed(() => {
	const index = HANAMI_TUNING_MODES.indexOf(props.modelValue);
	const step = 100 / HANAMI_TUNING_MODES.length;
	const left = index * step;
	const right = left + step;
	const top = (x: number): number => 14 - 14 * x / 100;
	return `${left},14 ${left},${top(left)} ${right},${top(right)} ${right},14`;
});

function select(mode: HanamiTuningMode): void {
	if (props.disabled || props.modelValue === mode) return;
	emit('update:modelValue', mode);
}
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.ends {
	display: flex;
	justify-content: space-between;
	font-size: 0.8em;
	opacity: 0.75;
}

.wedge {
	display: block;
	width: 100%;
	height: 14px;
}

.wedgeAll {
	fill: var(--MI_THEME-divider);
}

.wedgeSelected {
	fill: var(--MI_THEME-accent);
}

.segments {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	border: solid 1px var(--MI_THEME-fg);
}

.segment {
	min-height: 44px;
	padding: 4px 2px;
	font-size: 0.85em;
	line-height: 1.3;
	text-align: center;

	& + & {
		border-left: solid 1px var(--MI_THEME-fg);
	}

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 2px;
	}

	&.selected {
		background: var(--MI_THEME-fg);
		color: var(--MI_THEME-panel);
		font-weight: 700;
	}
}

.compact {
	.wedge {
		height: 8px;
	}

	.segment {
		min-height: 40px;
		font-size: 0.8em;
	}
}
</style>
