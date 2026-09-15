<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div @keydown.esc="clearSelection">
	<div :class="$style.toolbar">
		<span>{{ i18n.ts._hana._affinity._cloud.period }}</span>
		<button class="_button" :aria-label="paused ? i18n.ts._hana._affinity._cloud.play : i18n.ts._hana._affinity._cloud.pause" :aria-pressed="paused" @click="toggleRotation"><i :class="paused ? 'ti ti-player-play' : 'ti ti-player-pause'"></i></button>
	</div>
	<div
		ref="stage" :class="$style.stage" :style="{ '--cloud-avatar-size': `${avatarSize}px` }"
		@pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag"
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
			@pointermove="hover($event, point.item)" @pointerleave="leave"
			@focus="focusPeer($event, point.item)" @blur="leave" @click.stop="pin(point.item)"
		>
			<MkAvatar :user="point.item.user" :class="$style.avatar"/>
		</button>
	</div>
	<div :class="$style.hint">{{ i18n.ts._hana._affinity._cloud.help }}</div>
	<div :class="$style.detailSlot">
		<div v-if="selected" :class="$style.detail" data-testid="connection-detail" @pointerenter="cancelLeave" @pointerleave="leave" @focusin="cancelLeave" @focusout="leave">
			<div :class="$style.person">
				<MkAvatar :user="selected.user" :class="$style.detailAvatar"/>
				<div :class="$style.identity"><MkUserName :user="selected.user"/><div :class="$style.acct"><MkAcct :user="selected.user"/></div></div>
				<button class="_button" :aria-label="i18n.ts.close" @click="clearSelection"><i class="ti ti-x"></i></button>
			</div>
			<div :class="$style.distance"><i class="ti ti-ruler-measure"></i> {{ distanceLabel(selectedCloseness) }}</div>
			<div :class="$style.track" role="img" :aria-label="distanceLabel(selectedCloseness)"><span :style="{ left: `${(1 - selectedCloseness) * 90 + 5}%` }"></span></div>
			<div :class="$style.scale"><span>{{ i18n.ts._hana._affinity._cloud.near }}</span><span>{{ i18n.ts._hana._affinity._cloud.far }}</span></div>
			<p v-if="selected.counts" :class="$style.counts">{{ countsText(selected) }}</p>
			<div :class="$style.meta"><span>{{ selected.mutualInteraction ? i18n.ts._hana._affinity._cloud.both : i18n.ts._hana._affinity._cloud.oneWay }}</span><span v-if="selected.lastInteractionAt"><MkTime :time="selected.lastInteractionAt"/></span></div>
			<div :class="$style.detailFooter">
				<span>{{ pinned ? i18n.ts._hana._affinity._cloud.pinned : i18n.ts._hana._affinity._cloud.pinHint }}</span>
				<MkA v-if="!mock" :to="userPage(selected.user)">{{ i18n.ts.profile }} <i class="ti ti-chevron-right"></i></MkA>
			</div>
		</div>
	</div>
	<div :class="$style.footer">{{ i18n.ts._hana._affinity._cloud.footer }}</div>
</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import type * as Misskey from 'misskey-js';
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
const pinned = ref(false);
const reading = ref(false);
const layout = computed(() => buildConnectionLayout(props.items));
const selectedCloseness = computed(() => layout.value.find(point => point.item.user.id === selected.value?.user.id)?.closeness ?? 0.5);
const avatarSize = computed(() => connectionAvatarSize(props.items.length));
const peers = new Map<string, HTMLElement>();
let yaw = 0.45;
let pitch = -0.35;
let stageSize = 300;
let frameId = 0;
let previousTime = 0;
let mounted = false;
let visible = false;
let holdTimer: number | undefined;
let leaveTimer: number | undefined;
let suppressClickUntil = 0;
let drag: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
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
	return mounted && visible && layout.value.length > 0 && !window.document.hidden && !paused.value && !reading.value && !drag;
}

function animate(time: number) {
	frameId = 0;
	if (!canAnimate()) return;
	// 30 fps cap, time-based angular velocity (one revolution in about 28 s).
	const elapsed = time - previousTime;
	if (elapsed >= 1000 / 30 - 1) {
		yaw = (yaw + Math.min(elapsed, 80) / 1000 * 0.22) % (Math.PI * 2);
		previousTime = time;
		draw();
	}
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
	reading.value = false;
}

function distanceLabel(closeness: number) {
	const text = i18n.ts._hana._affinity._cloud;
	return [text.close, text.middle, text.outer][connectionDistanceBand(closeness)];
}

function countsText(item: Item) {
	const c = item.counts;
	if (!c) return '';
	return i18n.tsx._hana._affinity.counts({ reply: c.reply.out + c.reply.in, mention: c.mention.out + c.mention.in, renote: c.renote.out + c.renote.in, reaction: c.reaction.out + c.reaction.in });
}

function select(item: Item) {
	window.clearTimeout(leaveTimer);
	if (!pinned.value) {
		selected.value = item;
		reading.value = true;
	}
}

function hover(event: PointerEvent, item: Item) {
	// Moving avatars passing under a stationary cursor must not pause the globe.
	if (event.pointerType === 'mouse' && !drag) select(item);
}

function focusPeer(event: FocusEvent, item: Item) {
	if ((event.target as HTMLElement).matches(':focus-visible')) select(item);
}

function cancelLeave() {
	window.clearTimeout(leaveTimer);
	if (!pinned.value) reading.value = true;
}

function leave() {
	window.clearTimeout(leaveTimer);
	reading.value = false;
	leaveTimer = window.setTimeout(() => { if (!pinned.value) selected.value = null; }, 250);
}

function clearSelection() {
	window.clearTimeout(leaveTimer);
	selected.value = null;
	pinned.value = false;
	reading.value = false;
}

function pin(item: Item) {
	if (performance.now() < suppressClickUntil) return;
	window.clearTimeout(leaveTimer);
	selected.value = item;
	pinned.value = true;
	reading.value = false;
}

function startDrag(event: PointerEvent) {
	if (!event.isPrimary || event.button !== 0) return;
	window.clearTimeout(holdTimer);
	drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
	syncAnimation();
	const id = (event.target as HTMLElement).closest<HTMLElement>('[data-user-id]')?.dataset.userId;
	const item = props.items.find(entry => entry.user.id === id);
	if (item) holdTimer = window.setTimeout(() => { pin(item); suppressClickUntil = performance.now() + 500; drag = null; syncAnimation(); }, 450);
}

function moveDrag(event: PointerEvent) {
	if (drag?.id !== event.pointerId) return;
	if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 7) {
		drag.moved = true;
		window.clearTimeout(holdTimer);
		if (!pinned.value) clearSelection();
		stage.value?.setPointerCapture(event.pointerId);
	}
	if (drag.moved) {
		yaw = (yaw + (event.clientX - drag.x) * 0.008) % (Math.PI * 2);
		// Wrap rather than clamp: vertical dragging can pass both poles indefinitely.
		pitch = (pitch + (event.clientY - drag.y) * 0.008) % (Math.PI * 2);
		draw();
	}
	drag.x = event.clientX;
	drag.y = event.clientY;
}

function endDrag(event: PointerEvent) {
	window.clearTimeout(holdTimer);
	if (drag?.id === event.pointerId) {
		if (drag.moved) suppressClickUntil = performance.now() + 400;
		drag = null;
	}
	if (stage.value?.hasPointerCapture(event.pointerId)) stage.value.releasePointerCapture(event.pointerId);
	syncAnimation();
}

function motionChanged() { paused.value = Boolean(motionQuery?.matches) || !prefer.s.animation; }

function cancelGesture() {
	window.clearTimeout(holdTimer);
	drag = null;
	reading.value = false;
	syncAnimation();
}

function visibilityChanged() {
	if (window.document.hidden) cancelGesture();
	syncAnimation();
}

watch([paused, reading], syncAnimation, { flush: 'sync' });
watch(() => prefer.s.animation, motionChanged);
watch(selected, () => { if (mounted && visible) draw(); }, { flush: 'post' });
watch(layout, async () => {
	cancelGesture();
	clearSelection();
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
	window.clearTimeout(holdTimer);
	window.clearTimeout(leaveTimer);
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
.stage { position: relative; width: 100%; aspect-ratio: 1; max-width: 360px; margin: auto; isolation: isolate; contain: layout paint; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: grab; }
.connection { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 100; pointer-events: none; stroke: var(--MI_THEME-accent); stroke-width: 1.25; opacity: 0.5; }
.me { position: absolute; left: 50%; top: 50%; width: 32px; height: 32px; transform: translate(-50%, -50%); z-index: 100; pointer-events: none; border-radius: 50%; box-shadow: 0 0 0 4px var(--MI_THEME-panel), 0 0 0 5px var(--MI_THEME-accent); > small { position: absolute; top: 39px; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 0.65em; color: var(--MI_THEME-accent); } }
.avatar { width: 100%; height: 100%; pointer-events: none; }
.peer { position: absolute; left: 50%; top: 50%; width: var(--cloud-avatar-size); height: var(--cloud-avatar-size); border-radius: 50%; will-change: transform; box-shadow: 0 0 0 2px var(--MI_THEME-panel); &:focus-visible { outline: 2px solid var(--MI_THEME-accent); outline-offset: 3px; } }
.selected { outline: 2px solid var(--MI_THEME-accent); outline-offset: 3px; opacity: 1 !important; z-index: 101 !important; }
.hint, .footer { padding: 6px 12px 10px; font-size: 0.7em; line-height: 1.6; text-align: center; color: var(--MI_THEME-fgTransparentWeak); }
.detailSlot { height: 240px; box-sizing: border-box; padding: 0 10px 8px; }
.detail { height: 100%; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); background: var(--MI_THEME-panel); }
.person { display: flex; align-items: center; gap: 8px; font-size: 0.85em; > button { margin-left: auto; padding: 6px; } }
.detailAvatar { width: 32px; height: 32px; }
.identity { min-width: 0; overflow: hidden; }
.acct { font-size: 0.8em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; }
.distance { margin: 12px 0; color: var(--MI_THEME-accent); font-size: 0.8em; font-weight: bold; }
.track { height: 4px; position: relative; background: linear-gradient(90deg, var(--MI_THEME-accent), var(--MI_THEME-divider)); border-radius: 4px; > span { position: absolute; top: -3px; width: 10px; height: 10px; transform: translateX(-50%); background: var(--MI_THEME-accent); border-radius: 50%; box-shadow: 0 0 0 2px var(--MI_THEME-panel); } }
.scale { display: flex; justify-content: space-between; margin-top: 7px; font-size: 0.65em; opacity: 0.6; }
.counts { font-size: 0.75em; line-height: 1.8; }
.meta, .detailFooter { display: flex; justify-content: space-between; gap: 8px; font-size: 0.65em; line-height: 1.6; }
.detailFooter { border-top: 1px solid var(--MI_THEME-divider); padding-top: 8px; margin-top: 8px; color: var(--MI_THEME-fgTransparentWeak); }
</style>
