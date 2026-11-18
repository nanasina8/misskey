/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { trendCleanText } from './HanamiTrendEffectiveAuthors.js';

// 定期の自動投稿（質問箱の「質問募集中です」や、毎日の活動報告のように、同じ人が毎日同じ形の文を出すもの）を、
// いま話題の材料から外すための決まり。数字だけが日ごとに変わる文（「ノート: 33637(+50)」など）も同じ文として扱う。
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
/** 絞り込み用の先頭を作るときに見る範囲（文字数）。ここから数字と符号を除いた先頭 TREND_RECURRING_PREFIX_LENGTH 文字を使う */
export const TREND_RECURRING_PREFIX_SCAN = 48;
/** 絞り込み用の先頭から除く文字（数字・符号・桁区切り）。SQL の translate() にも同じ文字列を渡す */
export const TREND_RECURRING_PREFIX_IGNORED = '0123456789０１２３４５６７８９+-.,＋－−．，';

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

type RecurringNote = { userId: string; text: string | null; createdAt?: number };

const NUMBER = /[+\-−]?\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
const PREFIX_IGNORED = new Set(Array.from(TREND_RECURRING_PREFIX_IGNORED));

/**
 * 文の比較に使う形。URL・メンション・タグ・カスタム絵文字・空白を除き（人ごとに違う URL が付く定型文をそろえるため）、
 * 数字のまとまりは符号・小数・桁区切りごと「0」に置き換える（日ごとに数字だけが変わる定型文をそろえるため）。
 */
export function trendTemplateKey(text: string | null): string | null {
	const cleaned = trendCleanText(text ?? '').normalize('NFKC').replace(/\s+/gu, '').replace(NUMBER, '0');
	return Array.from(cleaned).length >= TREND_RECURRING_MIN_LENGTH ? cleaned : null;
}

export function trendRecurringPairKey(userId: string, templateKey: string): string {
	return `${userId}\u0000${templateKey}`;
}

/**
 * 過去の投稿を絞り込むための先頭。SQL の left(translate(left(text, SCAN), IGNORED, ''), LENGTH) と同じ切り方（文字単位）。
 * 数字と符号を除くので、先頭の近くに日ごとに変わる数字がある定型文でも、同じ先頭になる。
 */
export function trendRecurringPrefix(text: string): string {
	return Array.from(text).slice(0, TREND_RECURRING_PREFIX_SCAN).filter(char => !PREFIX_IGNORED.has(char)).slice(0, TREND_RECURRING_PREFIX_LENGTH).join('');
}

/**
 * 調べた結果を覚えておく期限。ふつうは memoMs のあいだ。
 * 「あと 1 日ぶんで定期の投稿になる」組（別の日がちょうど TREND_RECURRING_MIN_DAYS - 1 日）だけは、日付（JST）が変わったら調べ直す。
 * 今日の投稿が「別の日」に数わり、結果が変わるのはこの組だけなので。全部を 0 時に調べ直すと、1 回に調べる作者の上限からあふれる。
 */
export function trendRecurringMemoUntil(now: number, memoMs: number, priorDays: number): number {
	return priorDays === TREND_RECURRING_MIN_DAYS - 1 ? Math.min(now + memoMs, trendRecurringTodayStart(now) + DAY_MS) : now + memoMs;
}

function jstDay(at: number): number {
	return Math.floor((at + JST_OFFSET_MS) / DAY_MS);
}

/** 今日（JST）の 0 時。これより前の投稿だけを「別の日」として数える。 */
export function trendRecurringTodayStart(now: number): number {
	return jstDay(now) * DAY_MS - JST_OFFSET_MS;
}

/**
 * 定期の投稿かどうかを調べる候補（短いひとこと以外のすべて）。同じ文を出している人が多い順、同じ人数なら新しい投稿がある順に並べる。
 * 1 回に調べる作者には上限があるので、話題になりやすい「大勢が同じ文」のものと、これから話題になる「出たばかりの投稿」から先に調べるため
 * （毎日 0 時の自動投稿は、人ごとに文を変えていても、出た直後の回で調べ終わる）。
 */
export function trendRecurringCandidates<T extends RecurringNote>(notes: readonly T[]): T[] {
	const groups = new Map<string, { authors: Set<string>; notes: T[]; newest: number }>();
	for (const note of notes) {
		const key = trendTemplateKey(note.text);
		if (key == null) continue;
		const group = groups.get(key) ?? { authors: new Set<string>(), notes: [], newest: 0 };
		group.authors.add(note.userId);
		group.notes.push(note);
		group.newest = Math.max(group.newest, note.createdAt ?? 0);
		groups.set(key, group);
	}
	// sort は安定なので、人数も新しさも同じまとまりは元の順のまま。
	return [...groups.values()].sort((a, b) => b.authors.size - a.authors.size || b.newest - a.newest).flatMap(group => group.notes);
}

/**
 * 候補の作者が今日より前に出した投稿から、組（作者と文）ごとに、同じ文を出していた「別の日」の数を数える。
 * 今日（JST）の投稿と、TREND_RECURRING_LOOKBACK_DAYS より前の投稿は数えない。
 */
export function trendRecurringDayCounts(prior: readonly { userId: string; text: string | null; createdAt: number }[], now: number): Map<string, number> {
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
	return new Map([...days].map(([pair, seen]) => [pair, seen.size]));
}

/** 「同じ人が同じ文を、別の日に TREND_RECURRING_MIN_DAYS 日以上」出している組（作者と文）。 */
export function trendRecurringPairs(prior: readonly { userId: string; text: string | null; createdAt: number }[], now: number): Set<string> {
	return new Set([...trendRecurringDayCounts(prior, now)].filter(([, days]) => days >= TREND_RECURRING_MIN_DAYS).map(([pair]) => pair));
}
