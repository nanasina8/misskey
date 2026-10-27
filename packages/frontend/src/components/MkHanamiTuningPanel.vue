<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.disabled]: disabled }]" class="_gaps_m" :inert="disabled" :aria-disabled="disabled">
	<h3 v-if="showTitle" :class="$style.title">{{ t.title }}</h3>
	<MkRadios :modelValue="tuning.mode" :options="[{ value: 'auto', label: t.auto, disabled }, { value: 'manual', label: t.manual, disabled }]" @update:modelValue="setMode"><template #label>{{ t.mode }}</template></MkRadios>
	<MkFolder @opened="loadSuggestion">
		<template #label>{{ t.suggestion }}</template>
		<template #caption>{{ t.period }}</template>
		<MkLoading v-if="suggestionLoading"/>
		<MkError v-else-if="suggestionError" @retry="loadSuggestion"/>
		<p v-else-if="!suggestion?.eligible">{{ t.ineligible }}</p>
		<div v-else class="_gaps_s">
			<p :class="$style.description">{{ t.suggestionDescription }}</p>
			<div :class="$style.legend"><span><i :class="$style.seenKey"></i>{{ t.seenShare }}</span><span><i :class="$style.reactionKey"></i>{{ t.reactionShare }}</span></div>
			<div v-for="axis in suggestionAxes" :key="axis.axis" class="_gaps_s">
				<div :class="$style.row"><span>{{ labels[axis.axis] }}</span><small>{{ i18n.tsx._hana._tuning.suggestionCounts({ seen: axis.seen, reactions: axis.reactions }) }}</small></div>
				<div :class="$style.meter" aria-hidden="true"><span :class="$style.seen" :style="{ width: `${axis.seen / suggestion.totalSeen * 100}%` }"></span></div>
				<div :class="$style.meter" aria-hidden="true"><span :class="$style.reactions" :style="{ width: `${axis.reactions / suggestion.totalReactions * 100}%` }"></span></div>
			</div>
			<p :class="$style.description">{{ suggestionSummary }}</p>
			<MkButton v-if="suggestionChanges.length > 0" primary :disabled="disabled" @click="applySuggestion">{{ t.applySuggestion }}</MkButton>
		</div>
	</MkFolder>
	<template v-if="tuning.mode === 'auto'">
		<MkHanamiTuningRange v-for="key in autoKeys" :key="key" :modelValue="tuning[key]" :max="4" :label="t[key]" :valueText="stepText(key, tuning[key])" :textConverter="value => stepText(key, value)" :disabled="disabled" @update:modelValue="setTuning({ ...tuning, [key]: $event })">
			<template #caption><div :class="$style.row"><span>{{ t[`${key}Left`] }}</span><span>{{ t[`${key}Right`] }}</span></div><p :class="$style.description">{{ t[`${key}Description`] }}</p></template>
		</MkHanamiTuningRange>
	</template>
	<template v-else>
		<section class="_gaps_m">
			<div><h4 :class="$style.title">{{ t.amounts }}</h4><small>{{ t.amountsDescription }}</small></div>
			<MkHanamiTuningRange v-for="axis in axes" :key="axis" :modelValue="manual.amounts[axis] ?? 1" :max="3" :step="0.05" :label="labels[axis]" :valueText="`${percent(manual.amounts[axis] ?? 1)} · ${approx(axis)}`" :textConverter="percent" :disabled="disabled || !available.has(axis)" @update:modelValue="setManual({ ...manual, amounts: { ...manual.amounts, [axis]: $event } })"/>
		</section>
		<section v-for="group in weightGroups" :key="group.key" class="_gaps_m">
			<div><h4 :class="$style.title">{{ t[group.key] }}</h4><small>{{ t[`${group.key}Description`] }}</small></div>
			<MkHanamiTuningRange v-for="(label, index) in group.labels" :key="index" :modelValue="manual[group.key][index]" :max="3" :step="0.05" :label="label" :valueText="weight(manual[group.key][index])" :textConverter="weight" :disabled="disabled" @update:modelValue="setWeight(group.key, index, $event)"/>
		</section>
		<section class="_gaps_s">
			<h4 :class="$style.title">{{ t.authorCap }}</h4>
			<MkRadios :modelValue="manual.authorCap" :options="[1, 2, 3, 4].map(n => ({ value: n, label: i18n.tsx._hana._tuning.authorCount({ n }), disabled }))" @update:modelValue="setManual({ ...manual, authorCap: $event })"><template #label>{{ t.per30 }}</template></MkRadios>
		</section>
	</template>
	<section class="_gaps_s">
		<h4 :class="$style.title">{{ t.composition }}</h4>
		<div :class="$style.composition" role="img" :aria-label="axes.map(axis => `${labels[axis]} ${approx(axis)}`).join(t.listSeparator)">
			<span v-for="(axis, index) in axes" :key="axis" :style="{ width: `${composition.get(axis)}%`, background: colors[index] }"></span>
		</div>
		<div :class="$style.legend"><span v-for="(axis, index) in axes" :key="axis"><i :style="{ background: colors[index] }"></i>{{ labels[axis] }} {{ approx(axis) }}</span></div>
	</section>
	<MkSwitch :modelValue="state!.hanamiReduceEphemeralPosts" :disabled="disabled" @update:modelValue="update({ ...state!, hanamiReduceEphemeralPosts: $event })">
		<template #label>{{ t.reduceEphemeral }}</template><template #caption>{{ t.reduceEphemeralDescription }}</template>
	</MkSwitch>
	<MkButton :disabled="disabled" @click="update(resetHanamiTuning())">{{ t.reset }}</MkButton>
</div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import type * as Misskey from 'misskey-js';
import MkRadios from '@/components/MkRadios.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkButton from '@/components/MkButton.vue';
import MkHanamiTuningRange from '@/components/MkHanamiTuningRange.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { HANAMI_TUNING_ORDER, hanamiComposition, resetHanamiTuning, resolveHanamiTuning, switchHanamiMode, roundHanamiWeight, getAvailableHanamiAxes } from '@/utility/hanami-tuning.js';
import type { HanamiAxis, HanamiTuning, HanamiTuningUpdate } from '@/utility/hanami-tuning.js';

const props = withDefaults(defineProps<{
	showTitle?: boolean;
	disabled?: boolean;
}>(), { showTitle: true, disabled: false });

const { state, config, update: saveTuning } = useHanamiTuning();
const t = i18n.ts._hana._tuning;
const axes = HANAMI_TUNING_ORDER;
const labels = i18n.ts._hana._tuning._axis;
const tuning = computed(() => state.value!.hanamiTuning);
const resolved = computed(() => resolveHanamiTuning({ hanamiTuning: tuning.value }, config));
const manual = computed(() => ({ amounts: Object.fromEntries(resolved.value.amounts), freshWeights: resolved.value.freshWeights, closeWeights: resolved.value.closeWeights, authorCap: resolved.value.authorCap }));
const available = new Set(getAvailableHanamiAxes(config));
const composition = computed(() => hanamiComposition(tuning.value, config));
const colors = ['accent', 'warn', 'link', 'hashtag', 'mention', 'success', 'fg'].map(name => `var(--MI_THEME-${name})`);
const autoKeys = ['closeness', 'freshness', 'discovery'] as const;
const weightGroups = [{ key: 'freshWeights' as const, labels: [t.within6h, t.within24h, t.older] }, { key: 'closeWeights' as const, labels: [t.following, t.follower, t.other] }];
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const weight = (value: number): string => `×${value}`;
const approx = (axis: HanamiAxis): string => i18n.tsx._hana._tuning.approxPercent({ n: Math.round(composition.value.get(axis) ?? 0) });
const stepText = (key: typeof autoKeys[number], value: number): string => t[`${key}${value as 0 | 1 | 2 | 3 | 4}`];

function update(value: HanamiTuningUpdate): void {
	if (props.disabled) return;
	saveTuning(value);
}

function setTuning(value: HanamiTuning): void { update({ ...state.value!, hanamiTuning: value }); }

function setMode(mode: HanamiTuning['mode']): void { setTuning(switchHanamiMode(tuning.value, mode, config)); }

function setManual(value: NonNullable<HanamiTuning['manual']>): void { setTuning({ ...tuning.value, manual: value }); }

function setWeight(key: 'freshWeights' | 'closeWeights', index: number, value: number): void {
	const weights = [...manual.value[key]];
	weights[index] = value;
	setManual({ ...manual.value, [key]: weights });
}

const suggestion = ref<Misskey.entities.IHanamiTuningSuggestionResponse | null>(null);
const suggestionLoading = ref(false);
const suggestionError = ref(false);

async function loadSuggestion(): Promise<void> {
	if (props.disabled || suggestionLoading.value) return;
	suggestionLoading.value = true;
	suggestionError.value = false;
	try { suggestion.value = await misskeyApi('i/hanami-tuning-suggestion', {}); } catch { suggestionError.value = true; } finally { suggestionLoading.value = false; }
}

// Rates are independent of the draft amounts; keep the preview current while editing.
const suggestionAxes = computed(() => {
	if (!suggestion.value) return [];
	const mean = suggestion.value.axes.reduce((sum, axis) => sum + axis.seen / (suggestion.value!.totalSeen || 1) * axis.rate, 0);
	return suggestion.value.axes.map(axis => {
		const current = resolved.value.amounts.get(axis.axis) ?? 0;
		let factor = mean > 0 ? Math.max(0.5, Math.min(2, Math.sqrt(axis.rate / mean))) : 1;
		if (axis.axis === 'exploration') factor = Math.max(1, factor);
		return { ...axis, current, suggested: roundHanamiWeight(current * factor) };
	});
});
// Weights have 0.05 steps; allow for floating-point subtraction at that boundary.
const suggestionChanges = computed(() => suggestionAxes.value.filter(axis => available.has(axis.axis) && Math.abs(axis.suggested - axis.current) >= 0.05 - 1e-9));
const suggestionSummary = computed(() => suggestionChanges.value.length === 0 ? t.suggestionUnchanged : i18n.tsx._hana._tuning.suggestionSummary({
	changes: suggestionChanges.value.map(axis => i18n.tsx._hana._tuning.suggestionChange({ axis: labels[axis.axis], current: Math.round(axis.current * 100), suggested: Math.round(axis.suggested * 100) })).join(t.listSeparator),
	seen: suggestion.value?.totalSeen ?? 0, reactions: suggestion.value?.totalReactions ?? 0,
}));

function applySuggestion(): void {
	if (!suggestion.value?.eligible || suggestionChanges.value.length === 0) return;
	const value = switchHanamiMode(tuning.value, 'manual', config);
	setTuning({ ...value, manual: { ...manual.value, amounts: Object.fromEntries(suggestionAxes.value.map(axis => [axis.axis, axis.suggested])) } });
}
</script>

<style lang="scss" module>
.root { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.disabled { opacity: 0.5; }
.title, .description { margin: 0; }
.description { font-size: 0.9em; line-height: 1.6; margin-top: 8px; opacity: 0.8; }
.row { display: flex; flex-wrap: wrap; gap: 4px 8px; justify-content: space-between; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 0.8em; }
.legend > span { display: inline-flex; align-items: center; gap: 4px; }
.legend i { display: inline-block; flex: 0 0 8px; height: 8px; border-radius: 50%; }
.composition { display: flex; height: 12px; border-radius: var(--MI-radius); overflow: clip; background: var(--MI_THEME-divider); }
.meter { height: 5px; background: var(--MI_THEME-divider); border-radius: var(--MI-radius); overflow: clip; }
.meter span { display: block; height: 100%; }
.seen, .seenKey { background: var(--MI_THEME-fg); opacity: 0.45; }
.reactions, .reactionKey { background: var(--MI_THEME-accent); }
</style>
