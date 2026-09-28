<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps" :class="$style.root">
	<div :class="$style.legend"><span :class="$style.servedKey"></span>{{ t.share }} <span :class="$style.engagementKey"></span>{{ t.engagementShare }}</div>
	<div v-for="row in rows" :key="row.key">
		<div :class="$style.heading"><span>{{ row.label ?? row.key }}</span><strong><span v-tooltip="metricRatio(row.engagementShare, row.share) == null ? t.noValueYet : undefined">{{ display(metricRatio(row.engagementShare, row.share), 'ratio') }}</span></strong></div>
		<div :class="$style.track"><span v-if="shareWidth(row.share) !== null" :class="$style.served" :style="{ width: shareWidth(row.share) ?? undefined }"></span><span :class="$style.value">{{ t.share }}: <span v-tooltip="row.share == null ? t.noValueYet : undefined">{{ display(row.share, 'percent') }}</span></span></div>
		<div :class="$style.track"><span v-if="shareWidth(row.engagementShare) !== null" :class="$style.engagement" :style="{ width: shareWidth(row.engagementShare) ?? undefined }"></span><span :class="$style.value">{{ t.engagementShare }}: <span v-tooltip="row.engagementShare == null ? t.noValueYet : undefined">{{ display(row.engagementShare, 'percent') }}</span></span></div>
	</div>
	<p v-if="rows.length === 0">{{ t.noData }}</p>
</div>
</template>

<script setup lang="ts">
import type { Metric } from '@/scripts/hanami-metrics.js';
import { i18n } from '@/i18n.js';
import { formatMetric, metricRatio, shareWidth } from '@/scripts/hanami-metrics.js';

defineProps<{
	rows: { key: string; label?: string; share: Metric; engagementShare: Metric }[];
}>();
const t = i18n.ts._hana._admin;
const display = (value: Metric, kind: 'percent' | 'ratio') => formatMetric(value, t.unavailable, kind);
</script>

<style module lang="scss">
.root { min-width: 0; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: .85em; }
.servedKey, .engagementKey { width: 12px; height: 12px; border-radius: 3px; }
.servedKey, .served { background: #888; }
.engagementKey, .engagement { background: #58a65c; }
.heading { display: flex; justify-content: space-between; gap: 12px; overflow-wrap: anywhere; }
.track { position: relative; min-height: 26px; margin-top: 4px; background: var(--MI_THEME-panel); border-radius: 4px; overflow: hidden; }
.served, .engagement { position: absolute; inset: 0 auto 0 0; opacity: .3; }
.value { position: relative; display: block; padding: 4px 8px; font-size: .85em; }
</style>
