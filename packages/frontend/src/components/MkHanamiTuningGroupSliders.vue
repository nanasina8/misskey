<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.compact]: compact }]">
	<MkHanamiTuningRange
		v-for="group in HANAMI_AXIS_GROUP_NAMES" :key="group"
		:modelValue="modelValue[group]" :max="4" :showTicks="true" :swatch="HANAMI_GROUP_FILLS[group]"
		:label="t._groups[group]" :valueText="hanamiLevelName(modelValue[group])" :textConverter="hanamiLevelName" :disabled="disabled"
		@update:modelValue="set(group, $event)"
	>
		<template v-if="!compact && recommended" #caption>
			<div :class="$style.ticks">
				<span :class="$style.mark" :style="markStyle(recommended[group])">{{ i18n.tsx._hana._tuning.recommendChip({ level: hanamiLevelName(recommended[group]) }) }}</span>
			</div>
		</template>
	</MkHanamiTuningRange>
</div>
</template>

<script lang="ts" setup>
import MkHanamiTuningRange from '@/components/MkHanamiTuningRange.vue';
import { i18n } from '@/i18n.js';
import { HANAMI_AXIS_GROUP_NAMES } from '@/utility/hanami-tuning.js';
import type { HanamiAxisGroup } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_FILLS, hanamiLevelName } from '@/utility/hanami-tuning-view.js';

const props = withDefaults(defineProps<{
	/** まとまりごとの量 0〜4。 */
	modelValue: Record<HanamiAxisGroup, number>;
	/** おすすめの段階（印を出す）。まだ無ければ null。 */
	recommended?: Record<HanamiAxisGroup, number> | null;
	disabled?: boolean;
	compact?: boolean;
}>(), { recommended: null, disabled: false, compact: false });

const emit = defineEmits<{
	(ev: 'update:modelValue', value: Record<HanamiAxisGroup, number>): void;
}>();

const t = i18n.ts._hana._tuning;

// スライダーのつまみの位置（0%〜100%）に合わせて、端では内側に寄せる。
function markStyle(level: number): Record<string, string> {
	const shift = level <= 0 ? '0' : level >= 4 ? '-100%' : '-50%';
	return { left: `${level * 25}%`, transform: `translateX(${shift})` };
}

function set(group: HanamiAxisGroup, value: number): void {
	if (props.disabled) return;
	const level = Math.max(0, Math.min(4, Math.round(value)));
	if (level === props.modelValue[group]) return;
	emit('update:modelValue', { ...props.modelValue, [group]: level });
}
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.ticks {
	position: relative;
	height: 1.6em;
	font-size: 0.8em;
}

.mark {
	position: absolute;
	top: 0;
	white-space: nowrap;
	color: var(--MI_THEME-accent);
	font-weight: 700;

	&::before {
		content: "▲ ";
		font-size: 0.8em;
	}
}

.compact {
	gap: 4px;
}
</style>
