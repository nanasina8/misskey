/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_MAX_TERM_LEN, HANAMI_MIN_TERM_LEN, HANAMI_STOPWORDS, type HanamiTermToken, type HanamiTokenizer } from './HanamiTokenizer.js';

// 本命の形態素解析器。WASM(nodejsターゲット) + UniDic(最新辞書, 辞書WASM同梱) を使う。
// パッケージ: lindera-wasm-nodejs-unidic（mosuka 公式, ネイティブビルド不要・全アーキ共通）。
const LINDERA_PACKAGE = 'lindera-wasm-nodejs-unidic';
const LINDERA_DICTIONARY = 'embedded://unidic';
const LOCATION_COMPOUND_TAIL_TERMS = new Set<string>([
	'駅', '線', '街', '市', '区', '町', '村', '県', '府', '都', '道',
]);
const TITLE_COMPOUND_TAIL_TERMS = new Set<string>([
	'首相', '議長', '総裁', '大統領',
]);
const GENERAL_COMPOUND_TAIL_TERMS = new Set<string>([
	'垢',
]);
const NAME_SUFFIX_TERMS = new Set<string>([
	'氏', 'さん', 'ちゃん', 'くん', '様', 'さま',
]);
const TOPIC_SUFFIX_TERMS = new Set<string>([
	'党', '庁', '医', '罪', '報', '値', '型', '選', '海', '器', '観', '人', '達', '系', '目', '者', '生', '高', 'ぶり',
]);

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
	byteEnd?: number;
	byteStart?: number;
	surface?: string;
	// lindera-wasm(UniDic) は品詞を top-level + 下位分類で返す（camelCase）。
	partOfSpeech?: string; // 名詞 / 動詞 / 代名詞 / 接尾辞 …
	partOfSpeechSubcategory1?: string; // 固有名詞 / 普通名詞 / 数詞 …
	partOfSpeechSubcategory2?: string; // 一般 / サ変可能 / 副詞可能 / 形状詞可能 / 人名 / 地名 …
	partOfSpeechSubcategory3?: string;
	// 英語辞書系など pos が配列/別名のこともあるため緩く受ける fallback。
	pos?: string | string[];
	wordType?: string;
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
		const covered = new Set<number>();

		for (let i = 0; i < tokens.length; i++) {
			const compound = this.collectCompound(tokens, i);
			if (compound == null) continue;
			out.push(compound.token);
			for (let j = i; j <= compound.endIndex; j++) covered.add(j);
			i = compound.endIndex;
		}

		for (let i = 0; i < tokens.length; i++) {
			if (covered.has(i)) continue;
			const t = tokens[i];
			if (!this.isTopicNoun(t)) continue;
			const term = (t.surface ?? '').toString().trim().toLowerCase();
			if (term.length < HANAMI_MIN_TERM_LEN || term.length > HANAMI_MAX_TERM_LEN) continue;
			if (this.shouldDropTerm(term, t)) continue;
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

	private collectCompound(tokens: LinderaToken[], startIndex: number): { token: HanamiTermToken; endIndex: number } | null {
		const first = tokens[startIndex];
		if (!this.canStartCompound(first)) return null;

		let endIndex = startIndex;
		let term = (first.surface ?? '').toString();
		let proper = this.isProperNoun(first);
		let humanProperParts = this.isHumanProperNoun(first) ? 1 : 0;

		for (let i = startIndex + 1; i < tokens.length; i++) {
			const prev = tokens[i - 1];
			const current = tokens[i];
			if (!this.isAdjacent(prev, current)) break;
			if (!this.canContinueCompound(first, prev, current, humanProperParts)) break;

			term += (current.surface ?? '').toString();
			proper = proper || this.isProperNoun(current);
			if (this.isHumanProperNoun(current)) humanProperParts++;
			endIndex = i;

			if (term.length >= HANAMI_MAX_TERM_LEN) break;
		}

		if (endIndex === startIndex) return null;

		const normalized = term.trim().toLowerCase();
		if (normalized.length < HANAMI_MIN_TERM_LEN || normalized.length > HANAMI_MAX_TERM_LEN) return null;
		if (this.shouldDropTerm(normalized, first)) return null;

		return {
			token: { term: normalized, proper },
			endIndex,
		};
	}

	private canStartCompound(t: LinderaToken): boolean {
		return this.isTopicNoun(t);
	}

	private canContinueCompound(first: LinderaToken, prev: LinderaToken, current: LinderaToken, humanProperParts: number): boolean {
		if (this.canContinueProperCompound(prev, current)) return humanProperParts < 2;
		if (this.canContinueGroupCompound(first, prev, current)) return true;

		return this.canContinueTailCompound(first, prev, current);
	}

	private canContinueProperCompound(prev: LinderaToken, current: LinderaToken): boolean {
		if (!this.isProperNoun(prev) || !this.isProperNoun(current)) return false;
		// 連続固有名詞は人名の姓+名を主目的にする。地名の連続は住所や列挙で過結合しやすい。
		return prev.partOfSpeechSubcategory2 === '人名' && current.partOfSpeechSubcategory2 === '人名';
	}

	private canContinueGroupCompound(first: LinderaToken, prev: LinderaToken, current: LinderaToken): boolean {
		const term = (current.surface ?? '').toString().trim().toLowerCase();
		const prevTerm = (prev.surface ?? '').toString().trim().toLowerCase();

		if (this.isProperNoun(first) && term === '会') return true;
		return this.isProperNoun(first) && prevTerm === '会' && term === '系';
	}

	private canContinueTailCompound(first: LinderaToken, prev: LinderaToken, current: LinderaToken): boolean {
		const term = (current.surface ?? '').toString().trim().toLowerCase();
		const pos = (Array.isArray(current.pos) ? current.pos.join(',') : (current.partOfSpeech ?? (current.pos as string) ?? '')).toString();
		if (TITLE_COMPOUND_TAIL_TERMS.has(term)) return this.isProperNoun(prev);
		if (LOCATION_COMPOUND_TAIL_TERMS.has(term)) return this.canAttachLocationTail(first, prev);
		if (GENERAL_COMPOUND_TAIL_TERMS.has(term)) return true;
		if (pos === '接尾辞' && (current.partOfSpeechSubcategory1 ?? '') === '名詞的') {
			if (NAME_SUFFIX_TERMS.has(term)) return this.canAttachNameSuffix(prev);
			return TOPIC_SUFFIX_TERMS.has(term) && !this.shouldDropTerm((prev.surface ?? '').toString().trim().toLowerCase(), prev);
		}

		return false;
	}

	private canAttachLocationTail(first: LinderaToken, prev: LinderaToken): boolean {
		if (prev.partOfSpeechSubcategory2 === '地名') return true;

		const term = (prev.surface ?? '').toString().trim().toLowerCase();
		if (['地下', '山手'].includes(term)) return true;

		const firstTerm = (first.surface ?? '').toString().trim().toLowerCase();
		return ['地下', '山手'].includes(firstTerm);
	}

	private isHumanProperNoun(t: LinderaToken): boolean {
		return this.isProperNoun(t) && t.partOfSpeechSubcategory2 === '人名';
	}

	private canAttachNameSuffix(prev: LinderaToken): boolean {
		if (this.isProperNoun(prev)) return true;

		const term = (prev.surface ?? '').toString().trim().toLowerCase();
		return /^[一-鿿㐀-䶿々]{2,}$/.test(term) && !this.shouldDropTerm(term, prev);
	}

	private isAdjacent(prev: LinderaToken, current: LinderaToken): boolean {
		return prev.byteEnd != null && current.byteStart != null && prev.byteEnd === current.byteStart;
	}

	private shouldDropTerm(term: string, source?: LinderaToken): boolean {
		if (HANAMI_STOPWORDS.has(term)) return true;
		if (source != null && this.isWeakHiraganaCommonNoun(term, source)) return true;
		return false;
	}

	private isWeakHiraganaCommonNoun(term: string, t: LinderaToken): boolean {
		return /^[ぁ-ゟー]+$/.test(term) &&
			t.partOfSpeech === '名詞' &&
			t.partOfSpeechSubcategory1 === '普通名詞' &&
			t.partOfSpeechSubcategory2 !== '固有名詞';
	}
}
