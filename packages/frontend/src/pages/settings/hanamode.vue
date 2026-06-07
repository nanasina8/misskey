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
				<MkSwitch v-model="enabled" @update:modelValue="save">
					<template #label>{{ i18n.ts._hana._recommendation.enable }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.enableDescription }}</template>
				</MkSwitch>

				<MkRadios v-model="strength" :disabled="!enabled" @update:modelValue="save">
					<template #label>{{ i18n.ts._hana._recommendation.amount }}</template>
					<option value="low">{{ i18n.ts._hana._recommendation.amountLow }}</option>
					<option value="normal">{{ i18n.ts._hana._recommendation.amountNormal }}</option>
					<option value="high">{{ i18n.ts._hana._recommendation.amountHigh }}</option>
					<option value="veryHigh">{{ recommendationI18n.amountVeryHigh }}</option>
				</MkRadios>

				<MkSwitch v-model="autoInjectEnabled" :disabled="!enabled" @update:modelValue="save">
					<template #label>{{ recommendationI18n.autoInject }}</template>
					<template #caption>{{ recommendationI18n.autoInjectDescription }}</template>
				</MkSwitch>

				<MkRadios v-model="autoInjectStrength" :disabled="!enabled || !autoInjectEnabled" @update:modelValue="save">
					<template #label>{{ recommendationI18n.autoInjectAmount }}</template>
					<option value="low">{{ recommendationI18n.autoInjectAmountLow }}</option>
					<option value="normal">{{ recommendationI18n.autoInjectAmountNormal }}</option>
					<option value="high">{{ recommendationI18n.autoInjectAmountHigh }}</option>
				</MkRadios>

				<div class="_gaps_s">
					<div :class="$style.presetLabel"><i class="ti ti-wand"></i> {{ recommendationI18n.presets }}</div>
					<div :class="$style.presetRow">
						<MkButton v-for="p in PRESET_KEYS" :key="p" small rounded :disabled="!enabled" @click="applyPreset(p)">{{ recommendationI18n[PRESET_I18N[p]] }}</MkButton>
					</div>
				</div>

				<MkFolder :defaultOpen="false">
					<template #icon><i class="ti ti-adjustments"></i></template>
					<template #label>{{ i18n.ts._hana._recommendation.axes }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.axesDescription }}</template>

					<div class="_gaps_s">
						<MkRadios v-for="ax in AXES" :key="ax" v-model="axisLevels[ax]" :disabled="!enabled || !axisAvailable[ax]" @update:modelValue="save">
							<template #label><i :class="['ti', AXIS_ICON[ax]]"></i> {{ i18n.ts._hana._recommendation._reason[ax] }}</template>
							<option value="off">{{ recommendationI18n.axisLevelOff }}</option>
							<option value="low">{{ recommendationI18n.axisLevelLow }}</option>
							<option value="normal">{{ recommendationI18n.axisLevelNormal }}</option>
							<option value="high">{{ recommendationI18n.axisLevelHigh }}</option>
						</MkRadios>
					</div>
				</MkFolder>
			</div>
		</FormSection>
	</div>
</SearchMarker>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import FormSection from '@/components/form/section.vue';
import HanaHanaModeSwitcher from '@/components/HanaHanaModeSwitcher.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkRadios from '@/components/MkRadios.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkButton from '@/components/MkButton.vue';
import MkPreferenceContainer from '@/components/MkPreferenceContainer.vue';
import { ensureSignin } from '@/i.js';
import { updateCurrentAccountPartial } from '@/accounts.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { instance } from '@/instance.js';
import { prefer } from '@/preferences.js';

const $i = ensureSignin();
const showHanamiTimelineDateSeparators = prefer.model('showHanamiTimelineDateSeparators');

type AxisKey = 'popular' | 'lowExposure' | 'trending' | 'fof';
type AxisLevel = 'off' | 'low' | 'normal' | 'high';
type RecommendationStrength = 'low' | 'normal' | 'high' | 'veryHigh';
type RecommendationAutoInjectStrength = 'low' | 'normal' | 'high';
type PresetKey = 'balanced' | 'popular' | 'discover' | 'topic';
type RecommendationAccount = typeof $i & {
	hanamiRecommendationEnabled?: boolean;
	hanamiRecommendationStrength?: RecommendationStrength;
	hanamiRecommendationAutoInjectEnabled?: boolean;
	hanamiRecommendationAutoInjectStrength?: RecommendationAutoInjectStrength;
	hanamiRecommendationAxes?: Partial<Record<AxisKey, AxisLevel | boolean>>;
};
type RecommendationI18n = typeof i18n.ts._hana._recommendation & {
	amountVeryHigh: string;
	autoInject: string;
	autoInjectDescription: string;
	autoInjectAmount: string;
	autoInjectAmountLow: string;
	autoInjectAmountNormal: string;
	autoInjectAmountHigh: string;
	presets: string;
	presetBalanced: string;
	presetPopular: string;
	presetDiscover: string;
	presetTopic: string;
	axisLevelOff: string;
	axisLevelLow: string;
	axisLevelNormal: string;
	axisLevelHigh: string;
};

const account = $i as RecommendationAccount;
const recommendationI18n = i18n.ts._hana._recommendation as RecommendationI18n;

const AXES: AxisKey[] = ['popular', 'lowExposure', 'trending', 'fof'];
const AXIS_ICON: Record<AxisKey, string> = { popular: 'ti-flame', lowExposure: 'ti-seedling', trending: 'ti-trending-up', fof: 'ti-users' };
const PRESET_KEYS: PresetKey[] = ['balanced', 'popular', 'discover', 'topic'];
const PRESET_I18N = { balanced: 'presetBalanced', popular: 'presetPopular', discover: 'presetDiscover', topic: 'presetTopic' } as const;
// 各プリセットが軸ごとに設定する量。候補が無くても破綻しない「多め/少なめ」の指定。
const PRESETS: Record<PresetKey, Record<AxisKey, AxisLevel>> = {
	balanced: { popular: 'normal', lowExposure: 'normal', trending: 'normal', fof: 'normal' },
	popular: { popular: 'high', lowExposure: 'low', trending: 'normal', fof: 'low' },
	discover: { popular: 'low', lowExposure: 'high', trending: 'high', fof: 'normal' },
	topic: { popular: 'normal', lowExposure: 'normal', trending: 'high', fof: 'low' },
};

// 軸オーバーライド: 未設定（undefined）はサーバー既定に従う。鯖管が available=false にした軸はOFF固定。
const storedAxes = account.hanamiRecommendationAxes ?? {};
const serverAxes = (instance as { hanamiRecommendationAxisConfig?: Partial<Record<AxisKey, { available?: boolean; default?: boolean }>> }).hanamiRecommendationAxisConfig ?? {};
const axisAvailable = {
	popular: serverAxes.popular?.available !== false,
	lowExposure: serverAxes.lowExposure?.available !== false,
	trending: serverAxes.trending?.available !== false,
	fof: serverAxes.fof?.available !== false,
};

// 旧boolean / 新stringレベルどちらの保存値も量レベルに正規化。
function axisInitial(axis: AxisKey): AxisLevel {
	if (!axisAvailable[axis]) return 'off';
	const v = storedAxes[axis];
	if (v === 'off' || v === 'low' || v === 'normal' || v === 'high') return v;
	if (v === true) return 'normal';
	if (v === false) return 'off';
	return (serverAxes[axis]?.default ?? true) ? 'normal' : 'off';
}

const enabled = ref<boolean>(account.hanamiRecommendationEnabled ?? true);
const strength = ref<RecommendationStrength>(account.hanamiRecommendationStrength ?? 'high');
const autoInjectEnabled = ref<boolean>(account.hanamiRecommendationAutoInjectEnabled ?? false);
const autoInjectStrength = ref<RecommendationAutoInjectStrength>(account.hanamiRecommendationAutoInjectStrength ?? 'low');
const axisLevels = reactive<Record<AxisKey, AxisLevel>>({
	popular: axisInitial('popular'),
	lowExposure: axisInitial('lowExposure'),
	trending: axisInitial('trending'),
	fof: axisInitial('fof'),
});

function applyPreset(name: PresetKey) {
	const p = PRESETS[name];
	for (const ax of AXES) if (axisAvailable[ax]) axisLevels[ax] = p[ax];
	save();
}

let saveInFlight = false;
let saveQueued = false;

function buildAccountPatch() {
	return {
		hanamiRecommendationEnabled: enabled.value,
		hanamiRecommendationStrength: strength.value,
		hanamiRecommendationAutoInjectEnabled: autoInjectEnabled.value,
		hanamiRecommendationAutoInjectStrength: autoInjectStrength.value,
		hanamiRecommendationAxes: {
			popular: axisLevels.popular,
			lowExposure: axisLevels.lowExposure,
			trending: axisLevels.trending,
			fof: axisLevels.fof,
		},
	};
}

async function saveCurrentState() {
	const accountPatch = buildAccountPatch();
	await misskeyApi('i/update', accountPatch as never);
	updateCurrentAccountPartial(accountPatch as unknown as Parameters<typeof updateCurrentAccountPartial>[0]);
}

async function save() {
	if (saveInFlight) {
		saveQueued = true;
		return;
	}

	saveInFlight = true;
	try {
		do {
			saveQueued = false;
			try {
				await saveCurrentState();
			} catch (err) {
				// eslint-disable-next-line no-console
				console.error('hanamode save failed', err);
			}
		} while (saveQueued);
	} finally {
		saveInFlight = false;
	}
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
</style>
