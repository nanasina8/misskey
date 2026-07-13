<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div v-if="tickerState.normal" :class="$style.root" :style="themeColorStyle">
	<img v-if="faviconUrl" :class="$style.icon" :src="faviconUrl"/>
	<div :class="$style.name">{{ instanceName }}</div>
</div>
<div
	v-else
	:class="{
		[$style.posRoot]: true,
		[$style.verticalRoot]: tickerState.vertical,
		[$style.watermarkRoot]: tickerState.watermark,
		[$style.left]: tickerState.left,
		[$style.right]: tickerState.right,
	}"
	:style="tickerColors"
>
	<img v-if="faviconUrl" :class="$style.posIcon" :src="faviconUrl"/>
	<div :class="$style.posName">{{ instanceName }}</div>
</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { instanceName as localInstanceName } from '@@/js/config.js';
import type { CSSProperties } from 'vue';
import { instance as localInstance } from '@/instance.js';
import { getProxiedImageUrlNullable } from '@/utility/media-proxy.js';
import type { TickerPosition } from '@/utility/instance-ticker.js';
import { getTickerColors, getTickerState } from '@/utility/instance-ticker.js';

const props = withDefaults(defineProps<{
	host: string | null;
	instance?: {
		faviconUrl?: string | null
		name?: string | null
		themeColor?: string | null
	}
	position?: TickerPosition;
}>(), {
	position: 'default',
});

// if no instance data is given, this is for the local instance
const instanceName = computed(() => props.host == null ? localInstanceName : props.instance?.name ?? props.host);

const themeColor = computed(() => (props.host == null ? localInstance.themeColor : props.instance?.themeColor) ?? '#777777');

const tickerState = computed(() => getTickerState(props.position));

const tickerColors = computed<CSSProperties>(() => getTickerColors(themeColor.value) as unknown as CSSProperties);

const faviconUrl = computed(() => {
	let imageSrc: string | null = null;
	if (props.host == null) {
		if (localInstance.iconUrl == null) {
			return '/favicon.ico';
		} else {
			imageSrc = localInstance.iconUrl;
		}
	} else {
		imageSrc = props.instance?.faviconUrl ?? null;
	}
	return getProxiedImageUrlNullable(imageSrc);
});

const themeColorStyle = computed<CSSProperties>(() => {
	return {
		background: `linear-gradient(90deg, ${themeColor.value}, ${themeColor.value}00)`,
	};
});
</script>

<style lang="scss" module>
$height: 2ex;

.root {
	display: flex;
	align-items: center;
	height: $height;
	border-radius: 4px 0 0 4px;
	overflow: clip;
	color: #fff;

	// text-shadowは重いから使うな

	mask-image: linear-gradient(90deg,
		rgb(0,0,0),
		rgb(0,0,0) calc(100% - 16px),
		rgba(0,0,0,0) 100%
	);
}

.icon {
	height: $height;
	flex-shrink: 0;
}

.name {
	margin-left: 4px;
	line-height: 1;
	font-size: 0.9em;
	font-weight: bold;
	white-space: nowrap;
	overflow: visible;

	// text-shadowは重いから使うな
	color: var(--MI_THEME-fg);
	-webkit-text-stroke: var(--MI_THEME-panel) .225em;
	paint-order: stroke fill;
}

//#region taiyme 由来: 縦バー / 透かし表示
.posRoot {
	overflow: hidden; // fallback (overflow: clip)
	overflow: clip;
	display: block;
	box-sizing: border-box;
	background-color: var(--ticker-bg, #777777);
	color: var(--ticker-fg, #ffffff);
}

.posIcon {
	display: block;
	aspect-ratio: 1 / 1;
	box-sizing: border-box;
}

.posName {
	display: block;
	font-size: 0.9em;
	font-weight: bold;
	box-sizing: border-box;
}

.verticalRoot {
	--ticker-size: 2ex;
	position: absolute;
	top: 0;
	bottom: 0;
	display: grid;
	justify-items: center;
	grid-template: var(--ticker-size) 1fr / var(--ticker-size);
	gap: 4px;

	&.left {
		left: 0;
	}

	&.right {
		right: 0;
	}

	> .posIcon {
		width: var(--ticker-size);
		height: var(--ticker-size);
	}

	> .posName {
		writing-mode: vertical-lr;
		line-height: var(--ticker-size);
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}
}

.watermarkRoot {
	pointer-events: none;
	-webkit-user-select: none;
	user-select: none;
	position: absolute;
	z-index: -1;
	inset: 0;
	padding: 6px;
	display: flex;
	gap: 4px;
	flex-direction: column;
	justify-content: flex-end;
	background: linear-gradient(
		var(--ticker-bg-deg),
		rgba(0, 0, 0, 0) calc(100% - 3em),
		rgba(var(--ticker-bg-rgb, 119, 119, 119), 0.35) calc(100% - 3em),
		rgba(var(--ticker-bg-rgb, 119, 119, 119), 0.35) 100%
	);
	color: var(--ticker-fg, #fff);
	text-shadow: /* 0.866 ≈ sin(60deg) */
		1px 0 1px #000,
		0.866px 0.5px 1px #000,
		0.5px 0.866px 1px #000,
		0 1px 1px #000,
		-0.5px 0.866px 1px #000,
		-0.866px 0.5px 1px #000,
		-1px 0 1px #000,
		-0.866px -0.5px 1px #000,
		-0.5px -0.866px 1px #000,
		0 -1px 1px #000,
		0.5px -0.866px 1px #000,
		0.866px -0.5px 1px #000;

	&.left {
		--ticker-bg-deg: -135deg;
		align-items: flex-start;

		> .posName {
			text-align: start;
		}
	}

	&.right {
		--ticker-bg-deg: 135deg;
		align-items: flex-end;

		> .posName {
			text-align: end;
		}
	}

	> .posIcon {
		width: 1.5em;
		height: 1.5em;
		opacity: 0.8;
	}

	> .posName {
		max-width: 100%;
		margin: -4px; // text-shadow
		padding: 4px; // text-shadow
		line-height: 1;
		opacity: 0.7;
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}
}
//#endregion
</style>
