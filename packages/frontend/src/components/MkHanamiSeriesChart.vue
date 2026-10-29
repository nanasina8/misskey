<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root">
	<canvas ref="canvas" role="img" :aria-label="label"></canvas>
	<p v-if="!values.some(finiteMetric)" v-tooltip="i18n.ts._hana._admin.noValueYet" :class="$style.empty">{{ i18n.ts._hana._admin.unavailable }}</p>
</div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch } from 'vue';
import { Chart, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import type { Metric } from '@/scripts/hanami-metrics.js';
import { chartVLine } from '@/utility/chart-vline.js';
import { themeManager } from '@/theme.js';
import { i18n } from '@/i18n.js';
import { finiteMetric, seriesValues } from '@/scripts/hanami-metrics.js';
import { shortDay } from '@/scripts/hanami-admin-overview.js';

const props = withDefaults(defineProps<{ days: string[]; values: Metric[]; label: string; percent?: boolean; warn?: boolean }>(), { percent: false, warn: false });
Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip);
const canvas = useTemplateRef('canvas');
let chart: Chart<'line', Metric[], string> | undefined;

function draw() {
	if (!canvas.value) return;
	chart?.destroy();
	const style = getComputedStyle(window.document.documentElement);
	const accent = style.getPropertyValue(props.warn ? '--MI_THEME-warn' : '--MI_THEME-accent').trim();
	const fg = style.getPropertyValue('--MI_THEME-fg').trim();
	const divider = style.getPropertyValue('--MI_THEME-divider').trim();
	chart = new Chart<'line', Metric[], string>(canvas.value, {
		type: 'line',
		data: { labels: props.days.map(shortDay), datasets: [{ label: props.label, data: seriesValues(props.days, props.values, props.percent), borderColor: accent, backgroundColor: accent, borderWidth: 2, pointRadius: 2, spanGaps: false, fill: false }] },
		options: {
			responsive: true, maintainAspectRatio: false, animation: false,
			interaction: { mode: 'index', intersect: false },
			scales: {
				// Short M/D labels stay horizontal instead of rotating.
				x: { ticks: { color: fg, maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { color: divider } },
				y: { beginAtZero: true, ticks: { color: fg, precision: props.percent ? undefined : 0, callback: value => props.percent ? `${value}%` : value }, grid: { color: divider } },
			},
			plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${props.label}: ${context.parsed.y}${props.percent ? '%' : ''}` } } },
		},
		plugins: [chartVLine(divider)],
	});
}

watch(() => [props.days, props.values, props.label, props.percent, props.warn], draw, { deep: true });
onMounted(() => { draw(); themeManager.on('themeChanged', draw); });
onBeforeUnmount(() => { themeManager.off('themeChanged', draw); chart?.destroy(); });
</script>

<style module lang="scss">
.root { position: relative; height: 220px; min-width: 0; }
.empty { position: absolute; inset: 35% 0 auto; text-align: center; background: var(--MI_THEME-panel); padding: 8px; }
</style>
