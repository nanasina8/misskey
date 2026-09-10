/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { getLocalEmojiReactionFor, parseRemoteCustomEmojiReaction } from '@/utility/reaction-local-emoji.js';

describe('parseRemoteCustomEmojiReaction', () => {
	test('parses a remote custom emoji reaction', () => {
		expect(parseRemoteCustomEmojiReaction(':blobcat@example.com:')).toEqual({ name: 'blobcat', host: 'example.com' });
	});

	// ローカルのカスタム絵文字は `:name@.:` として届く。ホスト部を `[^:]+` で受けると `.` を掴んでしまい、
	// リモート扱いされたローカル絵文字がリアクション不可・ミュート不可・並び順反転になる。
	test('does not treat a local custom emoji reaction as remote', () => {
		expect(parseRemoteCustomEmojiReaction(':blobcat@.:')).toBeNull();
	});

	test('does not treat a unicode emoji or a bare custom emoji as remote', () => {
		expect(parseRemoteCustomEmojiReaction('❤️')).toBeNull();
		expect(parseRemoteCustomEmojiReaction(':blobcat:')).toBeNull();
	});
});

describe('getLocalEmojiReactionFor', () => {
	test('maps a remote reaction to the matched local emoji reaction', () => {
		expect(getLocalEmojiReactionFor(':blobcat@example.com:', { 'blobcat@example.com': 'blobcat_local' })).toBe(':blobcat_local@.:');
	});

	test('returns null for an unmatched remote reaction', () => {
		expect(getLocalEmojiReactionFor(':blobcat@example.com:', {})).toBeNull();
	});

	test('returns null for a local custom emoji reaction, which is already usable as-is', () => {
		expect(getLocalEmojiReactionFor(':blobcat@.:', { 'blobcat@.': 'blobcat' })).toBeNull();
	});
});
