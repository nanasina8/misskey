/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_MAX_TERM_LEN, HANAMI_MIN_TERM_LEN, HANAMI_STOPWORDS, type HanamiTokenizer } from './HanamiTokenizer.js';

/**
 * 依存無しの fallback tokenizer（TinySegmenter 相当の軽量版）。
 *
 * 形態素解析器が無くても動くよう、スクリプト境界ベースで素朴に分割する:
 *  - カタカナの連続を1語（外来語・固有名詞に強い）
 *  - 漢字の連続を1語（名詞になりやすい）
 *  - 漢字+ひらがな の短い連なりは漢字部分だけ採用（活用語尾を落とす近似）
 *  - ASCII 英数語を1語（小文字化）
 *
 * Lindera 導入までの暫定。精度は粗いが「急上昇用語」を拾う用途には十分機能する。
 */
export class BuiltinTokenizer implements HanamiTokenizer {
	public readonly name = 'builtin';

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async tokenize(text: string): Promise<string[]> {
		const out: string[] = [];

		// カタカナ連続（長音符・中黒を含む）
		for (const m of text.matchAll(/[゠-ヿㇰ-ㇿー]{2,}/g)) {
			this.push(out, m[0]);
		}
		// 漢字連続
		for (const m of text.matchAll(/[一-鿿㐀-䶿々]{1,}/g)) {
			this.push(out, m[0]);
		}
		// ひらがな連続（4文字以上のみ＝助詞の羅列を避けて意味語を拾う）
		for (const m of text.matchAll(/[぀-ゟ]{4,}/g)) {
			this.push(out, m[0]);
		}
		// ASCII 英数語（小文字化）
		for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) {
			this.push(out, m[0].toLowerCase());
		}

		return out;
	}

	private push(out: string[], raw: string): void {
		const term = raw.trim();
		if (term.length < HANAMI_MIN_TERM_LEN) return;
		if (term.length > HANAMI_MAX_TERM_LEN) return;
		if (HANAMI_STOPWORDS.has(term)) return;
		out.push(term);
	}
}
