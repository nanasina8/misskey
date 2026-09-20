<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkFolder :defaultOpen="true">
	<template #icon><i class="ti ti-database-refresh"></i></template>
	<template #label>{{ i18n.ts._hana._admin.tasteRebuild }}</template>
	<template #caption>{{ i18n.ts._hana._recommendation.tasteRebuildDescription }}</template>
	<div class="_gaps_s">
		<MkLoading v-if="loading"/>
		<MkInfo v-if="statusError" warn>{{ i18n.ts._hana._admin.unavailable }}: {{ statusError }}</MkInfo>
		<MkInfo v-if="tasteRebuildStatus && !statusError" :warn="tasteRebuildStatus.state === 'error'">{{ tasteRebuildStatusText }}</MkInfo>
		<div class="_buttons">
			<MkButton danger :disabled="loading || tasteRebuildStarting || statusError !== null || tasteRebuildStatus === null || tasteRebuildStatus.state === 'running'" @click="startTasteRebuild">
				<i class="ti ti-player-play"></i> {{ i18n.ts._hana._recommendation.tasteRebuildRun }}
			</MkButton>
			<MkButton :disabled="loading || tasteRebuildStarting" @click="refreshTasteRebuildStatus">
				<i class="ti ti-refresh"></i> {{ i18n.ts.reload }}
			</MkButton>
		</div>
	</div>
</MkFolder>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import MkButton from '@/components/MkButton.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';

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

const tasteRebuildStatus = ref<TasteRebuildStatus | null>(null);
const tasteRebuildStarting = ref(false);
const loading = ref(true);
const statusError = ref<string | null>(null);
let tasteRebuildPollTimer: number | null = null;
let disposed = false;

function formatTasteRebuildTime(t: number | null): string {
	if (t == null || !Number.isFinite(t)) return '-';
	const date = new Date(t);
	return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

const tasteRebuildStatusText = computed(() => {
	const s = tasteRebuildStatus.value;
	if (s == null) return i18n.ts._hana._admin.unavailable;
	const phase = s.phase == null ? '-' : i18n.ts._hana._recommendation[`tasteRebuildPhase_${s.phase}`];
	const counts = `embedding ${s.reembedded}/${s.purged}, evidence ${s.evidenceUpdated}/${s.evidencePurged}`;
	const updated = formatTasteRebuildTime(s.updatedAt);
	return `${s.state} / ${phase} / ${counts} / ${updated}${s.error == null ? '' : ` / ${s.error}`}`;
});

function clearPolling() {
	if (tasteRebuildPollTimer != null) window.clearTimeout(tasteRebuildPollTimer);
	tasteRebuildPollTimer = null;
}

function syncTasteRebuildPolling() {
	clearPolling();
	if (!disposed && statusError.value == null && tasteRebuildStatus.value?.state === 'running') {
		tasteRebuildPollTimer = window.setTimeout(() => void refreshTasteRebuildStatus(), 10 * 1000);
	}
}

async function refreshTasteRebuildStatus() {
	clearPolling();
	loading.value = true;
	try {
		const status = await misskeyApi('admin/hanami/taste-rebuild-status');
		if (disposed) return;
		tasteRebuildStatus.value = status;
		statusError.value = null;
	} catch (err) {
		if (disposed) return;
		statusError.value = err instanceof Error ? err.message : String(err);
	} finally {
		loading.value = false;
		syncTasteRebuildPolling();
	}
}

async function startTasteRebuild() {
	if (loading.value || tasteRebuildStarting.value || statusError.value != null || tasteRebuildStatus.value == null || tasteRebuildStatus.value.state === 'running') return;
	// Lock before confirmation too, so repeated clicks cannot start two requests.
	tasteRebuildStarting.value = true;
	try {
		const { canceled } = await os.confirm({
			type: 'warning',
			title: i18n.ts._hana._admin.tasteRebuild,
			text: i18n.ts._hana._recommendation.tasteRebuildConfirm,
		});
		if (canceled || disposed) return;
		const status = await misskeyApi('admin/hanami/taste-rebuild', {});
		if (disposed) return;
		tasteRebuildStatus.value = status;
		statusError.value = null;
		syncTasteRebuildPolling();
	} catch (err) {
		if (disposed) return;
		statusError.value = err instanceof Error ? err.message : String(err);
		await os.alert({ type: 'error', text: statusError.value });
		if (!disposed) await refreshTasteRebuildStatus();
	} finally {
		tasteRebuildStarting.value = false;
	}
}

onMounted(() => void refreshTasteRebuildStatus());
onUnmounted(() => {
	disposed = true;
	clearPolling();
});
</script>
