<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/admin/hanami" :label="i18n.ts._hana._admin.judge" :keywords="['hanami', 'judge']" icon="ti ti-scale">
	<div class="_gaps">
		<MkFolder :defaultOpen="true">
			<template #icon><i class="ti ti-activity"></i></template>
			<template #label>{{ t.status }}</template>
			<div class="_gaps">
				<div :class="$style.cards">
					<MkKeyValue :class="$style.card"><template #key>{{ t.runtime }}</template><template #value>{{ runtimeText }}</template></MkKeyValue>
					<MkKeyValue :class="$style.card"><template #key>{{ t.promptVersion }}</template><template #value>{{ metric(status?.promptVersion) }}</template></MkKeyValue>
					<MkKeyValue :class="$style.card"><template #key>{{ t.backlog }}</template><template #value>{{ metric(status?.backlog) }}</template></MkKeyValue>
					<MkKeyValue :class="$style.card"><template #key>{{ t.secondsPerNote }}</template><template #value>{{ metric(secondsPerNote) }}</template></MkKeyValue>
				</div>
				<div v-if="status" :class="$style.caption">{{ status.model }} · {{ status.latestRun?.status ?? '—' }} · {{ date(status.latestRun?.finishedAt ?? status.latestRun?.startedAt) }}</div>
				<MkInfo v-if="status?.runtime.available === false" warn>{{ t.trialUnavailable }} — {{ status.runtime.reason }}</MkInfo>
				<MkInfo v-if="status?.runtime.available === false">{{ t.fallback }}: {{ t.fallbackDescription }}</MkInfo>
				<MkInfo v-if="statusError" warn>{{ t.error }}: {{ statusError }}</MkInfo>
				<MkButton :disabled="statusLoading" @click="refreshStatus(true)"><i class="ti ti-refresh"></i> {{ statusLoading ? t.loading : t.refreshNow }}</MkButton>
			</div>
		</MkFolder>

		<MkInfo v-if="settingsError" warn>{{ t.error }}: {{ settingsError }}</MkInfo>
		<MkButton v-if="settingsError" @click="loadSettings">{{ t.retry }}</MkButton>
		<MkInfo v-if="!settingsLoaded && !settingsError">{{ t.loading }}</MkInfo>
		<template v-if="settingsLoaded">
			<MkFolder :defaultOpen="true">
				<template #icon><i class="ti ti-scale"></i></template>
				<template #label>{{ t.judge }}</template>
				<template #suffix>v{{ form.savedState.promptVersion }}<span v-if="form.modified.value" class="_modified">{{ i18n.ts.modified }}</span></template>
				<template #footer><MkFormFooter :form="footerForm" :canSaving="valid && !saving"/></template>
				<div class="_gaps" :inert="saving">
					<MkSwitch v-if="typeof form.state.enabled === 'boolean'" v-model="form.state.enabled">{{ t.enabled }}</MkSwitch>
					<MkKeyValue v-else><template #key>{{ t.enabled }}</template><template #value>{{ t.unavailable }}</template></MkKeyValue>
					<MkFolder>
						<template #label>{{ t.q1 }}</template>
						<div class="_gaps">
							<MkTextarea v-for="item in q1Basis" :key="item.key" v-model="form.state.basis[item.key]"><template #label>{{ item.label }}</template></MkTextarea>
						</div>
					</MkFolder>
					<MkFolder>
						<template #label>{{ t.q2 }}</template>
						<div class="_gaps">
							<MkTextarea v-for="item in q2Basis" :key="item.key" v-model="form.state.basis[item.key]"><template #label>{{ item.label }}</template></MkTextarea>
						</div>
					</MkFolder>
					<MkFolder>
						<template #label>{{ t.q3 }}</template>
						<div class="_gaps">
							<MkInfo>{{ t.contentTypeBonus }} (0–10)</MkInfo>
							<div :class="$style.inputs">
								<MkInput v-for="(label, index) in contentTypes" :key="index" v-model="form.state.contentTypeBonus[index]" type="number" :min="0" :max="10" :step="0.1"><template #label>{{ index }} · {{ label }}</template></MkInput>
							</div>
						</div>
					</MkFolder>
					<MkFolder>
						<template #label>{{ t.examples }}</template>
						<template #suffix>{{ form.state.examples.length }} / 30</template>
						<div class="_gaps">
							<div v-for="(_, index) in form.state.examples" :key="index" class="_gaps_s">
								<MkTextarea v-model="form.state.examples[index]"><template #label>{{ t.examples }} {{ index + 1 }}</template></MkTextarea>
								<MkButton small danger @click="form.state.examples.splice(index, 1)"><i class="ti ti-trash"></i> {{ i18n.ts.delete }}</MkButton>
							</div>
							<MkButton :disabled="form.state.examples.length >= 30" @click="form.state.examples.push('')"><i class="ti ti-plus"></i> {{ i18n.ts.add }}</MkButton>
						</div>
					</MkFolder>
					<MkFolder>
						<template #label>{{ t.templatePatterns }}</template>
						<div class="_gaps_s">
							<MkTextarea v-model="form.state.templatePatternsText" code><template #label>{{ t.templatePatterns }}</template><template #caption>{{ t.templatePatternsDescription }}</template></MkTextarea>
							<ol v-if="regexRows.some(row => row.invalid)" :class="$style.regexErrors" aria-live="polite">
								<li v-for="row in regexRows.filter(row => row.invalid)" :key="row.index" :value="row.index + 1"><code>{{ row.pattern }}</code> — {{ t.invalidRegex }}</li>
							</ol>
						</div>
					</MkFolder>
					<div :class="$style.inputs">
						<MkInput v-model="form.state.ephemeralThreshold" type="number" :step="0.05"><template #label>{{ t.thetaEphemeral }}</template></MkInput>
						<MkInput v-model="form.state.interestThreshold" type="number" :step="0.05"><template #label>{{ t.thetaInterest }}</template></MkInput>
						<MkInput v-model="form.state.reactionMax" type="number" :min="0" :step="0.1"><template #label>{{ t.reactionMax }}</template></MkInput>
						<MkInput v-model="form.state.interestMax" type="number" :min="0" :step="0.1"><template #label>{{ t.interestMax }}</template></MkInput>
					</div>
					<MkInfo v-if="!valid" warn>{{ t.error }} — {{ t.basis }} ≤ 2000 · {{ t.examples }} ≤ 30 × 2000 · {{ t.templatePatterns }} ≤ 100 × 512 · {{ t.contentTypeBonus }} 0–10</MkInfo>
				</div>
			</MkFolder>

			<MkFolder :defaultOpen="true">
				<template #icon><i class="ti ti-adjustments"></i></template>
				<template #label>{{ axisLabels.exploration }} · {{ t.whatIf }}</template>
				<div class="_gaps">
					<MkRange v-model="form.state.interestThreshold" :min="1" :max="5" :step="0.05" :continuousUpdate="true" :disabled="saving"><template #label>{{ t.thetaInterest }}: {{ metric(form.state.interestThreshold) }}</template><template #caption>{{ t.save }}: θi {{ metric(form.savedState.interestThreshold) }} → {{ metric(form.state.interestThreshold) }} · θe {{ metric(form.savedState.ephemeralThreshold) }} ({{ t.whatIf }})</template></MkRange>
					<MkInfo>{{ t.whatIfDraftDescription }}</MkInfo>
					<MkInfo v-if="whatIfLoading">{{ t.loading }}</MkInfo>
					<MkInfo v-if="whatIfError" warn>{{ t.error }}: {{ whatIfError }}</MkInfo>
					<MkButton v-if="whatIfError" @click="refreshWhatIf">{{ t.retry }}</MkButton>
					<template v-if="whatIfResult">
						<div :class="$style.caption">{{ whatIfResult.range.from }} – {{ whatIfResult.range.to }}</div>
						<div :class="$style.tableScroll">
							<table :class="$style.table">
								<thead><tr><th scope="col">{{ t.thetaInterest }}</th><th scope="col">{{ t.passed }}</th><th scope="col">{{ t.stockChange }}</th><th scope="col">{{ t.engagementRate }}</th></tr></thead>
								<tbody><tr v-for="row in whatIfResult.interest" :key="row.theta" :class="{ [$style.selected]: row.theta === form.state.interestThreshold }"><th scope="row">{{ metric(row.theta) }}</th><td>{{ metric(row.passed) }}</td><td>{{ stockDelta(row.passed) }}</td><td>{{ percent(row.passedEngagementRate) }}</td></tr></tbody>
							</table>
						</div>
						<div class="_gaps_s"><strong>{{ t.contentTypeEngagement }}</strong><div v-for="row in whatIfResult.contentTypeBonus" :key="row.contentType" :class="$style.typeRate"><span>{{ typeLabel(row.contentType) }}</span><span>{{ percent(row.engagementRate) }} · {{ t.contentTypeBonus }} {{ metric(row.bonusNow) }}</span></div></div>
						<MkInfo v-if="whatIfResult.unavailable.length">{{ t.unavailable }}: {{ whatIfResult.unavailable.join(', ') }}</MkInfo>
						<MkInfo v-if="whatIfResult.suppressed.length">{{ t.suppressedFewUsers }}: {{ whatIfResult.suppressed.join(', ') }}</MkInfo>
					</template>
				</div>
			</MkFolder>

			<MkFolder>
				<template #icon><i class="ti ti-player-play"></i></template>
				<template #label>{{ t.trial }}</template>
				<div class="_gaps">
					<MkButton primary :disabled="!trialAvailable || !valid || trialLoading || saving" @click="runTrial">{{ trialLoading ? t.loading : t.trial }} (50)</MkButton>
					<MkInfo v-if="!trialAvailable" warn>{{ t.trialUnavailable }}</MkInfo>
					<MkInfo v-if="trialError" warn>{{ t.error }}: {{ trialError }}</MkInfo>
					<div v-if="trialItems !== null" class="_gaps">
						<MkInfo v-if="trialDraftChanged" warn>{{ i18n.ts.draft }}: {{ i18n.ts.modified }}</MkInfo>
						<div :class="$style.chips" role="group" :aria-label="t.reason">
							<button type="button" class="_button" :class="[$style.chip, { [$style.selected]: trialFilter === null }]" :aria-pressed="trialFilter === null" @click="trialFilter = null">{{ t.allReasons }} ({{ trialItems.length }})</button>
							<button v-for="reason in trialReasons" :key="reason" type="button" class="_button" :class="[$style.chip, { [$style.selected]: trialFilter === reason }]" :aria-pressed="trialFilter === reason" @click="trialFilter = reason">{{ reasonLabel(reason) }} ({{ trialItems.filter(item => item.reason === reason).length }})</button>
						</div>
						<div :class="$style.tableScroll">
							<table :class="$style.table">
								<thead><tr><th scope="col">{{ t.note }}</th><th scope="col">{{ t.score }}</th><th scope="col">Q1</th><th scope="col">Q2</th><th scope="col">Q3</th><th scope="col">{{ t.reason }}</th></tr></thead>
								<tbody><tr v-for="(item, index) in filteredTrial" :key="`${item.noteId}:${index}`"><td :class="$style.note"><MkA :to="`/notes/${item.noteId}`">{{ item.text || item.noteId }}</MkA></td><td>{{ metric(item.reactionScore) }}</td><td>{{ metric(item.ephemeralScore) }}</td><td>{{ metric(item.interest) }}</td><td>{{ typeLabel(item.contentType) }}</td><td>{{ reasonLabel(item.reason) }}</td></tr></tbody>
							</table>
						</div>
					</div>
				</div>
			</MkFolder>
		</template>

		<MkFolder :defaultOpen="true">
			<template #icon><i class="ti ti-chart-bar"></i></template>
			<template #label>{{ t.judge }} · {{ t.stats }} (24h)</template>
			<div class="_gaps">
				<MkInfo v-if="aggregateError" warn>{{ t.error }}: {{ aggregateError }}</MkInfo>
				<MkButton :disabled="aggregateLoading" @click="refreshAggregate">{{ aggregateLoading ? t.loading : t.refreshNow }}</MkButton>
				<div :class="$style.cards">
					<MkKeyValue :class="$style.card"><template #key>{{ t.judge }}</template><template #value>{{ metric(aggregate?.judged) }}</template></MkKeyValue>
					<MkKeyValue :class="$style.card"><template #key>{{ t.q1 }}</template><template #value>{{ metric(aggregate?.ephemeral) }}</template></MkKeyValue>
					<MkKeyValue :class="$style.card"><template #key>{{ t.q2 }}</template><template #value>{{ metric(aggregate?.interestFiltered) }}</template></MkKeyValue>
					<MkKeyValue :class="$style.card"><template #key>{{ t.hiddenCost }} (30d)</template><template #value>{{ metric(hiddenTotal) }}</template></MkKeyValue>
				</div>
				<div v-if="aggregate" class="_gaps_s">
					<div v-for="row in aggregate.typeBreakdown" :key="row.contentType" :class="$style.typeRow"><span>{{ typeLabel(row.contentType) }}</span><meter v-if="aggregate.judged != null" :min="0" :max="Math.max(1, aggregate.judged)" :value="row.count" :aria-label="typeLabel(row.contentType)"></meter><span v-else>{{ t.unavailable }}</span><span>{{ metric(row.count) }}</span></div>
					<div :class="$style.tableScroll">
						<table :class="$style.table">
							<caption>{{ t.served }} · 20 (24h)</caption>
							<thead><tr><th scope="col">{{ t.note }}</th><th scope="col">{{ t.score }}</th><th scope="col">Q1</th><th scope="col">Q2</th></tr></thead>
							<tbody><tr v-for="(item, index) in aggregate.topServed.slice(0, 20)" :key="`${item.noteId}:${index}`"><td :class="$style.note"><MkA :to="`/notes/${item.noteId}`">{{ item.text || item.noteId }}</MkA></td><td>{{ metric(item.reactionScore) }}</td><td>{{ metric(item.ephemeralScore) }}</td><td>{{ metric(item.interest) }}</td></tr></tbody>
						</table>
					</div>
				</div>
				<MkInfo v-if="hiddenError" warn>{{ t.hiddenCost }}: {{ hiddenError }}</MkInfo>
				<MkInfo v-if="hiddenSuppressed.length" warn>{{ t.suppressedFewUsers }}: {{ hiddenSuppressed.join(', ') }}</MkInfo>
				<MkInfo v-if="hiddenUnavailable.length" warn>{{ t.partialData }} — {{ t.unavailable }}: {{ hiddenUnavailable.join(', ') }}</MkInfo>
				<div v-for="row in hiddenCosts" :key="row.axis" :class="$style.typeRate"><span>{{ axisLabel(row.axis) }}</span><span>{{ t.hiddenCost }} {{ metric(row.hidden) }}</span></div>
			</div>
		</MkFolder>

		<MkFolder>
			<template #icon><i class="ti ti-lock"></i></template>
			<template #label>{{ t.judgePolicy }}</template>
			<div class="_gaps_s"><MkKeyValue v-for="axis in axes" :key="axis" oneline><template #key>{{ axisLabels[axis] }}</template><template #value>{{ axis === 'exploration' ? t.passOnly : axis === 'globalPopular' || axis === 'trending' ? t.hideEphemeral : t.noJudge }}</template></MkKeyValue></div>
		</MkFolder>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import type { JudgeSettings } from '@/scripts/hanami-judge-form.js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkFormFooter from '@/components/MkFormFooter.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkRange from '@/components/MkRange.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import { useForm } from '@/composables/use-form.js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { createJudgeDebounce, judgeFormToSettings, judgeFormValid, judgePromptChanged, judgeRegexRows, judgeRejudgeEstimate, judgeSecondsPerNote, judgeSettingsToForm, judgeTrialAvailable } from '@/scripts/hanami-judge-form.js';

defineOptions({ name: 'HanamiJudge' });

const t = i18n.ts._hana._admin;
const axes = ['globalPopular', 'exploration', 'trending', 'neighborTrending', 'reactionSimilar', 'catchup', 'fof'] as const;
const axisLabels = i18n.ts._hana._recommendation._reason;
const axisLabel = (axis: string) => axes.includes(axis as typeof axes[number]) ? axisLabels[axis as typeof axes[number]] : axis;
// These labels describe the fixed Japanese model choices, not editable prompt fields.
const contentTypes = ['挨拶・相づち・定型文', 'ニュース・情報の共有', '解説・知識・ハウツー', '意見・考察・問題提起', '出来事・体験談・エピソード', 'ユーモア・ネタ・大喜利', '作品の投稿', '写真・食事・日常の記録', '告知・宣伝・募集・企画参加', '近況・独り言・感情の吐露'];
const q1Basis = [{ key: 'ephemeralA', label: 'A · その場限りの投稿' }, { key: 'ephemeralB', label: 'B · 単独で読める投稿' }] as const;
const q2Basis = [{ key: 'interest1', label: '1 · 第三者が読む価値がない' }, { key: 'interest2', label: '2 · ありふれた近況や独り言' }, { key: 'interest3', label: '3 · 普通' }, { key: 'interest4', label: '4 · 得るものや面白さがある' }, { key: 'interest5', label: '5 · 新しい情報・視点・気づき' }] as const;

const status = ref<entities.AdminHanamiJudgeStatusResponse | null>(null);
const statusLoading = ref(false);
const statusError = ref('');
const aggregate = ref<entities.AdminHanamiJudgeAggregateResponse | null>(null);
const aggregateLoading = ref(false);
const aggregateError = ref('');
const hiddenMetrics = ref<entities.AdminHanamiMetricsOpportunitiesResponse | null>(null);
const hiddenCosts = computed(() => hiddenMetrics.value?.hiddenCost ?? null);
const hiddenSuppressed = computed(() => hiddenMetrics.value?.suppressed.filter(key => key.includes('hiddenCost')) ?? []);
const hiddenUnavailable = computed(() => hiddenMetrics.value?.unavailable.filter(key => key.includes('hiddenCost')) ?? []);
const hiddenError = ref('');
const hiddenTotal = computed(() => {
	// A normal-TL exposure denominator affects rates, not candidate counts. All
	// other missing/suppressed hidden-cost cohorts make the count total unknown.
	if (hiddenSuppressed.value.length || hiddenUnavailable.value.some(key => key !== 'hiddenCost.normalExposureDenominator')) return null;
	return hiddenCosts.value?.length ? hiddenCosts.value.reduce<number | null>((sum, row) => sum == null || row.hidden == null ? null : sum + row.hidden, 0) : null;
});
const secondsPerNote = computed(() => status.value?.secPerNote ?? judgeSecondsPerNote(status.value?.latestRun?.params));
const runtimeText = computed(() => status.value == null ? '—' : status.value.runtime.available ? [status.value.runtime.device, status.value.runtime.deviceName].filter(Boolean).join(' · ') : t.unavailable);
const trialAvailable = computed(() => judgeTrialAvailable(status.value?.runtime));
const settingsLoaded = ref(false);
const settingsError = ref('');
const saving = ref(false);
let disposed = false;
const form = useForm(judgeSettingsToForm({
	schemaVersion: 1, promptVersion: 1, enabled: undefined,
	ephemeralThreshold: 0, interestThreshold: 2.95, reactionMax: 3, interestMax: 10,
	basis: { ephemeralA: '', ephemeralB: '', interest1: '', interest2: '', interest3: '', interest4: '', interest5: '' },
	examples: [], templatePatterns: [], contentTypeBonus: [],
}), async (state) => {
	const saved = await misskeyApi('admin/hanami/judge-settings', { settings: judgeFormToSettings(state) });
	Object.assign(form.state, judgeSettingsToForm(saved));
});
const regexRows = computed(() => judgeRegexRows(form.state.templatePatternsText));
const valid = computed(() => judgeFormValid(form.state));
// Do not return early inside useForm's save callback: that incorrectly clears dirty state.
const footerForm = { ...form, save: saveSettings, discard: () => { if (!saving.value) form.discard(); } };

const metric = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const percent = (value: number | null | undefined) => value == null ? '—' : `${metric(value * 100)}%`;
const date = (value: string | null | undefined) => value == null ? '—' : new Date(value).toLocaleString();
const typeLabel = (value: number | null) => value == null ? '—' : contentTypes[value] ?? String(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === 'object' && error != null && 'message' in error ? String(error.message) : String(error);

async function loadSettings() {
	settingsError.value = '';
	try {
		const settings = await misskeyApi('admin/hanami/judge-settings');
		if (disposed) return;
		Object.assign(form.state, judgeSettingsToForm(settings));
		Object.assign(form.savedState, judgeSettingsToForm(settings));
		settingsLoaded.value = true;
		whatIfDebounce.schedule();
	} catch (error) { settingsError.value = errorText(error); }
}

async function refreshStatus(force = false) {
	if (statusLoading.value) return;
	statusLoading.value = true;
	statusError.value = '';
	try {
		status.value = await misskeyApi('admin/hanami/judge-status', { force });
	} catch (error) {
		statusError.value = errorText(error);
	} finally {
		statusLoading.value = false;
	}
}

async function refreshAggregate() {
	if (aggregateLoading.value) return;
	aggregateLoading.value = true;
	aggregateError.value = '';
	hiddenError.value = '';
	await Promise.all([
		misskeyApi('admin/hanami/judge-aggregate').then(result => { aggregate.value = result; }).catch(error => { aggregateError.value = errorText(error); }),
		misskeyApi('admin/hanami/metrics/opportunities', { range: { days: 30 } }).then(result => { hiddenMetrics.value = result; }).catch(error => { hiddenMetrics.value = null; hiddenError.value = errorText(error); }),
	]);
	aggregateLoading.value = false;
}

async function saveSettings() {
	if (!valid.value || saving.value) return;
	saving.value = true;
	try {
		if (judgePromptChanged(judgeFormToSettings(form.savedState), judgeFormToSettings(form.state))) {
			const estimate = judgeRejudgeEstimate(status.value?.backlog, status.value?.candidateCount, secondsPerNote.value);
			const version = status.value?.promptVersion ?? form.savedState.promptVersion;
			const { canceled } = await os.confirm({
				type: 'warning', title: t.promptChangeConfirm,
				text: `${t.promptVersion}: v${version} → v${version + 1}\n${t.backlog}: ${metric(status.value?.backlog)} + ${metric(status.value?.candidateCount)} = ${metric(estimate.count)}\n${t.estimatedTime}: ${metric(estimate.seconds)} s`,
			});
			if (canceled || disposed) return;
		}
		await form.save();
		if (disposed) return;
		void refreshStatus();
		void refreshAggregate();
		whatIfDebounce.schedule();
	} catch (error) {
		await os.alert({ type: 'error', text: errorText(error) });
	} finally {
		saving.value = false;
	}
}

const trialItems = ref<entities.AdminHanamiJudgeTrialResponse['items'] | null>(null);
const trialSettings = ref<JudgeSettings | null>(null);
const trialDraftChanged = computed(() => trialSettings.value != null && JSON.stringify(trialSettings.value) !== JSON.stringify(judgeFormToSettings(form.state)));
const trialFilter = ref<string | null>(null);
const trialLoading = ref(false);
const trialError = ref('');
const trialReasons = computed(() => [...new Set(trialItems.value?.map(item => item.reason) ?? [])]);
const filteredTrial = computed(() => trialItems.value?.filter(item => trialFilter.value == null || item.reason === trialFilter.value) ?? []);
const reasonLabel = (reason: string) => ({ eligible: t.passed, ephemeral: t.q1, lowInterest: t.q2, template: t.templatePatterns, unjudged: t.noJudge, bot: 'bot', reply: i18n.ts.reply, emptyText: t.noData }[reason] ?? reason);

async function runTrial() {
	if (!trialAvailable.value || !valid.value || trialLoading.value || saving.value) return;
	trialLoading.value = true;
	trialError.value = '';
	trialItems.value = null;
	const draft = judgeFormToSettings(form.state);
	try {
		trialItems.value = (await misskeyApi('admin/hanami/judge-trial', { limit: 50, settings: draft })).items;
		trialSettings.value = draft;
		trialFilter.value = null;
	} catch (error) {
		trialError.value = errorText(error);
	} finally {
		trialLoading.value = false;
	}
}

const whatIfResult = ref<entities.AdminHanamiMetricsWhatIfResponse | null>(null);
const whatIfLoading = ref(false);
const whatIfError = ref('');
let whatIfSequence = 0;
let whatIfAbort: AbortController | null = null;
const whatIfDebounce = createJudgeDebounce(() => { void refreshWhatIf(); });

function invalidateWhatIf() {
	whatIfSequence++;
	whatIfAbort?.abort();
	whatIfResult.value = null;
	whatIfError.value = '';
	whatIfLoading.value = settingsLoaded.value;
	if (settingsLoaded.value) whatIfDebounce.schedule();
}

// The endpoint evaluates against all saved settings, including bonuses and the
// prompt version. A successful save must invalidate old results even if neither
// threshold changed; unsaved non-interest edits are deliberately not simulated.
watch(() => [form.state.interestThreshold, form.savedState], invalidateWhatIf, { deep: true });

async function refreshWhatIf() {
	whatIfDebounce.cancel();
	whatIfAbort?.abort();
	const sequence = ++whatIfSequence;
	if (disposed || !settingsLoaded.value || !Number.isFinite(form.state.interestThreshold)) { whatIfLoading.value = false; return; }
	whatIfAbort = new AbortController();
	whatIfLoading.value = true;
	whatIfError.value = '';
	try {
		// Each array varies one threshold against SAVED settings; never silently simulate a joint draft.
		const interest = [...new Set([2.5, 2.95, 3.2, 3.5, form.savedState.interestThreshold, form.state.interestThreshold])].sort((a, b) => a - b);
		const result = await misskeyApi('admin/hanami/metrics/what-if', { range: { days: 30 }, axis: 'exploration', thresholds: { interest } }, undefined, whatIfAbort.signal);
		if (sequence === whatIfSequence) whatIfResult.value = result;
	} catch (error) {
		if (sequence === whatIfSequence) { whatIfResult.value = null; whatIfError.value = errorText(error); }
	} finally {
		if (sequence === whatIfSequence) whatIfLoading.value = false;
	}
}

function stockDelta(passed: number | null): string {
	const baseline = whatIfResult.value?.interest.find(row => row.theta === form.savedState.interestThreshold)?.passed;
	if (passed == null || baseline == null) return '—';
	const delta = passed - baseline;
	return `${delta > 0 ? '+' : ''}${metric(delta)}`;
}

onMounted(() => { void loadSettings(); void refreshStatus(); void refreshAggregate(); });
onUnmounted(() => { disposed = true; whatIfDebounce.cancel(); whatIfSequence++; whatIfAbort?.abort(); });
</script>

<style lang="scss" module>
.cards, .inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.card { padding: 16px; background: var(--MI_THEME-bg); border-radius: 10px; overflow-wrap: anywhere; }
.caption { font-size: .85em; color: var(--MI_THEME-fgTransparentWeak); overflow-wrap: anywhere; }
.tableScroll { overflow-x: auto; }
.table {
	width: 100%; border-collapse: collapse; font-size: .9em;
	th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid var(--MI_THEME-divider); }
	thead th { white-space: nowrap; }
	caption { text-align: left; padding: 12px 0; font-weight: bold; }
}
.note { min-width: 180px; max-width: 320px; overflow-wrap: anywhere; white-space: pre-wrap; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border-radius: 100px; padding: 8px 12px; background: var(--MI_THEME-buttonBg); font-size: .85em; }
.selected { background: var(--MI_THEME-accentedBg); color: var(--MI_THEME-accent); }
.regexErrors { color: var(--MI_THEME-error); overflow-wrap: anywhere; }
.typeRow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(60px, 1fr) auto; gap: 12px; align-items: center; font-size: .85em; padding: 4px 0; meter { width: 100%; accent-color: var(--MI_THEME-accent); } }
.typeRate { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: .85em; }
</style>
