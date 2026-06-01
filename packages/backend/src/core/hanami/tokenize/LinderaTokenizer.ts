/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_MAX_TERM_LEN, HANAMI_MIN_TERM_LEN, HANAMI_STOPWORDS, type HanamiTermToken, type HanamiTokenizer } from './HanamiTokenizer.js';

// 本命の形態素解析器。WASM(nodejsターゲット) + UniDic(最新辞書, 辞書WASM同梱) を使う。
// パッケージ: lindera-wasm-nodejs-unidic（mosuka 公式, ネイティブビルド不要・全アーキ共通）。
const LINDERA_PACKAGE = 'lindera-wasm-nodejs-unidic';
const LINDERA_DICTIONARY = 'embedded://unidic';

// lindera-wasm の最小型（d.ts に合わせた手書き。動的importのため any 経由で受ける）。
interface LinderaTokenizerBuilder {
	setDictionary(uri: string): void;
	setMode(mode: string): void;
	setKeepWhitespace(keep: boolean): void;
	build(): LinderaWasmTokenizer;
}
interface LinderaWasmTokenizer {
	tokenize(text: string): LinderaToken[];
}
interface LinderaToken {
	surface?: string;
	// lindera-wasm(UniDic) は品詞を top-level + 下位分類で返す（camelCase）。
	partOfSpeech?: string; // 名詞 / 動詞 / 代名詞 / 接尾辞 …
	partOfSpeechSubcategory1?: string; // 固有名詞 / 普通名詞 / 数詞 …
	partOfSpeechSubcategory2?: string; // 一般 / サ変可能 / 副詞可能 / 形状詞可能 / 人名 / 地名 …
	partOfSpeechSubcategory3?: string;
	// 英語辞書系など pos が配列/別名のこともあるため緩く受ける fallback。
	pos?: string | string[];
}

/**
 * Lindera（本命の形態素解析器）アダプタ。
 *
 * - WASM(nodejs target) なのでネイティブビルド不要・amd64/arm64 共通で動く。
 * - 辞書は UniDic を WASM に同梱（embedded://unidic）。別途ダウンロード不要。
 * - 依存が解決できない/初期化に失敗した環境では isAvailable() が false を返し、
 *   HanamiTokenizerService が Builtin に fallback する。
 * - 辞書ロード（数十MB）は重いので Tokenizer を一度だけ build してキャッシュし再利用する。
 *   呼び出しはトレンドの非同期インデックスワーカー経路（fire-and-forget）から行う前提。
 */
export class LinderaTokenizer implements HanamiTokenizer {
	public readonly name = 'lindera';

	private tokenizer: LinderaWasmTokenizer | null = null;
	private resolved = false;
	private available = false;

	private async resolve(): Promise<void> {
		if (this.resolved) return;
		this.resolved = true;
		try {
			// 動的import（specifier を変数にして tsc のモジュール解決を回避＝未install環境でも型エラーにしない）。
			const specifier = LINDERA_PACKAGE;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const mod: any = await import(specifier).catch(() => null);
			if (mod == null) return;

			// CJS(wasm-bindgen nodejs出力)を ESM から読むため default も見る。
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const TokenizerBuilder = mod.TokenizerBuilder ?? mod.default?.TokenizerBuilder;
			if (TokenizerBuilder == null) return;

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
			const builder: LinderaTokenizerBuilder = new TokenizerBuilder();
			builder.setDictionary(LINDERA_DICTIONARY);
			builder.setMode('normal');
			builder.setKeepWhitespace(false);
			this.tokenizer = builder.build();
			this.available = this.tokenizer != null;
		} catch {
			this.available = false;
			this.tokenizer = null;
		}
	}

	async isAvailable(): Promise<boolean> {
		await this.resolve();
		return this.available;
	}

	async tokenize(text: string): Promise<string[]> {
		return (await this.tokenizeWithKind(text)).map(t => t.term);
	}

	async tokenizeWithKind(text: string): Promise<HanamiTermToken[]> {
		await this.resolve();
		if (!this.available || this.tokenizer == null) return [];

		let tokens: LinderaToken[];
		try {
			tokens = this.tokenizer.tokenize(text);
		} catch {
			return [];
		}

		const out: HanamiTermToken[] = [];
		for (const t of tokens) {
			if (!this.isTopicNoun(t)) continue;
			const term = (t.surface ?? '').toString().trim().toLowerCase();
			if (term.length < HANAMI_MIN_TERM_LEN || term.length > HANAMI_MAX_TERM_LEN) continue;
			if (HANAMI_STOPWORDS.has(term)) continue;
			out.push({ term, proper: this.isProperNoun(t) });
		}
		return out;
	}

	// 固有名詞か（UniDic 下位分類 sub1=固有名詞 / 英語UD PROPN）。一定割合の固有名詞確保に使う。
	private isProperNoun(t: LinderaToken): boolean {
		if ((t.partOfSpeechSubcategory1 ?? '') === '固有名詞') return true;
		const pos = (Array.isArray(t.pos) ? t.pos.join(',') : (t.partOfSpeech ?? (t.pos as string) ?? '')).toString();
		return /\bPROPN\b/.test(pos) && !t.partOfSpeechSubcategory1;
	}

	/**
	 * 「話題を代表できる名詞」だけを通す品詞フィルタ（UniDic下位分類ベース）。
	 * 採用: 名詞-固有名詞（人名/地名/組織等）, 名詞-普通名詞（一般/サ変可能）。
	 * 除外: 代名詞・接尾辞・記号・動詞・形容詞・副詞等（top-levelで弾く）、
	 *       名詞-数詞（数）, 名詞-普通名詞-副詞可能（今日/最近 等の時間語）,
	 *       名詞-普通名詞-形状詞可能（最高/微妙 等の評価語）。
	 * 英語辞書系など下位分類が無い実装では top-level pos の NOUN/PROPN を採用（fallback）。
	 */
	private isTopicNoun(t: LinderaToken): boolean {
		const pos = (Array.isArray(t.pos) ? t.pos.join(',') : (t.partOfSpeech ?? (t.pos as string) ?? '')).toString();

		// 英語UD（下位分類なし）: NOUN/PROPN のみ
		if (/\b(NOUN|PROPN)\b/.test(pos) && !t.partOfSpeechSubcategory1) return true;

		if (pos !== '名詞') return false; // 代名詞/接尾辞/動詞/形容詞/助詞/記号 等は弾く
		const sub1 = t.partOfSpeechSubcategory1 ?? '';
		const sub2 = t.partOfSpeechSubcategory2 ?? '';
		if (sub1 !== '固有名詞' && sub1 !== '普通名詞') return false; // 数詞などを除外
		if (sub2 === '副詞可能' || sub2 === '形状詞可能') return false; // 時間語/評価語を除外
		return true;
	}
}
