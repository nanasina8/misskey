/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
	createDefaultHanamiNoteJudgeSettings,
	createHanamiNoteJudgePrompt,
	splitHanamiNoteJudgeBatches,
	validateHanamiNoteJudgeSettings,
} from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { applyHanamiNoteJudgeRules, cleanHanamiNoteJudgeText } from '@/core/hanami/HanamiNoteJudgeRules.js';

describe('Hanami note judge rule layer', () => {
	const settings = createDefaultHanamiNoteJudgeSettings();

	it.each([
		[{ isBot: true, isReply: false, text: '詳しい解説です' }, 'bot'],
		[{ isBot: false, isReply: true, text: '詳しい解説です' }, 'reply'],
		[{ isBot: false, isReply: false, text: 'きょうのしろぷよ結果' }, 'template'],
		[{ isBot: false, isReply: false, text: '$[x2 :party:] 🎉' }, 'emptyText'],
	] as const)('excludes %s without an LLM input', (input, reason) => {
		const result = applyHanamiNoteJudgeRules({ ...input, templatePatterns: settings.templatePatterns });
		expect(result).toMatchObject({ shouldJudge: false, reason });
	});

	it('normalizes MFM, URL, custom emoji, whitespace, and bounds text before prompts', () => {
		const cleaned = cleanHanamiNoteJudgeText('$[x2 本文] https://example.test :wave: \n #タグ');
		expect(cleaned).toContain('本文');
		expect(cleaned).toContain('タグ');
		expect(cleaned).not.toContain('example.test');
		expect(cleaned).not.toContain(':wave:');
		expect(Array.from(cleanHanamiNoteJudgeText('あ'.repeat(401))).length).toBe(400);
	});

	it('returns the only LLM input for ordinary content', () => {
		expect(applyHanamiNoteJudgeRules({ isBot: false, isReply: false, text: 'SQLite の VACUUM はいつ必要かを整理した。', templatePatterns: settings.templatePatterns }))
			.toEqual({ shouldJudge: true, cleanedText: 'SQLite の VACUUM はいつ必要かを整理した。' });
	});
});

describe('Hanami note judge contracts', () => {
	it('splits jobs into stable batches of at most 64', () => {
		const batches = splitHanamiNoteJudgeBatches(Array.from({ length: 129 }, (_, index) => index));
		expect(batches.map(batch => batch.length)).toEqual([64, 64, 1]);
		expect(batches.flat()).toEqual(Array.from({ length: 129 }, (_, index) => index));
		expect(() => splitHanamiNoteJudgeBatches([1], 65)).toThrow(RangeError);
	});

	it('validates stored settings and schema/prompt versions', () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		expect(validateHanamiNoteJudgeSettings(settings)).toMatchObject({ ok: true });
		expect(validateHanamiNoteJudgeSettings({ ...settings, schemaVersion: 2 })).toMatchObject({ ok: false, error: 'unsupported settings schemaVersion' });
		expect(validateHanamiNoteJudgeSettings({ ...settings, promptVersion: 0 })).toMatchObject({ ok: false, error: 'promptVersion must be a positive integer' });
		expect(validateHanamiNoteJudgeSettings({ ...settings, templatePatterns: ['('] })).toMatchObject({ ok: false, error: 'templatePatterns contains an invalid regular expression' });
	});

	it('keeps the prompt skeleton in code while including editable basis and examples', () => {
		const settings = createDefaultHanamiNoteJudgeSettings();
		const prompt = createHanamiNoteJudgePrompt({ cleanedText: '投稿本文', hasFiles: true, settings: { ...settings, basis: { ...settings.basis, ephemeralA: '編集済みのA基準' }, examples: ['編集済みの判定例'] } });
		expect(prompt).toContain('編集済みのA基準');
		expect(prompt).toContain('編集済みの判定例');
		expect(prompt).toContain('（画像あり。画像の中身は見えません。）');
		expect(prompt).toContain('"contentType":"0から9"');
	});
});
