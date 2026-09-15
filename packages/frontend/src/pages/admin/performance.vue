<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<SearchMarker path="/admin/performance" :label="i18n.ts.performance" :keywords="['performance']" icon="ti ti-bolt">
			<div class="_gaps">
				<SearchMarker>
					<div class="_panel" style="padding: 16px;">
						<MkSwitch v-model="enableServerMachineStats" @change="onChange_enableServerMachineStats">
							<template #label><SearchLabel>{{ i18n.ts.enableServerMachineStats }}</SearchLabel></template>
							<template #caption>{{ i18n.ts.turnOffToImprovePerformance }}</template>
						</MkSwitch>
					</div>
				</SearchMarker>

				<SearchMarker>
					<div class="_panel" style="padding: 16px;">
						<MkSwitch v-model="enableIdenticonGeneration" @change="onChange_enableIdenticonGeneration">
							<template #label><SearchLabel>{{ i18n.ts.enableIdenticonGeneration }}</SearchLabel></template>
							<template #caption>{{ i18n.ts.turnOffToImprovePerformance }}</template>
						</MkSwitch>
					</div>
				</SearchMarker>

				<SearchMarker>
					<div class="_panel" style="padding: 16px;">
						<MkSwitch v-model="enableChartsForRemoteUser" @change="onChange_enableChartsForRemoteUser">
							<template #label><SearchLabel>{{ i18n.ts.enableChartsForRemoteUser }}</SearchLabel></template>
							<template #caption>{{ i18n.ts.turnOffToImprovePerformance }}</template>
						</MkSwitch>
					</div>
				</SearchMarker>

				<SearchMarker>
					<div class="_panel" style="padding: 16px;">
						<MkSwitch v-model="enableStatsForFederatedInstances" @change="onChange_enableStatsForFederatedInstances">
							<template #label><SearchLabel>{{ i18n.ts.enableStatsForFederatedInstances }}</SearchLabel></template>
							<template #caption>{{ i18n.ts.turnOffToImprovePerformance }}</template>
						</MkSwitch>
					</div>
				</SearchMarker>

				<SearchMarker>
					<div class="_panel" style="padding: 16px;">
						<MkSwitch v-model="enableChartsForFederatedInstances" @change="onChange_enableChartsForFederatedInstances">
							<template #label><SearchLabel>{{ i18n.ts.enableChartsForFederatedInstances }}</SearchLabel></template>
							<template #caption>{{ i18n.ts.turnOffToImprovePerformance }}</template>
						</MkSwitch>
					</div>
				</SearchMarker>

				<SearchMarker>
					<div class="_panel" style="padding: 16px;">
						<MkSwitch v-model="showRoleBadgesOfRemoteUsers" @change="onChange_showRoleBadgesOfRemoteUsers">
							<template #label><SearchLabel>{{ i18n.ts.showRoleBadgesOfRemoteUsers }}</SearchLabel></template>
							<template #caption>{{ i18n.ts.turnOffToImprovePerformance }}</template>
						</MkSwitch>
					</div>
				</SearchMarker>

				<SearchMarker>
					<MkFolder :defaultOpen="true">
						<template #icon><SearchIcon><i class="ti ti-bolt"></i></SearchIcon></template>
						<template #label><SearchLabel>Misskey® Fan-out Timeline Technology™ (FTT)</SearchLabel></template>
						<template v-if="fttForm.savedState.enableFanoutTimeline" #suffix>Enabled</template>
						<template v-else #suffix>Disabled</template>
						<template v-if="fttForm.modified.value" #footer>
							<MkFormFooter :form="fttForm"/>
						</template>

						<div class="_gaps">
							<SearchMarker>
								<MkSwitch v-model="fttForm.state.enableFanoutTimeline">
									<template #label><SearchLabel>{{ i18n.ts.enable }}</SearchLabel><span v-if="fttForm.modifiedStates.enableFanoutTimeline" class="_modified">{{ i18n.ts.modified }}</span></template>
									<template #caption>
										<div><SearchText>{{ i18n.ts._serverSettings.fanoutTimelineDescription }}</SearchText></div>
										<div><MkLink target="_blank" url="https://misskey-hub.net/docs/for-admin/features/ftt/">{{ i18n.ts.details }}</MkLink></div>
									</template>
								</MkSwitch>
							</SearchMarker>

							<template v-if="fttForm.state.enableFanoutTimeline">
								<SearchMarker :keywords="['db', 'database', 'fallback']">
									<MkSwitch v-model="fttForm.state.enableFanoutTimelineDbFallback">
										<template #label><SearchLabel>{{ i18n.ts._serverSettings.fanoutTimelineDbFallback }}</SearchLabel><span v-if="fttForm.modifiedStates.enableFanoutTimelineDbFallback" class="_modified">{{ i18n.ts.modified }}</span></template>
										<template #caption><SearchText>{{ i18n.ts._serverSettings.fanoutTimelineDbFallbackDescription }}</SearchText></template>
									</MkSwitch>
								</SearchMarker>

								<SearchMarker>
									<MkInput v-model="fttForm.state.perLocalUserUserTimelineCacheMax" type="number">
										<template #label><SearchLabel>perLocalUserUserTimelineCacheMax</SearchLabel><span v-if="fttForm.modifiedStates.perLocalUserUserTimelineCacheMax" class="_modified">{{ i18n.ts.modified }}</span></template>
									</MkInput>
								</SearchMarker>

								<SearchMarker>
									<MkInput v-model="fttForm.state.perRemoteUserUserTimelineCacheMax" type="number">
										<template #label><SearchLabel>perRemoteUserUserTimelineCacheMax</SearchLabel><span v-if="fttForm.modifiedStates.perRemoteUserUserTimelineCacheMax" class="_modified">{{ i18n.ts.modified }}</span></template>
									</MkInput>
								</SearchMarker>

								<SearchMarker>
									<MkInput v-model="fttForm.state.perUserHomeTimelineCacheMax" type="number">
										<template #label><SearchLabel>perUserHomeTimelineCacheMax</SearchLabel><span v-if="fttForm.modifiedStates.perUserHomeTimelineCacheMax" class="_modified">{{ i18n.ts.modified }}</span></template>
									</MkInput>
								</SearchMarker>

								<SearchMarker>
									<MkInput v-model="fttForm.state.perUserListTimelineCacheMax" type="number">
										<template #label><SearchLabel>perUserListTimelineCacheMax</SearchLabel><span v-if="fttForm.modifiedStates.perUserListTimelineCacheMax" class="_modified">{{ i18n.ts.modified }}</span></template>
									</MkInput>
								</SearchMarker>
							</template>
						</div>
					</MkFolder>
				</SearchMarker>

				<SearchMarker :keywords="['hanami', 'recommendation', 'おすすめ']">
					<MkFolder :defaultOpen="false">
						<template #icon><SearchIcon><i class="ti ti-flower-filled"></i></SearchIcon></template>
						<template #label><SearchLabel>{{ i18n.ts._hana._recommendation.title }}</SearchLabel></template>
						<template v-if="hanamiRecForm.modified.value" #footer>
							<MkFormFooter :form="hanamiRecForm"/>
						</template>

						<div class="_gaps">
							<MkFolder :defaultOpen="false">
								<template #icon><i class="ti ti-scale"></i></template>
								<template #label>Hanami Judge</template>
								<div class="_gaps">
									<MkInput v-model="judgeSettings.ephemeralA"><template #label>Q1 ephemeralA</template></MkInput>
									<MkInput v-model="judgeSettings.ephemeralB"><template #label>Q1 ephemeralB</template></MkInput>
									<MkInput v-model="judgeSettings.q1Examples"><template #label>Q1 examples</template></MkInput>
									<MkTextarea v-model="judgeSettings.q1Templates"><template #label>Q1 templates</template></MkTextarea>
									<MkInput v-model="judgeSettings.interest1"><template #label>Q2 interest1</template></MkInput>
									<MkInput v-model="judgeSettings.interest2"><template #label>Q2 interest2</template></MkInput>
									<MkInput v-model="judgeSettings.interest3"><template #label>Q2 interest3</template></MkInput>
									<MkInput v-model="judgeSettings.interest4"><template #label>Q2 interest4</template></MkInput>
									<MkInput v-model="judgeSettings.interest5"><template #label>Q2 interest5</template></MkInput>
									<MkInput v-model="judgeSettings.q2Examples"><template #label>Q2 examples</template></MkInput>
									<MkTextarea v-model="judgeSettings.q2Templates"><template #label>Q2 templates</template></MkTextarea>
									<MkInput v-for="key in judgeLimitKeys" :key="key" v-model="judgeSettings[key]" type="number"><template #label>{{ key }}</template></MkInput>
									<MkButton primary @click="saveJudgeSettings">設定を保存</MkButton>
									<MkButton @click="runJudgeTrial">下書き設定で試行（最新50件）</MkButton>
									<MkInfo>モデル: {{ judgeStatus.model ?? '-' }} / 最新実行: {{ judgeStatus.latestRun ?? '-' }} / backlog: {{ judgeStatus.backlog ?? '-' }}</MkInfo>
									<MkInfo>試行結果（除外理由を含む）</MkInfo>
									<pre>{{ JSON.stringify(judgeTrial, null, 2) }}</pre>
									<MkInfo>集計</MkInfo>
									<pre>{{ JSON.stringify(judgeAggregate, null, 2) }}</pre>
								</div>
							</MkFolder>
								<MkFolder :defaultOpen="false">
									<template #icon><i class="ti ti-adjustments"></i></template>
									<template #label>{{ i18n.ts._hana._recommendation.axes }}</template>
									<template #caption>{{ i18n.ts._hana._recommendation.axisConfigDescription }}</template>

								<div class="_gaps">
									<div v-for="ax in axisKeys" :key="ax" class="_gaps_s">
										<MkInfo>{{ hanamiReasonLabels[ax] }}</MkInfo>
										<MkSwitch v-model="hanamiRecForm.state[`${ax}Available`]">
											<template #label>{{ i18n.ts._hana._recommendation.axisAvailable }}<span v-if="hanamiRecForm.modifiedStates[`${ax}Available`]" class="_modified">{{ i18n.ts.modified }}</span></template>
										</MkSwitch>
										<MkSwitch v-model="hanamiRecForm.state[`${ax}Default`]" :disabled="!hanamiRecForm.state[`${ax}Available`]">
											<template #label>{{ i18n.ts._hana._recommendation.axisDefault }}<span v-if="hanamiRecForm.modifiedStates[`${ax}Default`]" class="_modified">{{ i18n.ts.modified }}</span></template>
										</MkSwitch>
										</div>
									</div>
								</MkFolder>

								<MkFolder :defaultOpen="false">
									<template #icon><i class="ti ti-database-refresh"></i></template>
									<template #label>{{ i18n.ts._hana._recommendation.tasteRebuild }}</template>
									<template #caption>{{ i18n.ts._hana._recommendation.tasteRebuildDescription }}</template>

									<div class="_gaps_s">
										<MkInfo>{{ tasteRebuildStatusText }}</MkInfo>
										<MkButton danger :disabled="tasteRebuildStarting || tasteRebuildStatus.state === 'running'" @click="startTasteRebuild">
											<i class="ti ti-player-play"></i> {{ i18n.ts._hana._recommendation.tasteRebuildRun }}
										</MkButton>
									</div>
								</MkFolder>
							</div>
						</MkFolder>
					</SearchMarker>

				<SearchMarker>
					<MkFolder :defaultOpen="true">
						<template #icon><SearchIcon><i class="ti ti-bolt"></i></SearchIcon></template>
						<template #label><SearchLabel>Misskey® Reactions Boost Technology™ (RBT)</SearchLabel><span class="_beta">{{ i18n.ts.beta }}</span></template>
						<template v-if="rbtForm.savedState.enableReactionsBuffering" #suffix>Enabled</template>
						<template v-else #suffix>Disabled</template>
						<template v-if="rbtForm.modified.value" #footer>
							<MkFormFooter :form="rbtForm"/>
						</template>

						<div class="_gaps_m">
							<SearchMarker>
								<MkSwitch v-model="rbtForm.state.enableReactionsBuffering">
									<template #label><SearchLabel>{{ i18n.ts.enable }}</SearchLabel><span v-if="rbtForm.modifiedStates.enableReactionsBuffering" class="_modified">{{ i18n.ts.modified }}</span></template>
									<template #caption><SearchText>{{ i18n.ts._serverSettings.reactionsBufferingDescription }}</SearchText></template>
								</MkSwitch>
							</SearchMarker>
						</div>
					</MkFolder>
				</SearchMarker>

				<SearchMarker>
					<MkFolder :defaultOpen="true">
						<template #icon><SearchIcon><i class="ti ti-recycle"></i></SearchIcon></template>
						<template #label><SearchLabel>Remote Notes Cleaning (仮)</SearchLabel></template>
						<template v-if="remoteNotesCleaningForm.savedState.enableRemoteNotesCleaning" #suffix>Enabled</template>
						<template v-else #suffix>Disabled</template>
						<template v-if="remoteNotesCleaningForm.modified.value" #footer>
							<MkFormFooter :form="remoteNotesCleaningForm"/>
						</template>

						<div class="_gaps_m">
							<MkSwitch v-model="remoteNotesCleaningForm.state.enableRemoteNotesCleaning">
								<template #label><SearchLabel>{{ i18n.ts.enable }}</SearchLabel><span v-if="remoteNotesCleaningForm.modifiedStates.enableRemoteNotesCleaning" class="_modified">{{ i18n.ts.modified }}</span></template>
								<template #caption><SearchText>{{ i18n.ts._serverSettings.remoteNotesCleaning_description }}</SearchText></template>
							</MkSwitch>

							<template v-if="remoteNotesCleaningForm.state.enableRemoteNotesCleaning">
								<MkInput v-model="remoteNotesCleaningForm.state.remoteNotesCleaningExpiryDaysForEachNotes" type="number">
									<template #label><SearchLabel>{{ i18n.ts._serverSettings.remoteNotesCleaningExpiryDaysForEachNotes }}</SearchLabel> ({{ i18n.ts.inDays }})<span v-if="remoteNotesCleaningForm.modifiedStates.remoteNotesCleaningExpiryDaysForEachNotes" class="_modified">{{ i18n.ts.modified }}</span></template>
									<template #suffix>{{ i18n.ts._time.day }}</template>
								</MkInput>

								<MkInput v-model="remoteNotesCleaningForm.state.remoteNotesCleaningMaxProcessingDurationInMinutes" type="number">
									<template #label><SearchLabel>{{ i18n.ts._serverSettings.remoteNotesCleaningMaxProcessingDuration }}</SearchLabel> ({{ i18n.ts.inMinutes }})<span v-if="remoteNotesCleaningForm.modifiedStates.remoteNotesCleaningMaxProcessingDurationInMinutes" class="_modified">{{ i18n.ts.modified }}</span></template>
									<template #suffix>{{ i18n.ts._time.minute }}</template>
								</MkInput>
							</template>
						</div>
					</MkFolder>
				</SearchMarker>
			</div>
		</SearchMarker>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
	import { ref, computed, onUnmounted } from 'vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { fetchInstance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import MkSwitch from '@/components/MkSwitch.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkLink from '@/components/MkLink.vue';
import { useForm } from '@/composables/use-form.js';
	import MkFormFooter from '@/components/MkFormFooter.vue';
	import MkInfo from '@/components/MkInfo.vue';
	import MkButton from '@/components/MkButton.vue';

const meta = await misskeyApi('admin/meta');

const enableServerMachineStats = ref(meta.enableServerMachineStats);
const enableIdenticonGeneration = ref(meta.enableIdenticonGeneration);
const enableChartsForRemoteUser = ref(meta.enableChartsForRemoteUser);
const enableStatsForFederatedInstances = ref(meta.enableStatsForFederatedInstances);
const enableChartsForFederatedInstances = ref(meta.enableChartsForFederatedInstances);
const showRoleBadgesOfRemoteUsers = ref(meta.showRoleBadgesOfRemoteUsers);

function onChange_enableServerMachineStats(value: boolean) {
	os.apiWithDialog('admin/update-meta', {
		enableServerMachineStats: value,
	}).then(() => {
		fetchInstance(true);
	});
}

function onChange_enableIdenticonGeneration(value: boolean) {
	os.apiWithDialog('admin/update-meta', {
		enableIdenticonGeneration: value,
	}).then(() => {
		fetchInstance(true);
	});
}

function onChange_enableChartsForRemoteUser(value: boolean) {
	os.apiWithDialog('admin/update-meta', {
		enableChartsForRemoteUser: value,
	}).then(() => {
		fetchInstance(true);
	});
}

function onChange_enableStatsForFederatedInstances(value: boolean) {
	os.apiWithDialog('admin/update-meta', {
		enableStatsForFederatedInstances: value,
	}).then(() => {
		fetchInstance(true);
	});
}

function onChange_enableChartsForFederatedInstances(value: boolean) {
	os.apiWithDialog('admin/update-meta', {
		enableChartsForFederatedInstances: value,
	}).then(() => {
		fetchInstance(true);
	});
}

function onChange_showRoleBadgesOfRemoteUsers(value: boolean) {
	os.apiWithDialog('admin/update-meta', {
		showRoleBadgesOfRemoteUsers: value,
	}).then(() => {
		fetchInstance(true);
	});
}

const fttForm = useForm({
	enableFanoutTimeline: meta.enableFanoutTimeline,
	enableFanoutTimelineDbFallback: meta.enableFanoutTimelineDbFallback,
	perLocalUserUserTimelineCacheMax: meta.perLocalUserUserTimelineCacheMax,
	perRemoteUserUserTimelineCacheMax: meta.perRemoteUserUserTimelineCacheMax,
	perUserHomeTimelineCacheMax: meta.perUserHomeTimelineCacheMax,
	perUserListTimelineCacheMax: meta.perUserListTimelineCacheMax,
}, async (state) => {
	await os.apiWithDialog('admin/update-meta', {
		enableFanoutTimeline: state.enableFanoutTimeline,
		enableFanoutTimelineDbFallback: state.enableFanoutTimelineDbFallback,
		perLocalUserUserTimelineCacheMax: state.perLocalUserUserTimelineCacheMax,
		perRemoteUserUserTimelineCacheMax: state.perRemoteUserUserTimelineCacheMax,
		perUserHomeTimelineCacheMax: state.perUserHomeTimelineCacheMax,
		perUserListTimelineCacheMax: state.perUserListTimelineCacheMax,
	});
	fetchInstance(true);
});

// はなみTL おすすめ: 軸ごとの available/default（For You 7軸）。
const axisKeys = ['globalPopular', 'exploration', 'trending', 'neighborTrending', 'reactionSimilar', 'catchup', 'fof'] as const;
type AxisKey = typeof axisKeys[number];
type LegacyAxisKey = 'popular';
const axisCfg = (meta.hanamiRecommendationAxisConfig ?? {}) as Partial<Record<AxisKey | LegacyAxisKey, { available?: boolean; default?: boolean }>>;
const axisConfigKeys: Record<AxisKey, readonly (AxisKey | LegacyAxisKey)[]> = {
	globalPopular: ['globalPopular', 'popular'],
	exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'],
	reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'],
	trending: ['trending'],
	fof: ['fof'],
};
const hanamiReasonLabels = i18n.ts._hana._recommendation._reason as unknown as Record<AxisKey, string>;

function axisCfgValue(axis: AxisKey, key: 'available' | 'default'): boolean {
	return axisConfigKeys[axis].map(k => axisCfg[k]?.[key]).find(v => v !== undefined) ?? true;
}

const hanamiRecForm = useForm({
	globalPopularAvailable: axisCfgValue('globalPopular', 'available'),
	globalPopularDefault: axisCfgValue('globalPopular', 'default'),
	explorationAvailable: axisCfgValue('exploration', 'available'),
	explorationDefault: axisCfgValue('exploration', 'default'),
	trendingAvailable: axisCfgValue('trending', 'available'),
	trendingDefault: axisCfgValue('trending', 'default'),
	neighborTrendingAvailable: axisCfgValue('neighborTrending', 'available'),
	neighborTrendingDefault: axisCfgValue('neighborTrending', 'default'),
	reactionSimilarAvailable: axisCfgValue('reactionSimilar', 'available'),
	reactionSimilarDefault: axisCfgValue('reactionSimilar', 'default'),
	catchupAvailable: axisCfgValue('catchup', 'available'),
	catchupDefault: axisCfgValue('catchup', 'default'),
	fofAvailable: axisCfgValue('fof', 'available'),
	fofDefault: axisCfgValue('fof', 'default'),
}, async (state) => {
	await os.apiWithDialog('admin/update-meta', {
		hanamiRecommendationAxisConfig: {
			globalPopular: { available: state.globalPopularAvailable, default: state.globalPopularDefault },
			exploration: { available: state.explorationAvailable, default: state.explorationDefault },
			trending: { available: state.trendingAvailable, default: state.trendingDefault },
			neighborTrending: { available: state.neighborTrendingAvailable, default: state.neighborTrendingDefault },
			reactionSimilar: { available: state.reactionSimilarAvailable, default: state.reactionSimilarDefault },
			catchup: { available: state.catchupAvailable, default: state.catchupDefault },
			fof: { available: state.fofAvailable, default: state.fofDefault },
		},
	} as never);
	fetchInstance(true);
});

type JudgeSettings = {
	ephemeralA: string;
	ephemeralB: string;
	interest1: string;
	interest2: string;
	interest3: string;
	interest4: string;
	interest5: string;
	q1Examples: string;
	q1Templates: string;
	q2Examples: string;
	q2Templates: string;
	thetaEMax: number;
	thetaIMax: number;
	reactionMax: number;
	interestMax: number;
};
type JudgeTrialItem = {
	noteId: string;
	text: string;
	reactionScore: number;
	ephemeralScore: number | null;
	interest: number | null;
	contentType: number | null;
	reason: 'unjudged' | 'bot' | 'reply' | 'template' | 'emptyText' | 'ephemeral' | 'lowInterest' | 'eligible';
};
const judgeLimitKeys = ['thetaEMax', 'thetaIMax', 'reactionMax', 'interestMax'] as const;
const judgeSettings = ref<JudgeSettings>({ ephemeralA: '', ephemeralB: '', interest1: '', interest2: '', interest3: '', interest4: '', interest5: '', q1Examples: '', q1Templates: '', q2Examples: '', q2Templates: '', thetaEMax: 0, thetaIMax: 0, reactionMax: 0, interestMax: 0 });
const judgeSettingsRaw = ref(await misskeyApi('admin/hanami/judge-settings'));
Object.assign(judgeSettings.value, {
	ephemeralA: judgeSettingsRaw.value.basis?.ephemeralA ?? '',
	ephemeralB: judgeSettingsRaw.value.basis?.ephemeralB ?? '',
	q1Examples: (judgeSettingsRaw.value.examples ?? []).join('\n'),
	q1Templates: (judgeSettingsRaw.value.templatePatterns ?? []).join('\n'),
	interest1: judgeSettingsRaw.value.basis?.interest1 ?? '',
	interest2: judgeSettingsRaw.value.basis?.interest2 ?? '',
	interest3: judgeSettingsRaw.value.basis?.interest3 ?? '',
	interest4: judgeSettingsRaw.value.basis?.interest4 ?? '',
	interest5: judgeSettingsRaw.value.basis?.interest5 ?? '',
	q2Examples: (judgeSettingsRaw.value.examples ?? []).join('\n'),
	q2Templates: (judgeSettingsRaw.value.templatePatterns ?? []).join('\n'),
	thetaEMax: judgeSettingsRaw.value.ephemeralThreshold ?? 0,
	thetaIMax: judgeSettingsRaw.value.interestThreshold ?? 2.95,
	reactionMax: judgeSettingsRaw.value.reactionMax ?? 3,
	interestMax: judgeSettingsRaw.value.interestMax ?? 10,
});
const judgeStatus = ref(await misskeyApi('admin/hanami/judge-status'));
const judgeTrial = ref<JudgeTrialItem[]>([]);
const judgeAggregate = ref(await misskeyApi('admin/hanami/judge-aggregate'));

function judgeDraftSettings() {
	const examples = [...new Set(`${judgeSettings.value.q1Examples}\n${judgeSettings.value.q2Examples}`.split('\n').map(value => value.trim()).filter(Boolean))];
	const templatePatterns = [...new Set(`${judgeSettings.value.q1Templates}\n${judgeSettings.value.q2Templates}`.split('\n').map(value => value.trim()).filter(Boolean))];
	return {
		...judgeSettingsRaw.value,
		ephemeralThreshold: Number(judgeSettings.value.thetaEMax), interestThreshold: Number(judgeSettings.value.thetaIMax),
		reactionMax: Number(judgeSettings.value.reactionMax), interestMax: Number(judgeSettings.value.interestMax), examples, templatePatterns,
		basis: {
			...judgeSettingsRaw.value.basis,
			ephemeralA: judgeSettings.value.ephemeralA,
			ephemeralB: judgeSettings.value.ephemeralB,
			interest1: judgeSettings.value.interest1,
			interest2: judgeSettings.value.interest2,
			interest3: judgeSettings.value.interest3,
			interest4: judgeSettings.value.interest4,
			interest5: judgeSettings.value.interest5,
		},
	};
}

async function runJudgeTrial() {
	judgeTrial.value = (await misskeyApi('admin/hanami/judge-trial', { limit: 50, settings: judgeDraftSettings() })).items;
}

async function saveJudgeSettings() {
	const response = await misskeyApi('admin/hanami/judge-settings', { settings: judgeDraftSettings() });
	judgeSettingsRaw.value = response;
}

type TasteRebuildStatus = {
	state: 'idle' | 'running' | 'done' | 'error';
	phase: 'embeddings' | 'evidence' | null;
	reembedded: number;
	purged: number;
	evidenceUpdated: number;
	evidencePurged: number;
	startedAt: number | null;
	updatedAt: number | null;
	error: string | null;
};

const tasteRebuildStatus = ref<TasteRebuildStatus>({
	state: 'idle',
	phase: null,
	reembedded: 0,
	purged: 0,
	evidenceUpdated: 0,
	evidencePurged: 0,
	startedAt: null,
	updatedAt: null,
	error: null,
});
const tasteRebuildStarting = ref(false);
let tasteRebuildPollTimer: number | null = null;

function formatTasteRebuildTime(t: number | null): string {
	return t == null ? '-' : new Date(t).toLocaleString();
}

const tasteRebuildStatusText = computed(() => {
	const s = tasteRebuildStatus.value;
	const phase = s.phase == null ? '-' : i18n.ts._hana._recommendation[`tasteRebuildPhase_${s.phase}`];
	const counts = `embedding ${s.reembedded}/${s.purged}, evidence ${s.evidenceUpdated}/${s.evidencePurged}`;
	const updated = formatTasteRebuildTime(s.updatedAt);
	return s.error != null
		? `${s.state} / ${phase} / ${counts} / ${updated} / ${s.error}`
		: `${s.state} / ${phase} / ${counts} / ${updated}`;
});

function syncTasteRebuildPolling() {
	if (tasteRebuildStatus.value.state === 'running') {
		if (tasteRebuildPollTimer == null) {
			tasteRebuildPollTimer = window.setInterval(() => {
				refreshTasteRebuildStatus();
			}, 10 * 1000);
		}
	} else if (tasteRebuildPollTimer != null) {
		window.clearInterval(tasteRebuildPollTimer);
		tasteRebuildPollTimer = null;
	}
}

async function refreshTasteRebuildStatus() {
	tasteRebuildStatus.value = await misskeyApi('admin/hanami/taste-rebuild-status');
	syncTasteRebuildPolling();
}

async function startTasteRebuild() {
	const { canceled } = await os.confirm({
		type: 'warning',
		title: i18n.ts._hana._recommendation.tasteRebuild,
		text: i18n.ts._hana._recommendation.tasteRebuildConfirm,
	});
	if (canceled) return;
	tasteRebuildStarting.value = true;
	try {
		tasteRebuildStatus.value = await misskeyApi('admin/hanami/taste-rebuild', {});
		syncTasteRebuildPolling();
	} catch (err) {
		await os.alert({ type: 'error', text: err instanceof Error ? err.message : String(err) });
		await refreshTasteRebuildStatus();
	} finally {
		tasteRebuildStarting.value = false;
	}
}

await refreshTasteRebuildStatus();
onUnmounted(() => {
	if (tasteRebuildPollTimer != null) window.clearInterval(tasteRebuildPollTimer);
});

const rbtForm = useForm({
	enableReactionsBuffering: meta.enableReactionsBuffering,
}, async (state) => {
	await os.apiWithDialog('admin/update-meta', {
		enableReactionsBuffering: state.enableReactionsBuffering,
	});
	fetchInstance(true);
});

const remoteNotesCleaningForm = useForm({
	enableRemoteNotesCleaning: meta.enableRemoteNotesCleaning,
	remoteNotesCleaningExpiryDaysForEachNotes: meta.remoteNotesCleaningExpiryDaysForEachNotes,
	remoteNotesCleaningMaxProcessingDurationInMinutes: meta.remoteNotesCleaningMaxProcessingDurationInMinutes,
}, async (state) => {
	await os.apiWithDialog('admin/update-meta', {
		enableRemoteNotesCleaning: state.enableRemoteNotesCleaning,
		remoteNotesCleaningExpiryDaysForEachNotes: state.remoteNotesCleaningExpiryDaysForEachNotes,
		remoteNotesCleaningMaxProcessingDurationInMinutes: state.remoteNotesCleaningMaxProcessingDurationInMinutes,
	});
	fetchInstance(true);
});

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts.performance,
	icon: 'ti ti-bolt',
}));
</script>
