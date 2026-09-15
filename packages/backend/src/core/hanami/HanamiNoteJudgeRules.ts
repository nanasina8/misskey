/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { extractMfmText } from './HanamiForYouTextNormalization.js';

export const HANAMI_NOTE_JUDGE_MAX_TEXT_LENGTH = 400;

export type HanamiNoteJudgeRuleReason = 'bot' | 'reply' | 'template' | 'emptyText';
export type HanamiNoteJudgeRuleResult =
	| Readonly<{ shouldJudge: true; cleanedText: string }>
	| Readonly<{ shouldJudge: false; reason: HanamiNoteJudgeRuleReason; cleanedText: string }>;

export type ApplyHanamiNoteJudgeRulesInput = Readonly<{
	text: string | null;
	isBot: boolean;
	isReply: boolean;
	templatePatterns: readonly string[];
}>;

/** Visible, bounded judge text: MFM/custom emoji/URLs are removed before truncation. */
export function cleanHanamiNoteJudgeText(text: string | null | undefined): string {
	if (typeof text !== 'string') return '';
	const visible = extractMfmText(text)
		.normalize('NFKC')
		.replace(/https?:\/\/[^\s]+/giu, ' ')
		.replace(/:[a-z0-9_+-]+:/giu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
	return Array.from(visible).slice(0, HANAMI_NOTE_JUDGE_MAX_TEXT_LENGTH).join('');
}

/** Emoji/punctuation-only text is not a judge input, even when an image is attached. */
export function hasHanamiNoteJudgeContent(cleanedText: string): boolean {
	return /[\p{L}\p{N}]/u.test(cleanedText);
}

/** Rule-stage exclusions are definitive and must never be sent to the LLM. */
export function applyHanamiNoteJudgeRules(input: ApplyHanamiNoteJudgeRulesInput): HanamiNoteJudgeRuleResult {
	const cleanedText = cleanHanamiNoteJudgeText(input.text);
	if (input.isBot) return { shouldJudge: false, reason: 'bot', cleanedText };
	if (input.isReply) return { shouldJudge: false, reason: 'reply', cleanedText };
	for (const pattern of input.templatePatterns) {
		try {
			if (new RegExp(pattern, 'iu').test(cleanedText)) return { shouldJudge: false, reason: 'template', cleanedText };
		} catch {
			// Invalid settings are rejected before jobs are made; do not turn a bad
			// pattern into an accidental exclusion if a stale setting slips through.
		}
	}
	if (!hasHanamiNoteJudgeContent(cleanedText)) return { shouldJudge: false, reason: 'emptyText', cleanedText };
	return { shouldJudge: true, cleanedText };
}
