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
	<MkRange :modelValue="modelValue" :min="min" :max="max" :step="step" :disabled="disabled" :textConverter="textConverter" @update:modelValue="emit('update:modelValue', $event)">
		<template #label><span :class="$style.label">{{ label }}<span>{{ valueText }}</span></span></template>
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
}>(), { min: 0, step: 1, disabled: false });
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
</style>
