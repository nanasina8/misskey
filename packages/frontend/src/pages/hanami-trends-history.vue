<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :tabs="[]">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<div class="_gaps">
			<section v-for="block in nonEmptyBlocks" :key="block.from" class="_panel" :class="$style.group">
				<h2 :class="$style.groupHead">{{ blockHeading(block.from) }}</h2>
				<div v-for="(item, index) in block.items" :key="item.topicId ?? item.term">
					<HanamiTrendRow :item="{ ...item, distinctAuthors: item.peakAuthors }" :rank="index + 1" :showAuthors="false"/>
					<div :class="$style.period">
						<span v-if="item.startedAt && item.startedAt < block.from">{{ i18n.ts._hana._trends.continuedFromBefore }} </span>
						{{ i18n.tsx._hana._trends.period({ from: timeFormat.format(new Date(item.firstSeenAt)), to: timeFormat.format(new Date(item.lastSeenAt)) }) }}
						· {{ i18n.tsx._hana._trends.peakAuthors({ n: item.peakAuthors }) }}
					</div>
					<div :class="$style.topicActions">
						<MkButton :aria-expanded="topicNotesState(block, item)?.open ?? false" @click="toggleTopicNotes(block, item)">
							{{ topicNotesState(block, item)?.open ? i18n.ts._hana._trends.hideTopicNotes : i18n.ts._hana._trends.showTopicNotes }}
						</MkButton>
					</div>
					<div v-if="topicNotesState(block, item)" v-show="topicNotesState(block, item)?.open">
						<MkLoading v-if="topicNotesState(block, item)?.loading" mini/>
						<div v-else-if="topicNotesState(block, item)?.failed" role="alert" :class="$style.topicActions">
							<p>{{ i18n.ts._hana._trends.topicNotesFailed }}</p>
							<MkButton @click="fetchTopicNotes(block, item)">{{ i18n.ts.retry }}</MkButton>
						</div>
						<p v-else-if="topicNotesState(block, item)?.notes?.length === 0" :class="$style.topicActions">{{ i18n.ts._hana._trends.noTopicNotes }}</p>
						<template v-else>
							<MkNote v-for="note in topicNotesState(block, item)?.notes ?? []" :key="note.id" :note="note"/>
						</template>
					</div>
				</div>
			</section>
			<MkLoading v-if="fetching"/>
			<div v-else-if="failed" role="alert" :class="$style.center">
				<p>{{ i18n.ts.somethingHappened }}</p>
				<MkButton @click="fetchHistory">{{ i18n.ts.retry }}</MkButton>
			</div>
			<p v-else-if="nonEmptyBlocks.length === 0 && nextUntil == null" :class="$style.center">{{ i18n.ts._hana._trends.empty }}</p>
			<div v-else-if="nextUntil" :class="$style.center"><MkButton rounded @click="fetchHistory">{{ i18n.ts._hana._trends.older }}</MkButton></div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { versatileLang } from '@@/js/intl-const.js';
import type * as Misskey from 'misskey-js';
import HanamiTrendRow from '@/components/HanamiTrendRow.vue';
import MkButton from '@/components/MkButton.vue';
import MkNote from '@/components/MkNote.vue';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { useGlobalEvent } from '@/events.js';

type HistoryBlock = Misskey.entities.NotesHanamiTrendHistoryResponse['blocks'][number];
type HistoryItem = HistoryBlock['items'][number];
type TopicNotesState = { open: boolean; loading: boolean; failed: boolean; notes: Misskey.entities.Note[] | null };
const topicNotes = reactive(new Map<string, TopicNotesState>());
const deletedNoteIds = new Set<string>();
useGlobalEvent('noteDeleted', noteId => {
	deletedNoteIds.add(noteId);
	for (const state of topicNotes.values()) {
		if (state.notes != null) state.notes = state.notes.filter(note => note.id !== noteId);
	}
});
const blocks = ref<HistoryBlock[]>([]);
const nextUntil = ref<string | null>(null);
const nonEmptyBlocks = computed(() => blocks.value.filter(block => block.items.length > 0));
const fetching = ref(false);
const failed = ref(false);
const dateFormat = new Intl.DateTimeFormat(versatileLang, { month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' });
const timeFormat = new Intl.DateTimeFormat(versatileLang, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' });

function blockHeading(from: string): string {
	const hour = new Date(Date.parse(from) + 9 * 3600000).getUTCHours();
	const names = [i18n.ts._hana._trends.blockNight0, i18n.ts._hana._trends.blockMorning, i18n.ts._hana._trends.blockDaytime, i18n.ts._hana._trends.blockEvening];
	return i18n.tsx._hana._trends.blockHeading({ date: dateFormat.format(new Date(from)), name: names[hour / 6], from: `${String(hour).padStart(2, '0')}:00`, to: `${String(hour + 6).padStart(2, '0')}:00` });
}

function topicNotesKey(block: HistoryBlock, item: HistoryItem): string {
	return JSON.stringify([block.from, block.to, item.topicId, item.topicId == null ? item.term : null]);
}

function topicNotesState(block: HistoryBlock, item: HistoryItem): TopicNotesState | undefined {
	return topicNotes.get(topicNotesKey(block, item));
}

async function toggleTopicNotes(block: HistoryBlock, item: HistoryItem): Promise<void> {
	const key = topicNotesKey(block, item);
	if (!topicNotes.has(key)) topicNotes.set(key, { open: false, loading: false, failed: false, notes: null });
	const state = topicNotes.get(key)!;
	state.open = !state.open;
	if (state.open && state.notes == null && !state.failed) await fetchTopicNotes(block, item);
}

async function fetchTopicNotes(block: HistoryBlock, item: HistoryItem): Promise<void> {
	const state = topicNotesState(block, item);
	if (state == null || state.loading) return;
	state.loading = true;
	state.failed = false;
	try {
		const res = await misskeyApiGet('notes/hanami-trend-topic-notes', {
			from: block.from, to: block.to, ...(item.topicId == null ? { term: item.term } : { topicId: item.topicId }),
		});
		state.notes = res.notes.filter(note => !deletedNoteIds.has(note.id));
	} catch {
		state.failed = true;
	} finally {
		state.loading = false;
	}
}

async function fetchHistory() {
	if (fetching.value) return;
	fetching.value = true;
	failed.value = false;
	try {
		const res = await misskeyApiGet('notes/hanami-trend-history', { blocks: 2, ...(nextUntil.value ? { until: nextUntil.value } : {}) });
		blocks.value.push(...res.blocks);
		nextUntil.value = res.nextUntil;
	} catch {
		failed.value = true;
	} finally {
		fetching.value = false;
	}
}

onMounted(fetchHistory);
definePage(() => ({ title: i18n.ts._hana._trends.history, icon: 'ti ti-trending-up' }));
</script>

<style lang="scss" module>
.group {
	overflow: hidden;
}

.groupHead {
	margin: 0;
	padding: 10px 14px 6px;
	font-size: 0.8em;
	font-weight: normal;
	letter-spacing: 0.04em;
	opacity: 0.7;
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.period {
	padding: 0 14px 10px;
	font-size: 0.75em;
	opacity: 0.7;
}

.topicActions {
	padding: 0 14px 10px;
}

.center {
	text-align: center;
	opacity: 0.8;
}
</style>
