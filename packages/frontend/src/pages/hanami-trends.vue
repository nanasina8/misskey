<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :tabs="[]">
	<div class="_spacer" :class="[$style.page, { [$style.pageWide]: wide }]">
		<div ref="body" class="_panel" :class="[$style.panel, { [$style.split]: wide }]">
			<div v-if="wide && chips.length" ref="topicList" :class="$style.topicList" role="group" :aria-label="i18n.ts._hana._trends.title">
				<button v-for="(item, index) in chips" :key="item.topicId" class="_button" :class="[$style.topicRow, { [$style.selectedRow]: selected?.topicId === item.topicId }]" :aria-pressed="selected?.topicId === item.topicId" @click="chooseChip(item)">
					<span :class="$style.rank">{{ index + 1 }}</span>
					<span :class="$style.rowHeading">{{ item.term }}{{ item.relatedTerms.length ? '（' + item.relatedTerms.slice(0, 2).join('・') + '）' : '' }}</span>
					<HanamiTopicBadge :kind="item.kind"/>
					<span :class="$style.rowAuthors">{{ item.past ? i18n.tsx._hana._trends.peakAuthorsLong({ n: item.authors }) : i18n.tsx._hana._trends.authors({ n: item.authors }) }}</span>
				</button>
			</div>
			<div v-if="!wide && chips.length" ref="chipStrip" :class="$style.chips" role="group" :aria-label="i18n.ts._hana._trends.title">
				<button v-for="item in chips" :key="item.topicId" class="_button" :class="[$style.chip, { [$style.selected]: selected?.topicId === item.topicId }]" :aria-pressed="selected?.topicId === item.topicId" @click="chooseChip(item)">
					<span :class="[$style.dot, $style[item.kind]]" aria-hidden="true"></span>{{ item.term }}
				</button>
			</div>
			<div :class="$style.detailPane">
				<MkLoading v-if="fetching || selecting"/>
				<div v-else-if="failed || selectionFailed" :class="$style.status" role="alert"><p>{{ i18n.ts.somethingHappened }}</p><MkButton @click="failed ? fetchTrends() : selectTopic()">{{ i18n.ts.retry }}</MkButton></div>
				<template v-else-if="selected">
					<section :class="$style.summary">
						<h1>{{ heading }}</h1>
						<div :class="$style.details">
							<HanamiTopicBadge :kind="selected.kind"/>
							<span v-if="selected.startedAt">{{ i18n.tsx._hana._trends.ongoingSince({ time: timeFormat.format(new Date(selected.startedAt)) }) }}</span>
							<span>{{ selected.past ? i18n.tsx._hana._trends.peakAuthorsLong({ n: selected.authors }) : i18n.tsx._hana._trends.authors({ n: selected.authors }) }}</span>
						</div>
						<HanamiTopicSparkline :series="selected.series" large :height="40"/>
					</section>
					<HanamiTopicTimeline :topicId="selected.topicId"/>
				</template>
				<p v-else :class="$style.status">{{ i18n.ts._hana._trends.empty }}</p>
			</div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { versatileLang } from '@@/js/intl-const.js';
import type * as Misskey from 'misskey-js';
import HanamiTopicTimeline from '@/components/HanamiTopicTimeline.vue';
import HanamiTopicSparkline from '@/components/HanamiTopicSparkline.vue';
import HanamiTopicBadge from '@/components/HanamiTopicBadge.vue';
import MkButton from '@/components/MkButton.vue';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { useRouter } from '@/router.js';
import { toast } from '@/os.js';
import { i18n } from '@/i18n.js';

type TopicSummary = Pick<Misskey.entities.NotesHanamiTopicResponse, 'topicId' | 'term' | 'relatedTerms' | 'startedAt' | 'series' | 'kind'> & { authors: number; past: boolean };
const props = defineProps<{ initialTopic?: string }>();
const router = useRouter();
const items = ref<TopicSummary[]>([]);
const temporary = shallowRef<TopicSummary | null>(null);
const selected = shallowRef<TopicSummary | null>(null);
const body = ref<HTMLElement | null>(null);
const wide = ref(false);
const topicList = ref<HTMLElement | null>(null);
const chipStrip = ref<HTMLElement | null>(null);
const chips = computed(() => temporary.value == null || items.value.some(item => item.topicId === temporary.value?.topicId) ? items.value : [temporary.value, ...items.value]);
const heading = computed(() => selected.value == null ? '' : selected.value.term + (selected.value.relatedTerms.length ? '（' + selected.value.relatedTerms.join('・') + '）' : ''));
const timeFormat = new Intl.DateTimeFormat(versatileLang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fetching = ref(false);
const failed = ref(false);
const selecting = ref(false);
const selectionFailed = ref(false);
const loaded = ref(false);
const notifiedMissing = new Set<string>();
let requestVersion = 0;
let selectionVersion = 0;
let disposed = false;
let resizeObserver: ResizeObserver | undefined;
onBeforeUnmount(() => { disposed = true; requestVersion++; selectionVersion++; resizeObserver?.disconnect(); });

function updateQuery(topicId: string | null): void {
	router.replace('/hanami/trends', { query: topicId == null ? {} : { topic: topicId } });
}

async function chooseChip(item: TopicSummary): Promise<void> {
	const left = chipStrip.value?.scrollLeft ?? 0;
	const top = topicList.value?.scrollTop ?? 0;
	selectionVersion++;
	selected.value = item;
	selecting.value = false;
	selectionFailed.value = false;
	updateQuery(item.topicId);
	await nextTick();
	if (!disposed && chipStrip.value) chipStrip.value.scrollLeft = left;
	if (!disposed && topicList.value) topicList.value.scrollTop = top;
}

async function selectTopic(): Promise<void> {
	if (disposed || !loaded.value) return;
	const version = ++selectionVersion;
	selectionFailed.value = false;
	const id = props.initialTopic;
	const current = id ? chips.value.find(item => item.topicId === id) : items.value[0];
	if (current != null || !id) {
		selected.value = current ?? null;
		selecting.value = false;
		return;
	}
	selected.value = null;
	selecting.value = true;
	try {
		const result = await misskeyApiGet('notes/hanami-topic', { topicId: id });
		if (version !== selectionVersion) return;
		temporary.value = { ...result, authors: result.peakAuthors, past: true };
		selected.value = temporary.value;
	} catch (error) {
		if (version !== selectionVersion) return;
		if ((error as { code?: string }).code === 'NO_SUCH_TOPIC') {
			selected.value = items.value[0] ?? null;
			if (!notifiedMissing.has(id)) { notifiedMissing.add(id); toast(i18n.ts._hana._trends.topicNotFound); }
			updateQuery(selected.value?.topicId ?? null);
		} else selectionFailed.value = true;
	} finally {
		if (version === selectionVersion) selecting.value = false;
	}
}

async function fetchTrends(): Promise<void> {
	if (disposed || fetching.value) return;
	const version = ++requestVersion;
	fetching.value = true;
	failed.value = false;
	try {
		const result = await misskeyApiGet('notes/hanami-trends', { limit: 30 });
		if (version !== requestVersion) return;
		items.value = result.items.flatMap(item => item.topicId == null ? [] : [{ ...item, topicId: item.topicId, authors: item.distinctAuthors, past: false }]);
		loaded.value = true;
		fetching.value = false;
		await selectTopic();
	} catch {
		if (version === requestVersion) failed.value = true;
	} finally {
		if (version === requestVersion) fetching.value = false;
	}
}

watch(() => props.initialTopic, () => { void selectTopic(); });
onMounted(() => {
	if (body.value) {
		wide.value = body.value.getBoundingClientRect().width >= 760;
		resizeObserver = new ResizeObserver(entries => {
			if (!disposed && entries[0]) wide.value = entries[0].contentRect.width >= 760;
		});
		resizeObserver.observe(body.value);
	}
	void fetchTrends();
});
definePage(() => ({ title: i18n.ts._hana._trends.title, icon: 'ti ti-trending-up' }));
</script>

<style lang="scss" module>
.page { min-width: 0; max-width: 100%; }
.pageWide { padding-top: 0; padding-bottom: 0; }
.panel { min-width: 0; overflow: clip; }
.split { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: calc(100cqh - (var(--MI-stickyTop, 0px) + var(--MI-stickyBottom, 0px))); }
.topicList { min-height: 0; overflow-y: auto; border-right: 1px solid var(--MI_THEME-divider); }
.topicRow { display: flex; align-items: center; gap: 6px; width: 100%; padding: 12px 8px; border-left: 3px solid transparent; text-align: left; &:focus-visible { outline: 2px solid var(--MI_THEME-accent); outline-offset: -2px; } }
.selectedRow { background: var(--MI_THEME-accentedBg); border-left-color: var(--MI_THEME-accent); }
.rank { width: 1.5em; flex-shrink: 0; color: var(--MI_THEME-fgTransparent); font-size: 0.8em; }
.rowHeading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85em; }
.rowAuthors { flex-shrink: 0; white-space: nowrap; font-size: 0.8em; color: var(--MI_THEME-fgTransparent); }
.topicRow > :not(.rowHeading) { flex-shrink: 0; }
.detailPane { min-width: 0; min-height: 0; }
.split > .detailPane { grid-column: 2; grid-row: 1; overflow-y: auto; }
.split > .detailPane:only-child { grid-column: 1 / -1; }
.chips { display: flex; gap: 6px; max-width: 100%; overflow-x: auto; padding: 10px 12px; border-bottom: 1px solid var(--MI_THEME-divider); }
.chip { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: var(--MI_THEME-buttonBg); font-size: 0.8em; font-weight: 500; white-space: nowrap; &:focus-visible { outline: 2px solid var(--MI_THEME-accent); outline-offset: -2px; } }
.selected { background: var(--MI_THEME-accent); color: var(--MI_THEME-fgOnAccent); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.new { background: var(--MI_THEME-accent); }
.rising { background: var(--MI_THEME-warn); }
.steady { background: var(--MI_THEME-fgTransparent); }
.summary { min-width: 0; padding: 16px; h1 { margin: 0 0 8px; font-size: 1.2em; overflow-wrap: anywhere; } }
.details { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--MI_THEME-fgTransparent); font-size: 0.8em; }
.status { padding: 16px; text-align: center; color: var(--MI_THEME-fgTransparent); }
</style>
