<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<section v-if="previewLimit === undefined || fetching || failed || notes.length > 0" :class="$style.posts">
	<div role="tablist" :class="$style.tabs">
		<button class="_button" role="tab" :aria-selected="sort === 'popular'" :class="{ [$style.selected]: sort === 'popular' }" @click="changeSort('popular')">{{ i18n.ts._hana._trends.sortPopular }}</button>
		<button class="_button" role="tab" :aria-selected="sort === 'recent'" :class="{ [$style.selected]: sort === 'recent' }" @click="changeSort('recent')">{{ i18n.ts._hana._trends.sortRecent }}</button>
	</div>
	<MkNote v-for="note in notes" :key="note.id" :note="note"/>
	<MkLoading v-if="fetching"/>
	<div v-else-if="failed" :class="$style.status" role="alert"><p>{{ i18n.ts.somethingHappened }}</p><MkButton @click="fetchNotes">{{ i18n.ts.retry }}</MkButton></div>
	<div v-else-if="previewLimit === undefined && hasMore" :class="$style.status"><MkButton v-appear="fetchNotes" rounded @click="fetchNotes">{{ i18n.ts.loadMore }}</MkButton></div>
	<p v-else-if="notes.length === 0" :class="$style.status">{{ i18n.ts._hana._trends.noTopicNotes }}</p>
</section>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import type * as Misskey from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import MkNote from '@/components/MkNote.vue';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { useGlobalEvent } from '@/events.js';

const props = defineProps<{
	topicId: string;
	previewLimit?: number;
}>();
const sort = ref<'popular' | 'recent'>('popular');
const notes = ref<Misskey.entities.Note[]>([]);
const deletedIds = new Set<string>();
const fetching = ref(false);
const failed = ref(false);
const hasMore = ref(true);
let offset = 0;
let requestVersion = 0;
let disposed = false;
onBeforeUnmount(() => { disposed = true; requestVersion++; });

useGlobalEvent('noteDeleted', id => {
	deletedIds.add(id);
	notes.value = notes.value.filter(note => note.id !== id);
});

async function fetchNotes(): Promise<void> {
	if (disposed || fetching.value || !hasMore.value) return;
	const version = requestVersion;
	const limit = props.previewLimit === undefined ? 20 : 10;
	fetching.value = true;
	failed.value = false;
	try {
		const result = await misskeyApiGet('notes/hanami-topic-notes', { topicId: props.topicId, sort: sort.value, limit, offset });
		if (version !== requestVersion) return;
		const seen = new Set(notes.value.map(note => note.id));
		const visible = props.previewLimit === undefined ? result : result.slice(0, props.previewLimit);
		notes.value.push(...visible.filter(note => !deletedIds.has(note.id) && !seen.has(note.id)));
		// Offsets count the SQL window, including posts removed by the safety filter.
		offset += limit;
		hasMore.value = props.previewLimit === undefined && result.length > 0 && offset < 500;
	} catch {
		if (version === requestVersion) failed.value = true;
	} finally {
		if (version === requestVersion) fetching.value = false;
	}
}

function resetNotes(): void {
	requestVersion++;
	notes.value = [];
	offset = 0;
	hasMore.value = true;
	failed.value = false;
	fetching.value = false;
}

function changeSort(value: 'popular' | 'recent'): void {
	if (sort.value === value) return;
	sort.value = value;
	resetNotes();
	void fetchNotes();
}

watch(() => props.topicId, () => {
	sort.value = 'popular';
	resetNotes();
	void fetchNotes();
}, { immediate: true });
</script>

<style lang="scss" module>
.posts { min-width: 0; overflow: clip; }
.tabs { display: flex; gap: 20px; padding: 12px 20px; border-bottom: 1px solid var(--MI_THEME-divider); button { padding: 6px 0; } }
.selected { color: var(--MI_THEME-accent); box-shadow: 0 2px var(--MI_THEME-accent); }
.status { padding: 16px; text-align: center; color: var(--MI_THEME-fgTransparent); }
</style>
