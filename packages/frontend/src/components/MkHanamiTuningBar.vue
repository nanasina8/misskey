<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.compact]: compact }]">
	<h3 :class="$style.title">{{ t.tilesTitle }}</h3>
	<div :class="$style.numbers">
		<div v-for="group in HANAMI_AXIS_GROUP_NAMES" :key="group" :class="$style.number" :data-group-count="group" :data-count="counts[group]">
			<span :class="$style.count">{{ counts[group] }}</span>
			<span :class="$style.name">
				<span :class="$style.swatch" :style="{ background: HANAMI_GROUP_FILLS[group] }" aria-hidden="true"></span>
				{{ compact ? t._groupShort[group] : t._groups[group] }}
			</span>
		</div>
	</div>
	<div :class="$style.figure">
		<!-- 帯は 10 件ぶん。下の目盛り 1 つが 1 件。 -->
		<div role="img" :aria-label="hanamiTilesLabel(counts)" :class="[$style.bar, { [$style.empty]: segments.length === 0 }]">
			<span
				v-for="segment in segments" :key="segment.group" :class="$style.segment"
				:style="{ flexGrow: segment.share, background: HANAMI_GROUP_FILLS[segment.group] }" :data-seg="segment.group"
			></span>
		</div>
		<div :class="$style.ruler" aria-hidden="true"><span v-for="n in 11" :key="n"></span></div>
		<div :class="$style.rulerLabels" aria-hidden="true"><span>0</span><span>5</span><span>{{ i18n.tsx._hana._tuning.count({ n: 10 }) }}</span></div>
		<!-- 「身近な人から」が動ける幅（かっこ）と、寄せる前の位置（縦の線）。文は下の rangeText で出す。 -->
		<div v-if="range" :class="$style.range" aria-hidden="true" data-testid="range">
			<span :class="$style.bracket" :style="{ left: `${range.low}%`, width: `${range.high - range.low}%` }" data-part="bracket"></span>
			<span :class="$style.base" :style="{ left: `${range.base}%` }" data-part="base"></span>
		</div>
	</div>
	<p v-if="range && rangeText" :class="$style.note">{{ rangeText }}</p>
	<p v-if="note" :class="$style.note">{{ note }}</p>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { i18n } from '@/i18n.js';
import { HANAMI_AXIS_GROUP_NAMES } from '@/utility/hanami-tuning.js';
import type { HanamiAxisGroup, HanamiShareRange } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_FILLS, hanamiTilesLabel } from '@/utility/hanami-tuning-view.js';

const props = withDefaults(defineProps<{
	/** まとまりごとの件数（合計 10 件。hanamiTenTiles の結果）。 */
	counts: Record<HanamiAxisGroup, number>;
	/** まとまりごとの割合（帯の幅に使う）。無ければ件数で分ける。 */
	shares?: Record<HanamiAxisGroup, number> | null;
	/** 反応に合わせて動ける幅。自動で動かないしかたでは null。 */
	range?: HanamiShareRange | null;
	/** 動ける幅の説明の文。 */
	rangeText?: string | null;
	/** 下に出す一言。 */
	note?: string | null;
	/** ポップアップ用の小さい表示。 */
	compact?: boolean;
}>(), { shares: null, range: null, rangeText: null, note: null, compact: false });

const t = i18n.ts._hana._tuning;

// 何も出ない設定（すべて 0%）では、帯は空の枠だけになる。
const segments = computed(() => HANAMI_AXIS_GROUP_NAMES
	.map(group => ({ group, share: Math.max(0, (props.shares ?? props.counts)[group]) }))
	.filter(segment => segment.share > 0));
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: 10px;
	min-width: 0;
}

.title {
	margin: 0;
	font-size: 0.95em;
	font-weight: 700;
}

.numbers {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: 8px 20px;
}

.number {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.count {
	font-size: 40px;
	font-weight: 700;
	line-height: 1;
	font-variant-numeric: tabular-nums;
}

.name {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 0.85em;
}

.swatch {
	flex: 0 0 auto;
	width: 12px;
	height: 12px;
}

.figure {
	display: flex;
	flex-direction: column;
}

.bar {
	display: flex;
	gap: 2px;
	height: 40px;

	&.empty {
		background: var(--MI_THEME-divider);
	}
}

.segment {
	flex: 0 1 0;
	min-width: 0;
}

.ruler {
	display: flex;
	justify-content: space-between;
	height: 6px;

	> span {
		width: 1px;
		background: var(--MI_THEME-fg);
	}
}

.rulerLabels {
	position: relative;
	height: 1.5em;
	font-size: 0.8em;
	opacity: 0.75;
	font-variant-numeric: tabular-nums;

	> span {
		position: absolute;
		top: 0;

		&:nth-child(1) { left: 0; }
		&:nth-child(2) { left: 50%; transform: translateX(-50%); }
		&:nth-child(3) { right: 0; }
	}
}

.range {
	position: relative;
	height: 14px;
	margin-top: 4px;
}

.bracket {
	position: absolute;
	top: 4px;
	height: 8px;
	box-sizing: border-box;
	border: solid 2px var(--MI_THEME-fg);
	border-top: none;
}

.base {
	position: absolute;
	top: 0;
	width: 2px;
	height: 12px;
	margin-left: -1px;
	background: var(--MI_THEME-fg);
}

.note {
	margin: 0;
	font-size: 0.85em;
	line-height: 1.6;
	opacity: 0.8;
}

.compact {
	gap: 8px;

	.count {
		font-size: 28px;
	}

	.numbers {
		gap: 4px 16px;
	}

	.bar {
		height: 28px;
	}
}
</style>
