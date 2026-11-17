<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.disabled]: disabled }]" :inert="disabled">
	<!-- 1. 調整のしかた -->
	<section :class="$style.section">
		<h2 :class="$style.heading">{{ t.mode }}</h2>
		<MkHanamiTuningModes :modelValue="tuning.mode" :disabled="disabled" @update:modelValue="setMode"/>
		<p :class="$style.text"><strong :class="$style.modeName" data-testid="mode-name">{{ t._modes[tuning.mode] }}</strong><span>{{ modeDescription }}</span></p>
	</section>

	<!-- 2. 選んだしかたの中身（おまかせは決めるものが無い） -->
	<section v-if="tuning.mode === 'direction'" :class="$style.section">
		<h2 :class="$style.heading">{{ t.directionTitle }}</h2>
		<MkHanamiTuningDirection :modelValue="tuning.direction" :previews="directionPreviews" :disabled="disabled" @update:modelValue="setTuning({ ...tuning, direction: $event })"/>
	</section>

	<section v-else-if="tuning.mode === 'recommend'" :class="$style.section">
		<h2 :class="$style.heading">{{ t.groupsTitle }}</h2>
		<MkHanamiTuningGroupSliders :modelValue="tuning.groups" :recommended="suggestion?.groups ?? null" :disabled="disabled" @update:modelValue="setTuning({ ...tuning, groups: $event })"/>
		<div :class="$style.buttons">
			<MkButton :disabled="disabled || !suggestion || sameGroups" @click="resetRecommend">{{ t.resetRecommend }}</MkButton>
		</div>
	</section>

	<section v-else-if="tuning.mode === 'manual'" :class="$style.section">
		<h2 :class="$style.heading">{{ t.manualTitle }}</h2>
		<div v-for="group in manualGroups" :key="group.group" :class="$style.manualGroup">
			<h3 :class="$style.subheading"><span :class="$style.swatch" :style="{ background: HANAMI_GROUP_FILLS[group.group] }" aria-hidden="true"></span>{{ t._groups[group.group] }}</h3>
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
	</section>

	<!-- 3. いまは、10 件のうち -->
	<section :class="$style.section">
		<MkHanamiTuningBar :counts="tiles.counts" :shares="shares" :range="range" :rangeText="rangeText" :note="tilesNote" data-testid="tiles"/>
	</section>

	<!-- 4. 反応への寄せ方（方向だけ決める のときだけ選べる） -->
	<section v-if="tuning.mode === 'direction'" :class="$style.section">
		<h2 :id="driftHeadingId" :class="$style.heading">{{ t.drift }}</h2>
		<div role="group" :aria-labelledby="driftHeadingId" :class="$style.options">
			<button
				v-for="drift in [0, 1, 2]" :key="drift" type="button" class="_button"
				:class="[$style.option, { [$style.selected]: tuning.drift === drift }]" :aria-pressed="tuning.drift === drift" :disabled="disabled"
				@click="setTuning({ ...tuning, drift })"
			>
				<span>{{ hanamiDriftName(drift) }}</span>
				<!-- 動く幅の広さを、かっこの幅で見せる。 -->
				<span :class="$style.optionBracket" :style="{ width: `${DRIFT_BRACKET_WIDTHS[drift]}px` }" aria-hidden="true"></span>
			</button>
		</div>
	</section>

	<!-- 5. あなたの反応から -->
	<section :class="$style.section" data-testid="reactions">
		<h2 :class="[$style.heading, $style.headingRow]">{{ t.suggestion }}<span :class="$style.caption">{{ t.period }}</span></h2>
		<MkError v-if="!suggestion && status === 'error'" @retry="load(true)"/>
		<MkLoading v-else-if="!suggestion && !disabled"/>
		<template v-else-if="suggestion">
			<p v-if="!reactionFigure" :class="$style.text">{{ t.noActivity }}</p>
			<template v-else>
				<!-- 上の帯が見た投稿、下の帯が反応した投稿。下のほうが広いまとまりへ寄せる。 -->
				<div role="img" :aria-label="reactionFigure.label" :class="$style.compare">
					<div :class="$style.compareHead" aria-hidden="true">
						<span :class="$style.compareName">{{ t.seenShare }}</span>
						<span :class="$style.compareNumbers"><span v-for="row in reactionRows" :key="row.group">{{ percentOf(row.seen) }}</span></span>
					</div>
					<div :class="$style.compareBar" aria-hidden="true">
						<span v-for="row in reactionFigure.seen" :key="row.group" :style="{ flexGrow: row.count, background: HANAMI_GROUP_FILLS[row.group] }"></span>
					</div>
					<svg v-if="reactionFigure.reactionEdges" aria-hidden="true" viewBox="0 0 100 28" preserveAspectRatio="none" :class="$style.compareLinks">
						<polygon :points="reactionFigure.band"/>
						<line v-for="(edge, index) in reactionFigure.seenEdges" :key="index" :x1="edge" y1="0" :x2="reactionFigure.reactionEdges[index]" y2="28"/>
					</svg>
					<div :class="[$style.compareBar, { [$style.compareEmpty]: !reactionFigure.reactionEdges }]" aria-hidden="true">
						<span v-for="row in reactionFigure.reacted" :key="row.group" :style="{ flexGrow: row.count, background: HANAMI_GROUP_FILLS[row.group] }"></span>
					</div>
					<div :class="$style.compareHead" aria-hidden="true">
						<span :class="$style.compareName">{{ t.reactionShare }}</span>
						<span :class="$style.compareNumbers"><span v-for="row in reactionRows" :key="row.group">{{ percentOf(row.reactions) }}</span></span>
					</div>
				</div>
				<div :class="$style.verdicts">
					<div v-for="row in reactionRows" :key="row.group" :class="$style.verdictRow" :data-group="row.group">
						<span :class="$style.verdictName"><span :class="$style.swatch" :style="{ background: HANAMI_GROUP_FILLS[row.group] }" aria-hidden="true"></span>{{ t._groups[row.group] }}</span>
						<span :class="[$style.verdict, { [$style.verdictUp]: row.tone === 'up', [$style.verdictDown]: row.tone === 'down' }]" data-part="chip">{{ row.chip }}</span>
						<span :class="[$style.caption, $style.verdictShares]">{{ i18n.tsx._hana._tuning.shares({ seen: row.seen, reactions: row.reactions }) }}</span>
					</div>
				</div>
			</template>
			<p v-if="!suggestion.eligible" :class="$style.notice" data-testid="ineligible">{{ i18n.tsx._hana._tuning.ineligible({ seen: suggestion.minSeen, reactions: suggestion.minReactions }) }}</p>
			<p :class="$style.caption">{{ reactionsNote }}</p>
			<table :class="$style.axisTable">
				<caption>{{ t.perAxis }}</caption>
				<thead>
					<tr>
						<th scope="col">{{ t.axisColumn }}</th>
						<th scope="col" :class="$style.numeric">{{ t.seenColumn }}</th>
						<th scope="col" :class="$style.numeric">{{ t.reactionsColumn }}</th>
						<th scope="col">{{ t.rateColumn }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="row in axisRows" :key="row.axis">
						<th scope="row"><span :class="$style.axisName"><span :class="$style.swatch" :style="{ background: HANAMI_GROUP_FILLS[row.group] }" aria-hidden="true"></span>{{ t._axis[row.axis] }}</span></th>
						<td :class="$style.numeric">{{ row.seen }}</td>
						<td :class="$style.numeric">{{ row.reactions }}</td>
						<td><span :class="$style.rate"><span :class="$style.rateBar" aria-hidden="true"><span :style="{ width: `${row.width}%` }"></span></span>{{ row.rateText }}</span></td>
					</tr>
				</tbody>
			</table>
		</template>
	</section>

	<!-- 6. 内訳 -->
	<MkFolder>
		<template #icon><i class="ti ti-stack-2"></i></template>
		<template #label>{{ t.breakdown }}</template>
		<div :class="$style.stack">
			<section v-for="group in breakdown" :key="group.group" :class="$style.breakdownGroup">
				<div :class="$style.breakdownHead">
					<span :class="$style.swatch" :style="{ background: HANAMI_GROUP_FILLS[group.group] }" aria-hidden="true"></span>
					<div :class="$style.breakdownTitle">
						<h3 :class="$style.subheading">{{ t._groups[group.group] }}</h3>
						<span :class="$style.caption">{{ t._groupCaptions[group.group] }}</span>
					</div>
					<span :class="$style.breakdownShare">{{ i18n.tsx._hana._tuning.count({ n: group.share }) }}</span>
				</div>
				<div v-for="axis in group.axes" :key="axis.axis" :class="$style.breakdownAxis">
					<div :class="$style.breakdownAxisHead">
						<span>{{ t._axis[axis.axis] }}</span>
						<span :class="$style.breakdownShare">{{ i18n.tsx._hana._tuning.count({ n: axis.share }) }}</span>
					</div>
					<span :class="$style.barTrack" aria-hidden="true"><span :style="{ width: `${axis.width}%`, background: HANAMI_GROUP_FILLS[group.group] }"></span></span>
					<span :class="$style.caption">{{ t._axisDescriptions[axis.axis] }}</span>
				</div>
			</section>
			<p :class="$style.caption">{{ t.breakdownNote }}</p>
		</div>
	</MkFolder>

	<!-- 7. そのほか -->
	<section :class="$style.section">
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
import MkHanamiTuningBar from '@/components/MkHanamiTuningBar.vue';
import MkHanamiTuningModes from '@/components/MkHanamiTuningModes.vue';
import { i18n } from '@/i18n.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { useHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import {
	HANAMI_AXIS_GROUPS, HANAMI_AXIS_GROUP_NAMES,
	applyHanamiSuggestedAmounts, getAvailableHanamiAxes, hanamiComposition, hanamiDirectionPreviews, hanamiGroupComposition, hanamiGroupTrends,
	hanamiShareRange, hanamiTilesSummary, resetHanamiTuning, resolveHanamiTuning, switchHanamiModeWithSuggestion,
} from '@/utility/hanami-tuning.js';
import type { HanamiAxis, HanamiAxisGroup, HanamiTuning, HanamiTuningMode, HanamiTuningUpdate } from '@/utility/hanami-tuning.js';
import { HANAMI_GROUP_FILLS, hanamiDriftName, hanamiLevelName } from '@/utility/hanami-tuning-view.js';

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

const modeDescription = computed(() => ({ auto: t.autoDescription, direction: t.directionDescription, recommend: t.recommendDescription, manual: t.manualDescription })[tuning.value.mode]);

// ---- 方向だけ決める ----
const directionPreviews = computed(() => hanamiDirectionPreviews(tuning.value, config));
/** 寄せ方（ひかえめ・ふつう・しっかり）のボタンに出す、かっこの幅（px）。 */
const DRIFT_BRACKET_WIDTHS = [16, 34, 60];

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
const shares = computed(() => hanamiGroupComposition(tuning.value, config, factors.value));
const range = computed(() => hanamiShareRange(tuning.value, config, factors.value));
const rangeText = computed(() => {
	if (range.value == null) return null;
	return (tuning.value.mode === 'direction' ? i18n.tsx._hana._tuning.rangeDirection : i18n.tsx._hana._tuning.rangeAuto)(range.value);
});
const groupNames = (groups: HanamiAxisGroup[]): string => groups.map(group => t._groups[group]).join(t.listSeparator);
const tilesNote = computed(() => {
	if (!tiles.value.moving) return t.tilesFixed;
	return tiles.value.increased.length > 0 ? i18n.tsx._hana._tuning.tilesDrifted({ groups: groupNames(tiles.value.increased) }) : null;
});

// ---- あなたの反応から ----
const trends = computed(() => hanamiGroupTrends(tuning.value, config, factors.value));
const share = (part: number, total: number): number => total > 0 ? Math.round(part / total * 100) : 0;
const reactionRows = computed(() => {
	const s = suggestion.value;
	if (!s) return [];
	return HANAMI_AXIS_GROUP_NAMES.map(group => {
		const members = s.axes.filter(axis => HANAMI_AXIS_GROUPS[group].includes(axis.axis));
		const seenCount = members.reduce((sum, axis) => sum + axis.seen, 0);
		const reactionCount = members.reduce((sum, axis) => sum + axis.reactions, 0);
		const seen = share(seenCount, s.totalSeen);
		const reactions = share(reactionCount, s.totalReactions);
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
		return { group, seen, reactions, seenCount, reactionCount, chip, tone };
	});
});
const percentOf = (value: number): string => `${value}%`;

// 見た投稿の帯と、反応した投稿の帯。境目どうしを線で結んで、ずれを見せる。
const reactionFigure = computed(() => {
	const rows = reactionRows.value;
	const seenTotal = rows.reduce((sum, row) => sum + row.seenCount, 0);
	const reactionTotal = rows.reduce((sum, row) => sum + row.reactionCount, 0);
	if (seenTotal <= 0) return null;
	// まとまりの境目の位置（%）。最後のまとまりの右端は入れない。
	const edges = (key: 'seenCount' | 'reactionCount', total: number): number[] => {
		let sum = 0;
		return rows.slice(0, -1).map(row => { sum += row[key]; return Math.round(sum / total * 1000) / 10; });
	};
	const seenEdges = edges('seenCount', seenTotal);
	const reactionEdges = reactionTotal > 0 ? edges('reactionCount', reactionTotal) : null;
	return {
		seen: rows.filter(row => row.seenCount > 0).map(row => ({ group: row.group, count: row.seenCount })),
		reacted: rows.filter(row => row.reactionCount > 0).map(row => ({ group: row.group, count: row.reactionCount })),
		seenEdges,
		reactionEdges,
		band: reactionEdges ? `${seenEdges[0]},0 ${seenEdges[1]},0 ${reactionEdges[1]},28 ${reactionEdges[0]},28` : '',
		label: rows.map(row => `${t._groups[row.group]} ${i18n.tsx._hana._tuning.shares({ seen: row.seen, reactions: row.reactions })}`).join(t.listSeparator),
	};
});

// 種類ごとの表。まとまりの順に並べ、反応した割合の棒は、いちばん高い種類を端にする。
const axisRows = computed(() => {
	const found = new Map((suggestion.value?.axes ?? []).map(axis => [axis.axis, axis]));
	const rows = HANAMI_AXIS_GROUP_NAMES.flatMap(group => HANAMI_AXIS_GROUPS[group].filter(axis => available.has(axis)).flatMap(axis => {
		const counts = found.get(axis);
		return counts ? [{ axis, group, seen: counts.seen, reactions: counts.reactions, rate: counts.seen > 0 ? counts.reactions / counts.seen * 100 : null }] : [];
	}));
	const max = Math.max(...rows.map(row => row.rate ?? 0));
	return rows.map(row => ({ ...row, width: row.rate != null && max > 0 ? Math.round(row.rate / max * 100) : 0, rateText: row.rate != null ? `${row.rate.toFixed(1)}%` : '–' }));
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
	gap: 28px;
	min-width: 0;
	max-width: 100%;
	overflow-wrap: anywhere;
}

.disabled {
	opacity: 0.5;
}

// まとまりは、枠で囲まず、上の太い線で区切る。
.section {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding-top: 10px;
	border-top: solid 2px var(--MI_THEME-fg);
}

.stack {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.heading {
	margin: 0;
	font-size: 0.95em;
	font-weight: 700;
}

.headingRow {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 0 12px;

	> .caption {
		font-weight: 400;
	}
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

.modeName {
	display: block;
}

.caption {
	margin: 0;
	font-size: 0.85em;
	line-height: 1.6;
	opacity: 0.75;
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
}

.numeric {
	text-align: right;
	font-variant-numeric: tabular-nums;
}

// ---- 反応への寄せ方 ----
.options {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
}

.option {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	min-height: 56px;
	padding: 8px;
	box-shadow: inset 0 0 0 1px var(--MI_THEME-divider);
	font-size: 0.9em;

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-focus);
		outline-offset: 2px;
	}

	&.selected {
		box-shadow: inset 0 0 0 2px var(--MI_THEME-fg);
		font-weight: 700;
	}
}

.optionBracket {
	height: 7px;
	box-sizing: border-box;
	border: solid 2px var(--MI_THEME-fg);
	border-top: none;
}

// ---- すべて自分で ----
.manualGroup {
	display: flex;
	flex-direction: column;
	gap: 8px;

	& + & {
		padding-top: 12px;
		border-top: solid 1px var(--MI_THEME-divider);
	}
}

// ---- あなたの反応から ----
.compare {
	display: flex;
	flex-direction: column;
}

.compareHead {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 0 12px;
	padding: 4px 0;
	font-size: 0.85em;
}

.compareName {
	font-weight: 700;
}

.compareNumbers {
	display: inline-flex;
	gap: 10px;
	font-variant-numeric: tabular-nums;
}

.compareBar {
	display: flex;
	gap: 2px;
	height: 18px;

	> span {
		flex: 0 1 0;
		min-width: 0;
	}

	&.compareEmpty {
		margin-top: 12px;
		background: var(--MI_THEME-divider);
	}
}

.compareLinks {
	display: block;
	width: 100%;
	height: 28px;

	> polygon {
		fill: color-mix(in srgb, var(--MI_THEME-fg) 8%, transparent);
	}

	> line {
		stroke: var(--MI_THEME-fg);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}
}

.verdicts {
	display: flex;
	flex-direction: column;
}

.verdictRow {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 0 12px;
	align-items: center;
	padding: 8px 0;
	border-top: solid 1px var(--MI_THEME-divider);
}

.verdictName {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.verdict {
	font-weight: 700;
	text-align: right;
}

.verdictUp::before {
	content: "▲ ";
	font-size: 0.8em;
}

.verdictDown::before {
	content: "▼ ";
	font-size: 0.8em;
}

.verdictShares {
	grid-column: 1 / 3;
	font-variant-numeric: tabular-nums;
}

.notice {
	margin: 0;
	padding-left: 10px;
	border-left: solid 2px var(--MI_THEME-fg);
	font-size: 0.85em;
	line-height: 1.6;
}

.axisTable {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.9em;

	caption {
		padding: 8px 0 4px;
		font-weight: 700;
		text-align: left;
	}

	th,
	td {
		padding: 6px 0 6px 8px;
		font-weight: 400;
		text-align: left;

		&:first-child {
			padding-left: 0;
		}

		&.numeric {
			text-align: right;
		}
	}

	thead th {
		font-size: 0.85em;
		opacity: 0.75;
		vertical-align: bottom;
	}

	tbody tr {
		border-top: solid 1px var(--MI_THEME-divider);
	}
}

.axisName {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.rate {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-variant-numeric: tabular-nums;
}

.rateBar {
	display: block;
	width: 44px;
	height: 8px;

	> span {
		display: block;
		height: 100%;
		background: var(--MI_THEME-fg);
	}
}

// ---- 内訳 ----
.breakdownGroup {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.breakdownHead {
	display: flex;
	align-items: baseline;
	gap: 8px;
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
	padding-left: 20px;
}

.breakdownAxisHead {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 4px 8px;
}

.barTrack {
	display: block;
	height: 8px;
	background: var(--MI_THEME-divider);

	> span {
		display: block;
		height: 100%;
	}
}
</style>
