/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * meta."hanamiNoteJudgeSettings" の DB 上の既定値（migration 1789344000000-hanamiNoteJudge で付けた値そのまま）。
 *
 * エンティティの列定義を DB と一致させるためだけに置く（check-migrations が食い違いを出さないようにする）。
 * 判定に使う今の既定値は core/hanami/HanamiNoteJudgeContracts.ts の createDefaultHanamiNoteJudgeSettings()。
 * ここを書き換えると DB の既定値と食い違うので、変えるときは既定値を変える migration とセットにすること。
 */
export const HANAMI_NOTE_JUDGE_SETTINGS_COLUMN_DEFAULT = {
	schemaVersion: 1,
	promptVersion: 1,
	ephemeralThreshold: 0,
	interestThreshold: 2.95,
	reactionMax: 3,
	interestMax: 10,
	basis: {
		ephemeralA: 'その場限りの投稿（挨拶、短い相づち、相手や文脈がないと意味が通らない独り言、bot/定型の自動投稿、フォロー募集や質問募集などの呼びかけだけ）',
		ephemeralB: '単独で読める投稿（情報、意見、出来事の描写、作品の紹介、ジョークやネタとして成立しているもの。短くてもよい）',
		interest1: '挨拶・相づち・定型文・呼びかけ・内輪向けで、第三者が読む価値がない',
		interest2: 'ありふれた近況や独り言で、第三者には特に意味がない',
		interest3: '普通。読めるが特に印象に残らない／本文が題名やタグだけで画像の中身は判断できない',
		interest4: '読んで得るものや面白さがはっきりある',
		interest5: '新しい情報・視点・気づきがあり、この人の他の投稿も読みたくなる'
	},
	examples: [],
	templatePatterns: [
		'メシをよそえました',
		'#FediQB',
		'#MKTQB',
		'Mewk',
		'を引いたよ',
		'登録してから',
		'きょうのしろぷよ',
		'きょうのほにゅ',
		'ルリアに話しかけ',
		'#好きな曲10曲',
		'緊急地震速報',
		'震度速報',
		'#3good',
		'^0+$',
		'にゃんぷっぷーとあそぼう',
		'質問募集',
		'ラブレター募集',
		'悪口診断',
		'#愛される理由',
		'生活リズムスイッチ'
	]
} as const;
