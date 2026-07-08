/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 埋め込み前クリーニングの純関数（v0.7 敵対レビューR2-H2/R3 の回帰テスト）。
// - extractMfmText: ネスト MFM の装飾残骸（`<center ]] ]` 等）を出さない
// - contentCharCount: 絵文字連打・ゼロ幅のみを「内容ゼロ」と数える

import { extractMfmText, contentCharCount } from '@/core/hanami/HanamiTasteClusterBatchService.js';

describe('extractMfmText (v0.7 R2-H2)', () => {
	it('ネスト MFM 関数記法の残骸を出さない', () => {
		const out = extractMfmText('$[tada.speed=0s $[x2 $[sparkle 本文テキスト]]]');
		expect(out).toContain('本文テキスト');
		expect(out).not.toContain('$[');
		expect(out).not.toContain(']]');
		expect(out).not.toContain('tada');
	});

	it('center/bold の中の本文は残す', () => {
		const out = extractMfmText('<center>**大事な話**</center>');
		expect(out).toContain('大事な話');
		expect(out).not.toContain('<center');
	});

	it('url/mention/カスタム絵文字は落とし、hashtag 語と unicode 絵文字は残す', () => {
		const out = extractMfmText('見て https://example.com @alice@remote.example :custom_emoji: #お絵描き 🎨');
		expect(out).toContain('見て');
		expect(out).toContain('お絵描き');
		expect(out).toContain('🎨');
		expect(out).not.toContain('example.com');
		expect(out).not.toContain('alice');
		expect(out).not.toContain('custom_emoji');
	});
});

describe('contentCharCount (v0.7 R3)', () => {
	it('絵文字連打は内容ゼロ', () => {
		expect(contentCharCount('😀😃😄😁😆😅')).toBe(0);
	});

	it('ゼロ幅スペースのみは内容ゼロ', () => {
		expect(contentCharCount('​ ​​ ​')).toBe(0);
	});

	it('日本語・英数字は数える', () => {
		expect(contentCharCount('あいうabc123')).toBe(9);
	});

	it('記号だけは数えない', () => {
		expect(contentCharCount('!?…ーー〜〜')).toBeLessThanOrEqual(2); // 長音符は Letter 扱いになり得るが記号群で閾値12には届かない
	});
});
