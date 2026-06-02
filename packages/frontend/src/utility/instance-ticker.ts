/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taiyme 由来: ノートのサーバー情報ティッカーの表示位置（縦バー / 透かし）
// Original: https://github.com/taiyme/misskey TmsInstanceTicker.impl.ts

export type TickerPosition = 'default' | 'leftVerticalBar' | 'rightVerticalBar' | 'leftWatermark' | 'rightWatermark';

type RGB = {
	readonly r: number;
	readonly g: number;
	readonly b: number;
};

const DEFAULT_RGB = { r: 119, g: 119, b: 119 } as const satisfies RGB;

const validHex = (hex: string): boolean => /^[0-9a-f]+$/i.test(hex);

export const hexToRgb = (hex: string): RGB => {
	let h = hex.startsWith('#') ? hex.slice(1) : hex;
	if (h.length === 3) {
		if (!validHex(h)) return DEFAULT_RGB;
		h = [...h].map(char => char.repeat(2)).join('');
	}
	if (!(h.length === 6 && validHex(h))) return DEFAULT_RGB;
	const [r, g, b] = Array.from(h.match(/.{2}/g) ?? [], n => parseInt(n, 16));
	return { r, g, b } as const satisfies RGB;
};

export type TickerColors = {
	readonly '--ticker-bg': string;
	readonly '--ticker-fg': string;
	readonly '--ticker-bg-rgb': string;
};

const TICKER_BG_COLOR_DEFAULT = '#777777' as const;
const TICKER_YUV_THRESHOLD = 191 as const;
const TICKER_FG_COLOR_LIGHT = '#ffffff' as const;
const TICKER_FG_COLOR_DARK = '#2f2f2fcc' as const;

const tickerColorsCache = new Map<string, TickerColors>();

export const getTickerColors = (themeColor: string | null | undefined): TickerColors => {
	const bgHex = themeColor ?? TICKER_BG_COLOR_DEFAULT;

	const cached = tickerColorsCache.get(bgHex);
	if (cached != null) return cached;

	const { r, g, b } = hexToRgb(bgHex);
	const yuv = 0.299 * r + 0.587 * g + 0.114 * b;
	const fgHex = yuv > TICKER_YUV_THRESHOLD ? TICKER_FG_COLOR_DARK : TICKER_FG_COLOR_LIGHT;

	const tickerColors = {
		'--ticker-fg': fgHex,
		'--ticker-bg': bgHex,
		'--ticker-bg-rgb': `${r}, ${g}, ${b}`,
	} as const satisfies TickerColors;

	tickerColorsCache.set(bgHex, tickerColors);

	return tickerColors;
};

export type TickerState = {
	readonly normal: boolean;
	readonly vertical: boolean;
	readonly watermark: boolean;
	readonly left: boolean;
	readonly right: boolean;
};

export const getTickerState = (position: TickerPosition): TickerState => {
	const vertical = position === 'leftVerticalBar' || position === 'rightVerticalBar';
	const watermark = position === 'leftWatermark' || position === 'rightWatermark';
	const normal = !vertical && !watermark;
	const left = position === 'leftVerticalBar' || position === 'leftWatermark';
	const right = position === 'rightVerticalBar' || position === 'rightWatermark';
	return { normal, vertical, watermark, left, right } as const satisfies TickerState;
};
