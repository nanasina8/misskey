<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div
	role="slider" tabindex="0" :aria-label="label" :aria-valuemin="min" :aria-valuemax="max"
	:aria-valuenow="modelValue" :aria-valuetext="valueText" :aria-disabled="disabled" :aria-describedby="captionId" :class="$style.root"
	@keydown="onKeydown"
>
	<MkRange :modelValue="modelValue" :min="min" :max="max" :step="step" :disabled="disabled" :showTicks="showTicks" :textConverter="textConverter" @update:modelValue="emit('update:modelValue', $event)">
		<template #label>
			<span :class="$style.label">
				<span :class="$style.name"><span v-if="swatch" :class="$style.swatch" :style="{ background: swatch }" aria-hidden="true"></span>{{ label }}</span>
				<span :class="$style.value">{{ valueText }}</span>
			</span>
		</template>
		<template #caption><div :id="captionId"><slot name="caption"></slot></div></template>
	</MkRange>
</div>
</template>

<script lang="ts" setup>
import { useId } from 'vue';
import MkRange from '@/components/MkRange.vue';
const props = withDefaults(defineProps<{
	modelValue: number; min?: number; max: number; step?: number; label: string; valueText: string; disabled?: boolean;
	textConverter?: (value: number) => string;
	/** 目盛りを出す（段階が少ないとき）。 */
	showTicks?: boolean;
	/** ラベルの前に出す小さな見本（CSS の background。色でも柄でもよい）。 */
	swatch?: string;
}>(), { min: 0, step: 1, disabled: false, showTicks: false });
const emit = defineEmits<{ (ev: 'update:modelValue', value: number): void }>();
const captionId = useId();

function onKeydown(event: KeyboardEvent): void {
	if (props.disabled) return;
	const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 0;
	if (direction === 0 && event.key !== 'Home' && event.key !== 'End') return;
	event.preventDefault();
	const value = event.key === 'Home' ? props.min : event.key === 'End' ? props.max : props.modelValue + direction * props.step;
	emit('update:modelValue', Math.round(Math.max(props.min, Math.min(props.max, value)) * 100) / 100);
}
</script>

<style lang="scss" module>
.root { min-width: 0; }
.label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-variant-numeric: tabular-nums; }
.name { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; }
.swatch { flex: 0 0 auto; width: 12px; height: 12px; }
.value { opacity: 0.75; }
</style>
