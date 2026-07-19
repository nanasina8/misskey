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
// reactionSimilar（興味マッチ新着）: 10分tickで事前計算するユーザー別 zset。
// member = `${noteId}:${authorId}:${clusterId | 'r'}` / score = max(cos_cluster, cos_recent) × 鮮度。
export const HANAMI_TASTE_MATCH_KEY_PREFIX = 'hanami:tastematch:';
// 差分計算用。raw score は鮮度を掛ける前の baseCos、metadata は noteId -> authorId:bucket。
export const HANAMI_TASTE_MATCH_RAW_KEY_PREFIX = 'hanami:tastematch:raw:';
export const HANAMI_TASTE_MATCH_RAW_META_KEY_PREFIX = 'hanami:tastematch:rawmeta:';
// cursor と入力ベクトルの指紋を持つユーザー別 hash。serve からは参照しない。
export const HANAMI_TASTE_MATCH_STATE_KEY_PREFIX = 'hanami:tastematch:state:';
// 短期興味量 meta（§9.8.2）: hash fields totalHeat / heat:{clusterId} / hasRecentVec。
export const HANAMI_TASTE_MATCH_META_KEY_PREFIX = 'hanami:tastematch:meta:';
// 短期興味シグナル（§9.8.1）: member = `${targetNoteId}:${kind}` / score = 行動時刻ms。
export const HANAMI_RECENT_ACT_KEY_PREFIX = 'hanami:recentact:';
// For You を実際に読んだ人のマーカー（taste match バッチの対象ゲート）。
// served は TTL30分の重複抑制キーなので流用不可（v0.7 敵対レビューR2-H1: 30分でactive判定から
// 外れて zset が48h腐る）。ページ配信のたびに張り直す長期マーカーを別に持つ。
export const HANAMI_FORYOU_ACTIVE_KEY_PREFIX = 'hanami:foryou:active:';
export const HANAMI_FORYOU_ACTIVE_TTL_SEC = 14 * 24 * 60 * 60;

// provenance: 反応/返信/リノートが rec 由来か（served 済みか）を判定する遡及窓（§7.2 = 14日）。
export const HANAMI_SERVED_PROVENANCE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

// PG event TTL（§7.2）。batch cleanup の基準。served/seen=14日 / 個人event=180日。
export const HANAMI_EVENT_TTL_SERVED_SEEN_MS = 14 * 24 * 60 * 60 * 1000;
export const HANAMI_EVENT_TTL_PERSONAL_MS = 180 * 24 * 60 * 60 * 1000;

// 反応が rec でない（served されていない）ときに event.source へ入れる値。review script が rec/normal を分ける基準。
export const HANAMI_SOURCE_NORMAL = 'normal';
