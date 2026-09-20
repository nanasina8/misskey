<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<MkInfo v-if="loadError" warn>{{ i18n.ts._hana._admin.unavailable }}: {{ loadError }}</MkInfo>
	<template v-else>
		<MkInfo>{{ i18n.ts._hana._recommendation.axisConfigDescription }}</MkInfo>
		<MkFolder v-for="axis in axisKeys" :key="axis">
			<template #label>{{ hanamiReasonLabels[axis] }}</template>
			<template #suffix>
				<span :class="$style.summary">{{ i18n.ts._hana._admin.maximumShare }}: {{ shareText(axis) }} · {{ i18n.ts._hana._admin[judgePolicy(axis)] }}</span>
			</template>
			<template #caption>{{ i18n.ts._hana._admin.confidence }}: high / low / none · {{ axis === 'exploration' ? 'EXPLORATION_SHARE (quota, normal)' : 'AXIS_MAX_SHARE (cap, normal)' }} · {{ i18n.ts._hana._admin.judgePolicy }}</template>
			<div class="_gaps_s">
				<MkSwitch v-model="hanamiRecForm.state[`${axis}Available`]" :disabled="saving">
					<template #label>{{ i18n.ts._hana._admin.available }}<span v-if="hanamiRecForm.modifiedStates[`${axis}Available`]" class="_modified">{{ i18n.ts.modified }}</span></template>
				</MkSwitch>
				<MkSwitch v-model="hanamiRecForm.state[`${axis}Default`]" :disabled="saving || !hanamiRecForm.state[`${axis}Available`]">
					<template #label>{{ i18n.ts._hana._admin.defaultOn }}<span v-if="hanamiRecForm.modifiedStates[`${axis}Default`]" class="_modified">{{ i18n.ts.modified }}</span></template>
				</MkSwitch>
			</div>
		</MkFolder>
		<div v-if="hanamiRecForm.modified.value" class="_buttons">
			<MkButton primary :disabled="saving" @click="save">{{ i18n.ts._hana._admin.save }}</MkButton>
			<MkButton :disabled="saving" @click="hanamiRecForm.discard">{{ i18n.ts._hana._admin.cancel }}</MkButton>
		</div>
	</template>
	<div class="_panel _gaps" style="padding: 16px;">
		<MkKeyValue>
			<template #key>{{ i18n.ts._hana._admin.authorCap }}</template>
			<template #value>{{ AUTHOR_PER_PAGE_CAP }}</template>
		</MkKeyValue>
		<MkKeyValue>
			<template #key>{{ i18n.ts._hana._admin.volumeMultiplier }}</template>
			<template #value>{{ volumeText }}</template>
		</MkKeyValue>
		<MkKeyValue>
			<template #key>{{ i18n.ts._hana._admin.confidence }}</template>
			<template #value>
				<div>engagement = {{ i18n.ts.reaction }} + {{ i18n.ts.reply }} / {{ i18n.ts.renote }}</div>
				<div>high: engagement ≥ {{ CONFIDENCE_HIGH_ENGAGEMENT }} ∧ ALS factor ∧ centroid</div>
				<div>low: ¬high ∧ (engagement ≥ {{ CONFIDENCE_LOW_ENGAGEMENT }} ∨ following ∨ relation)</div>
				<div>none: ¬high ∧ ¬low</div>
			</template>
		</MkKeyValue>
	</div>
</div>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import { useForm } from '@/composables/use-form.js';
import { fetchInstance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const axisKeys = ['globalPopular', 'neighborTrending', 'reactionSimilar', 'catchup', 'trending', 'fof', 'exploration'] as const;
type AxisKey = typeof axisKeys[number];
type AxisConfig = Partial<Record<AxisKey | 'popular', { available?: boolean; default?: boolean }>>;
type AxisFormState = Record<`${AxisKey}${'Available' | 'Default'}`, boolean>;
const axisConfigKeys: Record<AxisKey, readonly (AxisKey | 'popular')[]> = {
	globalPopular: ['globalPopular', 'popular'],
	exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'],
	reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'],
	trending: ['trending'],
	fof: ['fof'],
};
const hanamiReasonLabels = i18n.ts._hana._recommendation._reason;

// Read-only P2 snapshots of backend/core/hanami/HanamiForYouInterleave.ts.
// Six ordinary caps and the independent exploration quota must stay separate.
// These are base shares (all levels normal), not guaranteed delivery percentages.
const AXIS_MAX_SHARE = {
	high: { globalPopular: 0.30, neighborTrending: 0.25, reactionSimilar: 0.15, catchup: 0.07, trending: 0.12, fof: 0.03 },
	low: { globalPopular: 0.55, neighborTrending: 0.12, reactionSimilar: 0.08, catchup: 0.03, trending: 0.12, fof: 0.02 },
	none: { globalPopular: 0.75, neighborTrending: 0.00, reactionSimilar: 0.00, catchup: 0.00, trending: 0.12, fof: 0.03 },
} as const;
const EXPLORATION_SHARE = { high: 0.08, low: 0.08, none: 0.10 } as const;
const AXIS_LEVEL_WEIGHT = { off: 0, low: 0.55, normal: 1.0, high: 1.6 } as const;
const AUTHOR_PER_PAGE_CAP = 2;
// HanamiForYouService.computeConfidence: engagement counts reactions + reply/renote posts.
const CONFIDENCE_HIGH_ENGAGEMENT = 50;
const CONFIDENCE_LOW_ENGAGEMENT = 5;
const volumeText = Object.entries(AXIS_LEVEL_WEIGHT).map(([level, weight]) => `${level}: ×${weight}`).join(' / ');

function shareText(axis: AxisKey): string {
	return (['high', 'low', 'none'] as const).map(confidence => `${Math.round(100 * (axis === 'exploration' ? EXPLORATION_SHARE[confidence] : AXIS_MAX_SHARE[confidence][axis]))}%`).join(' / ');
}

function judgePolicy(axis: AxisKey): 'passOnly' | 'hideEphemeral' | 'noJudge' {
	return axis === 'exploration' ? 'passOnly' : axis === 'globalPopular' || axis === 'trending' ? 'hideEphemeral' : 'noJudge';
}

const loadError = ref<string | null>(null);
const saving = ref(false);
let axisCfg: AxisConfig = {};
try {
	axisCfg = (await misskeyApi('admin/meta')).hanamiRecommendationAxisConfig ?? {};
} catch (err) {
	loadError.value = err instanceof Error ? err.message : String(err);
}

function axisCfgValue(axis: AxisKey, key: 'available' | 'default'): boolean {
	return axisConfigKeys[axis].map(k => axisCfg[k]?.[key]).find(v => v !== undefined) ?? true;
}

const initialState = Object.fromEntries(axisKeys.flatMap(axis => [
	[`${axis}Available`, axisCfgValue(axis, 'available')],
	[`${axis}Default`, axisCfgValue(axis, 'default')],
])) as AxisFormState;
const hanamiRecForm = useForm(initialState, async (state) => {
	// update-meta replaces this JSON object. Retain legacy/unknown entries and
	// fields not represented by these switches. Materialize all seven effective
	// values so editing reactionSimilar cannot implicitly change neighborTrending.
	const latest = (await misskeyApi('admin/meta')).hanamiRecommendationAxisConfig ?? {};
	const config: AxisConfig = { ...latest };
	for (const axis of axisKeys) {
		config[axis] = {
			...config[axis],
			available: state[`${axis}Available`],
			default: state[`${axis}Default`],
		};
	}
	await misskeyApi('admin/update-meta', { hanamiRecommendationAxisConfig: config });
	void fetchInstance(true);
});

async function save() {
	if (saving.value || loadError.value || !hanamiRecForm.modified.value) return;
	saving.value = true;
	try {
		await hanamiRecForm.save();
	} catch (err) {
		await os.alert({ type: 'error', text: err instanceof Error ? err.message : String(err) });
	} finally {
		saving.value = false;
	}
}
</script>

<style lang="scss" module>
.summary {
	white-space: normal;
}
</style>
