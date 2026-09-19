/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const HANAMI_NOTE_JUDGE_MODEL = 'Qwen/Qwen3-4B-Instruct-2507';
export const HANAMI_NOTE_JUDGE_SETTINGS_SCHEMA_VERSION = 1;
// ハード上限（ペイロード検証・Python 側 MAX_NOTES と一致させる）。
export const HANAMI_NOTE_JUDGE_MAX_BATCH_SIZE = 64;
// 既定の1ジョブ件数。CPU 4B 推論は実測 ~31s/件（i3-10100F）で、64件は35分のジョブタイムアウトに
// 収まらず全損する。16件なら ~10-16分で収まる。HANAMI_NOTE_JUDGE_BATCH_SIZE で 1..64 に調整可。
export const HANAMI_NOTE_JUDGE_DEFAULT_BATCH_SIZE = 16;

export type HanamiNoteJudgeBasis = Readonly<{
	ephemeralA: string;
	ephemeralB: string;
	interest1: string;
	interest2: string;
	interest3: string;
	interest4: string;
	interest5: string;
}>;

/** JSON stored in Meta.hanamiNoteJudgeSettings (the Meta entity is not changed here). */
export type HanamiNoteJudgeSettings = Readonly<{
	schemaVersion: typeof HANAMI_NOTE_JUDGE_SETTINGS_SCHEMA_VERSION;
	promptVersion: number;
	ephemeralThreshold: number;
	interestThreshold: number;
	reactionMax: number;
	interestMax: number;
	basis: HanamiNoteJudgeBasis;
	examples: readonly string[];
	templatePatterns: readonly string[];
}>;

const DEFAULT_BASIS: HanamiNoteJudgeBasis = {
	ephemeralA: 'その場限りの投稿（挨拶、短い相づち、相手や文脈がないと意味が通らない独り言、bot/定型の自動投稿、フォロー募集や質問募集などの呼びかけだけ）',
	ephemeralB: '単独で読める投稿（情報、意見、出来事の描写、作品の紹介、ジョークやネタとして成立しているもの。短くてもよい）',
	interest1: '挨拶・相づち・定型文・呼びかけ・内輪向けで、第三者が読む価値がない',
	interest2: 'ありふれた近況や独り言で、第三者には特に意味がない',
	interest3: '普通。読めるが特に印象に残らない／本文が題名やタグだけで画像の中身は判断できない',
	interest4: '読んで得るものや面白さがはっきりある',
	interest5: '新しい情報・視点・気づきがあり、この人の他の投稿も読みたくなる',
};

export const HANAMI_NOTE_JUDGE_DEFAULT_TEMPLATE_PATTERNS = [
	'メシをよそえました', '#FediQB', '#MKTQB', 'Mewk', 'を引いたよ', '登録してから', 'きょうのしろぷよ', 'きょうのほにゅ',
	'ルリアに話しかけ', '#好きな曲10曲', '緊急地震速報', '震度速報', '#3good', '^0+$', 'にゃんぷっぷーとあそぼう',
	'質問募集', 'ラブレター募集', '悪口診断', '#愛される理由', '生活リズムスイッチ',
] as const;

/** Return a mutable copy suitable for admin-side edits before persistence. */
export function createDefaultHanamiNoteJudgeSettings(): HanamiNoteJudgeSettings {
	return {
		schemaVersion: HANAMI_NOTE_JUDGE_SETTINGS_SCHEMA_VERSION,
		promptVersion: 1,
		ephemeralThreshold: 0,
		interestThreshold: 2.95,
		reactionMax: 3,
		interestMax: 10,
		basis: { ...DEFAULT_BASIS },
		examples: [],
		templatePatterns: [...HANAMI_NOTE_JUDGE_DEFAULT_TEMPLATE_PATTERNS],
	};
}

export type HanamiNoteJudgeSettingsValidation =
	| Readonly<{ ok: true; value: HanamiNoteJudgeSettings }>
	| Readonly<{ ok: false; error: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
}

/** Validate persisted JSON before it is used in prompts or regular-expression compilation. */
export function validateHanamiNoteJudgeSettings(value: unknown): HanamiNoteJudgeSettingsValidation {
	if (!isRecord(value)) return { ok: false, error: 'settings must be an object' };
	if (value.schemaVersion !== HANAMI_NOTE_JUDGE_SETTINGS_SCHEMA_VERSION) return { ok: false, error: 'unsupported settings schemaVersion' };
	if (!Number.isInteger(value.promptVersion) || (value.promptVersion as number) < 1) return { ok: false, error: 'promptVersion must be a positive integer' };
	if (!isFiniteNumber(value.ephemeralThreshold) || !isFiniteNumber(value.interestThreshold) || !isFiniteNumber(value.reactionMax) || !isFiniteNumber(value.interestMax)) return { ok: false, error: 'thresholds and score maxima must be finite numbers' };
	if ((value.reactionMax as number) < 0 || (value.interestMax as number) < 0) return { ok: false, error: 'score maxima must not be negative' };
	if (!isRecord(value.basis)) return { ok: false, error: 'basis must be an object' };
	const basis = value.basis;
	const basisKeys: Array<keyof HanamiNoteJudgeBasis> = ['ephemeralA', 'ephemeralB', 'interest1', 'interest2', 'interest3', 'interest4', 'interest5'];
	if (!basisKeys.every(key => isBoundedText(basis[key]))) return { ok: false, error: 'basis contains invalid text' };
	if (!Array.isArray(value.examples) || value.examples.length > 30 || !value.examples.every(isBoundedText)) return { ok: false, error: 'examples must contain at most 30 non-empty texts' };
	if (!Array.isArray(value.templatePatterns) || value.templatePatterns.length > 100 || !value.templatePatterns.every(pattern => typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 512)) return { ok: false, error: 'templatePatterns contains an invalid pattern' };
	for (const pattern of value.templatePatterns) {
		try { void new RegExp(pattern, 'iu'); } catch { return { ok: false, error: 'templatePatterns contains an invalid regular expression' }; }
	}

	return {
		ok: true,
		value: {
			schemaVersion: HANAMI_NOTE_JUDGE_SETTINGS_SCHEMA_VERSION,
			promptVersion: value.promptVersion as number,
			ephemeralThreshold: value.ephemeralThreshold as number,
			interestThreshold: value.interestThreshold as number,
			reactionMax: value.reactionMax as number,
			interestMax: value.interestMax as number,
			basis: Object.fromEntries(basisKeys.map(key => [key, basis[key]])) as HanamiNoteJudgeBasis,
			examples: [...value.examples] as string[],
			templatePatterns: [...value.templatePatterns] as string[],
		},
	};
}

export type HanamiNoteJudgePromptInput = Readonly<{
	cleanedText: string;
	hasFiles: boolean;
	settings: HanamiNoteJudgeSettings;
}>;

const CONTENT_TYPE_CHOICES = [
	'挨拶・相づち・定型文', 'ニュース・情報の共有', '解説・知識・ハウツー', '意見・考察・問題提起', '出来事・体験談・エピソード',
	'ユーモア・ネタ・大喜利', '作品の投稿', '写真・食事・日常の記録', '告知・宣伝・募集・企画参加', '近況・独り言・感情の吐露',
] as const;

/**
 * Code owns the questions, output grammar, and content-type labels. Instance
 * settings may only supply bases, examples, and rule templates.
 */
export function createHanamiNoteJudgePrompt(input: HanamiNoteJudgePromptInput): string {
	const { basis } = input.settings;
	const examples = input.settings.examples.length === 0 ? '（なし）' : input.settings.examples.map(example => `- ${example}`).join('\n');
	const imageNotice = input.hasFiles ? '\n（画像あり。画像の中身は見えません。）' : '';
	return `あなたは公開投稿を第三者視点で評価する判定器です。投稿本文だけを根拠にしてください。\n\n投稿:\n---\n${input.cleanedText}${imageNotice}\n---\n\nQ1: 次の投稿は、投稿者を知らない第三者が単独で読んでも意味が通り、読む価値がありますか？\nA = ${basis.ephemeralA}\nB = ${basis.ephemeralB}\n\nQ2: 投稿者を知らない第三者が読んだときの「興味深さ」を 1〜5 で評価してください。\n1 = ${basis.interest1}\n2 = ${basis.interest2}\n3 = ${basis.interest3}\n4 = ${basis.interest4}\n5 = ${basis.interest5}\n\nQ3: 種類を 0〜9 で選んでください。\n${CONTENT_TYPE_CHOICES.map((choice, index) => `${index} = ${choice}`).join('\n')}\n\n判定例:\n${examples}\n\n回答は他の文章を出さず、必ず {"ephemeral":"AまたはB","interest":"1から5","contentType":"0から9"} の JSON 形式にしてください。`;
}

/** Split an already ordered job list without ever issuing a model job over 64 notes. */
export function splitHanamiNoteJudgeBatches<T>(items: readonly T[], maxSize = HANAMI_NOTE_JUDGE_MAX_BATCH_SIZE): T[][] {
	if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > HANAMI_NOTE_JUDGE_MAX_BATCH_SIZE) throw new RangeError(`maxSize must be an integer between 1 and ${HANAMI_NOTE_JUDGE_MAX_BATCH_SIZE}`);
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += maxSize) batches.push(items.slice(index, index + maxSize));
	return batches;
}
