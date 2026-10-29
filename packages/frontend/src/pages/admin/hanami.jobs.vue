<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/admin/hanami" :label="i18n.ts._hana._admin.jobs" :keywords="['jobs', 'GPU', 'queue']" icon="ti ti-cpu">
	<div class="_gaps" :class="$style.root">
		<div :class="$style.refresh">
			<MkButton :disabled="manualLoading" @click="refresh(true)"><i class="ti ti-refresh"></i> {{ manualLoading ? t.loading : j.refresh }}</MkButton>
			<div v-if="fetchedAt">{{ j.lastFetched }}: <button type="button" class="_button" :class="$style.time" @click="showTime(fetchedAt)"><MkTime :key="fetchedAt" :time="fetchedAt" :allowOverrideByUser="false"/></button></div>
		</div>
		<MkInfo v-if="error" warn>{{ t.error }}: {{ error }}</MkInfo>
		<template v-if="status">
			<div class="_gaps_s" aria-live="polite">
				<MkInfo v-for="warning in status.warnings" :key="warning" warn>{{ j._warning[warning] }}</MkInfo>
				<MkInfo v-if="status.warnings.length === 0">{{ j.healthy }}</MkInfo>
			</div>

			<MkFolder :defaultOpen="true">
				<template #label>{{ j.gpuAndLock }}</template>
				<div class="_gaps_s">
					<MkKeyValue><template #key>{{ j.gpu }}</template><template #value>{{ gpuAvailable ? j.gpuAvailable : j.gpuUnavailable }}<span v-if="status.gpu.deviceName"> · {{ status.gpu.deviceName }}</span><span v-if="status.gpu.device"> ({{ status.gpu.device }})</span></template></MkKeyValue>
					<MkInfo v-if="status.gpu.reason">{{ status.gpu.reason }}</MkInfo>
					<MkKeyValue><template #key>{{ j.lock }}</template><template #value>{{ status.lock.held ? j.lockHeld : j.lockFree }}<span v-if="status.lock.held"> · {{ status.lock.kind ? jobLabel(status.lock.kind) : j.unknownOwner }}</span></template></MkKeyValue>
					<div v-if="status.lock.held" class="_gaps_s">
						<div v-if="status.lock.acquiredAt">{{ j.acquiredAt }}: <button type="button" class="_button" :class="$style.time" @click="showTime(status.lock.acquiredAt)"><MkTime :key="status.lock.acquiredAt" :time="status.lock.acquiredAt" :allowOverrideByUser="false"/></button></div>
						<div>{{ status.lock.expiresInMs == null ? j.noExpiry : i18n.tsx._hana._admin._jobs.expiresIn({ seconds: Math.ceil(status.lock.expiresInMs / 1000) }) }}</div>
					</div>
					<MkKeyValue><template #key>{{ j._job.topicJudge }}</template><template #value>{{ status.topicJudgeWaiting ? j.waiting : j.notWaiting }}</template></MkKeyValue>
				</div>
			</MkFolder>

			<MkFolder :defaultOpen="true">
				<template #label>{{ j.queue }}</template>
				<div class="_gaps_s">
					<MkInfo v-if="status.queue.truncated" warn>{{ j.truncated }}</MkInfo>
					<div :class="$style.tableScroll" tabindex="0" role="region" :aria-label="j.queue">
						<table :class="$style.table">
							<thead><tr><th scope="col">{{ j.jobName }}</th><th scope="col">{{ j.active }}</th><th scope="col">{{ j.wait }}</th><th scope="col">{{ j.delayed }}</th><th scope="col">{{ j.failed }}</th><th scope="col">{{ j.oldestWaiting }}</th></tr></thead>
							<tbody><tr v-for="row in status.queue.jobs" :key="row.name"><th scope="row">{{ queueLabel(row.name) }}</th><td>{{ row.active }}</td><td>{{ row.wait }}</td><td>{{ row.delayed }}</td><td>{{ row.failed }}</td><td><button v-if="row.oldestWaitingAt" type="button" class="_button" :class="$style.time" @click="showTime(row.oldestWaitingAt)"><MkTime :key="row.oldestWaitingAt" :time="row.oldestWaitingAt" :allowOverrideByUser="false"/></button><span v-else>—</span></td></tr></tbody>
						</table>
					</div>
				</div>
			</MkFolder>

			<section class="_gaps_s" :aria-label="j.latestRuns">
				<strong>{{ j.latestRuns }}</strong>
				<small>{{ j.retainedRunsHint }}</small>
				<div :class="$style.cards">
					<section v-for="card in cards" :key="card.kind" class="_panel _gaps_s" :class="$style.card" :aria-label="jobLabel(card.kind)">
						<strong>{{ jobLabel(card.kind) }}</strong>
						<template v-if="card.kind === 'topicJudge'">
							<template v-if="status.topicJudge">
								<MkKeyValue><template #key>{{ t.trendTopicJudgeLastResult }}</template><template #value>{{ t._trendTopicJudgeOutcome[status.topicJudge.outcome] }}</template></MkKeyValue>
								<MkKeyValue><template #key>{{ t.trendTopicJudgeAt }}</template><template #value><button type="button" class="_button" :class="$style.time" @click="showTime(status.topicJudge.at)"><MkTime :key="status.topicJudge.at" :time="status.topicJudge.at" :allowOverrideByUser="false"/></button></template></MkKeyValue>
								<MkKeyValue><template #key>{{ t.trendTopicJudgeRequested }}</template><template #value>{{ i18n.tsx._hana._admin.trendTopicJudgeCounts({ daily: status.topicJudge.requested.daily, same: status.topicJudge.requested.pairs, titles: status.topicJudge.requested.titles }) }}</template></MkKeyValue>
								<MkKeyValue><template #key>{{ t.trendTopicJudgeSaved }}</template><template #value>{{ i18n.tsx._hana._admin.trendTopicJudgeCounts({ daily: status.topicJudge.saved.daily, same: status.topicJudge.saved.same, titles: status.topicJudge.saved.titles }) }}</template></MkKeyValue>
								<MkKeyValue><template #key>{{ t.trendTopicJudgeRejectedTitles }}</template><template #value>{{ status.topicJudge.rejectedTitles }}</template></MkKeyValue>
								<MkKeyValue><template #key>{{ t.trendTopicJudgeLastSuccessAt }}</template><template #value><button v-if="status.topicJudge.lastSuccessAt" type="button" class="_button" :class="$style.time" @click="showTime(status.topicJudge.lastSuccessAt)"><MkTime :key="status.topicJudge.lastSuccessAt" :time="status.topicJudge.lastSuccessAt" :allowOverrideByUser="false"/></button><span v-else>—</span></template></MkKeyValue>
								<MkInfo v-if="status.topicJudge.error" warn>{{ status.topicJudge.error }}</MkInfo>
							</template>
							<MkInfo v-else>{{ t.noData }}</MkInfo>
						</template>
						<template v-else>
							<small v-if="card.kind === 'embedding'">{{ j.tasteRunHint }}</small>
							<MkKeyValue><template #key>{{ j.latestWork }}</template><template #value><template v-if="card.run?.latestWork"><button type="button" class="_button" :class="$style.time" @click="showTime(card.run.latestWork.finishedAt ?? card.run.latestWork.startedAt)"><MkTime :key="card.run.latestWork.finishedAt ?? card.run.latestWork.startedAt" :time="card.run.latestWork.finishedAt ?? card.run.latestWork.startedAt" :allowOverrideByUser="false"/></button> · {{ i18n.tsx._hana._admin._jobs.processed({ count: card.run.latestWork.processedCount ?? 0 }) }}</template><span v-else>{{ j.noWorkYet }}</span></template></MkKeyValue>
							<MkKeyValue><template #key>{{ j.latest }}</template><template #value><template v-if="card.run?.latest">{{ runLabel(card.run.latest) }} · <button type="button" class="_button" :class="$style.time" @click="showTime(card.run.latest.finishedAt ?? card.run.latest.startedAt)"><MkTime :key="card.run.latest.finishedAt ?? card.run.latest.startedAt" :time="card.run.latest.finishedAt ?? card.run.latest.startedAt" :allowOverrideByUser="false"/></button></template><span v-else>{{ j.noRuns }}</span></template></MkKeyValue>
							<MkInfo v-if="card.run?.latest?.failure" warn>{{ card.run.latest.failure }}</MkInfo>
							<MkInfo v-if="card.run?.latest?.skippedReason">{{ j.skipped }}: {{ card.run.latest.skippedReason }}</MkInfo>
							<template v-if="card.run">
								<small>{{ j.last24h }}（{{ j.last24hNote }}）</small>
								<dl :class="$style.counts"><div v-for="key in runCounts" :key="key"><dt>{{ j[key] }}</dt><dd>{{ card.run.last24h[key] }}</dd></div></dl>
							</template>
							<template v-if="card.kind === 'note-judge'">
								<MkKeyValue><template #key>{{ t.backlog }}</template><template #value>{{ status.noteJudge.backlog ?? '—' }}</template></MkKeyValue>
								<MkKeyValue><template #key>{{ t.secondsPerNote }}</template><template #value>{{ status.noteJudge.secPerNote == null ? '—' : status.noteJudge.secPerNote.toLocaleString(undefined, { maximumFractionDigits: 2 }) }}</template></MkKeyValue>
							</template>
						</template>
					</section>
				</div>
			</section>

			<MkFolder :defaultOpen="true">
				<template #label>{{ j.recentFailures }}</template>
				<div class="_gaps">
					<MkInfo v-if="status.recentFailures.length === 0">{{ j.noFailures }}</MkInfo>
					<div v-for="(failure, index) in status.recentFailures" :key="`${failure.kind}:${failure.startedAt}:${index}`" class="_gaps_s">
						<strong>{{ jobLabel(failure.kind) }}</strong>
						<button type="button" class="_button" :class="$style.time" @click="showTime(failure.startedAt)"><MkTime :time="failure.startedAt" :allowOverrideByUser="false"/></button>
						<div>{{ failure.failure ?? j.noFailureReason }}</div>
					</div>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>{{ j.events }}</template>
				<div class="_gaps">
					<MkInfo v-if="status.events.length === 0">{{ j.noEvents }}</MkInfo>
					<div v-for="(event, index) in status.events.slice(0, 30)" :key="`${event.at}:${index}`" class="_gaps_s">
						<strong>{{ jobLabel(event.job) }} · {{ j._event[event.event] }}</strong>
						<button type="button" class="_button" :class="$style.time" @click="showTime(event.at)"><MkTime :time="event.at" :allowOverrideByUser="false"/></button>
						<small v-if="event.durationMs != null">{{ i18n.tsx._hana._admin._jobs.duration({ seconds: (event.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) }) }}</small>
						<MkInfo v-if="event.error" warn>{{ event.error.name }}: {{ event.error.message }}</MkInfo>
						<details v-if="event.error?.stderrTail"><summary>{{ j.stderr }}</summary><pre :class="$style.stderr">{{ event.error.stderrTail }}</pre></details>
					</div>
				</div>
			</MkFolder>
		</template>
		<MkInfo v-else-if="!error">{{ t.loading }}</MkInfo>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue';
import type { entities } from 'misskey-js';
import { useInterval } from '@@/js/use-interval.js';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';

type Status = entities.AdminHanamiJobsStatusResponse;
const t = i18n.ts._hana._admin;
const j = t._jobs;
const status = ref<Status | null>(null);
const manualLoading = ref(false);
const error = ref('');
const fetchedAt = ref<string | null>(null);
const gpuAvailable = computed(() => status.value?.gpu.available && status.value.gpu.device === 'cuda');
const cards = computed(() => ['note-judge', 'topicJudge', 'als', 'embedding'].map(kind => ({ kind, run: status.value?.runs.find(run => run.kind === kind) })));
const runCounts = ['ready', 'failed', 'interrupted', 'empty'] as const;
const jobLabel = (kind: string) => (({ ...j._job, 'note-judge': j._job.noteJudge, embedding: j._job.tasteTick } as Record<string, string>)[kind] ?? kind);
const queueLabel = (name: string) => (j._queue as Record<string, string>)[name] ?? name;
const runLabel = (run: NonNullable<Status['runs'][number]['latest']>) => run.interrupted ? j.interrupted : run.status === 'ready' && run.processedCount === 0 ? j.empty : ({ ready: j.ready, pending: j.pending, failed: j.failed }[run.status] ?? run.status);
const errorText = (err: unknown) => err instanceof Error ? err.message : typeof err === 'object' && err != null && 'message' in err ? String(err.message) : String(err);
let controller: AbortController | undefined;
let active = false;

// Automatic refreshes stay quiet: only a manual refresh disables the button, and errors clear on the next success.
async function refresh(manual = false) {
	if (controller != null || !active) return;
	if (manual) manualLoading.value = true;
	const request = new AbortController();
	controller = request;
	try {
		const result = await misskeyApi('admin/hanami/jobs-status', { eventsLimit: 30 }, undefined, request.signal);
		if (active && controller === request) { status.value = result; fetchedAt.value = new Date().toISOString(); error.value = ''; }
	} catch (err) {
		if (active && controller === request) error.value = errorText(err);
	} finally {
		if (controller === request) controller = undefined;
		if (manual) manualLoading.value = false;
	}
}

function showTime(time: string) {
	void os.alert({ type: 'info', text: new Date(time).toLocaleString() });
}

function stop() {
	active = false;
	controller?.abort();
	controller = undefined;
	manualLoading.value = false;
}

// Registered before useInterval so the first scheduled refresh sees an active page.
onMounted(() => { active = true; });
onActivated(() => { active = true; });
onDeactivated(stop);
onUnmounted(stop);
// Pauses while the browser tab is hidden, and follows KeepAlive activation.
useInterval(() => { void refresh(); }, 15_000, { immediate: true, afterMounted: true });
</script>

<style lang="scss" module>
.root { min-width: 0; overflow-wrap: anywhere; }
.refresh { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; font-size: .9em; }
.time { text-decoration: underline; text-underline-offset: .2em; text-align: start; }
.tableScroll { max-width: 100%; overflow-x: auto; }
.table {
	width: 100%; border-collapse: collapse; font-size: .85em;
	th, td { padding: 8px; text-align: start; border-bottom: 1px solid var(--MI_THEME-divider); }
	th { white-space: nowrap; }
}
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.card { min-width: 0; padding: 16px; border-radius: var(--MI-radius); }
.counts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 0; div { display: flex; justify-content: space-between; gap: 4px; } dd { margin: 0; } }
.stderr { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85em; }
</style>
