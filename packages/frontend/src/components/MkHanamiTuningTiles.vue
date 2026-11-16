<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.compact]: compact }]">
	<h3 :class="$style.title">{{ t.tilesTitle }}</h3>
	<div role="img" :aria-label="hanamiTilesLabel(counts)" :class="$style.tiles">
		<span
			v-for="(group, index) in tiles" :key="index" :class="[$style.tile, { [$style.empty]: group == null }]"
			:style="group ? { background: HANAMI_GROUP_COLORS[group] } : undefined" :data-group="group ?? undefined"
		><i v-if="group" :class="HANAMI_GROUP_ICONS[group]" aria-hidden="true"></i></span>
	</div>
	<div :class="$style.legend">
		<span v-for="group in HANAMI_AXIS_GROUP_NAMES" :key="group" :class="$style.legendItem" :data-group-count="group">
			<span :class="$style.swatch" :style="{ background: HANAMI_GROUP_COLORS[group] }" aria-hidden="true"></span>
			<span :class="$style.legendName">{{ compact ? t._groupShort[group] : t._groups[group] }}</span>
			<span :class="$style.legendCount">{{ i18n.tsx._hana._tuning.count({ n: counts[group] }) }}</span>
		</span>
	</div>
	<p v-if="note" :class="$style.note">{{ note }}</p>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { HANAMI_AXIS_GROUP_NAMES } from '@/utility/hanami-tuning.js';
import type { HanamiAxisGroup } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_COLORS, HANAMI_GROUP_ICONS, hanamiTilesLabel } from '@/utility/hanami-tuning-view.js';

const props = withDefaults(defineProps<{
	/** まとまりごとの件数（合計 10 件。hanamiTenTiles の結果）。 */
	counts: Record<HanamiAxisGroup, number>;
	/** 下に出す一言。 */
	note?: string | null;
	/** ポップアップ用の小さい表示。 */
	compact?: boolean;
}>(), { note: null, compact: false });

const t = i18n.ts._hana._tuning;

// 何も出ない設定（すべて 0%）でも、10 枚の枠は残す。
const tiles = computed<(HanamiAxisGroup | null)[]>(() => {
	const list: (HanamiAxisGroup | null)[] = HANAMI_AXIS_GROUP_NAMES.flatMap(group => Array<HanamiAxisGroup>(Math.max(0, props.counts[group])).fill(group));
	while (list.length < 10) list.push(null);
	return list.slice(0, 10);
});
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-width: 0;
}

.title {
	margin: 0;
	font-size: 1em;
	font-weight: 700;
}

.tiles {
	display: grid;
	grid-template-columns: repeat(10, minmax(0, 1fr));
	gap: 4px;
}

.tile {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 40px;
	border-radius: 8px;
	color: var(--MI-hanamiGroupOn);
	font-size: 16px;

	&.empty {
		background: var(--MI_THEME-divider);
	}
}

.legend {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 16px;
	font-size: 0.9em;
}

.legendItem {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.swatch {
	flex: 0 0 auto;
	width: 10px;
	height: 10px;
	border-radius: 3px;
}

.legendName {
	opacity: 0.8;
}

.legendCount {
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

.note {
	margin: 0;
	font-size: 0.85em;
	line-height: 1.6;
	opacity: 0.8;
}

.compact {
	.tile {
		height: 32px;
		font-size: 14px;
	}

	.legend {
		font-size: 0.8em;
		gap: 4px 12px;
	}
}
</style>
