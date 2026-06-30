<template>
<SearchMarker path="/settings/hanamode" :label="i18n.ts._hana.hanaMode" :keywords="['hana', 'mode']" icon="ti ti-flower-filled">
	<div class="_gaps">
		<FormSection first>
			<template #label>{{ i18n.ts._hana.hanaMode }}</template>
			<HanaHanaModeSwitcher></HanaHanaModeSwitcher>
		</FormSection>

		<FormSection>
			<template #label>{{ i18n.ts._hana.hanamiTimeline }}</template>

			<MkPreferenceContainer k="showHanamiTimelineDateSeparators">
				<MkSwitch v-model="showHanamiTimelineDateSeparators">
					<template #label>{{ i18n.ts._hana.showHanamiTimelineDateSeparators }}</template>
					<template #caption>{{ i18n.ts._hana.showHanamiTimelineDateSeparatorsDescription }}</template>
				</MkSwitch>
			</MkPreferenceContainer>
		</FormSection>

		<FormSection>
			<template #label>{{ i18n.ts._hana._recommendation.title }}</template>
			<template #description>{{ i18n.ts._hana._recommendation.description }}</template>

			<div class="_gaps_m">
				<MkSwitch v-model="recommendationForm.state.enabled">
					<template #label>{{ i18n.ts._hana._recommendation.enable }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.enableDescription }}</template>
				</MkSwitch>

				<MkSwitch v-model="recommendationForm.state.showReason" :disabled="!recommendationForm.state.enabled">
					<template #label>{{ i18n.ts._hana._recommendation.showReason }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.showReasonDescription }}</template>
				</MkSwitch>

				<MkSwitch v-model="recommendationForm.state.autoInjectEnabled" :disabled="!recommendationForm.state.enabled">
					<template #label>{{ recommendationI18n.autoInject }}</template>
					<template #caption>{{ recommendationI18n.autoInjectDescription }}</template>
				</MkSwitch>

				<MkRadios v-model="recommendationForm.state.autoInjectStrength" :disabled="!recommendationForm.state.enabled || !recommendationForm.state.autoInjectEnabled">
					<template #label>{{ recommendationI18n.autoInjectAmount }}</template>
					<option value="low">{{ recommendationI18n.autoInjectAmountLow }}</option>
					<option value="normal">{{ recommendationI18n.autoInjectAmountNormal }}</option>
					<option value="high">{{ recommendationI18n.autoInjectAmountHigh }}</option>
				</MkRadios>

				<div class="_gaps_s">
					<div :class="$style.presetLabel"><i class="ti ti-wand"></i> {{ recommendationI18n.presets }}</div>
					<div :class="$style.presetRow">
						<MkButton v-for="p in PRESET_KEYS" :key="p" small rounded :disabled="!recommendationForm.state.enabled" @click="applyPreset(p)">{{ recommendationI18n[PRESET_I18N[p]] }}</MkButton>
					</div>
				</div>

				<MkFolder :defaultOpen="true">
					<template #icon><i class="ti ti-adjustments"></i></template>
					<template #label>{{ i18n.ts._hana._recommendation.axes }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.axesDescription }}</template>

					<div :class="$style.axisEditor">
						<div :class="[$style.axisRow, $style.axisHeader]">
							<div>{{ i18n.ts.type }}</div>
							<div>{{ i18n.ts._hana._recommendation.amount }}</div>
							<div>{{ recommendationI18n.axisMultiplier }}</div>
							<div>{{ recommendationI18n.axisSharePreview }}</div>
						</div>
						<div v-for="ax in AXES" :key="ax" :class="$style.axisRow">
							<div :class="$style.axisName">
								<i :class="['ti', AXIS_ICON[ax]]"></i>
								<span>{{ reasonLabels[ax] }}</span>
								<span v-if="!axisAvailable[ax]" :class="$style.axisUnavailable">{{ recommendationI18n.axisDisabledByServer }}</span>
							</div>
							<div :class="$style.levelButtons">
								<button
									v-for="level in AXIS_LEVELS"
									:key="level"
									type="button"
									class="_button"
									:class="[$style.levelButton, { [$style.levelButtonActive]: recommendationForm.state[ax] === level }]"
									:disabled="!recommendationForm.state.enabled || !axisAvailable[ax]"
									@click="setAxisLevel(ax, level)"
								>
									{{ axisLevelLabel(level) }}
								</button>
							</div>
							<div :class="$style.axisMultiplier">{{ axisLevelMultiplierLabel(recommendationForm.state[ax]) }}</div>
							<div :class="$style.axisShares">
								<span>{{ recommendationI18n.axisConfidenceHigh }} {{ axisShareLabel(ax, 'high') }}</span>
								<span>{{ recommendationI18n.axisConfidenceLow }} {{ axisShareLabel(ax, 'low') }}</span>
								<span>{{ recommendationI18n.axisConfidenceNone }} {{ axisShareLabel(ax, 'none') }}</span>
							</div>
						</div>
					</div>
				</MkFolder>

				<MkFormFooter :form="recommendationForm"/>
			</div>
		</FormSection>

		<FormSection>
			<template #label>{{ exploreI18n.mediaFilter }}</template>
			<template #description>{{ exploreI18n.mediaFilterDescription }}</template>

			<MkRadios v-model="exploreMediaFilter" @update:modelValue="saveExploreMediaFilter">
				<option value="all">{{ exploreI18n.mediaFilterAll }}</option>
				<option value="hideSensitive">{{ exploreI18n.mediaFilterHideSensitive }}</option>
				<option value="hideMedia">{{ exploreI18n.mediaFilterHideMedia }}</option>
			</MkRadios>
		</FormSection>
	</div>
</SearchMarker>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import FormSection from '@/components/form/section.vue';
import HanaHanaModeSwitcher from '@/components/HanaHanaModeSwitcher.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkButton from '@/components/MkButton.vue';
import MkFormFooter from '@/components/MkFormFooter.vue';
import MkPreferenceContainer from '@/components/MkPreferenceContainer.vue';
import { ensureSignin } from '@/i.js';
import { updateCurrentAccountPartial } from '@/accounts.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { instance } from '@/instance.js';
import { prefer } from '@/preferences.js';
import { useForm } from '@/composables/use-form.js';
import { suggestReload } from '@/utility/reload-suggest.js';

const $i = ensureSignin();
const showHanamiTimelineDateSeparators = prefer.model('showHanamiTimelineDateSeparators');

type AxisKey = 'globalPopular' | 'neighborTrending' | 'reactionSimilar' | 'catchup' | 'trending' | 'fof' | 'exploration';
type LegacyAxisKey = 'popular';
type AxisLevel = 'off' | 'low' | 'normal' | 'high';
type RecommendationAutoInjectStrength = 'low' | 'normal' | 'high';
type PresetKey = 'balanced' | 'popular' | 'close' | 'discover' | 'topic';
type ExploreMediaFilter = 'all' | 'hideSensitive' | 'hideMedia';
type RecommendationFormState = {
	enabled: boolean;
	autoInjectEnabled: boolean;
	autoInjectStrength: RecommendationAutoInjectStrength;
	showReason: boolean;
} & Record<AxisKey, AxisLevel>;
type RecommendationAccount = typeof $i & {
	exploreMediaFilter?: ExploreMediaFilter;
	hanamiRecommendationEnabled?: boolean;
	hanamiRecommendationAutoInjectEnabled?: boolean;
	hanamiRecommendationAutoInjectStrength?: RecommendationAutoInjectStrength;
	hanamiRecommendationAxes?: Partial<Record<AxisKey | LegacyAxisKey, AxisLevel | boolean>>;
	hanamiShowRecommendationReason?: boolean;
};
type RecommendationI18n = typeof i18n.ts._hana._recommendation & {
	autoInject: string;
	autoInjectDescription: string;
	autoInjectAmount: string;
	autoInjectAmountLow: string;
	autoInjectAmountNormal: string;
	autoInjectAmountHigh: string;
	presets: string;
	presetBalanced: string;
	presetPopular: string;
	presetClose: string;
	presetDiscover: string;
	presetTopic: string;
	axisLevelOff: string;
	axisLevelLow: string;
	axisLevelNormal: string;
	axisLevelHigh: string;
	axisMultiplier: string;
	axisSharePreview: string;
	axisConfidenceHigh: string;
	axisConfidenceLow: string;
	axisConfidenceNone: string;
	axisDisabledByServer: string;
};

const account = $i as RecommendationAccount;
const recommendationI18n = i18n.ts._hana._recommendation as RecommendationI18n;
const exploreI18n = (i18n.ts._hana as typeof i18n.ts._hana & { _explore: { mediaFilter: string; mediaFilterDescription: string; mediaFilterAll: string; mediaFilterHideSensitive: string; mediaFilterHideMedia: string } })._explore;
const reasonLabels = i18n.ts._hana._recommendation._reason as unknown as Record<AxisKey, string>;

const AXES: AxisKey[] = ['globalPopular', 'exploration', 'trending', 'neighborTrending', 'reactionSimilar', 'catchup', 'fof'];
const AXIS_LEVELS: AxisLevel[] = ['off', 'low', 'normal', 'high'];
const AXIS_LEVEL_MULTIPLIER: Record<AxisLevel, number> = { off: 0, low: 0.55, normal: 1, high: 1.6 };
const BASE_AXIS_SHARE: Record<'high' | 'low' | 'none', Record<AxisKey, number>> = {
	high: { globalPopular: 0.15, exploration: 0.05, trending: 0.15, neighborTrending: 0.25, reactionSimilar: 0.25, catchup: 0.30, fof: 0.15 },
	low: { globalPopular: 0.45, exploration: 0.10, trending: 0.25, neighborTrending: 0.20, reactionSimilar: 0.10, catchup: 0.15, fof: 0.20 },
	none: { globalPopular: 0.70, exploration: 0.10, trending: 0.25, neighborTrending: 0, reactionSimilar: 0, catchup: 0, fof: 0.10 },
};
const AXIS_ICON: Record<AxisKey, string> = {
	globalPopular: 'ti-flame',
	exploration: 'ti-compass',
	trending: 'ti-trending-up',
	neighborTrending: 'ti-users-group',
	reactionSimilar: 'ti-heart-handshake',
	catchup: 'ti-history',
	fof: 'ti-users',
};
const PRESET_KEYS: PresetKey[] = ['balanced', 'popular', 'close', 'discover', 'topic'];
const PRESET_I18N = { balanced: 'presetBalanced', popular: 'presetPopular', close: 'presetClose', discover: 'presetDiscover', topic: 'presetTopic' } as const;
const PRESETS: Record<PresetKey, Record<AxisKey, AxisLevel>> = {
	balanced: { globalPopular: 'normal', exploration: 'normal', trending: 'normal', neighborTrending: 'normal', reactionSimilar: 'normal', catchup: 'normal', fof: 'normal' },
	popular: { globalPopular: 'normal', exploration: 'low', trending: 'normal', neighborTrending: 'high', reactionSimilar: 'high', catchup: 'normal', fof: 'low' },
	close: { globalPopular: 'low', exploration: 'low', trending: 'low', neighborTrending: 'high', reactionSimilar: 'normal', catchup: 'high', fof: 'normal' },
	discover: { globalPopular: 'low', exploration: 'high', trending: 'normal', neighborTrending: 'normal', reactionSimilar: 'high', catchup: 'low', fof: 'high' },
	topic: { globalPopular: 'low', exploration: 'low', trending: 'high', neighborTrending: 'high', reactionSimilar: 'low', catchup: 'low', fof: 'low' },
};

const storedAxes = account.hanamiRecommendationAxes ?? {};
const serverAxes = (instance as { hanamiRecommendationAxisConfig?: Partial<Record<AxisKey | LegacyAxisKey, { available?: boolean; default?: boolean }>> }).hanamiRecommendationAxisConfig ?? {};
const AXIS_CONFIG_KEYS: Record<AxisKey, readonly (AxisKey | LegacyAxisKey)[]> = {
	globalPopular: ['globalPopular', 'popular'],
	exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'],
	reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'],
	trending: ['trending'],
	fof: ['fof'],
};

function axisServerValue(axis: AxisKey): { available: boolean; default: boolean } {
	const keys = AXIS_CONFIG_KEYS[axis];
	const available = keys.map(k => serverAxes[k]?.available).find(v => v !== undefined) ?? true;
	const def = keys.map(k => serverAxes[k]?.default).find(v => v !== undefined) ?? true;
	return { available, default: def };
}

function axisStoredValue(axis: AxisKey): AxisLevel | boolean | undefined {
	for (const key of AXIS_CONFIG_KEYS[axis]) {
		const v = storedAxes[key];
		if (v !== undefined) return v;
	}
	return undefined;
}

function axisInitial(axis: AxisKey): AxisLevel {
	const server = axisServerValue(axis);
	if (!server.available) return 'off';
	const v = axisStoredValue(axis);
	if (v === 'off' || v === 'low' || v === 'normal' || v === 'high') return v;
	if (v === true) return 'normal';
	if (v === false) return 'off';
	return server.default ? 'normal' : 'off';
}

const axisAvailable = Object.fromEntries(AXES.map(ax => [ax, axisServerValue(ax).available])) as Record<AxisKey, boolean>;

const exploreMediaFilter = ref<ExploreMediaFilter>(account.exploreMediaFilter ?? 'all');
const recommendationForm = useForm<RecommendationFormState>({
	enabled: account.hanamiRecommendationEnabled ?? true,
	autoInjectEnabled: account.hanamiRecommendationAutoInjectEnabled ?? true,
	autoInjectStrength: account.hanamiRecommendationAutoInjectStrength ?? 'low',
	showReason: account.hanamiShowRecommendationReason ?? false,
	globalPopular: axisInitial('globalPopular'),
	exploration: axisInitial('exploration'),
	trending: axisInitial('trending'),
	neighborTrending: axisInitial('neighborTrending'),
	reactionSimilar: axisInitial('reactionSimilar'),
	catchup: axisInitial('catchup'),
	fof: axisInitial('fof'),
}, async (state) => {
	const accountPatch = buildAccountPatch(state);
	await os.apiWithDialog('i/update', accountPatch as never);
	updateCurrentAccountPartial(accountPatch as unknown as Parameters<typeof updateCurrentAccountPartial>[0]);
	suggestReload();
});

function axisLevelLabel(level: AxisLevel): string {
	switch (level) {
		case 'off': return recommendationI18n.axisLevelOff;
		case 'low': return recommendationI18n.axisLevelLow;
		case 'normal': return recommendationI18n.axisLevelNormal;
		case 'high': return recommendationI18n.axisLevelHigh;
	}
}

function axisLevelMultiplierLabel(level: AxisLevel): string {
	return `${AXIS_LEVEL_MULTIPLIER[level]}x`;
}

function axisShareLabel(axis: AxisKey, confidence: 'high' | 'low' | 'none'): string {
	const share = Math.min(1, BASE_AXIS_SHARE[confidence][axis] * AXIS_LEVEL_MULTIPLIER[recommendationForm.state[axis]]);
	return `${Math.round(share * 1000) / 10}%`;
}

function setAxisLevel(axis: AxisKey, level: AxisLevel) {
	if (!recommendationForm.state.enabled || !axisAvailable[axis]) return;
	recommendationForm.state[axis] = level;
}

function applyPreset(name: PresetKey) {
	const p = PRESETS[name];
	for (const ax of AXES) if (axisAvailable[ax]) recommendationForm.state[ax] = p[ax];
}

function buildAccountPatch(state: RecommendationFormState) {
	return {
		hanamiRecommendationEnabled: state.enabled,
		hanamiRecommendationAutoInjectEnabled: state.autoInjectEnabled,
		hanamiRecommendationAutoInjectStrength: state.autoInjectStrength,
		hanamiShowRecommendationReason: state.showReason,
		hanamiRecommendationAxes: {
			globalPopular: state.globalPopular,
			exploration: state.exploration,
			trending: state.trending,
			neighborTrending: state.neighborTrending,
			reactionSimilar: state.reactionSimilar,
			catchup: state.catchup,
			fof: state.fof,
		},
	};
}

async function saveExploreMediaFilter() {
	const patch = { exploreMediaFilter: exploreMediaFilter.value };
	await os.apiWithDialog('i/update', patch as never);
	updateCurrentAccountPartial(patch as unknown as Parameters<typeof updateCurrentAccountPartial>[0]);
}
</script>

<style lang="scss" module>
.presetLabel {
	font-size: 0.85em;
	opacity: 0.8;
	margin-bottom: 6px;
}

.presetRow {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.axisEditor {
	overflow: hidden;
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: 8px;
}

.axisRow {
	display: grid;
	grid-template-columns: minmax(160px, 1.05fr) minmax(248px, 1.35fr) minmax(64px, 0.4fr) minmax(210px, 1fr);
	gap: 12px;
	align-items: center;
	padding: 12px;
	border-top: solid 0.5px var(--MI_THEME-divider);

	&:first-child {
		border-top: none;
	}
}

.axisHeader {
	background: color(from var(--MI_THEME-fg) srgb r g b / 0.04);
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.7);
	font-size: 0.8em;
	font-weight: 700;
}

.axisName {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
	min-width: 0;

	> span {
		overflow-wrap: anywhere;
	}
}

.axisUnavailable {
	padding: 1px 6px;
	border-radius: 999px;
	background: color(from var(--MI_THEME-warn) srgb r g b / 0.12);
	color: var(--MI_THEME-warn);
	font-size: 0.78em;
}

.levelButtons {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 6px;
	min-width: 0;
}

.levelButton {
	min-width: 0;
	height: 32px;
	padding: 0 8px;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: 6px;
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.86);
	font-size: 0.85em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;

	&:disabled {
		opacity: 0.45;
	}
}

.levelButtonActive {
	border-color: var(--MI_THEME-accent);
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);
}

.axisMultiplier {
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.axisShares {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 8px;
	min-width: 0;
	color: color(from var(--MI_THEME-fg) srgb r g b / 0.72);
	font-size: 0.82em;

	> span {
		white-space: nowrap;
	}
}

@media (max-width: 800px) {
	.axisHeader {
		display: none;
	}

	.axisRow {
		grid-template-columns: 1fr;
		gap: 8px;
	}

	.levelButtons {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}
</style>
