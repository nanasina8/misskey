<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.disabled]: disabled }]" :inert="disabled">
	<!-- 1. 調整のしかた -->
	<section :class="$style.card">
		<h2 :class="$style.heading">{{ t.mode }}</h2>
		<div :class="$style.scale" aria-hidden="true">
			<div :class="$style.scaleTrack">
				<span v-for="mode in HANAMI_TUNING_MODES" :key="mode" :class="[$style.scaleDot, { [$style.scaleDotActive]: tuning.mode === mode }]"></span>
			</div>
			<div :class="$style.scaleLabels"><span>{{ t.automatic }}</span><span>{{ t.manualSide }}</span></div>
		</div>
		<div role="group" :aria-label="t.mode" :class="$style.modes">
			<button
				v-for="mode in HANAMI_TUNING_MODES" :key="mode" type="button" class="_button"
				:class="[$style.mode, { [$style.selected]: tuning.mode === mode }]" :aria-pressed="tuning.mode === mode" :disabled="disabled"
				:data-mode="mode" @click="setMode(mode)"
			>
				<span :class="$style.modeIcon" aria-hidden="true"><i :class="HANAMI_MODE_ICONS[mode]"></i></span>
				<span :class="$style.modeName">{{ t._modes[mode] }}</span>
				<span :class="$style.modeCaption">{{ t._modeCaptions[mode] }}</span>
				<i v-if="tuning.mode === mode" class="ti ti-check" :class="$style.modeCheck" aria-hidden="true"></i>
			</button>
		</div>
	</section>

	<!-- 2. 選んだしかたの中身 と 3. いまは、10 件のうち -->
	<section :class="$style.card">
		<div v-if="tuning.mode === 'auto'" :class="$style.stack">
			<h2 :class="$style.heading">{{ t._modes.auto }}</h2>
			<p :class="$style.text">{{ t.autoDescription }}</p>
		</div>

		<div v-else-if="tuning.mode === 'direction'" :class="$style.stack">
			<h2 :class="$style.heading">{{ t.directionTitle }}</h2>
			<MkHanamiTuningDirection :modelValue="tuning.direction" :disabled="disabled" @update:modelValue="setTuning({ ...tuning, direction: $event })"/>
			<div :class="$style.stack">
				<h3 :class="$style.subheading">{{ t.rangeTitle }}</h3>
				<div role="img" :aria-label="bandLabel" :class="$style.band" data-testid="direction-band">
					<span :class="$style.bandTrack"></span>
					<span :class="$style.bandRange" :style="{ left: `${band.low}%`, width: `${band.high - band.low}%` }" data-part="range"></span>
					<span :class="$style.bandBase" :style="{ left: `${band.base}%` }" data-part="base"></span>
					<span :class="$style.bandNow" :style="{ left: `${band.now}%` }" data-part="now"></span>
				</div>
				<div :class="$style.bandEnds" aria-hidden="true"><span>{{ t.rangeClose }}</span><span>{{ t.rangeWide }}</span></div>
				<div :class="$style.bandLegend" aria-hidden="true">
					<span><span :class="[$style.bandKey, $style.bandKeyBase]"></span>{{ t.rangeBase }}</span>
					<span><span :class="[$style.bandKey, $style.bandKeyNow]"></span>{{ t.rangeNow }}</span>
					<span><span :class="[$style.bandKey, $style.bandKeyRange]"></span>{{ t.rangeBand }}</span>
				</div>
			</div>
			<div :class="$style.stack">
				<h3 :id="driftHeadingId" :class="$style.subheading">{{ t.drift }}</h3>
				<div role="group" :aria-labelledby="driftHeadingId" :class="$style.segments">
					<button
						v-for="drift in [0, 1, 2]" :key="drift" type="button" class="_button"
						:class="[$style.segment, { [$style.selected]: tuning.drift === drift }]" :aria-pressed="tuning.drift === drift" :disabled="disabled"
						@click="setTuning({ ...tuning, drift })"
					>{{ hanamiDriftName(drift) }}</button>
				</div>
			</div>
		</div>

		<div v-else-if="tuning.mode === 'recommend'" :class="$style.stack">
			<h2 :class="$style.heading">{{ t._modes.recommend }}</h2>
			<p :class="$style.text">{{ t.recommendDescription }}</p>
			<MkHanamiTuningGroupSliders :modelValue="tuning.groups" :recommended="suggestion?.groups ?? null" :disabled="disabled" @update:modelValue="setTuning({ ...tuning, groups: $event })"/>
			<div :class="$style.buttons">
				<MkButton :disabled="disabled || !suggestion || sameGroups" @click="resetRecommend">{{ t.resetRecommend }}</MkButton>
			</div>
		</div>

		<div v-else :class="$style.stack">
			<h2 :class="$style.heading">{{ t._modes.manual }}</h2>
			<p :class="$style.text">{{ t.manualDescription }}</p>
			<div v-for="group in manualGroups" :key="group.group" :class="$style.manualGroup">
				<h3 :class="$style.subheading"><span :class="$style.swatch" :style="{ background: HANAMI_GROUP_COLORS[group.group] }" aria-hidden="true"></span>{{ t._groups[group.group] }}</h3>
				<MkHanamiTuningRange
					v-for="axis in group.axes" :key="axis"
					:modelValue="manualAmounts.get(axis) ?? 0" :max="3" :step="0.05" :label="t._axis[axis]"
					:valueText="percent(manualAmounts.get(axis) ?? 0)" :textConverter="percent" :disabled="disabled"
					@update:modelValue="setAmount(axis, $event)"
				>
					<template #caption><span :class="$style.caption">{{ t._axisDescriptions[axis] }}</span></template>
				</MkHanamiTuningRange>
			</div>
			<p :class="$style.caption">{{ t.manualHint }}</p>
			<MkRadios :modelValue="manualAuthorCap" :options="authorCapOptions" @update:modelValue="setAuthorCap">
				<template #label>{{ t.authorCap }}</template>
				<template #caption>{{ t.per30 }}</template>
			</MkRadios>
			<div :class="$style.buttons">
				<MkButton :disabled="disabled || !suggestion" @click="applySuggestion">{{ t.applySuggestion }}</MkButton>
			</div>
		</div>

		<hr :class="$style.divider">
		<MkHanamiTuningTiles :counts="tiles.counts" :note="tilesNote" data-testid="tiles"/>
	</section>

	<!-- 4. あなたの反応から -->
	<section :class="$style.card" data-testid="reactions">
		<div>
			<h2 :class="$style.heading">{{ t.suggestion }}</h2>
			<p :class="$style.caption">{{ t.period }}</p>
		</div>
		<MkError v-if="!suggestion && status === 'error'" @retry="load(true)"/>
		<MkLoading v-else-if="!suggestion && !disabled"/>
		<template v-else-if="suggestion">
			<p v-if="suggestion.totalSeen === 0" :class="$style.text">{{ t.noActivity }}</p>
			<template v-else>
				<div :class="$style.barLegend" aria-hidden="true">
					<span><span :class="[$style.barKey, $style.seenBar]"></span>{{ t.seenShare }}</span>
					<span><span :class="[$style.barKey, $style.reactedBar]"></span>{{ t.reactionShare }}</span>
				</div>
				<div v-for="row in reactionRows" :key="row.group" :class="$style.reactionRow" :data-group="row.group">
					<span :class="$style.reactionIcon" :style="{ background: HANAMI_GROUP_COLORS[row.group] }" aria-hidden="true"><i :class="HANAMI_GROUP_ICONS[row.group]"></i></span>
					<div :class="$style.reactionBody">
						<div :class="$style.reactionHead">
							<span :class="$style.reactionName">{{ t._groups[row.group] }}</span>
							<span :class="[$style.chip, { [$style.chipUp]: row.tone === 'up', [$style.chipDown]: row.tone === 'down' }]" data-part="chip">
								<i v-if="row.tone === 'up'" class="ti ti-arrow-up" aria-hidden="true"></i>
								<i v-else-if="row.tone === 'down'" class="ti ti-arrow-down" aria-hidden="true"></i>
								{{ row.chip }}
							</span>
						</div>
						<div :class="$style.bars" aria-hidden="true">
							<span :class="$style.barTrack"><span :class="$style.seenBar" :style="{ width: `${row.seen}%` }"></span></span>
							<span :class="$style.barTrack"><span :class="$style.reactedBar" :style="{ width: `${row.reactions}%` }"></span></span>
						</div>
						<span :class="$style.caption">{{ i18n.tsx._hana._tuning.shares({ seen: row.seen, reactions: row.reactions }) }}</span>
					</div>
				</div>
			</template>
			<p v-if="!suggestion.eligible" :class="$style.notice" data-testid="ineligible">
				<i class="ti ti-info-circle" aria-hidden="true"></i>
				{{ i18n.tsx._hana._tuning.ineligible({ seen: suggestion.minSeen, reactions: suggestion.minReactions }) }}
			</p>
			<p :class="$style.caption">{{ reactionsNote }}</p>
			<MkFolder>
				<template #label>{{ t.perAxis }}</template>
				<div :class="$style.axisList">
					<div v-for="axis in suggestionAxes" :key="axis.axis" :class="$style.axisRow">
						<span>{{ t._axis[axis.axis] }}</span>
						<span :class="$style.caption">{{ i18n.tsx._hana._tuning.suggestionCounts({ seen: axis.seen, reactions: axis.reactions }) }}</span>
					</div>
				</div>
			</MkFolder>
		</template>
	</section>

	<!-- 5. 内訳 -->
	<MkFolder>
		<template #icon><i class="ti ti-stack-2"></i></template>
		<template #label>{{ t.breakdown }}</template>
		<div :class="$style.stack">
			<section v-for="group in breakdown" :key="group.group" :class="$style.breakdownGroup">
				<div :class="$style.breakdownHead">
					<span :class="$style.reactionIcon" :style="{ background: HANAMI_GROUP_COLORS[group.group] }" aria-hidden="true"><i :class="HANAMI_GROUP_ICONS[group.group]"></i></span>
					<div :class="$style.breakdownTitle">
						<h3 :class="$style.subheading">{{ t._groups[group.group] }}</h3>
						<span :class="$style.caption">{{ t._groupCaptions[group.group] }}</span>
					</div>
					<span :class="$style.breakdownShare">{{ i18n.tsx._hana._tuning.count({ n: group.share }) }}</span>
				</div>
				<div v-for="axis in group.axes" :key="axis.axis" :class="$style.breakdownAxis">
					<div :class="$style.reactionHead">
						<span>{{ t._axis[axis.axis] }}</span>
						<span :class="$style.breakdownShare">{{ i18n.tsx._hana._tuning.count({ n: axis.share }) }}</span>
					</div>
					<span :class="$style.barTrack" aria-hidden="true"><span :style="{ width: `${axis.width}%`, background: HANAMI_GROUP_COLORS[group.group] }"></span></span>
					<span :class="$style.caption">{{ t._axisDescriptions[axis.axis] }}</span>
				</div>
			</section>
			<p :class="$style.caption">{{ t.breakdownNote }}</p>
		</div>
	</MkFolder>

	<!-- 6. そのほか -->
	<section :class="$style.card">
		<h2 :class="$style.heading">{{ t.others }}</h2>
		<MkSwitch :modelValue="state!.hanamiReduceEphemeralPosts" :disabled="disabled" @update:modelValue="update({ ...state!, hanamiReduceEphemeralPosts: $event })">
			<template #label>{{ t.reduceEphemeral }}</template>
			<template #caption>{{ t.reduceEphemeralDescription }}</template>
		</MkSwitch>
		<div :class="$style.buttons">
			<MkButton :disabled="disabled" @click="update(resetHanamiTuning())">{{ t.reset }}</MkButton>
		</div>
	</section>
</div>
</template>

<script lang="ts" setup>
import { computed, useId, watch } from 'vue';
import MkRadios from '@/components/MkRadios.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkButton from '@/components/MkButton.vue';
import MkHanamiTuningRange from '@/components/MkHanamiTuningRange.vue';
import MkHanamiTuningDirection from '@/components/MkHanamiTuningDirection.vue';
import MkHanamiTuningGroupSliders from '@/components/MkHanamiTuningGroupSliders.vue';
import MkHanamiTuningTiles from '@/components/MkHanamiTuningTiles.vue';
import { i18n } from '@/i18n.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { useHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import {
	HANAMI_AXIS_GROUPS, HANAMI_AXIS_GROUP_NAMES, HANAMI_TUNING_MODES,
	applyHanamiSuggestedAmounts, getAvailableHanamiAxes, hanamiComposition, hanamiDirectionBand, hanamiGroupTrends,
	hanamiTilesSummary, resetHanamiTuning, resolveHanamiTuning, switchHanamiModeWithSuggestion,
} from '@/utility/hanami-tuning.js';
import type { HanamiAxis, HanamiAxisGroup, HanamiTuning, HanamiTuningMode, HanamiTuningUpdate } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_COLORS, HANAMI_GROUP_ICONS, HANAMI_MODE_ICONS, hanamiDriftName, hanamiLevelName } from '@/utility/hanami-tuning-view.js';

const props = withDefaults(defineProps<{
	disabled?: boolean;
}>(), { disabled: false });

const { state, config, update: saveTuning } = useHanamiTuning();
const { suggestion, status, factors, load } = useHanamiTuningSuggestion();
const t = i18n.ts._hana._tuning;
const driftHeadingId = useId();
const tuning = computed(() => state.value!.hanamiTuning);
const available = new Set(getAvailableHanamiAxes(config));

// パネルを開いたら（使える状態なら）反応を読み込む。
watch(() => props.disabled, disabled => { if (!disabled) void load(); }, { immediate: true });

function update(value: HanamiTuningUpdate): void {
	if (props.disabled) return;
	saveTuning(value);
}

function setTuning(value: HanamiTuning): void { update({ ...state.value!, hanamiTuning: value }); }

function setMode(mode: HanamiTuningMode): void {
	if (mode === tuning.value.mode) return;
	setTuning(switchHanamiModeWithSuggestion(tuning.value, mode, config, suggestion.value));
}

// ---- 方向だけ決める ----
const band = computed(() => hanamiDirectionBand(tuning.value, config, factors.value));
const bandLabel = computed(() => band.value.lean === 'close' ? t.rangeNowClose : band.value.lean === 'wide' ? t.rangeNowWide : t.rangeNowSame);

// ---- おすすめから調整 ----
const sameGroups = computed(() => suggestion.value != null && HANAMI_AXIS_GROUP_NAMES.every(group => suggestion.value!.groups[group] === tuning.value.groups[group]));

function resetRecommend(): void {
	if (!suggestion.value) return;
	setTuning({ ...tuning.value, groups: { ...suggestion.value.groups } });
}

// ---- すべて自分で ----
const manualResolved = computed(() => resolveHanamiTuning({ hanamiTuning: tuning.value }, config));
const manualAmounts = computed(() => manualResolved.value.amounts);
const manualAuthorCap = computed(() => manualResolved.value.authorCap);
const manualGroups = HANAMI_AXIS_GROUP_NAMES
	.map(group => ({ group, axes: HANAMI_AXIS_GROUPS[group].filter(axis => available.has(axis)) }))
	.filter(group => group.axes.length > 0);
const authorCapOptions = computed(() => [1, 2, 3, 4].map(n => ({ value: n, label: i18n.tsx._hana._tuning.authorCount({ n }), disabled: props.disabled })));
const percent = (value: number): string => `${Math.round(value * 100)}%`;

function setManual(amounts: Partial<Record<HanamiAxis, number>>, authorCap: number): void {
	setTuning({ ...tuning.value, mode: 'manual', manual: { amounts, authorCap } });
}

function setAmount(axis: HanamiAxis, value: number): void {
	setManual({ ...Object.fromEntries(manualAmounts.value), [axis]: value }, manualAuthorCap.value);
}

function setAuthorCap(value: number): void {
	setManual(Object.fromEntries(manualAmounts.value), value);
}

function applySuggestion(): void {
	if (!suggestion.value) return;
	setTuning(applyHanamiSuggestedAmounts(tuning.value, suggestion.value.axes, config));
}

// ---- いまは、10 件のうち ----
const tiles = computed(() => hanamiTilesSummary(tuning.value, config, factors.value));
const groupNames = (groups: HanamiAxisGroup[]): string => groups.map(group => t._groups[group]).join(t.listSeparator);
const tilesNote = computed(() => {
	if (!tiles.value.moving) return t.tilesFixed;
	return tiles.value.increased.length > 0 ? i18n.tsx._hana._tuning.tilesDrifted({ groups: groupNames(tiles.value.increased) }) : null;
});

// ---- あなたの反応から ----
const suggestionAxes = computed(() => (suggestion.value?.axes ?? []).filter(axis => available.has(axis.axis)));
const trends = computed(() => hanamiGroupTrends(tuning.value, config, factors.value));
const share = (part: number, total: number): number => total > 0 ? Math.round(part / total * 100) : 0;
const reactionRows = computed(() => {
	const s = suggestion.value;
	if (!s) return [];
	return HANAMI_AXIS_GROUP_NAMES.map(group => {
		const members = s.axes.filter(axis => HANAMI_AXIS_GROUPS[group].includes(axis.axis));
		const seen = share(members.reduce((sum, axis) => sum + axis.seen, 0), s.totalSeen);
		const reactions = share(members.reduce((sum, axis) => sum + axis.reactions, 0), s.totalReactions);
		let chip: string;
		let tone: 'up' | 'down' | 'flat';
		if (tuning.value.mode === 'recommend') {
			chip = i18n.tsx._hana._tuning.recommendChip({ level: hanamiLevelName(s.groups[group]) });
			tone = s.groups[group] > 2 ? 'up' : s.groups[group] < 2 ? 'down' : 'flat';
		} else if (tuning.value.mode === 'manual') {
			chip = t.referenceChip;
			tone = 'flat';
		} else {
			tone = trends.value?.[group] ?? 'flat';
			chip = tone === 'up' ? t.trendUp : tone === 'down' ? t.trendDown : t.trendFlat;
		}
		return { group, seen, reactions, chip, tone };
	});
});
const reactionsNote = computed(() => tuning.value.mode === 'recommend' ? t.reactionsNoteRecommend : tuning.value.mode === 'manual' ? t.reactionsNoteManual : t.reactionsNoteMoving);

// ---- 内訳 ----
const breakdown = computed(() => {
	const composition = hanamiComposition(tuning.value, config, factors.value);
	const max = Math.max(1, ...[...composition.values()]);
	return HANAMI_AXIS_GROUP_NAMES.map(group => {
		const axes = HANAMI_AXIS_GROUPS[group].filter(axis => available.has(axis)).map(axis => {
			const value = composition.get(axis) ?? 0;
			return { axis, share: Math.round(value), width: Math.round(value / max * 100) };
		});
		return { group, share: Math.round(HANAMI_AXIS_GROUPS[group].reduce((sum, axis) => sum + (composition.get(axis) ?? 0), 0)), axes };
	}).filter(group => group.axes.length > 0);
});
</script>

<style lang="scss" module>
.root {
	display: flex;
	flex-direction: column;
	gap: var(--MI-margin);
	min-width: 0;
	max-width: 100%;
	overflow-wrap: anywhere;
}

.disabled {
	opacity: 0.5;
}

.card {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 16px;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-panel);
}

.stack {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.heading {
	margin: 0;
	font-size: 1.05em;
	font-weight: 700;
}

.subheading {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	font-size: 0.95em;
	font-weight: 700;
}

.text {
	margin: 0;
	line-height: 1.7;
}

.caption {
	margin: 0;
	font-size: 0.85em;
	line-height: 1.6;
	opacity: 0.75;
}

.divider {
	width: 100%;
	margin: 4px 0;
	border: none;
	border-top: solid 1px var(--MI_THEME-divider);
}

.buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.swatch {
	flex: 0 0 auto;
	width: 12px;
	height: 12px;
	border-radius: 3px;
}

// ---- 調整のしかた ----
.scale {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 0 20px;
}

.scaleTrack {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 16px;

	&::before {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		top: 7px;
		height: 2px;
		background: var(--MI_THEME-divider);
	}
}

.scaleDot {
	position: relative;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: color-mix(in srgb, var(--MI_THEME-fg) 45%, transparent);
}

.scaleDotActive {
	width: 16px;
	height: 16px;
	background: var(--MI_THEME-accent);
}

.scaleLabels {
	display: flex;
	justify-content: space-between;
	margin: 0 -20px;
	font-size: 0.8em;
	opacity: 0.75;
}

.modes {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px;
}

.mode {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 6px;
	min-height: 112px;
	padding: 10px;
	border: solid 2px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	text-align: left;

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 2px;
	}

	&.selected {
		border-color: var(--MI_THEME-accent);
		background: var(--MI_THEME-accentedBg);

		.modeIcon {
			background: var(--MI_THEME-accent);
			color: var(--MI_THEME-fgOnAccent);
		}
	}
}

.modeIcon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	border-radius: 10px;
	background: var(--MI_THEME-buttonBg);
	font-size: 20px;
}

.modeName {
	font-weight: 700;
	line-height: 1.4;
}

.modeCaption {
	font-size: 0.8em;
	line-height: 1.5;
	opacity: 0.75;
}

.modeCheck {
	position: absolute;
	top: 8px;
	right: 8px;
	color: var(--MI_THEME-accent);
}

// ---- 方向の帯 ----
.band {
	position: relative;
	height: 28px;
}

.bandTrack {
	position: absolute;
	left: 0;
	right: 0;
	top: 12px;
	height: 4px;
	border-radius: 2px;
	background: var(--MI_THEME-divider);
}

.bandRange {
	position: absolute;
	top: 6px;
	height: 16px;
	border-radius: 8px;
	background: color-mix(in srgb, var(--MI_THEME-accent) 25%, transparent);
}

.bandBase {
	position: absolute;
	top: 2px;
	width: 3px;
	height: 24px;
	margin-left: -1.5px;
	border-radius: 2px;
	background: color-mix(in srgb, var(--MI_THEME-fg) 60%, transparent);
}

.bandNow {
	position: absolute;
	top: 6px;
	width: 16px;
	height: 16px;
	margin-left: -8px;
	border: solid 2px var(--MI_THEME-panel);
	border-radius: 50%;
	box-sizing: border-box;
	background: var(--MI_THEME-accent);
}

.bandEnds {
	display: flex;
	justify-content: space-between;
	font-size: 0.8em;
	opacity: 0.75;
}

.bandLegend {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 16px;
	font-size: 0.8em;

	> span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
}

.bandKey {
	display: inline-block;
}

.bandKeyBase {
	width: 3px;
	height: 12px;
	border-radius: 2px;
	background: color-mix(in srgb, var(--MI_THEME-fg) 60%, transparent);
}

.bandKeyNow {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: var(--MI_THEME-accent);
}

.bandKeyRange {
	width: 18px;
	height: 10px;
	border-radius: 5px;
	background: color-mix(in srgb, var(--MI_THEME-accent) 25%, transparent);
}

.segments {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
}

.segment {
	min-height: 40px;
	padding: 4px 8px;
	border: solid 2px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 2px;
	}

	&.selected {
		border-color: var(--MI_THEME-accent);
		background: var(--MI_THEME-accentedBg);
		font-weight: 700;
	}
}

// ---- すべて自分で ----
.manualGroup {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding-top: 8px;
	border-top: solid 1px var(--MI_THEME-divider);
}

// ---- あなたの反応から ----
.barLegend {
	display: flex;
	gap: 16px;
	font-size: 0.8em;

	> span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
}

.barKey {
	display: inline-block;
	width: 18px;
	height: 6px;
	border-radius: 3px;
}

.reactionRow {
	display: flex;
	gap: 12px;
	align-items: flex-start;
}

.reactionIcon {
	display: flex;
	flex: 0 0 auto;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border-radius: 10px;
	color: var(--MI-hanamiGroupOn);
	font-size: 18px;
}

.reactionBody {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.reactionHead {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 4px 8px;
}

.reactionName {
	font-weight: 700;
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 8px;
	border-radius: 999px;
	font-size: 0.8em;
	background: var(--MI_THEME-buttonBg);
}

.chipUp {
	background: var(--MI_THEME-accentedBg);
	color: var(--MI_THEME-accent);
	font-weight: 700;
}

.chipDown {
	background: color-mix(in srgb, var(--MI_THEME-warn) 18%, transparent);
	color: var(--MI_THEME-warn);
	font-weight: 700;
}

.bars {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.barTrack {
	display: block;
	height: 6px;
	border-radius: 3px;
	overflow: clip;
	background: var(--MI_THEME-divider);

	> span {
		display: block;
		height: 100%;
		border-radius: 3px;
	}
}

.seenBar {
	background: color-mix(in srgb, var(--MI_THEME-fg) 45%, transparent);
}

.reactedBar {
	background: var(--MI_THEME-accent);
}

.notice {
	display: flex;
	gap: 6px;
	margin: 0;
	padding: 8px 12px;
	border-radius: var(--MI-radius);
	background: var(--MI_THEME-infoBg);
	color: var(--MI_THEME-infoFg);
	font-size: 0.85em;
	line-height: 1.6;
}

.axisList {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.axisRow {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 4px 12px;
	font-variant-numeric: tabular-nums;
}

// ---- 内訳 ----
.breakdownGroup {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.breakdownHead {
	display: flex;
	align-items: center;
	gap: 12px;
}

.breakdownTitle {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	min-width: 0;
}

.breakdownShare {
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.breakdownAxis {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding-left: 48px;
}
</style>
