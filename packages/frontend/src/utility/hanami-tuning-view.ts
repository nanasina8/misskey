/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';
import type { HanamiAxisGroup } from '@/utility/hanami-tuning.js';

/** 調整パネル・ポップアップで共通の、見た目だけの決まりごと。 */

/**
 * まとまりの塗り（style.scss の :root で定義）。色はテーマのアクセント色 1 つだけで、柄で分ける。
 * 身近＝べた塗り / 話題＝斜線 / 出会い＝点。background にそのまま渡す。
 */
export const HANAMI_GROUP_FILLS: Record<HanamiAxisGroup, string> = {
	close: 'var(--MI-hanamiGroupClose)',
	buzz: 'var(--MI-hanamiGroupBuzz)',
	fresh: 'var(--MI-hanamiGroupFresh)',
};

const LEVEL_KEYS = ['veryFew', 'few', 'normal', 'many', 'veryMany'] as const;
const DRIFT_KEYS = ['gentle', 'normal', 'strong'] as const;
const DIRECTION_KEYS = ['close', 'balanced', 'wide'] as const;

/** 「おすすめから調整」の 0〜4 の段階の名前（かなり少なめ〜かなり多め）。 */
export function hanamiLevelName(level: number): string {
	return i18n.ts._hana._tuning._levels[LEVEL_KEYS[level] ?? 'normal'];
}

/** 反応への寄せ方 0〜2 の名前。 */
export function hanamiDriftName(drift: number): string {
	return i18n.ts._hana._tuning._drifts[DRIFT_KEYS[drift] ?? 'normal'];
}

/** 方向 0〜2 の名前。 */
export function hanamiDirectionName(direction: number): string {
	return i18n.ts._hana._tuning._directions[DIRECTION_KEYS[direction] ?? 'balanced'];
}

/** 「10 件のうち」の読み上げ用の文。 */
export function hanamiTilesLabel(counts: Record<HanamiAxisGroup, number>): string {
	return i18n.tsx._hana._tuning.tilesLabel(counts);
}
