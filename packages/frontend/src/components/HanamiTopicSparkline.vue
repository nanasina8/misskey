<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="series.length >= 2" :class="[$style.graph, { [$style.large]: large }]">
	<svg :width="large ? '100%' : 64" :height="height" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" aria-hidden="true">
		<polygon :points="area" :class="$style.area"/>
		<polyline :points="line" :class="$style.line" vector-effect="non-scaling-stroke"/>
		<circle :cx="points.at(-1)?.x" :cy="points.at(-1)?.y" r="2.2" :class="$style.point"/>
	</svg>
	<div v-if="large" :class="$style.ticks"><span>{{ time(series[0].at) }}</span><span>{{ time(series.at(-1)!.at) }}</span></div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { versatileLang } from '@@/js/intl-const.js';

const props = withDefaults(defineProps<{ series: { at: string; authors: number }[]; large?: boolean; height?: number }>(), { large: false });
const width = computed(() => props.large ? 640 : 64);
const height = computed(() => props.height ?? (props.large ? 48 : 22));
const points = computed(() => {
	const max = Math.max(1, ...props.series.map(point => point.authors));
	const first = Date.parse(props.series[0]?.at ?? '');
	const duration = Date.parse(props.series.at(-1)?.at ?? '') - first;
	return props.series.map((point, index) => ({
		x: 2 + (duration > 0 ? (Date.parse(point.at) - first) / duration : index / Math.max(1, props.series.length - 1)) * (width.value - 4),
		y: height.value - 3 - (point.authors / max) * (height.value - 5),
	}));
});
const line = computed(() => points.value.map(point => `${point.x},${point.y}`).join(' '));
const area = computed(() => `2,${height.value - 3} ${line.value} ${width.value - 2},${height.value - 3}`);
const timeFormat = new Intl.DateTimeFormat(versatileLang, { hour: '2-digit', minute: '2-digit', hour12: false });

function time(at: string): string { return timeFormat.format(new Date(at)); }
</script>

<style lang="scss" module>
.graph { width: 64px; flex-shrink: 0; }
.large { width: 100%; }
.area { fill: var(--MI_THEME-accent); opacity: 0.12; }
.line { fill: none; stroke: var(--MI_THEME-accent); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.point { fill: var(--MI_THEME-accent); }
.ticks { display: flex; justify-content: space-between; font-size: 0.75em; color: var(--MI_THEME-fgTransparent); }
</style>
