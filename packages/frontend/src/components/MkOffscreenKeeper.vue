<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" data-focus-container :style="{ height, boxSizing: height ? 'border-box' : undefined }">
	<KeepAlive>
		<XSlotHost v-if="active"/>
	</KeepAlive>
</div>
</template>

<script lang="ts" setup>
import { defineComponent, KeepAlive, nextTick, onMounted, onUnmounted, ref, useSlots, useTemplateRef, watch } from 'vue';
import { OFFSCREEN_KEEPER_ENABLED, register, unregister } from '@/utility/offscreen-observer.js';

const props = defineProps<{
	disabled?: boolean;
}>();

const slots = useSlots();
const XSlotHost = defineComponent({
	setup: () => () => slots.default?.(),
});
const rootEl = useTemplateRef('rootEl');
const active = ref(true);
const height = ref<string>();

async function activate(): Promise<void> {
	active.value = true;
	await nextTick();
	if (active.value) height.value = undefined;
}

watch(() => props.disabled, disabled => {
	if (disabled) void activate();
});

let observedEl: HTMLElement | null = null;
onMounted(() => {
	if (!OFFSCREEN_KEEPER_ENABLED || !rootEl.value) return;
	observedEl = rootEl.value;
	register(observedEl, entry => {
		if (entry.isIntersecting || props.disabled) {
			void activate();
		} else if (active.value && entry.boundingClientRect.height > 0 && !observedEl?.contains(window.document.activeElement)) {
			height.value = `${entry.boundingClientRect.height}px`;
			active.value = false;
		}
	});
});

onUnmounted(() => {
	if (observedEl) unregister(observedEl);
});
</script>
