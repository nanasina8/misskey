<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<div :class="$style.sub">{{ i18n.ts._aiModeration.scanCaption }}</div>

	<!-- 始める（管理者のみ） -->
	<div v-if="iAmAdmin" class="_panel" :class="$style.panel">
		<div :class="$style.form">
			<MkSelect v-model="mode" :items="modeDef">
				<template #label>{{ i18n.ts._aiModeration.scanMode }}</template>
			</MkSelect>
			<MkSelect v-model="target" :items="targetDef">
				<template #label>{{ i18n.ts._aiModeration.scanTarget }}</template>
			</MkSelect>
			<MkSelect v-model="period" :items="periodDef">
				<template #label>{{ i18n.ts._aiModeration.scanPeriod }}</template>
			</MkSelect>
			<div class="_gaps_s">
				<MkInput v-model="maxJudged" type="number" :min="1" :max="10000000" :disabled="unlimited">
					<template #label>{{ i18n.ts._aiModeration.scanMaxJudged }}</template>
				</MkInput>
				<MkSwitch v-model="unlimited">
					<template #label>{{ i18n.ts._aiModeration.scanUnlimited }}</template>
				</MkSwitch>
			</div>
		</div>
		<div class="_buttons">
			<MkButton :disabled="estimating" @click="runEstimate"><i class="ti ti-calculator"></i> {{ i18n.ts._aiModeration.scanEstimate }}</MkButton>
			<MkButton primary :disabled="running != null || starting" @click="start"><i class="ti ti-player-play"></i> {{ i18n.ts._aiModeration.scanStart }}</MkButton>
		</div>
		<div v-if="estimate" :class="$style.sub">
			{{ i18n.tsx._aiModeration.scanEstimateResult({
				notes: estimate.notes,
				candidates: estimate.candidates,
				sampled: estimate.sampled,
				sampledCandidates: estimate.sampledCandidates,
				perHour: estimate.postsPerHour,
				judged: plannedJudged,
				time: durationText(plannedJudged / Math.max(estimate.postsPerHour, 1) * 3600),
			}) }}
		</div>
	</div>

	<MkInfo v-if="error" warn>{{ error }}</MkInfo>

	<template v-if="show?.scan">
		<!-- 1回分の状況 -->
		<div class="_panel" :class="$style.panel">
			<div :class="$style.head">
				<MkSelect v-if="show.scans.length > 1" v-model="selectedScanId" :items="scanDef" small>
					<template #label>{{ i18n.ts._aiModeration.scanHistory }}</template>
				</MkSelect>
				<div v-else :class="$style.title">{{ scanLabel(show.scan) }}</div>
				<div class="_buttons" :class="$style.headButtons">
					<MkButton small :disabled="loading" @click="reload"><i class="ti ti-refresh"></i> {{ i18n.ts._aiModeration.reload }}</MkButton>
					<MkButton small :disabled="exporting" @click="exportScan('json')"><i class="ti ti-download"></i> JSON</MkButton>
					<MkButton small :disabled="exporting" @click="exportScan('csv')"><i class="ti ti-download"></i> CSV</MkButton>
					<MkButton v-if="iAmAdmin && show.scan.status === 'running'" small danger @click="cancel"><i class="ti ti-player-stop"></i> {{ i18n.ts._aiModeration.scanCancel }}</MkButton>
				</div>
			</div>
			<div :class="$style.keyValues">
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.scanState }}</template>
					<template #value>{{ statusLabel(show.scan.status) }}<span v-if="show.progress != null" :class="$style.sub"> ・ {{ Math.round(show.progress * 100) }}%</span><span v-if="show.etaSeconds != null" :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.scanEta({ time: durationText(show.etaSeconds) }) }}</span></template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.scanConditions }}</template>
					<template #value>{{ modeLabel(show.scan.mode) }} ・ {{ targetLabel(show.scan.target) }} ・ {{ show.scan.maxJudged == null ? i18n.ts._aiModeration.scanUnlimited : i18n.tsx._aiModeration.scanMaxValue({ n: show.scan.maxJudged }) }}<span :class="$style.sub"> ・ <MkTime v-if="show.scan.since" :time="show.scan.since" mode="absolute"/><template v-else>{{ i18n.ts._aiModeration.scanFromBeginning }}</template> 〜 <MkTime :time="show.scan.until" mode="absolute"/></span></template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.scanCounts }}</template>
					<template #value>{{ i18n.tsx._aiModeration.scanCountsValue({ scanned: show.scan.scannedCount, judged: show.scan.judgedCount, flagged: show.scan.flaggedCount, wouldHide: show.scan.wouldHideCount }) }}</template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.scanStartedBy }}</template>
					<template #value>{{ show.scan.startedBy ?? '—' }}<span :class="$style.sub"> ・ <MkTime :time="show.scan.createdAt"/><template v-if="show.scan.finishedAt"> 〜 <MkTime :time="show.scan.finishedAt"/></template></span></template>
				</MkKeyValue>
			</div>
			<MkInfo v-if="show.scan.lastError" warn>{{ show.scan.lastError }}</MkInfo>
			<MkInfo v-if="show.scan.status === 'running' && tickStale" warn>{{ i18n.ts._aiModeration.scanTickStale }}</MkInfo>
		</div>

		<!-- 判定条件 -->
		<div class="_panel" :class="$style.panel">
			<div :class="$style.cardLabel">{{ i18n.ts._aiModeration.criteriaTitle }}</div>
			<div v-if="show.criteria" :class="$style.keyValues">
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.criteriaVersion }}</template>
					<template #value><code>{{ show.scan.criteriaVersion }}</code><span v-if="show.criteriaVersions.length > 1" :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.criteriaMixed({ count: show.criteriaVersions.length }) }}</span></template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.criteriaModel }}</template>
					<template #value>{{ criteriaText('model') }}<span :class="$style.sub"> ・ {{ i18n.ts._aiModeration.criteriaScript }} <code>{{ criteriaText('judgeScriptSha') }}</code></span></template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.criteriaThresholds }}</template>
					<template #value>{{ i18n.tsx._aiModeration.criteriaThresholdsValue({ flag: criteriaText('localThreshold'), hide: criteriaText('autoHideThreshold'), points: criteriaText('autoHideMinPoints'), days: criteriaText('newAuthorDays') }) }}</template>
				</MkKeyValue>
			</div>
		</div>

		<!-- 集計 -->
		<div :class="$style.summary">
			<div class="_panel" :class="$style.panel">
				<div :class="$style.cardLabel">{{ i18n.ts._aiModeration.scanByLabel }}</div>
				<table :class="$style.table">
					<tbody>
						<tr v-for="row in show.byLabel" :key="row.label ?? '-'">
							<td>{{ scoreLabelText(row.label) }}</td>
							<td>{{ row.items }}</td>
							<td :class="$style.sub">{{ i18n.tsx._aiModeration.scanFlaggedOf({ count: row.flagged }) }}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<div v-for="block in summaryBlocks" :key="block.title" class="_panel" :class="$style.panel">
				<div :class="$style.cardLabel">{{ block.title }}</div>
				<div v-if="block.rows.length === 0" :class="$style.sub">—</div>
				<table v-else :class="$style.table">
					<thead>
						<tr>
							<th scope="col"></th>
							<th scope="col">{{ i18n.ts._aiModeration.scanColItems }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.scanColAccounts }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.scanColWouldHide }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="row in block.rows" :key="row.name">
							<td :class="$style.nameCell">{{ row.name }}</td>
							<td>{{ row.items }}</td>
							<td>{{ row.accounts }}</td>
							<td>{{ row.wouldHideAccounts }}</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>

		<!-- 一覧 -->
		<MkTabs
			v-model:tab="itemFilter"
			:tabs="[{
				key: 'flagged',
				title: i18n.ts._aiModeration.scanFilterFlagged,
			}, {
				key: 'wouldHide',
				title: i18n.ts._aiModeration.scanFilterWouldHide,
			}, {
				key: 'notFlagged',
				title: i18n.ts._aiModeration.scanFilterNotFlagged,
			}]"
		/>
		<MkPagination v-slot="{ items }" :key="`${show.scan.id}:${itemFilter}`" :paginator="itemsPaginator">
			<div class="_panel" :class="$style.tableScroll">
				<table :class="[$style.table, $style.items]">
					<thead>
						<tr>
							<th scope="col">{{ i18n.ts._aiModeration.scanColPostedAt }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.accountCol }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.noteBody }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.aiJudgementCol }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.evidenceTitle }}</th>
							<th scope="col">{{ i18n.ts._aiModeration.scanColWouldHide }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="item in items" :key="item.id">
							<td><MkTime :time="item.noteCreatedAt" mode="absolute"/></td>
							<td><MkA v-if="item.user" :to="`/admin/user/${item.noteUserId}`"><MkAcct :user="item.user"/></MkA><span v-else>—</span></td>
							<td :class="$style.textCell">
								<MkA v-if="item.noteExists" :to="`/notes/${item.noteId}`">{{ item.noteText }}</MkA>
								<span v-else>{{ item.noteText }} <span :class="$style.sub">（{{ i18n.ts._aiModeration.noteDeleted }}）</span></span>
							</td>
							<td>{{ itemScore(item) }}</td>
							<td :class="$style.signalCell">{{ item.spamSignals.length > 0 ? item.spamSignals.map(spamSignalLabel).join('・') : '—' }}</td>
							<td>{{ item.wouldHide ? i18n.ts._aiModeration.scanYes : '' }}</td>
						</tr>
					</tbody>
				</table>
			</div>
		</MkPagination>
	</template>
	<div v-else-if="!loading" class="_panel" :class="$style.empty">{{ i18n.ts._aiModeration.scanNone }}</div>
</div>
</template>

<script lang="ts" setup>
import { computed, markRaw, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import { useInterval } from '@@/js/use-interval.js';
import MkAcct from '@/components/global/MkAcct.vue';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkPagination from '@/components/MkPagination.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkTabs from '@/components/MkTabs.vue';
import { useMkSelect } from '@/composables/use-mkselect.js';
import { i18n } from '@/i18n.js';
import { iAmAdmin } from '@/i.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { Paginator } from '@/utility/paginator.js';

type ShowResponse = entities.AdminAiModerationScanShowResponse;
type Scan = NonNullable<ShowResponse['scan']>;
type ScanItem = entities.AdminAiModerationScanItemsResponse[number];

const props = defineProps<{
	spamSignalLabel: (signal: string) => string;
}>();

const t = i18n.ts._aiModeration;

const { model: mode, def: modeDef } = useMkSelect({
	items: [
		{ label: t.scanModeFiltered, value: 'filtered' },
		{ label: t.scanModeAll, value: 'all' },
	],
	initialValue: 'filtered',
});
const { model: target, def: targetDef } = useMkSelect({
	items: [
		{ label: t.scanTargetAll, value: 'all' },
		{ label: t.scanTargetLocal, value: 'local' },
		{ label: t.scanTargetRemote, value: 'remote' },
	],
	initialValue: 'all',
});
const { model: period, def: periodDef } = useMkSelect({
	items: [
		{ label: i18n.tsx._aiModeration.scanDays({ days: 7 }), value: '7' },
		{ label: i18n.tsx._aiModeration.scanDays({ days: 30 }), value: '30' },
		{ label: i18n.tsx._aiModeration.scanDays({ days: 90 }), value: '90' },
		{ label: i18n.tsx._aiModeration.scanDays({ days: 365 }), value: '365' },
		{ label: t.scanFromBeginning, value: 'all' },
	],
	initialValue: '30',
});
const maxJudged = ref<number | null>(5000);
const unlimited = ref(false);
// 見積もりで判定する件数（上限なしなら判定に回る見込みの件数ぜんぶ）
const plannedJudged = computed(() => {
	const candidates = estimate.value?.candidates ?? 0;
	return unlimited.value ? candidates : Math.min(candidates, maxJudged.value ?? 5000);
});
const days = computed(() => period.value === 'all' ? null : Number(period.value));

const show = ref<ShowResponse | null>(null);
const loading = ref(false);
const error = ref('');
const estimate = ref<entities.AdminAiModerationScanEstimateResponse | null>(null);
const estimating = ref(false);
const starting = ref(false);
const exporting = ref(false);
const selectedScanId = ref<string | null>(null);
const itemFilter = ref<'flagged' | 'wouldHide' | 'notFlagged'>('flagged');

// 定期実行が10分以上動いていなければ、スキャンは進まない
const lastTickAt = ref<string | null>(null);
const tickStale = computed(() => lastTickAt.value == null || Date.now() - new Date(lastTickAt.value).getTime() > 10 * 60 * 1000);

const running = computed(() => show.value?.scans.find(s => s.status === 'running') ?? null);

const scanDef = computed(() => (show.value?.scans ?? []).map(s => ({ label: scanLabel(s), value: s.id })));

function errorText(err: unknown): string {
	if (err != null && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
	return String(err);
}

async function reload(): Promise<void> {
	if (loading.value) return;
	loading.value = true;
	error.value = '';
	try {
		const [res, status] = await Promise.all([
			misskeyApi('admin/ai-moderation/scan/show', selectedScanId.value != null ? { scanId: selectedScanId.value } : {}),
			misskeyApi('admin/ai-moderation/status'),
		]);
		show.value = res;
		lastTickAt.value = status.lastTickAt;
		if (selectedScanId.value == null && res.scan != null) selectedScanId.value = res.scan.id;
	} catch (err) {
		error.value = errorText(err);
	} finally {
		loading.value = false;
	}
}

watch(selectedScanId, (id, old) => {
	if (old != null && id !== old) void reload();
});

// 実行中は 30 秒ごとに読み直す
useInterval(() => {
	if (show.value?.scan?.status === 'running') void reload();
}, 30 * 1000, { immediate: false, afterMounted: true });

async function runEstimate(): Promise<void> {
	estimating.value = true;
	try {
		estimate.value = await misskeyApi('admin/ai-moderation/scan/estimate', { mode: mode.value, target: target.value, days: days.value });
	} catch (err) {
		os.alert({ type: 'error', text: errorText(err) });
	} finally {
		estimating.value = false;
	}
}

async function start(): Promise<void> {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: t.scanConfirmStart,
	});
	if (canceled) return;
	starting.value = true;
	try {
		const scan = await misskeyApi('admin/ai-moderation/scan/start', { mode: mode.value, target: target.value, days: days.value, maxJudged: unlimited.value ? null : (maxJudged.value ?? 5000) });
		selectedScanId.value = scan.id;
		await reload();
		os.success();
	} catch (err) {
		os.alert({ type: 'error', text: errorText(err) });
	} finally {
		starting.value = false;
	}
}

async function cancel(): Promise<void> {
	if (show.value?.scan == null) return;
	const { canceled } = await os.confirm({ type: 'warning', text: t.scanConfirmCancel });
	if (canceled) return;
	await misskeyApi('admin/ai-moderation/scan/cancel', { scanId: show.value.scan.id });
	await reload();
}

const itemsPaginator = markRaw(new Paginator('admin/ai-moderation/scan/items', {
	limit: 30,
	computedParams: computed(() => ({
		scanId: show.value?.scan?.id ?? '',
		flagged: itemFilter.value === 'notFlagged' ? false : true,
		...(itemFilter.value === 'wouldHide' ? { wouldHide: true } : {}),
	})),
}));

const csvColumns = ['noteId', 'noteCreatedAt', 'username', 'noteUserHost', 'noteVisibility', 'localLabel', 'spam', 'scam', 'abuse', 'normal', 'flagged', 'wouldHide', 'spamSignals', 'triggers', 'links', 'criteriaVersion', 'noteExists', 'noteText'] as const;

function csvCell(value: unknown): string {
	const s = value == null ? '' : Array.isArray(value) ? value.join(' ') : String(value);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name: string, content: string, type: string): void {
	const blob = new Blob([content], { type });
	const a = window.document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = name;
	a.click();
	URL.revokeObjectURL(a.href);
}

async function exportScan(format: 'json' | 'csv'): Promise<void> {
	if (show.value?.scan == null) return;
	exporting.value = true;
	try {
		const scanId = show.value.scan.id;
		let page = await misskeyApi('admin/ai-moderation/scan/export', { scanId });
		const result = { exportedAt: new Date().toISOString(), scan: page.scan, criteria: page.criteria, items: [...page.items] };
		while (page.next != null) {
			page = await misskeyApi('admin/ai-moderation/scan/export', { scanId, sinceId: page.next });
			result.items.push(...page.items);
			for (const c of page.criteria) {
				if (!result.criteria.some(x => x.version === c.version)) result.criteria.push(c);
			}
		}
		const base = `ai-moderation-scan-${scanId}`;
		if (format === 'json') {
			download(`${base}.json`, JSON.stringify(result, null, 2), 'application/json');
		} else {
			const lines = [csvColumns.join(',')];
			for (const item of result.items) {
				const row: Record<(typeof csvColumns)[number], unknown> = {
					...item,
					spam: item.localScores?.spam,
					scam: item.localScores?.scam,
					abuse: item.localScores?.abuse,
					normal: item.localScores?.normal,
				};
				lines.push(csvColumns.map(c => csvCell(row[c])).join(','));
			}
			// 判定条件は別ファイルにせず、先頭のコメント行に入れる（表計算ソフトでは1行目を飛ばす）
			const header = `# scan=${scanId} criteria=${result.criteria.map(c => `${c.version}:${JSON.stringify(c.criteria)}`).join(' | ')}`;
			download(`${base}.csv`, `${String.fromCharCode(0xFEFF)}${csvCell(header)}\n${lines.join('\n')}`, 'text/csv');
		}
	} catch (err) {
		os.alert({ type: 'error', text: errorText(err) });
	} finally {
		exporting.value = false;
	}
}

function durationText(seconds: number): string {
	if (seconds < 60 * 60) return i18n.tsx._aiModeration.scanMinutes({ n: Math.max(1, Math.round(seconds / 60)) });
	if (seconds < 48 * 60 * 60) return i18n.tsx._aiModeration.scanHours({ n: Math.round(seconds / 3600 * 10) / 10 });
	return i18n.tsx._aiModeration.scanDaysDuration({ n: Math.round(seconds / 86400 * 10) / 10 });
}

function statusLabel(status: Scan['status']): string {
	switch (status) {
		case 'running': return t.scanRunning;
		case 'done': return t.scanDone;
		case 'canceled': return t.scanCanceled;
	}
}

function modeLabel(m: Scan['mode']): string {
	return m === 'all' ? t.scanModeAll : t.scanModeFiltered;
}

function targetLabel(v: Scan['target']): string {
	return v === 'local' ? t.scanTargetLocal : v === 'remote' ? t.scanTargetRemote : t.scanTargetAll;
}

function scanLabel(s: Scan): string {
	return `${new Date(s.createdAt).toLocaleString()} ・ ${statusLabel(s.status)} ・ ${modeLabel(s.mode)}`;
}

function criteriaText(key: string): string {
	const value = (show.value?.criteria as Record<string, unknown> | null)?.[key];
	return value == null ? '—' : String(value);
}

function scoreLabelText(label: string | null): string {
	switch (label) {
		case 'spam': return t.spam;
		case 'scam': return t.scam;
		case 'abuse': return t.abuse;
		case 'normal': return t.normal;
		default: return label ?? '—';
	}
}

function itemScore(item: ScanItem): string {
	if (item.localScores == null) return '—';
	const top = item.localLabel ?? 'normal';
	const value = top === 'normal' ? item.localScores.normal : top === 'spam' ? item.localScores.spam : top === 'scam' ? item.localScores.scam : item.localScores.abuse;
	return `${scoreLabelText(top)} ${Math.round(value * 100)}%`;
}

const summaryBlocks = computed(() => {
	const s = show.value;
	if (s == null) return [];
	return [
		{ title: t.scanByHost, rows: s.hosts.map(r => ({ name: r.host ?? t.scanLocalHost, ...r })) },
		{ title: t.scanByLink, rows: s.links.map(r => ({ name: r.link ?? '—', ...r })) },
		{ title: t.scanBySignal, rows: s.signals.map(r => ({ name: props.spamSignalLabel(r.signal ?? ''), ...r })) },
	];
});

void reload();
</script>

<style lang="scss" module>
.sub {
	font-size: 0.9em;
	opacity: 0.7;
}

.cardLabel {
	font-size: 0.85em;
	opacity: 0.7;
	margin-bottom: 8px;
}

.panel {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 12px 16px;
}

.form {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 12px;
}

.head {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: 8px 16px;
}

.title {
	font-weight: bold;
}

.headButtons {
	margin-left: auto;
}

.keyValues {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
	gap: 12px;
}

.summary {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
	gap: 12px;
	align-items: start;
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.9em;

	th, td {
		padding: 6px 10px;
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

.items tbody tr {
	border-top: solid 0.5px var(--MI_THEME-divider);
}

.nameCell {
	overflow-wrap: anywhere;
}

.tableScroll {
	overflow-x: auto;
}

.textCell {
	min-width: 200px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.signalCell {
	min-width: 120px;
}

.empty {
	padding: 16px;
	text-align: center;
	opacity: 0.7;
}
</style>
