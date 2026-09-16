<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div @keydown.esc="dismissTooltip">
	<div :class="$style.toolbar">
		<span>{{ i18n.ts._hana._affinity._cloud.period }}</span>
		<button class="_button" :aria-label="paused ? i18n.ts._hana._affinity._cloud.play : i18n.ts._hana._affinity._cloud.pause" :aria-pressed="paused" @click="toggleRotation"><i :class="paused ? 'ti ti-player-play' : 'ti ti-player-pause'"></i></button>
	</div>
	<div
		ref="stage" :class="$style.stage" :style="{ '--cloud-avatar-size': `${avatarSize}px` }"
		@pointerdown="startDrag" @pointermove="movePointer" @pointerleave="leaveStage" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag"
		@contextmenu.prevent
	>
		<svg v-if="selected && self" :class="$style.connection" viewBox="0 0 100 100" aria-hidden="true">
			<line ref="distanceLine" vector-effect="non-scaling-stroke"/>
		</svg>
		<div v-if="self" :class="$style.me"><MkAvatar :user="self" :class="$style.avatar"/><small>{{ i18n.ts._hana._affinity._cloud.you }}</small></div>
		<button
			v-for="point in layout" :key="point.item.user.id"
			:ref="element => setPeer(point.item.user.id, element)"
			class="_button" :class="[$style.peer, { [$style.selected]: selected?.user.id === point.item.user.id }]"
			:aria-label="`${point.item.user.name ?? point.item.user.username} · ${distanceLabel(point.closeness)}`"
			:data-user-id="point.item.user.id"
			@focus="showFocused($event, point.item)" @blur="dismissTooltip" @click.stop="clickPeer($event, point.item)"
		>
			<MkAvatar :user="point.item.user" :class="$style.avatar"/>
		</button>
	</div>
	<div :class="$style.footer">{{ i18n.ts._hana._affinity._cloud.footer }}</div>
</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import HanamiConnectionTooltip from './HanamiConnectionTooltip.vue';
import type * as Misskey from 'misskey-js';
import * as os from '@/os.js';
import { buildConnectionLayout, cloudCamera, connectionAvatarSize, connectionDistanceBand, projectCloudPoint } from '@/utility/hanami-connection-layout.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { userPage } from '@/filters/user.js';

type Item = Misskey.entities.UsersHanamiAffinityResponse['items'][number];
const props = defineProps<{ items: Item[]; self?: Misskey.entities.UserLite; mock?: boolean }>();
const stage = useTemplateRef('stage');
const distanceLine = useTemplateRef('distanceLine');
const paused = ref(!prefer.s.animation);
const selected = ref<Item | null>(null);
const layout = computed(() => buildConnectionLayout(props.items));
const avatarSize = computed(() => connectionAvatarSize(props.items.length));
const peers = new Map<string, HTMLElement>();
let yaw = 0.45;
let pitch = -0.35;
let stageSize = 300;
let frameId = 0;
let previousTime = 0;
let mounted = false;
let visible = false;
const MIN_SPEED = 0.18;
const DECEL = 0.95;
const INITIAL = { yaw: -1.8, pitch: -0.6 };
let tooltipTimer: number | undefined;
let touchTimer: number | undefined;
let hitTestTimer: number | undefined;
let tooltip: { showing: ReturnType<typeof ref<boolean>>; source: 'mouse' | 'touch' | 'keyboard' } | null = null;
let hoverTarget: HTMLElement | null = null;
let cursor: { x: number; y: number } | null = null;
// Camera angular velocity in rad/s, shared by mouse, touch and automatic rotation.
let velocity = { ...INITIAL };
let drag: { id: number; x: number; y: number; startX: number; startY: number; started: number; updated: number; moved: boolean; longPressed: boolean; target: HTMLElement | null } | null = null;
let motionQuery: MediaQueryList | undefined;
let visibilityObserver: IntersectionObserver | undefined;
let resizeObserver: ResizeObserver | undefined;

function setPeer(id: string, element: unknown) {
	if (element instanceof HTMLElement) peers.set(id, element);
	else peers.delete(id);
}

// No Vue updates, layout reads, score scans or avatar rendering in the frame loop.
function draw() {
	const camera = cloudCamera(yaw, pitch);
	for (const point of layout.value) {
		const element = peers.get(point.item.user.id);
		if (!element) continue;
		const projected = projectCloudPoint(point, camera);
		element.style.transform = `translate3d(${((projected.x - 50) * stageSize / 100).toFixed(2)}px, ${((projected.y - 50) * stageSize / 100).toFixed(2)}px, 0) translate(-50%, -50%) scale(${projected.scale.toFixed(3)})`;
		element.style.zIndex = String(projected.order);
		element.style.opacity = projected.opacity.toFixed(2);
		if (distanceLine.value && selected.value?.user.id === point.item.user.id) {
			const dx = projected.x - 50, dy = projected.y - 50;
			const length = Math.hypot(dx, dy);
			const start = 22 / stageSize * 100;
			const end = (avatarSize.value * projected.scale / 2 + 4) / stageSize * 100;
			// Stop at the avatar edges, keeping the line off their faces.
			distanceLine.value.style.visibility = length > start + end ? 'visible' : 'hidden';
			if (length > start + end) {
				distanceLine.value.setAttribute('x1', String(50 + dx / length * start));
				distanceLine.value.setAttribute('y1', String(50 + dy / length * start));
				distanceLine.value.setAttribute('x2', String(projected.x - dx / length * end));
				distanceLine.value.setAttribute('y2', String(projected.y - dy / length * end));
			}
		}
	}
}

function canAnimate() {
	return mounted && visible && layout.value.length > 0 && !window.document.hidden && !paused.value && !drag;
}

function decelerate(value: number, decay: number) {
	// Each axis keeps its actual value once it crosses the threshold; no speed floor.
	const reduced = Math.abs(value) > MIN_SPEED ? value * decay : value;
	return Math.abs(reduced) < 0.001 ? 0 : reduced;
}

function animate(time: number) {
	frameId = 0;
	if (!canAnimate()) return;
	const elapsed = time - previousTime;
	const seconds = Math.min(elapsed, 80) / 1000;
	const speed = tooltip ? 0.25 : 1;
	const decay = Math.pow(DECEL, elapsed / 16.7);
	velocity.yaw = decelerate(velocity.yaw, decay);
	velocity.pitch = decelerate(velocity.pitch, decay);
	yaw += velocity.yaw * seconds * speed;
	pitch += velocity.pitch * seconds * speed;
	yaw %= Math.PI * 2;
	pitch %= Math.PI * 2;
	previousTime = time;
	draw();
	// Hit testing and reactive tooltip changes run outside the rendering loop.
	if (cursor && hitTestTimer == null) hitTestTimer = window.setTimeout(checkCursor, 100);
	frameId = requestAnimationFrame(animate);
}

function syncAnimation() {
	if (!canAnimate()) {
		cancelAnimationFrame(frameId);
		frameId = 0;
	} else if (!frameId) {
		previousTime = performance.now();
		frameId = requestAnimationFrame(animate);
	}
}

function toggleRotation() {
	// An explicit Play also works when the global animation preference is off.
	paused.value = !paused.value;
}

function distanceLabel(closeness: number) {
	const text = i18n.ts._hana._affinity._cloud;
	return [text.close, text.middle, text.outer][connectionDistanceBand(closeness)];
}

function closeTooltip() {
	window.clearTimeout(tooltipTimer);
	window.clearTimeout(touchTimer);
	if (tooltip) tooltip.showing.value = false;
	tooltip = null;
	selected.value = null;
}

function dismissTooltip() {
	closeTooltip();
	// Keep the hover target until the pointer actually changes targets.
}

function showTooltip(anchorElement: HTMLElement, source: 'mouse' | 'touch' | 'keyboard') {
	const point = layout.value.find(entry => entry.item.user.id === anchorElement.dataset.userId);
	if (!point) return;
	closeTooltip();
	const showing = ref(true);
	tooltip = { showing, source };
	selected.value = point.item;
	const { dispose } = os.popup(HanamiConnectionTooltip, {
		showing, anchorElement, item: point.item, closeness: point.closeness, mock: props.mock,
	}, { closed: () => dispose() });
}

function peerAt(target: EventTarget | null) {
	const peer = target instanceof Element ? target.closest<HTMLElement>('[data-user-id]') : null;
	return peer && stage.value?.contains(peer) ? peer : null;
}

function updateHover(target: HTMLElement | null) {
	if (tooltip?.source === 'keyboard' || target === hoverTarget) return;
	closeTooltip();
	hoverTarget = target;
	if (target) tooltipTimer = window.setTimeout(() => showTooltip(target, 'mouse'), 300);
}

function checkCursor() {
	hitTestTimer = undefined;
	if (cursor && !drag) updateHover(peerAt(window.document.elementFromPoint(cursor.x, cursor.y)));
}

function leaveStage() {
	cursor = null;
	updateHover(null);
}

function showFocused(event: FocusEvent, item: Item) {
	const element = peers.get(item.user.id);
	if (event.target === element && element.matches(':focus-visible')) showTooltip(element, 'keyboard');
}

function openProfile(item: Item) {
	if (!props.mock) os.pageWindow(userPage(item.user));
}

function clickPeer(event: MouseEvent, item: Item) {
	// Pointer clicks are handled on release; native keyboard/AT activation has detail 0.
	if (event.detail === 0 && !drag) openProfile(item);
}

function startDrag(event: PointerEvent) {
	if (!event.isPrimary || event.button !== 0 || drag) return;
	window.clearTimeout(tooltipTimer);
	window.clearTimeout(hitTestTimer);
	hitTestTimer = undefined;
	if (event.pointerType !== 'mouse') {
		closeTooltip();
		hoverTarget = null;
		cursor = null;
	}
	const now = performance.now();
	drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, started: now, updated: now, moved: false, longPressed: false, target: peerAt(event.target) };
	syncAnimation();
	if (event.pointerType !== 'mouse' && drag.target) touchTimer = window.setTimeout(() => {
		if (!drag || drag.moved || !drag.target) return;
		drag.longPressed = true;
		showTooltip(drag.target, 'touch');
	}, 450);
}

function movePointer(event: PointerEvent) {
	if (event.pointerType === 'mouse') {
		cursor = { x: event.clientX, y: event.clientY };
		if (!drag) {
			updateHover(peerAt(event.target));
			return;
		}
	}
	if (drag?.id !== event.pointerId) return;
	if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) {
		drag.moved = true;
		closeTooltip();
		hoverTarget = null;
		stage.value?.setAttribute('data-dragging', 'true');
		stage.value?.setPointerCapture(event.pointerId);
	}
	if (drag.moved) {
		const now = performance.now();
		const dx = (event.clientX - drag.x) * 0.016;
		const dy = (event.clientY - drag.y) * 0.016;
		yaw = (yaw + dx) % (Math.PI * 2);
		pitch = (pitch + dy) % (Math.PI * 2);
		const duration = Math.max(1, now - drag.updated);
		velocity = { yaw: dx * 1000 / duration, pitch: dy * 1000 / duration };
		drag.x = event.clientX;
		drag.y = event.clientY;
		drag.updated = now;
		draw();
	}
}

function endDrag(event: PointerEvent) {
	if (drag?.id !== event.pointerId) return;
	const gesture = drag;
	drag = null;
	stage.value?.removeAttribute('data-dragging');
	closeTooltip();
	if (gesture.moved && (event.type !== 'pointerup' || performance.now() - gesture.updated >= 100)) velocity = { yaw: 0, pitch: 0 };
	if (event.type === 'pointerup' && !gesture.moved && !gesture.longPressed && performance.now() - gesture.started < 300) {
		const item = props.items.find(entry => entry.user.id === gesture.target?.dataset.userId);
		if (item) openProfile(item);
	}
	if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId);
	syncAnimation();
}

function motionChanged() { paused.value = Boolean(motionQuery?.matches) || !prefer.s.animation; }

function cancelGesture() {
	const pointerId = drag?.id;
	if (drag?.moved) velocity = { yaw: 0, pitch: 0 };
	drag = null;
	stage.value?.removeAttribute('data-dragging');
	if (pointerId != null && stage.value?.hasPointerCapture(pointerId)) stage.value.releasePointerCapture(pointerId);
	cursor = null;
	hoverTarget = null;
	window.clearTimeout(hitTestTimer);
	hitTestTimer = undefined;
	closeTooltip();
	syncAnimation();
}

function visibilityChanged() {
	if (window.document.hidden) cancelGesture();
	syncAnimation();
}

watch(paused, syncAnimation, { flush: 'sync' });
watch(() => prefer.s.animation, motionChanged);
watch(selected, () => { if (mounted && visible) draw(); }, { flush: 'post' });
watch(layout, async () => {
	cancelGesture();
	await nextTick();
	if (mounted && visible) draw();
});
onMounted(() => {
	mounted = true;
	motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	paused.value ||= motionQuery.matches;
	motionQuery.addEventListener('change', motionChanged);
	window.addEventListener('pointerup', endDrag);
	window.addEventListener('pointercancel', endDrag);
	window.addEventListener('blur', cancelGesture);
	window.document.addEventListener('visibilitychange', visibilityChanged);
	resizeObserver = new ResizeObserver(entries => {
		stageSize = entries[0].contentRect.width;
		if (visible) draw();
	});
	visibilityObserver = new IntersectionObserver(entries => {
		visible = entries[0].isIntersecting;
		if (visible) draw();
		else cancelGesture();
		syncAnimation();
	});
	if (stage.value) {
		resizeObserver.observe(stage.value);
		visibilityObserver.observe(stage.value);
	}
});
onBeforeUnmount(() => {
	mounted = false;
	cancelAnimationFrame(frameId);
	cancelGesture();
	motionQuery?.removeEventListener('change', motionChanged);
	visibilityObserver?.disconnect();
	resizeObserver?.disconnect();
	window.removeEventListener('pointerup', endDrag);
	window.removeEventListener('pointercancel', endDrag);
	window.removeEventListener('blur', cancelGesture);
	window.document.removeEventListener('visibilitychange', visibilityChanged);
});
</script>

<style lang="scss" module>
.toolbar { display: flex; justify-content: space-between; padding: 10px 14px 0; font-size: 0.75em; color: var(--MI_THEME-fgTransparentWeak); > button { padding: 2px 6px; } }
.stage { position: relative; width: 100%; aspect-ratio: 1; max-width: 360px; margin: auto; isolation: isolate; contain: layout paint; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: grab; &[data-dragging] { cursor: grabbing; .peer { cursor: grabbing; } } }
.connection { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 100; pointer-events: none; stroke: var(--MI_THEME-accent); stroke-width: 1.25; opacity: 0.5; }
.me { position: absolute; left: 50%; top: 50%; width: 32px; height: 32px; transform: translate(-50%, -50%); z-index: 100; pointer-events: none; border-radius: 50%; box-shadow: 0 0 0 4px var(--MI_THEME-panel), 0 0 0 5px var(--MI_THEME-accent); > small { position: absolute; top: 39px; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 0.65em; color: var(--MI_THEME-accent); } }
.avatar { width: 100%; height: 100%; pointer-events: none; }
.peer { position: absolute; left: 50%; top: 50%; width: var(--cloud-avatar-size); height: var(--cloud-avatar-size); border-radius: 50%; cursor: pointer; will-change: transform; box-shadow: 0 0 0 2px var(--MI_THEME-panel); &:focus-visible { outline: 2px solid var(--MI_THEME-accent); outline-offset: 3px; } }
.selected { outline: 2px solid var(--MI_THEME-accent); outline-offset: 3px; opacity: 1 !important; z-index: 101 !important; }
.footer { padding: 6px 12px 10px; font-size: 0.7em; line-height: 1.6; text-align: center; color: var(--MI_THEME-fgTransparentWeak); }
</style>
