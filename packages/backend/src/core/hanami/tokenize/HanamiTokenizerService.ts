/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import type { HanamiTermToken, HanamiTokenizer } from './HanamiTokenizer.js';
import { BuiltinTokenizer } from './BuiltinTokenizer.js';
import { LinderaTokenizer } from './LinderaTokenizer.js';

/**
 * 形態素解析の選択窓口。本命 Lindera が使えればそれを、無ければ Builtin に fallback。
 * 解析前に本文から URL・メンション・ハッシュタグ・カスタム絵文字記法を除去する（本文のみ対象）。
 */
@Injectable()
export class HanamiTokenizerService {
	private lindera = new LinderaTokenizer();
	private builtin = new BuiltinTokenizer();
	private active: HanamiTokenizer | null = null;

	@bindThis
	private async getActive(): Promise<HanamiTokenizer> {
		if (this.active != null) return this.active;
		this.active = (await this.lindera.isAvailable()) ? this.lindera : this.builtin;
		// 起動後の初回解析時に、どの tokenizer が有効化されたかをログに出す（運用で Lindera 有効を確認できる）。
		// eslint-disable-next-line no-console
		console.info(`[hanami] trend tokenizer active: ${this.active.name}${this.active === this.builtin ? ' (fallback; install lindera to enable morphological analysis)' : ''}`);
		return this.active;
	}

	/**
	 * 本文を解析用にクリーニングする。URL/メンション/ハッシュタグ/カスタム絵文字/記号類を落とす。
	 */
	@bindThis
	public clean(text: string): string {
		return text
			.replace(/https?:\/\/\S+/g, ' ') // URL
			.replace(/[@＠][\w._-]+(?:@[\w.-]+)?/g, ' ') // メンション
			.replace(/[#＃][^\s#＃]+/g, ' ') // ハッシュタグ
			.replace(/:[a-zA-Z0-9_+-]+:/g, ' ') // カスタム絵文字 :name:
			.replace(/\$\[[^\]]*\]/g, ' ') // MFM 関数記法の外枠
			.replace(/[`*~_>|]/g, ' '); // 軽微な記法記号
	}

	@bindThis
	public async tokenize(text: string): Promise<string[]> {
		const tokenizer = await this.getActive();
		return tokenizer.tokenize(this.clean(text));
	}

	/**
	 * 固有名詞判定つきトークン。Lindera など下位分類を持つ実装はそのまま、
	 * 持たない fallback(Builtin) では proper=false で代替する。
	 */
	@bindThis
	public async tokenizeWithKind(text: string): Promise<HanamiTermToken[]> {
		const tokenizer = await this.getActive();
		const cleaned = this.clean(text);
		if (tokenizer.tokenizeWithKind) return tokenizer.tokenizeWithKind(cleaned);
		return (await tokenizer.tokenize(cleaned)).map(term => ({ term, proper: false }));
	}

	@bindThis
	public async activeName(): Promise<string> {
		return (await this.getActive()).name;
	}
}
