/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { trendCleanText } from './HanamiTrendEffectiveAuthors.js';

// 定期の自動投稿（質問箱の「質問募集中です」など、同じ人が毎日同じ文を出すもの）を、いま話題の材料から外すための決まり。
/** さかのぼる日数 */
export const TREND_RECURRING_LOOKBACK_DAYS = 7;
/** 今日より前の、この日数以上の別の日に同じ文を出していたら、定期の投稿とみなす */
export const TREND_RECURRING_MIN_DAYS = 2;
/** URL・メンション・タグ・空白を除いた文がこれより短い投稿は調べない（「草」などの短いひとこと） */
export const TREND_RECURRING_MIN_LENGTH = 6;
/** 1 回に調べる作者の上限 */
export const TREND_RECURRING_MAX_AUTHORS = 500;
/** 過去の投稿を絞り込むのに使う、文の先頭の文字数 */
export const TREND_RECURRING_PREFIX_LENGTH = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

type RecurringNote = { userId: string; text: string | null };

/** 文の比較に使う形。URL・メンション・タグ・カスタム絵文字・空白を除く（人ごとに違う URL が付く定型文をそろえるため）。 */
export function trendTemplateKey(text: string | null): string | null {
	const cleaned = trendCleanText(text ?? '').normalize('NFKC').replace(/\s+/gu, '');
	return Array.from(cleaned).length >= TREND_RECURRING_MIN_LENGTH ? cleaned : null;
}

export function trendRecurringPairKey(userId: string, templateKey: string): string {
	return `${userId}\u0000${templateKey}`;
}

/** SQL の left(text, n) と同じ切り方（文字単位）。 */
export function trendRecurringPrefix(text: string): string {
	return Array.from(text).slice(0, TREND_RECURRING_PREFIX_LENGTH).join('');
}

function jstDay(at: number): number {
	return Math.floor((at + JST_OFFSET_MS) / DAY_MS);
}

/** 今日（JST）の 0 時。これより前の投稿だけを「別の日」として数える。 */
export function trendRecurringTodayStart(now: number): number {
	return jstDay(now) * DAY_MS - JST_OFFSET_MS;
}

/**
 * 定期の投稿かどうかを調べる候補（短いひとこと以外のすべて）。同じ文を出している人が多い順に並べる。
 * 1 回に調べる作者には上限があるので、話題になりやすい「大勢が同じ文」のものから先に調べるため。
 */
export function trendRecurringCandidates<T extends RecurringNote>(notes: readonly T[]): T[] {
	const groups = new Map<string, { authors: Set<string>; notes: T[] }>();
	for (const note of notes) {
		const key = trendTemplateKey(note.text);
		if (key == null) continue;
		const group = groups.get(key) ?? { authors: new Set<string>(), notes: [] };
		group.authors.add(note.userId);
		group.notes.push(note);
		groups.set(key, group);
	}
	// sort は安定なので、人数が同じまとまりは元の順のまま。
	return [...groups.values()].sort((a, b) => b.authors.size - a.authors.size).flatMap(group => group.notes);
}

/**
 * 候補の作者が今日より前に出した投稿から、「同じ人が同じ文を、別の日に TREND_RECURRING_MIN_DAYS 日以上」
 * 出している組（作者と文）を返す。
 */
export function trendRecurringPairs(prior: readonly { userId: string; text: string | null; createdAt: number }[], now: number): Set<string> {
	const today = jstDay(now);
	const days = new Map<string, Set<number>>();
	for (const note of prior) {
		const key = trendTemplateKey(note.text);
		const day = jstDay(note.createdAt);
		if (key == null || day >= today || day < today - TREND_RECURRING_LOOKBACK_DAYS) continue;
		const pair = trendRecurringPairKey(note.userId, key);
		const seen = days.get(pair) ?? new Set<number>();
		seen.add(day);
		days.set(pair, seen);
	}
	return new Set([...days].filter(([, seen]) => seen.size >= TREND_RECURRING_MIN_DAYS).map(([pair]) => pair));
}
