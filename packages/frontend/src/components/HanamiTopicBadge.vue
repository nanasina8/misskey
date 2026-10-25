<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<span :class="[$style.badge, $style[kind]]">{{ label }}</span>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';

const props = defineProps<{ kind: 'new' | 'rising' | 'steady' }>();
const label = computed(() => ({ new: i18n.ts._hana._trends.kindNew, rising: i18n.ts._hana._trends.kindRising, steady: i18n.ts._hana._trends.kindSteady })[props.kind]);
</script>

<style lang="scss" module>
.badge { display: inline-block; border-radius: 4px; padding: 2px 5px; font-size: 0.85em; white-space: nowrap; }
.new { color: var(--MI_THEME-accent); background: var(--MI_THEME-accentedBg); }
.rising { color: var(--MI_THEME-warn); background: color-mix(in srgb, var(--MI_THEME-warn) 12%, transparent); }
.steady { color: var(--MI_THEME-fgTransparent); background: var(--MI_THEME-buttonBg); }
</style>
