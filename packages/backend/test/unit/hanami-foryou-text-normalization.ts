/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHanamiExactTextFingerprint, createHanamiStrictBotTemplateFingerprint, extractMfmText, normalizeHanamiExactText } from '@/core/hanami/HanamiForYouTextNormalization.js';

describe('Hanami For You text normalization', () => {
	it('normalizes decorations, fullwidth characters, newlines, and invisible variants identically', () => {
		const plain = createHanamiExactTextFingerprint('Hello world!');
		expect(createHanamiExactTextFingerprint('$[x2 Ｈｅｌｌｏ\nworld!\u200B]')).toBe(plain);
		expect(createHanamiExactTextFingerprint('hello\uFE0F   world!')).toBe(plain);
	});

	it('does not conflate semantically near wording', () => {
		expect(createHanamiExactTextFingerprint('I like cats')).not.toBe(createHanamiExactTextFingerprint('I love cats'));
	});

	it('never throws for malformed MFM and falls back to its raw text', () => {
		const malformed = '$[x2 unclosed';
		expect(() => normalizeHanamiExactText(malformed)).not.toThrow();
		expect(extractMfmText(malformed)).toBe(malformed);
	});

	it('makes strict bot-template fingerprints author-scoped without generalizing wording', () => {
		expect(createHanamiStrictBotTemplateFingerprint('author-a', 'status 1')).not.toBe(createHanamiStrictBotTemplateFingerprint('author-a', 'status 2'));
		expect(createHanamiStrictBotTemplateFingerprint('author-a', 'status')).not.toBe(createHanamiStrictBotTemplateFingerprint('author-b', 'status'));
	});
});
