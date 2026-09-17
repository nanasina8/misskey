<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :tabs="[]">
	<div class="_spacer" style="--MI_SPACER-w: 800px;">
		<div class="_gaps">
			<MkInfo>{{ text.sample }}</MkInfo>
			<div :class="$style.layout">
				<div :class="$style.preview" :style="{ width: `${width}px` }">
					<MkContainer>
						<template #icon><i class="ti ti-users"></i></template>
						<template #header>{{ text.nameCloud }}</template>
						<HanamiConnectionCloud :items="items" :self="previewUsers[0]" :distanceColors="distanceColors" mock/>
					</MkContainer>
				</div>
				<div class="_gaps" :class="$style.options">
					<MkInput v-model="countInput" type="number" :min="CONNECTION_COUNT_MIN" :max="CONNECTION_COUNT_MAX" :step="1" @focusout="countInput = normalizeConnectionCount(countInput)">
						<template #label>{{ text.count }}</template>
						<template #caption>{{ CONNECTION_COUNT_MIN }}–{{ CONNECTION_COUNT_MAX }}</template>
					</MkInput>
					<MkSelect v-model="width" :items="[{ value: 300, label: '300px' }, { value: 360, label: '360px' }]">
						<template #label>{{ text.width }}</template>
					</MkSelect>
					<MkSwitch v-model="distanceColors">{{ i18n.ts._hana._affinity._cloud.distanceColors }}</MkSwitch>
				</div>
			</div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import { selectPreviewItems, previewUsers } from './hanami-connections-preview.data.js';
import HanamiConnectionCloud from '@/components/HanamiConnectionCloud.vue';
import MkContainer from '@/components/MkContainer.vue';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkInfo from '@/components/MkInfo.vue';
import { CONNECTION_COUNT_DEFAULT, CONNECTION_COUNT_MIN, CONNECTION_COUNT_MAX, normalizeConnectionCount } from '@/utility/hanami-connection-layout.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';

const text = i18n.ts._hana._affinity._cloud;
const countInput = ref(CONNECTION_COUNT_DEFAULT);
const count = computed(() => normalizeConnectionCount(countInput.value));
const width = ref<300 | 360>(300);
const distanceColors = ref(false);
const items = computed(() => selectPreviewItems(count.value));
definePage(() => ({ title: text.preview, icon: 'ti ti-users' }));
</script>

<style lang="scss" module>
.layout { display: flex; align-items: flex-start; justify-content: center; flex-wrap: wrap; gap: 24px; }
.preview { max-width: 100%; flex-shrink: 0; }
.options { flex: 1; min-width: min(240px, 100%); max-width: 360px; }
</style>
