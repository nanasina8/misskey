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

				<MkSwitch v-model="showReason" :disabled="!enabled" @update:modelValue="save">
					<template #label>{{ i18n.ts._hana._recommendation.showReason }}</template>
					<template #caption>{{ i18n.ts._hana._recommendation.showReasonDescription }}</template>
				</MkSwitch>

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
import MkPreferenceContainer from '@/components/MkPreferenceContainer.vue';
import { ensureSignin } from '@/i.js';
import { updateCurrentAccountPartial } from '@/accounts.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';

// For You-only 化（canonical spec §7/§14-D5）: per-axis/preset/amount は廃止し、
// 残すのは はなみTL ON/OFF・理由表示・auto-inject のみ（§2）。
const $i = ensureSignin();
const showHanamiTimelineDateSeparators = prefer.model('showHanamiTimelineDateSeparators');

type RecommendationAutoInjectStrength = 'low' | 'normal' | 'high';
type ExploreMediaFilter = 'all' | 'hideSensitive' | 'hideMedia';
type RecommendationAccount = typeof $i & {
	exploreMediaFilter?: ExploreMediaFilter;
	hanamiRecommendationEnabled?: boolean;
	hanamiRecommendationAutoInjectEnabled?: boolean;
	hanamiRecommendationAutoInjectStrength?: RecommendationAutoInjectStrength;
	hanamiShowRecommendationReason?: boolean;
};
type RecommendationI18n = typeof i18n.ts._hana._recommendation & {
	autoInject: string;
	autoInjectDescription: string;
	autoInjectAmount: string;
	autoInjectAmountLow: string;
	autoInjectAmountNormal: string;
	autoInjectAmountHigh: string;
};

const account = $i as RecommendationAccount;
const recommendationI18n = i18n.ts._hana._recommendation as RecommendationI18n;
const exploreI18n = (i18n.ts._hana as typeof i18n.ts._hana & { _explore: { mediaFilter: string; mediaFilterDescription: string; mediaFilterAll: string; mediaFilterHideSensitive: string; mediaFilterHideMedia: string } })._explore;

const enabled = ref<boolean>(account.hanamiRecommendationEnabled ?? true);
const autoInjectEnabled = ref<boolean>(account.hanamiRecommendationAutoInjectEnabled ?? true);
const autoInjectStrength = ref<RecommendationAutoInjectStrength>(account.hanamiRecommendationAutoInjectStrength ?? 'low');
const showReason = ref<boolean>(account.hanamiShowRecommendationReason ?? false);
const exploreMediaFilter = ref<ExploreMediaFilter>(account.exploreMediaFilter ?? 'all');

let saveInFlight = false;
let saveQueued = false;

function buildAccountPatch() {
	return {
		hanamiRecommendationEnabled: enabled.value,
		hanamiRecommendationAutoInjectEnabled: autoInjectEnabled.value,
		hanamiRecommendationAutoInjectStrength: autoInjectStrength.value,
		hanamiShowRecommendationReason: showReason.value,
	};
}

async function saveCurrentState() {
	const accountPatch = buildAccountPatch();
	await misskeyApi('i/update', accountPatch as never);
	updateCurrentAccountPartial(accountPatch as unknown as Parameters<typeof updateCurrentAccountPartial>[0]);
}

async function saveExploreMediaFilter() {
	const patch = { exploreMediaFilter: exploreMediaFilter.value };
	await misskeyApi('i/update', patch as never);
	updateCurrentAccountPartial(patch as unknown as Parameters<typeof updateCurrentAccountPartial>[0]);
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
