<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModal ref="modal" v-slot="{ type, maxHeight }" :anchorElement="anchorElement" :returnFocusTo="anchorElement" @click="modal?.close()" @esc="modal?.close()" @closed="emit('closed')">
	<div class="_popup" :class="[$style.body, { [$style.drawer]: type === 'drawer' }]" :style="{ maxHeight: maxHeight ? `${maxHeight}px` : '85dvh' }">
		<MkHanamiTuningQuick @close="modal?.close()"/>
	</div>
</MkModal>
</template>

<script lang="ts" setup>
import { useTemplateRef } from 'vue';
import MkModal from '@/components/MkModal.vue';
import MkHanamiTuningQuick from '@/components/MkHanamiTuningQuick.vue';

defineProps<{ anchorElement?: HTMLElement | null }>();
const emit = defineEmits<{ (ev: 'closed'): void }>();
const modal = useTemplateRef('modal');
</script>

<style lang="scss" module>
.body { box-sizing: border-box; width: 380px; max-width: calc(100vw - 24px); padding: 16px; overflow-y: auto; }
.drawer { width: 100vw; max-width: 100vw; border-radius: var(--MI-radius) var(--MI-radius) 0 0; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
</style>
