<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<canvas ref="canvas" role="img" :aria-label="label"></canvas>
	<p v-if="!values.some(finiteMetric)" :class="$style.empty">{{ i18n.ts._hana._admin.unavailable }}</p>
</div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch } from 'vue';
import { Chart, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import type { Metric } from '@/scripts/hanami-metrics.js';
import { chartVLine } from '@/utility/chart-vline.js';
import { globalEvents } from '@/events.js';
import { i18n } from '@/i18n.js';
import { finiteMetric, seriesValues } from '@/scripts/hanami-metrics.js';

const props = withDefaults(defineProps<{ days: string[]; values: Metric[]; label: string; percent?: boolean }>(), { percent: false });
Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip);
const canvas = useTemplateRef('canvas');
let chart: Chart<'line', Metric[], string> | undefined;

function draw() {
	if (!canvas.value) return;
	chart?.destroy();
	const style = getComputedStyle(window.document.documentElement);
	const accent = style.getPropertyValue('--MI_THEME-accent').trim();
	const fg = style.getPropertyValue('--MI_THEME-fg').trim();
	const divider = style.getPropertyValue('--MI_THEME-divider').trim();
	chart = new Chart<'line', Metric[], string>(canvas.value, {
		type: 'line',
		data: { labels: props.days, datasets: [{ label: props.label, data: seriesValues(props.days, props.values, props.percent), borderColor: accent, backgroundColor: accent, borderWidth: 2, pointRadius: 2, spanGaps: false, fill: false }] },
		options: {
			responsive: true, maintainAspectRatio: false, animation: false,
			interaction: { mode: 'index', intersect: false },
			scales: {
				x: { ticks: { color: fg, maxTicksLimit: 7 }, grid: { color: divider } },
				y: { beginAtZero: true, ticks: { color: fg, callback: value => props.percent ? `${value}%` : value }, grid: { color: divider } },
			},
			plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${props.label}: ${context.parsed.y}${props.percent ? '%' : ''}` } } },
		},
		plugins: [chartVLine(divider)],
	});
}

watch(() => [props.days, props.values, props.label, props.percent], draw, { deep: true });
onMounted(() => { draw(); globalEvents.on('themeChanged', draw); });
onBeforeUnmount(() => { globalEvents.off('themeChanged', draw); chart?.destroy(); });
</script>

<style module lang="scss">
.root { position: relative; height: 220px; min-width: 0; }
.empty { position: absolute; inset: 35% 0 auto; text-align: center; background: var(--MI_THEME-panel); padding: 8px; }
</style>
