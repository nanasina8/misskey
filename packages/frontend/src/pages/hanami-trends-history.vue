<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :tabs="[]">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<div class="_gaps">
			<section v-for="group in groups" :key="group.snapshotId" class="_panel" :class="$style.group">
				<h2 :class="$style.groupHead">{{ i18n.tsx._hana._trends.group({ time: snapshotFormat.format(new Date(group.generatedAt)), n: group.items.length }) }}</h2>
				<HanamiTrendRow v-for="(item, index) in group.items" :key="item.trendEntryId" :item="item" :rank="index + 1"/>
			</section>
			<MkLoading v-if="fetching"/>
			<div v-else-if="failed" role="alert" :class="$style.center">
				<p>{{ i18n.ts.somethingHappened }}</p>
				<MkButton @click="fetchHistory">{{ i18n.ts.retry }}</MkButton>
			</div>
			<p v-else-if="items.length === 0" :class="$style.center">{{ i18n.ts._hana._trends.empty }}</p>
			<div v-else-if="hasMore" :class="$style.center"><MkButton rounded @click="fetchHistory">{{ i18n.ts._hana._trends.older }}</MkButton></div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { versatileLang } from '@@/js/intl-const.js';
import type * as Misskey from 'misskey-js';
import HanamiTrendRow from '@/components/HanamiTrendRow.vue';
import MkButton from '@/components/MkButton.vue';
import { misskeyApiGet } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

type TrendItem = Misskey.entities.NotesHanamiTrendsResponse['items'][number];
const items = ref<TrendItem[]>([]);
const cursor = ref<string | null>(null);
const hasMore = ref(false);
const fetching = ref(false);
const failed = ref(false);
const snapshotFormat = new Intl.DateTimeFormat(versatileLang, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const groups = computed(() => {
	const result: { snapshotId: string; generatedAt: string; items: TrendItem[] }[] = [];
	for (const item of items.value) {
		let group = result.at(-1);
		if (group?.snapshotId !== item.snapshotId) {
			group = { snapshotId: item.snapshotId, generatedAt: item.snapshotGeneratedAt, items: [] };
			result.push(group);
		}
		group.items.push(item);
	}
	return result;
});

async function fetchHistory() {
	if (fetching.value) return;
	fetching.value = true;
	failed.value = false;
	try {
		let res: Misskey.entities.NotesHanamiTrendsResponse;
		try {
			res = await misskeyApiGet('notes/hanami-trends', { history: true, limit: 30, ...(cursor.value ? { cursor: cursor.value } : {}) });
		} catch (err) {
			const code = (err as { code?: string } | null)?.code;
			if (!cursor.value || (code !== 'CURSOR_EXPIRED' && code !== 'INVALID_CURSOR')) throw err;
			cursor.value = null;
			items.value = [];
			hasMore.value = false;
			res = await misskeyApiGet('notes/hanami-trends', { history: true, limit: 30 });
		}
		items.value.push(...res.items);
		cursor.value = res.nextCursor;
		hasMore.value = res.hasMore;
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

.center {
	text-align: center;
	opacity: 0.8;
}
</style>
