<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div :class="$style.toolbar">
		<MkSwitch v-model="autoReload">
			<template #label>{{ t.autoReload }}</template>
		</MkSwitch>
		<div class="_buttons" :class="$style.toolbarButtons">
			<MkButton small :disabled="loading" @click="reload"><i class="ti ti-refresh"></i> {{ t.reload }}</MkButton>
			<MkButton small :disabled="data == null" @click="copyJson"><i class="ti ti-copy"></i> {{ t.copyJson }}</MkButton>
		</div>
	</div>
	<div :class="$style.sub">{{ t.caption }}</div>
	<MkInfo v-if="error" warn>{{ error }}</MkInfo>

	<template v-if="data">
		<!-- 見張り -->
		<section class="_panel" :class="$style.panel">
			<div :class="$style.head">
				<div :class="$style.title">{{ t.checks }}</div>
				<MkSwitch v-model="showOk" :class="$style.headSwitch">
					<template #label>{{ t.showOk }}</template>
				</MkSwitch>
			</div>
			<table :class="$style.table">
				<tbody>
					<tr v-for="check in visibleChecks" :key="check.id">
						<td :class="$style.iconCell"><i :class="levelIcon(check.level)" :style="{ color: levelColor(check.level) }" :title="check.level"></i></td>
						<td :class="$style.nowrap">{{ check.title }}</td>
						<td :class="$style.sub">{{ check.detail ?? '' }}</td>
					</tr>
				</tbody>
			</table>
			<div v-if="visibleChecks.length === 0" :class="$style.sub">{{ t.allOk }}</div>
		</section>

		<div :class="$style.grid">
			<!-- 判定係 -->
			<section class="_panel" :class="$style.panel">
				<div :class="$style.title">{{ t.worker }}</div>
				<div v-if="data.dispatcher" :class="$style.keyValues">
					<MkKeyValue>
						<template #key>{{ t.state }}</template>
						<template #value>{{ data.dispatcher.state }}<span :class="$style.sub"> ・ {{ ago(data.dispatcher.since) }}</span></template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.updatedAt }}</template>
						<template #value>{{ ago(data.dispatcher.updatedAt) }}</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.pids }}</template>
						<template #value>{{ t.leader }} {{ data.leaderPid ?? '—' }} ・ {{ t.workerPid }} {{ data.dispatcher.workerPid ?? '—' }}</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.processed }}</template>
						<template #value>{{ data.dispatcher.processed }}<span :class="$style.sub"><template v-if="data.dispatcher.workerUptimeSec != null"> ・ {{ t.uptime }} {{ duration(data.dispatcher.workerUptimeSec) }}</template><template v-if="data.dispatcher.vramGiB != null"> ・ GPU {{ data.dispatcher.vramGiB.toFixed(2) }}GB</template></span></template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.inflight }}</template>
						<template #value>{{ data.dispatcher.inflight ? `${data.dispatcher.inflight.kind} ${data.dispatcher.inflight.count} 件・${ago(data.dispatcher.inflight.startedAt)}` : '—' }}</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.lastError }}</template>
						<template #value>{{ data.dispatcher.lastError ?? '—' }}</template>
					</MkKeyValue>
				</div>
				<div v-else :class="$style.sub">{{ t.noDispatcher }}</div>
			</section>

			<!-- GPU の取り合い -->
			<section class="_panel" :class="$style.panel">
				<div :class="$style.title">{{ t.contention }}</div>
				<div :class="$style.keyValues">
					<MkKeyValue>
						<template #key>{{ t.lockHolder }}</template>
						<template #value>{{ data.lock.holder ?? t.none }}<span v-if="data.lock.acquiredAt" :class="$style.sub"> ・ {{ ago(data.lock.acquiredAt) }}</span><span v-if="data.lock.ttlSec != null" :class="$style.sub"> ・ {{ t.ttl }} {{ data.lock.ttlSec }}s</span></template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.runtime }}</template>
						<template #value>{{ data.runtimeAvailable == null ? '—' : data.runtimeAvailable ? 'OK' : t.noGpu }}</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ t.scan }}</template>
						<template #value>{{ data.scan.running ? `${t.scanRunning}${data.scan.exhausted ? `・${t.scanExhausted}` : ''}` : t.none }}</template>
					</MkKeyValue>
				</div>
				<table v-if="data.waiters.length > 0" :class="$style.table">
					<thead><tr><th scope="col">{{ t.waiter }}</th><th scope="col" :class="$style.num">{{ t.priority }}</th><th scope="col">{{ t.waitingSince }}</th></tr></thead>
					<tbody>
						<tr v-for="w in data.waiters" :key="w.kind"><td>{{ w.kind }}</td><td :class="$style.num">{{ w.priority }}</td><td>{{ w.since ? ago(w.since) : '—' }}</td></tr>
					</tbody>
				</table>
				<div v-else :class="$style.sub">{{ t.noWaiters }}</div>
			</section>
		</div>

		<!-- 種類ごと -->
		<section class="_panel" :class="[$style.panel, $style.scroll]">
			<div :class="$style.title">{{ t.kinds }}</div>
			<table :class="$style.table">
				<thead>
					<tr>
						<th scope="col">{{ t.kind }}</th>
						<th scope="col" :class="$style.num">{{ t.base }}</th>
						<th scope="col" :class="$style.num">{{ t.length }}</th>
						<th scope="col" :class="$style.num">{{ t.inflightCol }}</th>
						<th scope="col" :class="$style.num">{{ t.oldest }}</th>
						<th scope="col" :class="$style.num">{{ t.hourItems }}</th>
						<th scope="col" :class="$style.num">{{ t.secPerItem }}</th>
						<th scope="col" :class="$style.num">{{ t.dropped }}</th>
						<th scope="col" :class="$style.num">{{ t.failed }}</th>
						<th scope="col" :class="$style.num">{{ t.mismatch }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="k in data.kinds" :key="k.kind">
						<td>{{ k.kind }}<span :class="$style.sub"> ・ {{ t.batchOf }} {{ k.maxBatch }}<template v-if="k.deadlineSec != null"> ・ {{ t.deadline }} {{ k.deadlineSec }}s</template></span></td>
						<td :class="$style.num">{{ k.base }}</td>
						<td :class="$style.num">{{ k.length }}</td>
						<td :class="$style.num">{{ k.inflight }}</td>
						<td :class="$style.num">{{ k.oldestWaitSec != null ? duration(k.oldestWaitSec) : '—' }}</td>
						<td :class="$style.num">{{ k.itemsLastHour }}<span :class="$style.sub"> / {{ k.batchesLastHour }}{{ t.times }}</span></td>
						<td :class="$style.num">{{ k.secPerItem != null ? k.secPerItem.toFixed(2) : '—' }}</td>
						<td :class="$style.num">{{ k.dropped }}</td>
						<td :class="$style.num">{{ k.failed }}</td>
						<td :class="$style.num">{{ k.listOnly + k.bodyOnly > 0 ? `${k.listOnly}/${k.bodyOnly}` : '—' }}</td>
					</tr>
				</tbody>
			</table>
		</section>

		<!-- 次にやる順 -->
		<section class="_panel" :class="[$style.panel, $style.scroll]">
			<div :class="$style.title">{{ t.next }}</div>
			<div :class="$style.sub">{{ t.nextCaption }}</div>
			<table v-if="data.next.length > 0" :class="$style.table">
				<thead>
					<tr>
						<th scope="col" :class="$style.num">{{ t.round }}</th>
						<th scope="col">{{ t.kind }}</th>
						<th scope="col">{{ t.item }}</th>
						<th scope="col" :class="$style.num">{{ t.waited }}</th>
						<th scope="col" :class="$style.num">{{ t.priorityBreakdown }}</th>
						<th scope="col" :class="$style.num">{{ t.deadline }}</th>
						<th scope="col" :class="$style.num">{{ t.attempts }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="item in data.next" :key="`${item.kind}:${item.itemId}`">
						<td :class="$style.num">{{ item.round }}</td>
						<td>{{ item.kind }}</td>
						<td :class="$style.mono">{{ item.itemId }}</td>
						<td :class="$style.num">{{ duration(item.waitSec) }}</td>
						<td :class="$style.num"><b>{{ item.total }}</b><span :class="$style.sub"> = {{ item.base }} + {{ item.aging }} + {{ item.deadline }}</span></td>
						<td :class="$style.num">{{ item.deadlineInSec != null ? `${item.deadlineInSec}s` : '—' }}</td>
						<td :class="$style.num">{{ item.attempts }}</td>
					</tr>
				</tbody>
			</table>
			<div v-else :class="$style.sub">{{ t.empty }}</div>
		</section>

		<div :class="$style.grid">
			<!-- 最近の判定 -->
			<section class="_panel" :class="[$style.panel, $style.scroll]">
				<div :class="$style.title">{{ t.batches }}</div>
				<table v-if="data.batches.length > 0" :class="$style.table">
					<thead>
						<tr>
							<th scope="col">{{ t.at }}</th>
							<th scope="col">{{ t.kind }}</th>
							<th scope="col" :class="$style.num">{{ t.size }}</th>
							<th scope="col" :class="$style.num">{{ t.seconds }}</th>
							<th scope="col" :class="$style.num">{{ t.secPerItem }}</th>
							<th scope="col" :class="$style.num">{{ t.maxWait }}</th>
							<th scope="col" :class="$style.num">{{ t.errors }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="(b, i) in data.batches" :key="i">
							<td :class="$style.nowrap">{{ clock(b.at) }}</td>
							<td>{{ b.kind }}</td>
							<td :class="$style.num">{{ b.size }}</td>
							<td :class="$style.num">{{ (b.durationMs / 1000).toFixed(1) }}</td>
							<td :class="$style.num">{{ b.size > 0 ? (b.durationMs / b.size / 1000).toFixed(2) : '—' }}</td>
							<td :class="$style.num">{{ duration(Math.round(b.maxWaitMs / 1000)) }}</td>
							<td :class="$style.num">{{ b.errors > 0 ? b.errors : '' }}</td>
						</tr>
					</tbody>
				</table>
				<div v-else :class="$style.sub">{{ t.empty }}</div>
			</section>

			<!-- 出来事 -->
			<section class="_panel" :class="[$style.panel, $style.scroll]">
				<div :class="$style.title">{{ t.events }}</div>
				<table v-if="data.events.length > 0" :class="$style.table">
					<thead>
						<tr>
							<th scope="col">{{ t.at }}</th>
							<th scope="col">{{ t.event }}</th>
							<th scope="col">{{ t.kind }}</th>
							<th scope="col" :class="$style.num">{{ t.size }}</th>
							<th scope="col" :class="$style.num">{{ t.seconds }}</th>
							<th scope="col">{{ t.detail }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="(e, i) in data.events" :key="i" :class="{ [$style.bad]: isBadEvent(e) }">
							<td :class="$style.nowrap">{{ clock(e.at) }}</td>
							<td :class="$style.nowrap">{{ e.type }}</td>
							<td>{{ e.kind ?? '' }}</td>
							<td :class="$style.num">{{ e.count ?? '' }}</td>
							<td :class="$style.num">{{ e.durationMs != null ? (e.durationMs / 1000).toFixed(1) : '' }}</td>
							<td :class="[$style.sub, $style.detail]">{{ e.detail ?? '' }}</td>
						</tr>
					</tbody>
				</table>
				<div v-else :class="$style.sub">{{ t.empty }}</div>
			</section>
		</div>
	</template>
	<MkLoading v-else-if="loading"/>
</div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import type { entities } from 'misskey-js';
import { useInterval } from '@@/js/use-interval.js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';

const t = i18n.ts._hana._admin._gpuQueue;

const data = ref<entities.AdminHanamiGpuQueueResponse | null>(null);
const loading = ref(false);
const error = ref('');
const autoReload = ref(true);
const showOk = ref(false);
// 失敗・あきらめ・リーダーを失った、などは目立たせる（譲るときの正常な終了 code=0 は除く）
const badEvents = new Set(['batchFailed', 'handlerFailed', 'giveUp', 'workerFailed', 'leaderLost', 'retry']);

function isBadEvent(e: { type: string; detail: string | null }): boolean {
	if (e.type === 'workerExit') return !(e.detail ?? '').startsWith('code=0 ');
	return badEvents.has(e.type);
}

const levelOrder: Record<string, number> = { error: 0, warn: 1, info: 2, ok: 3 };

const visibleChecks = computed(() => (data.value?.checks ?? [])
	.filter(c => showOk.value || c.level !== 'ok')
	.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]));

async function reload(): Promise<void> {
	if (loading.value) return;
	loading.value = true;
	try {
		data.value = await misskeyApi('admin/hanami/gpu-queue', {});
		error.value = '';
	} catch (err) {
		error.value = String((err as { message?: unknown }).message ?? err);
	} finally {
		loading.value = false;
	}
}

useInterval(() => {
	if (autoReload.value) void reload();
}, 5000, { immediate: true, afterMounted: true });

function copyJson(): void {
	if (data.value == null) return;
	copyToClipboard(JSON.stringify(data.value, null, 2));
	os.success();
}

function levelIcon(level: string): string {
	switch (level) {
		case 'error': return 'ti ti-alert-triangle';
		case 'warn': return 'ti ti-alert-triangle';
		case 'info': return 'ti ti-info-circle';
		default: return 'ti ti-check';
	}
}

function levelColor(level: string): string {
	switch (level) {
		case 'error': return 'var(--MI_THEME-error)';
		case 'warn': return 'var(--MI_THEME-warn)';
		case 'info': return 'var(--MI_THEME-accent)';
		default: return 'var(--MI_THEME-success)';
	}
}

function duration(sec: number): string {
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
	return `${Math.floor(sec / 3600)}h${Math.floor(sec % 3600 / 60)}m`;
}

function ago(at: number): string {
	const now = data.value?.now ?? Date.now();
	return `${duration(Math.max(0, Math.round((now - at) / 1000)))} ${t.ago}`;
}

function clock(at: number): string {
	return new Date(at).toLocaleTimeString();
}
</script>

<style lang="scss" module>
.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 16px;
}

.toolbarButtons {
	margin-left: auto;
}

.panel {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 16px;
}

.scroll {
	overflow-x: auto;
}

.head {
	display: flex;
	align-items: center;
	gap: 12px;
}

.headSwitch {
	margin-left: auto;
}

.title {
	font-weight: bold;
}

.sub {
	font-size: 0.9em;
	opacity: 0.7;
}

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
	gap: 12px;
	align-items: start;
}

.keyValues {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
	gap: 10px;
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.9em;

	th, td {
		padding: 5px 8px;
		text-align: left;
		vertical-align: top;
	}

	th {
		font-weight: normal;
		opacity: 0.7;
		white-space: nowrap;
	}

	tbody tr + tr {
		border-top: solid 0.5px var(--MI_THEME-divider);
	}
}

.num {
	text-align: right !important;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.nowrap {
	white-space: nowrap;
}

.iconCell {
	width: 1.5em;
}

.mono {
	font-family: monospace;
	font-size: 0.9em;
	overflow-wrap: anywhere;
}

.detail {
	overflow-wrap: anywhere;
}

.bad td {
	color: var(--MI_THEME-error);
}
</style>
