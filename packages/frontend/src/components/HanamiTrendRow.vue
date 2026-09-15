<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.row">
	<div :class="$style.head">
		<MkA :class="$style.term" :to="`/search?q=${encodeURIComponent(item.term)}`" :title="item.term">{{ item.term }}</MkA>
		<span :class="$style.authors">{{ i18n.tsx._hana._trends.authors({ n: item.distinctAuthors }) }}</span>
		<span :class="$style.rank">{{ rank }}</span>
	</div>
	<MkA v-if="item.representativeNote" :class="$style.note" :to="`/notes/${item.representativeNote.id}`">
		<MkAvatar :class="$style.avatar" :user="item.representativeNote.user"/>
		<MkUserName :class="$style.user" :user="item.representativeNote.user"/>
		<span :class="$style.text"><Mfm :text="summary" :plain="true" :nowrap="true"/></span>
		<MkTime :class="$style.time" :time="item.representativeNote.createdAt"/>
	</MkA>
	<div v-else :class="$style.noNote">{{ i18n.ts._hana._trends.noRepresentativeNote }}</div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';

const props = defineProps<{
	item: Misskey.entities.NotesHanamiTrendsResponse['items'][number];
	rank: number;
}>();

// 代表ノートは1行だけ。改行と連続空白を潰し、長文は切る（CW があれば CW を見せる）
const summary = computed(() => {
	const note = props.item.representativeNote;
	if (note == null) return '';
	const text = (note.cw ?? note.text ?? '').replace(/\s+/g, ' ').trim();
	return text.length > 120 ? text.slice(0, 120) + '…' : text;
});
</script>

<style lang="scss" module>
.row {
	padding: 10px 14px;
	border-bottom: solid 0.5px var(--MI_THEME-divider);

	&:last-child {
		border-bottom: none;
	}
}

.head {
	display: flex;
	align-items: baseline;
	gap: 6px;
	min-width: 0;
}

.term {
	font-weight: bold;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.authors {
	flex: 1;
	min-width: 0;
	font-size: 0.75em;
	opacity: 0.7;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.rank {
	flex-shrink: 0;
	font-size: 0.75em;
	opacity: 0.6;
	font-variant-numeric: tabular-nums;
}

.note, .noNote {
	display: flex;
	align-items: center;
	gap: 6px;
	height: 24px;
	margin-top: 2px;
	font-size: 0.85em;
	min-width: 0;
}

.note {
	text-decoration: none;
	color: inherit;
}

.noNote {
	font-size: 0.75em;
	opacity: 0.55;
}

.avatar {
	width: 20px;
	height: 20px;
	flex-shrink: 0;
}

.user {
	flex-shrink: 0;
	max-width: 30%;
	font-weight: bold;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.text {
	flex: 1;
	min-width: 0;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	opacity: 0.85;

	> * {
		display: inline;
		white-space: nowrap;
	}
}

.time {
	flex-shrink: 0;
	font-size: 0.85em;
	opacity: 0.6;
}
</style>
