<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div role="group" :aria-label="t.directionTitle" :class="[$style.root, { [$style.compact]: compact }]">
	<button
		v-for="(choice, index) in choices" :key="index" type="button" class="_button"
		:class="[$style.choice, { [$style.selected]: modelValue === index }]" :aria-pressed="modelValue === index" :disabled="disabled"
		@click="select(index)"
	>
		<!-- 真ん中があなた。内側の輪が身近、外側の輪が広く。点の色はまとまりの色。 -->
		<svg aria-hidden="true" viewBox="0 0 96 64" :class="$style.figure">
			<circle cx="48" cy="32" r="14" :class="$style.ring"/>
			<circle cx="48" cy="32" r="26" :class="[$style.ring, $style.outer]"/>
			<circle v-for="(dot, i) in choice.dots" :key="i" :cx="dot[1]" :cy="dot[2]" r="4" :style="{ fill: HANAMI_GROUP_COLORS[dot[0]] }"/>
			<circle cx="48" cy="32" r="6" :class="$style.me"/>
		</svg>
		<span :class="$style.name">{{ hanamiDirectionName(index) }}</span>
		<i v-if="modelValue === index" class="ti ti-check" :class="$style.check" aria-hidden="true"></i>
	</button>
</div>
</template>

<script lang="ts" setup>
import { i18n } from '@/i18n.js';
import type { HanamiAxisGroup } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_COLORS, hanamiDirectionName } from '@/utility/hanami-tuning-view.js';

const props = withDefaults(defineProps<{
	/** 0 = 身近な人中心 / 1 = バランス / 2 = 広く出会う */
	modelValue: number;
	disabled?: boolean;
	compact?: boolean;
}>(), { disabled: false, compact: false });

const emit = defineEmits<{
	(ev: 'update:modelValue', value: number): void;
}>();

const t = i18n.ts._hana._tuning;

type Dot = readonly [HanamiAxisGroup, number, number];
// 点の数は、その方向でのおよその割合（身近・話題・出会い）を表す。
const choices: { dots: readonly Dot[] }[] = [
	{ dots: [['close', 62, 32], ['close', 55, 44.1], ['close', 41, 44.1], ['close', 34, 32], ['close', 41, 19.9], ['close', 55, 19.9], ['buzz', 70.5, 19]] },
	{ dots: [['close', 57.9, 41.9], ['close', 38.1, 41.9], ['close', 38.1, 22.1], ['close', 57.9, 22.1], ['buzz', 70.5, 45], ['buzz', 25.5, 19], ['fresh', 48, 6]] },
	{ dots: [['close', 62, 32], ['close', 34, 32], ['buzz', 70.5, 45], ['buzz', 25.5, 19], ['fresh', 48, 6], ['fresh', 48, 58], ['fresh', 25.5, 45], ['fresh', 70.5, 19]] },
];

function select(index: number): void {
	if (props.disabled || props.modelValue === index) return;
	emit('update:modelValue', index);
}
</script>

<style lang="scss" module>
.root {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
}

.choice {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	min-height: 112px;
	padding: 8px 4px;
	border: 2px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	text-align: center;

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 2px;
	}

	&.selected {
		border-color: var(--MI_THEME-accent);
		background: var(--MI_THEME-accentedBg);
	}
}

.figure {
	width: 100%;
	height: 56px;
}

.ring {
	fill: none;
	stroke: var(--MI_THEME-divider);
	stroke-width: 1.5;
}

.outer {
	stroke-dasharray: 3 3;
}

.me {
	fill: var(--MI_THEME-accent);
}

.name {
	font-size: 0.85em;
	font-weight: 700;
	line-height: 1.4;
}

.check {
	position: absolute;
	top: 6px;
	right: 6px;
	color: var(--MI_THEME-accent);
	font-size: 14px;
}

.compact {
	.choice {
		min-height: 96px;
	}

	.figure {
		height: 46px;
	}

	.name {
		font-size: 0.8em;
	}
}
</style>
