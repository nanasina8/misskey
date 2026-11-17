<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div role="group" :aria-label="t.directionTitle" :class="[$style.root, { [$style.compact]: compact }]">
	<button
		v-for="(choice, index) in choices" :key="index" type="button" class="_button"
		:class="[$style.choice, { [$style.selected]: modelValue === index }]" :aria-pressed="modelValue === index" :aria-label="choice.label" :disabled="disabled"
		@click="select(index)"
	>
		<span :class="$style.name">{{ choice.name }}</span>
		<!-- その方向にしたときの、実際の割合の帯。 -->
		<span :class="$style.bar" aria-hidden="true">
			<span v-for="segment in choice.segments" :key="segment.group" :style="{ flexGrow: segment.share, background: HANAMI_GROUP_FILLS[segment.group] }"></span>
		</span>
		<span :class="$style.ratio" aria-hidden="true">{{ choice.ratio }}</span>
	</button>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { HANAMI_AXIS_GROUP_NAMES, hanamiTenTiles } from '@/utility/hanami-tuning.js';
import type { HanamiAxisGroup } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_FILLS, hanamiDirectionName, hanamiTilesLabel } from '@/utility/hanami-tuning-view.js';

const props = withDefaults(defineProps<{
	/** 0 = 身近な人中心 / 1 = バランス / 2 = 広く出会う */
	modelValue: number;
	/** 方向ごとの、まとまりの割合（hanamiDirectionPreviews の結果）。 */
	previews: Record<HanamiAxisGroup, number>[];
	disabled?: boolean;
	compact?: boolean;
}>(), { disabled: false, compact: false });

const emit = defineEmits<{
	(ev: 'update:modelValue', value: number): void;
}>();

const t = i18n.ts._hana._tuning;

const choices = computed(() => props.previews.map((shares, index) => {
	const counts = hanamiTenTiles(shares);
	const name = hanamiDirectionName(index);
	return {
		name,
		segments: HANAMI_AXIS_GROUP_NAMES.map(group => ({ group, share: Math.max(0, shares[group]) })).filter(segment => segment.share > 0),
		ratio: HANAMI_AXIS_GROUP_NAMES.map(group => counts[group]).join(' : '),
		label: i18n.tsx._hana._tuning.directionLabel({ name, detail: hanamiTilesLabel(counts) }),
	};
}));

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
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-height: 80px;
	padding: 10px 8px;
	box-shadow: inset 0 0 0 1px var(--MI_THEME-divider);
	text-align: left;

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 2px;
	}

	&.selected {
		box-shadow: inset 0 0 0 2px var(--MI_THEME-fg);

		.name {
			font-weight: 700;
		}
	}
}

.name {
	font-size: 0.9em;
	line-height: 1.4;
}

.bar {
	display: flex;
	gap: 1px;
	height: 10px;

	> span {
		flex: 0 1 0;
		min-width: 0;
	}
}

.ratio {
	font-size: 0.8em;
	opacity: 0.75;
	font-variant-numeric: tabular-nums;
}

.compact {
	.choice {
		min-height: 72px;
		padding: 8px 6px;
	}

	.name {
		font-size: 0.8em;
	}
}
</style>
