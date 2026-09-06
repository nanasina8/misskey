/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import * as mfm from 'mfm-js';

export const HANAMI_EXACT_TEXT_FINGERPRINT_VERSION = 'exact-mfm-nfkc-v1';
export const HANAMI_STRICT_BOT_TEMPLATE_FINGERPRINT_VERSION = 'bot-template-author-v1';

/**
 * Extract the visible text used by Hanami's text-only processing.
 *
 * This intentionally preserves the existing taste-cluster behavior: text,
 * unicodeEmoji, and hashtag nodes are retained; supported wrappers are walked;
 * unsupported nodes are omitted; malformed MFM falls back to the raw input.
 */
export function extractMfmText(text: string): string {
	try {
		const out: string[] = [];
		const walk = (nodes: mfm.MfmNode[]): void => {
			for (const node of nodes) {
				if (node.type === 'text') out.push(node.props.text);
				else if (node.type === 'unicodeEmoji') out.push(node.props.emoji);
				else if (node.type === 'hashtag') out.push(node.props.hashtag);
				else if ('children' in node && node.children != null) walk(node.children as mfm.MfmNode[]);
			}
		};
		walk(mfm.parse(text));
		return out.join(' ');
	} catch {
		return text;
	}
}

/**
 * Canonical content for exact same-text comparison. This is not semantic
 * matching: it only removes presentation-equivalent Unicode and formatting.
 */
export function normalizeHanamiExactText(text: string): string {
	return extractMfmText(text)
		.normalize('NFKC')
		.replace(/[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, '')
		.toLocaleLowerCase('und')
		.replace(/\s+/gu, ' ')
		.trim();
}

/** Opaque, versioned fingerprint for exact-normalized hard de-duplication. */
export function createHanamiExactTextFingerprint(text: string): string {
	return `${HANAMI_EXACT_TEXT_FINGERPRINT_VERSION}:${createHash('sha256').update(normalizeHanamiExactText(text), 'utf8').digest('base64url')}`;
}

/**
 * Author-scoped template fingerprint for bot-volume observation.
 *
 * It applies the exact-normalized pipeline and binds the result to the author.
 * No words, numbers, URLs, emoji, or punctuation are generalized, so distinct
 * wording remains distinct. Consumers may use repeated fingerprints as a
 * same-author signal only; this API is not a bot exclusion decision.
 */
export function createHanamiStrictBotTemplateFingerprint(authorId: string, text: string): string {
	const normalized = normalizeHanamiExactText(text);
	return `${HANAMI_STRICT_BOT_TEMPLATE_FINGERPRINT_VERSION}:${createHash('sha256').update(`${authorId}\u0000${normalized}`, 'utf8').digest('base64url')}`;
}
