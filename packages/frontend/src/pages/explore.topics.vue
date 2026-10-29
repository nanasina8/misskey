<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_spacer _gaps" style="--MI_SPACER-w: 800px;">
	<section class="_gaps">
		<header :class="$style.sectionHeader">
			<h2 :class="$style.sectionTitle">{{ i18n.ts._hana._trends.title }}</h2>
			<div :class="$style.headerActions">
				<small v-if="items[0]" :class="$style.snapshot">{{ i18n.tsx._hana._trends.snapshot({ time: timeFormat.format(new Date(items[0].snapshotGeneratedAt)) }) }}</small>
				<MkA class="_link" to="/hanami/trends">{{ i18n.ts._hana._trends.seeAll }}</MkA>
			</div>
		</header>
		<MkLoading v-if="fetching"/>
		<div v-else-if="failed" :class="$style.status" role="alert">
			<p>{{ i18n.ts.somethingHappened }}</p>
			<MkButton @click="fetchTrends">{{ i18n.ts.retry }}</MkButton>
		</div>
		<p v-else-if="topics.length === 0" :class="$style.status">{{ i18n.ts._hana._trends.empty }}</p>
		<div v-else class="_gaps">
			<article v-for="(item, index) in topics" :key="item.topicId" class="_panel" :class="[$style.card, { [$style.expanded]: expandedTopicId === item.topicId }]">
				<h3 :class="$style.topicHeading" :aria-labelledby="`${id}-${item.topicId}-heading`">
					<button type="button" class="_button" :class="$style.toggle" :aria-labelledby="`${id}-${item.topicId}-heading`" :aria-describedby="item.sourceTerms ? `${id}-${item.topicId}-terms ${id}-${item.topicId}-details` : `${id}-${item.topicId}-details`" :aria-expanded="expandedTopicId === item.topicId" :aria-controls="`${id}-${item.topicId}`" @click="toggleTopic(item.topicId)">
						<span :id="`${id}-${item.topicId}-heading`" :class="$style.titleRow">
							<span :class="$style.rank">{{ index + 1 }}</span>
							<span :class="$style.heading">{{ item.title || item.term }}</span>
							<HanamiTopicBadge :kind="item.kind"/>
						</span>
						<span v-if="item.sourceTerms" :id="`${id}-${item.topicId}-terms`" :class="$style.sourceTerms">{{ item.sourceTerms }}</span>
						<span :id="`${id}-${item.topicId}-details`" :class="$style.details">
							<span>{{ i18n.tsx._hana._trends.authors({ n: item.distinctAuthors }) }}</span>
							<HanamiTopicSparkline :series="item.series"/>
							<span v-if="item.startedAt">{{ i18n.tsx._hana._trends.since({ time: timeFormat.format(new Date(item.startedAt)) }) }}</span>
						</span>
					</button>
				</h3>
				<div v-show="expandedTopicId === item.topicId" :id="`${id}-${item.topicId}`" :class="$style.preview">
					<template v-if="expandedTopicId === item.topicId">
						<HanamiTopicTimeline :topicId="item.topicId" :previewLimit="3"/>
						<MkA class="_link" :class="$style.showAll" :to="`/hanami/trends?topic=${encodeURIComponent(item.topicId)}`">{{ i18n.ts._hana._explore.showAllTopicNotes }}</MkA>
					</template>
				</div>
			</article>
		</div>
	</section>
	<section v-if="!fetching && popularNotes.length" class="_gaps">
		<header :class="$style.sectionHeader">
			<h2 :class="$style.sectionTitle">{{ i18n.ts._hana._explore.popularNotes }}</h2>
			<button type="button" class="_button _textButton" @click="emit('showFeatured')">{{ i18n.ts.showMore }}</button>
		</header>
		<div class="_panel">
			<MkNote v-for="note in popularNotes" :key="note.id" :note="note"/>
		</div>
	</section>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { versatileLang } from '@@/js/intl-const.js';
import type * as Misskey from 'misskey-js';
import HanamiTopicBadge from '@/components/HanamiTopicBadge.vue';
import HanamiTopicSparkline from '@/components/HanamiTopicSparkline.vue';
import HanamiTopicTimeline from '@/components/HanamiTopicTimeline.vue';
import MkButton from '@/components/MkButton.vue';
import MkNote from '@/components/MkNote.vue';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const emit = defineEmits<{
	(ev: 'showFeatured'): void;
}>();
const id = useId();
const items = ref<Misskey.entities.NotesHanamiTrendsResponse['items']>([]);
const featuredNotes = ref<Misskey.entities.Note[]>([]);
const topics = computed(() => items.value.flatMap(item => item.topicId == null ? [] : [{
	...item,
	topicId: item.topicId,
	sourceTerms: (item.title ? [item.term, ...item.relatedTerms] : item.relatedTerms).slice(0, 4).join('・'),
}]));
const popularNotes = computed(() => {
	const representativeIds = new Set(items.value.flatMap(item => item.representativeNote ? [item.representativeNote.id] : []));
	return featuredNotes.value.filter(note => !representativeIds.has(note.id)).slice(0, 5);
});
const expandedTopicId = ref<string | null>(null);
const fetching = ref(false);
const failed = ref(false);
const timeFormat = new Intl.DateTimeFormat(versatileLang, { hour: '2-digit', minute: '2-digit', hour12: false });
let disposed = false;
onBeforeUnmount(() => { disposed = true; });

function toggleTopic(topicId: string): void {
	expandedTopicId.value = expandedTopicId.value === topicId ? null : topicId;
}

async function fetchTrends(): Promise<void> {
	if (disposed || fetching.value) return;
	fetching.value = true;
	failed.value = false;
	try {
		const result = await misskeyApiGet('notes/hanami-trends', { history: false, limit: 10 });
		if (disposed) return;
		items.value = result.items;
		expandedTopicId.value = topics.value[0]?.topicId ?? null;
	} catch {
		if (!disposed) failed.value = true;
	} finally {
		if (!disposed) fetching.value = false;
	}
}

async function fetchFeatured(): Promise<void> {
	try {
		const result = await misskeyApiGet('notes/featured', { limit: 10 });
		if (!disposed) featuredNotes.value = result;
	} catch {
		// Featured posts are optional; topic loading and retry remain independent.
	}
}

onMounted(() => {
	void fetchTrends();
	void fetchFeatured();
});
</script>

<style lang="scss" module>
.sectionHeader {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--MI-marginHalf);
}

.sectionTitle {
	margin: 0;
	font-size: 1.2em;
}

.headerActions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--MI-marginHalf);
}

.snapshot {
	color: var(--MI_THEME-fgTransparent);
}

.card {
	min-width: 0;
	border: 1px solid var(--MI_THEME-divider);

	&.expanded {
		border-color: var(--MI_THEME-accent);
	}
}

.topicHeading {
	margin: 0;
	font-size: 1em;
}

.toggle {
	display: block;
	box-sizing: border-box;
	width: 100%;
	padding: var(--MI-margin);
	text-align: left;

	&:focus-visible {
		outline: 2px solid var(--MI_THEME-accent);
		outline-offset: -2px;
	}
}

.titleRow {
	display: flex;
	align-items: center;
	gap: var(--MI-marginHalf);
}

.rank {
	flex-shrink: 0;
	color: var(--MI_THEME-fgTransparent);
}

.heading {
	flex: 1;
	min-width: 0;
	overflow-wrap: anywhere;
}

.sourceTerms {
	display: block;
	margin-top: var(--MI-marginHalf);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 0.8em;
	color: var(--MI_THEME-fgTransparent);
}

.details {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--MI-marginHalf);
	margin-top: var(--MI-marginHalf);
	font-size: 0.8em;
}

.preview {
	border-top: 1px solid var(--MI_THEME-divider);
}

.showAll {
	display: block;
	padding: var(--MI-margin);
	text-align: center;
}

.status {
	padding: var(--MI-margin);
	text-align: center;
	color: var(--MI_THEME-fgTransparent);
}
</style>
