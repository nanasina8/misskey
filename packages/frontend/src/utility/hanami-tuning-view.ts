/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';
import type { HanamiAxisGroup, HanamiTuningMode } from '@/utility/hanami-tuning.js';

/** 調整パネル・ポップアップで共通の、見た目だけの決まりごと。 */

export const HANAMI_MODE_ICONS: Record<HanamiTuningMode, string> = {
	auto: 'ti ti-sparkles',
	direction: 'ti ti-compass',
	recommend: 'ti ti-adjustments-star',
	manual: 'ti ti-adjustments-horizontal',
};

export const HANAMI_GROUP_ICONS: Record<HanamiAxisGroup, string> = {
	close: 'ti ti-user',
	buzz: 'ti ti-flame',
	fresh: 'ti ti-seedling',
};

/** style.scss の :root で定義している、まとまりの色。 */
export const HANAMI_GROUP_COLORS: Record<HanamiAxisGroup, string> = {
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
