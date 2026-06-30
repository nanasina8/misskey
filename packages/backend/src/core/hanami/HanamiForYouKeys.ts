/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// はなみ For You の Redis キー前缀とラベル（canonical spec §7.2）。
// served/seen/authorServed/homeSeen/fof:shown を1か所で定義する。

export const HANAMI_SERVED_KEY_PREFIX = 'hanami:rec:served:';
export const HANAMI_AUTHOR_SERVED_KEY_PREFIX = 'hanami:rec:authorServed:';
export const HANAMI_SEEN_KEY_PREFIX = 'hanami:rec:seen:';
export const HANAMI_HOME_SEEN_KEY_PREFIX = 'hanami:rec:homeSeen:';
export const HANAMI_FOF_SHOWN_KEY_PREFIX = 'hanami:fof:shown:';

// provenance: 反応/返信/リノートが rec 由来か（served 済みか）を判定する遡及窓（§7.2 = 14日）。
export const HANAMI_SERVED_PROVENANCE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

// PG event TTL（§7.2）。batch cleanup の基準。served/seen=14日 / 個人event=180日。
export const HANAMI_EVENT_TTL_SERVED_SEEN_MS = 14 * 24 * 60 * 60 * 1000;
export const HANAMI_EVENT_TTL_PERSONAL_MS = 180 * 24 * 60 * 60 * 1000;

// 反応が rec でない（served されていない）ときに event.source へ入れる値。review script が rec/normal を分ける基準。
export const HANAMI_SOURCE_NORMAL = 'normal';
