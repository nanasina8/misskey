<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div>
	<Transition
		:enterActiveClass="prefer.s.animation ? $style.transition_toast_enterActive : ''"
		:leaveActiveClass="prefer.s.animation ? $style.transition_toast_leaveActive : ''"
		:enterFromClass="prefer.s.animation ? $style.transition_toast_enterFrom : ''"
		:leaveToClass="prefer.s.animation ? $style.transition_toast_leaveTo : ''"
		appear @afterLeave="emit('closed')"
	>
		<div v-if="showing" class="_acrylic" :class="$style.root" :style="{ zIndex }">
			<div style="padding: 16px 24px;">
				{{ message }}
				<button v-if="actionLabel" type="button" class="_textButton" :class="$style.action" @click="act">{{ actionLabel }}</button>
			</div>
		</div>
	</Transition>
</div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue';
import * as os from '@/os.js';
import { prefer } from '@/preferences.js';

const props = withDefaults(defineProps<{
	message: string;
	actionLabel?: string;
	duration?: number;
}>(), { duration: 4000 });

const emit = defineEmits<{
	(ev: 'closed'): void;
	(ev: 'action'): void;
}>();

const zIndex = os.claimZIndex('high');
const showing = ref(true);

let timer: number;

function act(): void {
	if (!showing.value) return;
	showing.value = false;
	emit('action');
}

onUnmounted(() => window.clearTimeout(timer));
onMounted(() => {
	timer = window.setTimeout(() => {
		showing.value = false;
	}, props.duration);
});
</script>

<style lang="scss" module>
.action { pointer-events: auto; padding: 8px; }
.transition_toast_enterActive,
.transition_toast_leaveActive {
	transition: opacity 0.3s, transform 0.3s !important;
}
.transition_toast_enterFrom,
.transition_toast_leaveTo {
	opacity: 0;
	transform: translateY(-100%);
}

.root {
	position: fixed;
	left: 0;
	right: 0;
	top: 50px;
	margin: 0 auto;
	margin-top: 16px;
	min-width: 300px;
	max-width: calc(100% - 32px);
	width: min-content;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	border-radius: 8px;
	overflow: clip;
	text-align: center;
	pointer-events: none;
}
</style>
