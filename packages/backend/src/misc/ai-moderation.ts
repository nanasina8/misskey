/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';

/**
 * AI 投稿チェックで使う純粋関数（DB や Redis に触らない）。テストしやすくするため独立させている。
 */

export const AI_MODERATION_TRIGGERS = ['unsolicitedContact', 'newAuthorLink', 'newLocalContact'] as const;
export type AiModerationTrigger = typeof AI_MODERATION_TRIGGERS[number];

export const AI_MODERATION_LABELS = ['normal', 'spam', 'scam', 'abuse'] as const;
export type AiModerationLocalLabel = typeof AI_MODERATION_LABELS[number];
export type AiModerationScores = Record<(typeof AI_MODERATION_LABELS)[number], number>;

export type AiModerationContact = {
	userId: string;
	followsAuthor: boolean;
};

export type AiModerationTriggerInput = {
	authorIsRemote: boolean;
	authorFirstSeenAt: Date;
	authorHasLocalFollowers: boolean;
	contacts: readonly AiModerationContact[];
	text: string | null;
	cw: string | null;
	newAuthorDays: number;
	localHost: string;
	/** 判定の基準時刻（既定は今）。過去の投稿を調べるときは投稿時刻を渡す */
	now?: Date;
};

function isNewAuthor(input: AiModerationTriggerInput): boolean {
	const elapsed = (input.now?.getTime() ?? Date.now()) - input.authorFirstSeenAt.getTime();
	return elapsed < input.newAuthorDays * 24 * 60 * 60 * 1000;
}

/**
 * 事前の絞り込み。当たった理由の配列を返す（空なら対象外）。
 */
export function computeAiModerationTriggers(input: AiModerationTriggerInput): AiModerationTrigger[] {
	const triggers: AiModerationTrigger[] = [];

	const isNew = isNewAuthor(input);
	const hasUnfollowingContact = input.contacts.some(contact => !contact.followsAuthor);

	if (input.authorIsRemote && input.contacts.length >= 1 && !input.authorHasLocalFollowers && hasUnfollowingContact) {
		triggers.push('unsolicitedContact');
	}

	if (isNew && extractAiModerationLinksFromNote(input.text, input.cw, input.localHost).length > 0) {
		triggers.push('newAuthorLink');
	}

	if (!input.authorIsRemote && isNew && hasUnfollowingContact) {
		triggers.push('newLocalContact');
	}

	return triggers;
}

const URL_SCHEME_RE = /https?:\/\/[^\s"'<>]+/g;
const SCHEMELESS_RE = /(?<![a-zA-Z0-9.-])([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)*\.[a-zA-Z]{2,})\/([^\s"'<>()\[\]【】（）]+)/g;
const MENTION_RE = /@[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?/g;

/**
 * ドメインとパスを `ドメイン(小文字)/最初のパス要素` のキーへ正規化する。
 * 自サーバーのホストや空は null を返す。
 */
function linkKey(domain: string, path: string, local: string): string | null {
	const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
	if (normalized === '' || normalized === local) return null;
	const first = path.split('/').find(segment => segment.length > 0);
	return first ? `${normalized}/${first}` : normalized;
}

function urlMatchToKey(url: string, local: string): string | null {
	const rest = url.replace(/^https?:\/\//, '');
	const slash = rest.indexOf('/');
	const domain = slash === -1 ? rest : rest.slice(0, slash);
	const path = slash === -1 ? '' : rest.slice(slash + 1);
	return linkKey(domain, path, local);
}

/**
 * 本文からリンクを取り出し、`ドメイン(小文字)/最初のパス要素` の形のキーの重複なし配列を返す。
 * `https://` 付きの URL と、スキーム無しの `ドメイン/パス` の両方を拾う。メンションは先に取り除く。
 * パス無しのスキーム無しドメイン（例 `example.com`）は誤検出が多いので拾わない。
 * 自サーバーのホストへのリンクは数えない。
 */
export function extractAiModerationLinks(text: string | null, localHost: string): string[] {
	if (text == null || text.length === 0) return [];

	const local = localHost.trim().toLowerCase();
	const results = new Set<string>();

	// メンション（@user@host / @user）を先に取り除く。
	const stripped = text.replace(MENTION_RE, ' ');

	for (const match of stripped.matchAll(URL_SCHEME_RE)) {
		const key = urlMatchToKey(match[0], local);
		if (key != null) results.add(key);
	}

	// スキーム付き URL を除いたうえで、スキーム無し `ドメイン/パス` を拾う。
	const withoutScheme = stripped.replace(URL_SCHEME_RE, ' ');
	for (const match of withoutScheme.matchAll(SCHEMELESS_RE)) {
		const key = linkKey(match[1], match[2], local);
		if (key != null) results.add(key);
	}

	return [...results];
}

/**
 * 本文と CW の両方からリンクを取り出す。`computeAiModerationTriggers` が CW 内のリンクも
 * 判定できるようにするための補助。
 */
export function extractAiModerationLinksFromNote(text: string | null, cw: string | null, localHost: string): string[] {
	const combined = [cw, text]
		.filter((part): part is string => part != null && part.length > 0)
		.join('\n');
	return extractAiModerationLinks(combined, localHost);
}

/**
 * 判定記録の `textFingerprint` に使う文の正規化。
 * メンションを消す → URL・スキーム無しリンクを `domain/最初のパス` キーへ置換 →
 * 末尾の「空白＋英小文字2〜6文字」を1回だけ消す（`ormh` 対策）→ 連続空白を1つに →
 * 前後空白除去 → 小文字化。
 */
export function normalizeAiModerationText(text: string | null, localHost: string): string {
	if (text == null || text.length === 0) return '';

	const local = localHost.trim().toLowerCase();

	let s = text.replace(MENTION_RE, ' ');

	// URL（https://）をキーへ
	s = s.replace(URL_SCHEME_RE, (url) => urlMatchToKey(url, local) ?? ' ');

	// スキーム無し `ドメイン/パス` をキーへ
	s = s.replace(SCHEMELESS_RE, (_whole, domain: string, path: string) => linkKey(domain, path, local) ?? ' ');

	// 末尾の「空白＋英小文字2〜6文字」を1回だけ消す
	s = s.replace(/\s+[a-z]{2,6}$/, '');

	// 連続空白を1つに
	s = s.replace(/\s+/g, ' ');

	return s.trim().toLowerCase();
}

/**
 * 正規化した本文の sha256 先頭32文字（hex）。本文が空なら null。
 */
export function computeAiModerationTextFingerprint(text: string | null, localHost: string): string | null {
	if (text == null || text.trim().length === 0) return null;
	const normalized = normalizeAiModerationText(text, localHost);
	if (normalized.length === 0) return null;
	return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * 引っかけるかどうか。`localLabel` は4つの確率のうち最大のもの。
 */
export function decideAiModerationFlag(
	scores: AiModerationScores | null,
	externalFlagged: boolean | null,
	threshold: number,
): {
	flagged: boolean;
	localLabel: AiModerationLocalLabel | null;
} {
	const spamScam = scores != null ? scores.spam + scores.scam : 0;
	const abuse = scores != null ? scores.abuse : 0;
	const flagged = (scores != null && (spamScam >= threshold || abuse >= threshold)) || externalFlagged === true;

	let localLabel: AiModerationLocalLabel | null = null;
	if (scores != null) {
		localLabel = AI_MODERATION_LABELS.reduce((a, b) => (scores[a] >= scores[b] ? a : b));
	}

	return { flagged, localLabel };
}

export const AI_MODERATION_STRONG_MIN_ACCOUNTS = 3;

export type AiModerationSeverity = 'strong' | 'partial' | 'none';

export type AiModerationHostStats = {
	/** このサーバーのユーザーがそのホストのユーザーをフォローしている数 */
	localFollowersCount: number;
	/** 窓内で引っかけた投稿の件数 */
	flaggedCount: number;
	/** 窓内で引っかけた投稿のアカウント数 */
	flaggedAccountCount: number;
};

/**
 * 怪しさの段階。`strong` は「自鯖フォロワー0 かつ 引っかけたアカウントが N 以上」。
 */
export function classifyAiModerationHost(stats: AiModerationHostStats): AiModerationSeverity {
	if (stats.flaggedCount === 0) return 'none';
	if (stats.localFollowersCount === 0 && stats.flaggedAccountCount >= AI_MODERATION_STRONG_MIN_ACCOUNTS) return 'strong';
	return 'partial';
}

export type AiModerationRecommendation = 'blockHost' | 'suspendAccounts' | null;

export function recommendAiModerationAction(severity: AiModerationSeverity): AiModerationRecommendation {
	switch (severity) {
		case 'strong': return 'blockHost';
		case 'partial': return 'suspendAccounts';
		case 'none': return null;
	}
}

export type AiModerationAccountSignalsInput = {
	username: string;
	avatarId: string | null;
	text: string | null;
};

export type AiModerationAccountSignals = {
	noAvatar: boolean;
	namePattern: string;
	trailingNoise: boolean;
};

/**
 * username の「型」を返す。英字の連続は `a+`、数字/英数の連続は長さ付き（例 `aoi_4kyqyj` → `a+_x6`）。
 */
export function aiModerationNamePattern(username: string): string {
	let out = '';
	let i = 0;
	while (i < username.length) {
		const ch = username[i]!;
		if (/[a-zA-Z0-9]/.test(ch)) {
			let j = i;
			while (j < username.length && /[a-zA-Z0-9]/.test(username[j]!)) j++;
			const run = username.slice(i, j);
			out += /^[a-zA-Z]+$/.test(run) ? 'a+' : `x${run.length}`;
			i = j;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/**
 * アカウントの目印（アイコン無し / ユーザー名の型 / 文末のランダム英字）。
 */
export function aiModerationAccountSignals(user: AiModerationAccountSignalsInput): AiModerationAccountSignals {
	return {
		noAvatar: user.avatarId == null,
		namePattern: aiModerationNamePattern(user.username),
		trailingNoise: user.text != null && /\s+[a-z]{2,6}$/.test(user.text),
	};
}

export type AiModerationGroupBy = 'host' | 'link' | 'fingerprint';

export type AiModerationGroupRow = {
	noteUserHost: string | null;
	links: readonly string[];
	textFingerprint: string | null;
};

/**
 * まとめ表示で行が属するグループのキーを返す。host のとき null はこのサーバー自身。
 */
export function aiModerationGroupKeys(row: AiModerationGroupRow, groupBy: AiModerationGroupBy): Array<string | null> {
	switch (groupBy) {
		case 'host': return [row.noteUserHost];
		case 'link': return [...new Set(row.links)];
		case 'fingerprint': return row.textFingerprint != null ? [row.textFingerprint] : [];
	}
}

export type AiModerationBulkCountDecision =
	| { ok: true }
	| { ok: false; reason: 'countMismatch' | 'tooMany' };

/**
 * bulk 操作の件数ガード。画面で見せた件数と食い違ったら止める（countMismatch）。
 * 上限を超えても止める（tooMany）。
 */
export function decideAiModerationBulkCount(actualCount: number, expectedCount: number, maxItems: number): AiModerationBulkCountDecision {
	if (actualCount !== expectedCount) return { ok: false, reason: 'countMismatch' };
	if (actualCount > maxItems) return { ok: false, reason: 'tooMany' };
	return { ok: true };
}

export type AiModerationBulkSuspendSkipReason = 'admin' | 'moderator' | 'localOld' | 'alreadySuspended';

export type AiModerationBulkSuspendSkipInput = {
	isAdministrator: boolean;
	isModerator: boolean;
	isLocal: boolean;
	isOlderThanNewAuthorDays: boolean;
	isAlreadySuspended: boolean;
};

/**
 * bulk-suspend で飛ばす理由を返す（飛ばさないなら null）。
 * 凍結済み > 管理者 > モデレーター > 古いローカルユーザー。
 */
export function decideAiModerationBulkSuspendSkip(input: AiModerationBulkSuspendSkipInput): AiModerationBulkSuspendSkipReason | null {
	if (input.isAlreadySuspended) return 'alreadySuspended';
	if (input.isAdministrator) return 'admin';
	if (input.isModerator) return 'moderator';
	if (input.isLocal && input.isOlderThanNewAuthorDays) return 'localOld';
	return null;
}

export type AiModerationGroupSampleInput = {
	noteUserId: string;
	noteUserHost: string | null;
	createdAt: Date;
	localLabel: string | null;
	localScores: Record<string, number> | null;
	noteText: string;
	links: readonly string[];
	textFingerprint: string | null;
	contactUserIds: readonly string[];
	triggers: readonly string[];
};

export type AiModerationGroupStats = {
	key: string | null;
	flaggedCount: number;
	accountCount: number;
	targetCount: number;
	deliveryCount: number;
	firstAt: string;
	lastAt: string;
	peakPerHour: number;
	peakAccountsPerHour: number;
	labelCounts: Record<string, number>;
	avgSpamScore: number | null;
	maxPerAccount: number;
	trailingNoiseRatio: number;
	hosts?: Array<{ host: string | null; accounts: number }>;
	samples?: Array<{ text: string; count: number }>;
};

const TRAILING_NOISE_RE = /\s+[a-z]{2,6}$/;

/**
 * まとめ表示の1グループを集計する（DB / Redis に触らない純粋関数）。
 * firstAt / lastAt / peakPerHour は投稿時刻（createdAt）で数える。
 */
export function buildAiModerationGroup(
	key: string | null,
	recs: readonly AiModerationGroupSampleInput[],
	groupBy: AiModerationGroupBy,
): AiModerationGroupStats {
	const accountIds = [...new Set(recs.map(r => r.noteUserId))];
	const targetIds = new Set<string>();
	let deliveryCount = 0;
	const hours = new Map<number, number>();
	const hourAccounts = new Map<number, Set<string>>();
	const labelCounts: Record<string, number> = {};
	let spamScoreSum = 0;
	let spamScoreCount = 0;
	const perAccount = new Map<string, number>();
	let firstAt: Date | null = null;
	let lastAt: Date | null = null;

	for (const rec of recs) {
		for (const targetId of rec.contactUserIds) {
			targetIds.add(targetId);
			deliveryCount++;
		}

		const hour = Math.floor(rec.createdAt.getTime() / 3600000);
		hours.set(hour, (hours.get(hour) ?? 0) + 1);
		let hourSet = hourAccounts.get(hour);
		if (hourSet == null) {
			hourSet = new Set();
			hourAccounts.set(hour, hourSet);
		}
		hourSet.add(rec.noteUserId);

		labelCounts[rec.localLabel ?? 'null'] = (labelCounts[rec.localLabel ?? 'null'] ?? 0) + 1;

		if (rec.localScores != null) {
			spamScoreSum += (rec.localScores.spam ?? 0) + (rec.localScores.scam ?? 0);
			spamScoreCount++;
		}

		perAccount.set(rec.noteUserId, (perAccount.get(rec.noteUserId) ?? 0) + 1);

		if (firstAt == null || rec.createdAt.getTime() < firstAt.getTime()) firstAt = rec.createdAt;
		if (lastAt == null || rec.createdAt.getTime() > lastAt.getTime()) lastAt = rec.createdAt;
	}

	const trailingNoiseAccounts = new Set<string>();
	for (const rec of recs) {
		if (TRAILING_NOISE_RE.test(rec.noteText)) trailingNoiseAccounts.add(rec.noteUserId);
	}

	const group: AiModerationGroupStats = {
		key,
		flaggedCount: recs.length,
		accountCount: accountIds.length,
		targetCount: targetIds.size,
		deliveryCount,
		firstAt: (firstAt ?? new Date(0)).toISOString(),
		lastAt: (lastAt ?? new Date(0)).toISOString(),
		peakPerHour: hours.size === 0 ? 0 : Math.max(...hours.values()),
		peakAccountsPerHour: hourAccounts.size === 0 ? 0 : Math.max(...[...hourAccounts.values()].map(s => s.size)),
		labelCounts,
		avgSpamScore: spamScoreCount === 0 ? null : spamScoreSum / spamScoreCount,
		maxPerAccount: perAccount.size === 0 ? 0 : Math.max(...perAccount.values()),
		trailingNoiseRatio: accountIds.length === 0 ? 0 : trailingNoiseAccounts.size / accountIds.length,
	};

	if (groupBy === 'link' || groupBy === 'fingerprint') {
		// hosts: host 別アカウント数（多い順に最大5）
		const hostAccounts = new Map<string | null, Set<string>>();
		for (const rec of recs) {
			let set = hostAccounts.get(rec.noteUserHost);
			if (set == null) {
				set = new Set();
				hostAccounts.set(rec.noteUserHost, set);
			}
			set.add(rec.noteUserId);
		}
		group.hosts = [...hostAccounts.entries()]
			.map(([host, accounts]) => ({ host, accounts: accounts.size }))
			.sort((a, b) => b.accounts - a.accounts)
			.slice(0, 5);

		group.samples = buildAiModerationGroupSamples(recs, groupBy);
	}

	return group;
}

function buildAiModerationGroupSamples(recs: readonly AiModerationGroupSampleInput[], groupBy: AiModerationGroupBy): Array<{ text: string; count: number }> {
	if (groupBy === 'fingerprint') {
		const textCounts = new Map<string, number>();
		for (const rec of recs) {
			textCounts.set(rec.noteText, (textCounts.get(rec.noteText) ?? 0) + 1);
		}
		return [...textCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([text, count]) => ({ text, count }));
	}

	// link: 指紋ごとにまとめる
	const fpCounts = new Map<string, { count: number; text: string }>();
	for (const rec of recs) {
		const fp = rec.textFingerprint ?? rec.noteText;
		const entry = fpCounts.get(fp);
		if (entry != null) {
			entry.count++;
		} else {
			fpCounts.set(fp, { count: 1, text: rec.noteText });
		}
	}
	return [...fpCounts.values()]
		.sort((a, b) => b.count - a.count)
		.slice(0, 3)
		.map(entry => ({ text: entry.text, count: entry.count }));
}

export const AI_MODERATION_SPAM_SIGNALS = [
	'strangerContact',
	'manyStrangers',
	'sameTextOtherAccounts',
	'repeatedText',
	'sameLinkOtherAccounts',
	'hostWave',
	'noAvatar',
	'trailingNoise',
] as const;
export type AiModerationSpamSignal = typeof AI_MODERATION_SPAM_SIGNALS[number];

/** 広げ方の目印。これが1つも無ければ、AI の点数がいくら高くても自動では隠さない */
export const AI_MODERATION_SPREAD_SIGNALS: ReadonlySet<AiModerationSpamSignal> = new Set(['strangerContact', 'manyStrangers', 'sameTextOtherAccounts', 'repeatedText']);

export const AI_MODERATION_SPAM_SIGNAL_POINTS: Record<AiModerationSpamSignal, number> = {
	strangerContact: 2,
	manyStrangers: 2,
	sameTextOtherAccounts: 3,
	repeatedText: 2,
	sameLinkOtherAccounts: 1,
	hostWave: 1,
	noAvatar: 1,
	trailingNoise: 1,
};

/** 自動で隠すのに要る点数 */
export const AI_MODERATION_AUTO_HIDE_MIN_POINTS = 4;

export type AiModerationSpamEvidenceInput = {
	/** 頼まれていない接触（フォローされていない相手への DM・メンション・リプライ） */
	strangerContact: boolean;
	/** 24時間で接触した、フォローされていないこのサーバーの相手の人数 */
	strangers24h: number;
	/** 72時間で同じ文（正規化後）を引っかけられた、ほかのアカウントの数 */
	sameTextOtherAccounts: number;
	/** 72時間で同じアカウントが同じ文を出した回数（今回を含む） */
	sameTextSameAccount: number;
	/** 72時間で同じリンクを貼って引っかけられた、ほかのアカウントの数 */
	sameLinkOtherAccounts: number;
	/** 24時間で同じサーバーから引っかけられた、ほかのアカウントの数（このサーバーのユーザーは 0） */
	hostOtherFlaggedAccounts: number;
	noAvatar: boolean;
	trailingNoise: boolean;
};

/**
 * スパムらしさの根拠を行動から集める（AI の点数とは別）。
 * リンクを貼っただけでは何も付かない。知らない人へ送る・同じ文をばらまく・複数アカウントで同じことをする、が本体。
 */
export function collectAiModerationSpamSignals(input: AiModerationSpamEvidenceInput): AiModerationSpamSignal[] {
	const signals: AiModerationSpamSignal[] = [];
	if (input.strangerContact) signals.push('strangerContact');
	if (input.strangers24h >= 3) signals.push('manyStrangers');
	if (input.sameTextOtherAccounts >= 1) signals.push('sameTextOtherAccounts');
	if (input.sameTextSameAccount >= 3) signals.push('repeatedText');
	if (input.sameLinkOtherAccounts >= 2) signals.push('sameLinkOtherAccounts');
	if (input.hostOtherFlaggedAccounts >= 2) signals.push('hostWave');
	if (input.noAvatar) signals.push('noAvatar');
	if (input.trailingNoise) signals.push('trailingNoise');
	return signals;
}

export function scoreAiModerationSpamSignals(signals: readonly string[]): { points: number; hasSpread: boolean } {
	let points = 0;
	let hasSpread = false;
	for (const signal of signals) {
		const value = AI_MODERATION_SPAM_SIGNAL_POINTS[signal as AiModerationSpamSignal];
		if (value == null) continue;
		points += value;
		if (AI_MODERATION_SPREAD_SIGNALS.has(signal as AiModerationSpamSignal)) hasSpread = true;
	}
	return { points, hasSpread };
}

export type AiModerationAutoHideInput = {
	flagged: boolean;
	localScores: AiModerationScores | null;
	externalFlagged: boolean | null;
	threshold: number;
	signals: readonly string[];
	authorIsRemote: boolean;
	authorIsNew: boolean;
	authorHasLocalFollowers: boolean;
};

/**
 * 自動で隠すかどうか（アカウント単位）。すべて満たすときだけ true。
 * 1. 引っかかった 2. Qwen の spam+scam が閾値以上（Qwen が無ければ外部 API の判定）
 * 3. 広げ方の目印（知らない人へ送る・同じ文のばらまき）があり、根拠の点数が足りる
 * 4. このサーバーで誰にもフォローされていない 5. このサーバーの古いユーザーではない
 */
export function decideAiModerationAutoHide(input: AiModerationAutoHideInput): boolean {
	if (!input.flagged) return false;
	const strongEnough = input.localScores != null
		? input.localScores.spam + input.localScores.scam >= input.threshold
		: input.externalFlagged === true;
	if (!strongEnough) return false;
	const { points, hasSpread } = scoreAiModerationSpamSignals(input.signals);
	if (!hasSpread || points < AI_MODERATION_AUTO_HIDE_MIN_POINTS) return false;
	if (input.authorHasLocalFollowers) return false;
	if (!input.authorIsRemote && !input.authorIsNew) return false;
	return true;
}

export type AiModerationAccountState = 'suspended' | 'deleted' | 'hidden' | 'unhidden' | 'open';

export type AiModerationOutcomeRow = {
	userId: string;
	host: string | null;
	/** 自動で隠す判定に当たったか（none / 試運転で隠すはずだった / 実際に隠した） */
	auto: 'none' | 'wouldHide' | 'hidden';
	signals: readonly string[];
	/** このサーバーで凍結 */
	isSuspended: boolean;
	/** 相手のサーバーで消された（凍結・削除で Delete が届いた）か、行ごと無くなった */
	isDeleted: boolean;
	/** いま隠している（アカウントかサーバー） */
	isHidden: boolean;
	/** 期間内に人が「隠すのをやめる」を押した */
	wasUnhidden: boolean;
	/** いちばん新しい判定の判定条件の版 */
	criteriaVersion?: string | null;
};

/** 凍結 > 相手のサーバーで消えた > 隠すのをやめた > 隠している > 何もしていない */
export function aiModerationAccountState(row: AiModerationOutcomeRow): AiModerationAccountState {
	if (row.isSuspended) return 'suspended';
	if (row.isDeleted) return 'deleted';
	if (row.wasUnhidden && !row.isHidden) return 'unhidden';
	if (row.isHidden) return 'hidden';
	return 'open';
}

type StateCounts = Record<AiModerationAccountState, number>;

function emptyCounts(): StateCounts {
	return { suspended: 0, deleted: 0, hidden: 0, unhidden: 0, open: 0 };
}

export type AiModerationOutcomes = {
	accounts: number;
	byState: StateCounts;
	/** 自動で隠す判定に当たったアカウント（試運転の「隠すはずだった」を含む）のその後 */
	auto: StateCounts & { accounts: number; wouldHide: number; autoHidden: number };
	/** 自動では隠さなかったアカウントのその後（凍結・消えたものは取りこぼし） */
	notAuto: StateCounts & { accounts: number };
	/** 自動の当たりのうち、凍結か消えた割合（人が外したものを外れとみなす）。母数 0 なら null */
	autoConfirmedRate: number | null;
	bySignal: Array<{ signal: string; accounts: number; suspendedOrDeleted: number; unhidden: number }>;
	/** 判定条件の版ごと（判定器や閾値を変えたら、ここで前後を比べる） */
	byCriteria: Array<{ version: string | null; accounts: number; autoAccounts: number; suspendedOrDeleted: number; unhidden: number }>;
};

/**
 * 判定したアカウントが、その後どうなったか（凍結・相手のサーバーで消えた・隠すのをやめた）を集計する。
 * 自動で隠す条件の当たり外れを、人の判断（凍結／外す）と相手のサーバーの判断（消える）で測るために使う。
 */
export function summarizeAiModerationOutcomes(rows: readonly AiModerationOutcomeRow[]): AiModerationOutcomes {
	const byState = emptyCounts();
	const auto = { ...emptyCounts(), accounts: 0, wouldHide: 0, autoHidden: 0 };
	const notAuto = { ...emptyCounts(), accounts: 0 };
	const signals = new Map<string, { accounts: number; suspendedOrDeleted: number; unhidden: number }>();
	const criteria = new Map<string | null, { accounts: number; autoAccounts: number; suspendedOrDeleted: number; unhidden: number }>();

	for (const row of rows) {
		const state = aiModerationAccountState(row);
		byState[state]++;
		if (row.auto !== 'none') {
			auto.accounts++;
			auto[state]++;
			if (row.auto === 'hidden') auto.autoHidden++; else auto.wouldHide++;
		} else {
			notAuto.accounts++;
			notAuto[state]++;
		}
		const version = row.criteriaVersion ?? null;
		let byVersion = criteria.get(version);
		if (byVersion == null) {
			byVersion = { accounts: 0, autoAccounts: 0, suspendedOrDeleted: 0, unhidden: 0 };
			criteria.set(version, byVersion);
		}
		byVersion.accounts++;
		if (row.auto !== 'none') byVersion.autoAccounts++;
		if (state === 'suspended' || state === 'deleted') byVersion.suspendedOrDeleted++;
		if (state === 'unhidden') byVersion.unhidden++;
		for (const signal of new Set(row.signals)) {
			let entry = signals.get(signal);
			if (entry == null) {
				entry = { accounts: 0, suspendedOrDeleted: 0, unhidden: 0 };
				signals.set(signal, entry);
			}
			entry.accounts++;
			if (state === 'suspended' || state === 'deleted') entry.suspendedOrDeleted++;
			if (state === 'unhidden') entry.unhidden++;
		}
	}

	const confirmed = auto.suspended + auto.deleted;
	const judged = confirmed + auto.unhidden;

	return {
		accounts: rows.length,
		byState,
		auto,
		notAuto,
		autoConfirmedRate: judged === 0 ? null : confirmed / judged,
		bySignal: [...signals.entries()]
			.map(([signal, v]) => ({ signal, ...v }))
			.sort((a, b) => b.accounts - a.accounts),
		byCriteria: [...criteria.entries()]
			.map(([version, v]) => ({ version, ...v }))
			.sort((a, b) => b.accounts - a.accounts),
	};
}

/**
 * 判定条件の版。判定器（モデル・スクリプト＝プロンプト）や閾値・点数を変えたら版が変わる。
 * 判定記録・全体スキャンにこの版を残し、後から「どの条件で引っかけたか」を比べられるようにする。
 */
export type AiModerationCriteria = {
	/** 形式の版（この型を変えたら上げる） */
	schema: 1;
	model: string;
	/** 判定スクリプト（プロンプト込み）の sha256 先頭16文字 */
	judgeScriptSha: string | null;
	localThreshold: number;
	autoHideThreshold: number;
	autoHideMinPoints: number;
	signalPoints: Record<string, number>;
	spreadSignals: string[];
	newAuthorDays: number;
	externalEnabled: boolean;
	externalModel: string | null;
};

export function buildAiModerationCriteria(input: {
	model: string;
	judgeScriptSha: string | null;
	localThreshold: number;
	autoHideThreshold: number;
	newAuthorDays: number;
	externalEnabled: boolean;
	externalModel: string | null;
}): AiModerationCriteria {
	return {
		schema: 1,
		model: input.model,
		judgeScriptSha: input.judgeScriptSha,
		localThreshold: input.localThreshold,
		autoHideThreshold: input.autoHideThreshold,
		autoHideMinPoints: AI_MODERATION_AUTO_HIDE_MIN_POINTS,
		signalPoints: { ...AI_MODERATION_SPAM_SIGNAL_POINTS },
		spreadSignals: [...AI_MODERATION_SPREAD_SIGNALS].sort(),
		newAuthorDays: input.newAuthorDays,
		externalEnabled: input.externalEnabled,
		externalModel: input.externalEnabled ? input.externalModel : null,
	};
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value != null && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

/** 条件の中身から決まる版の名前（sha256 先頭12文字）。キーの順番には左右されない */
export function aiModerationCriteriaVersion(criteria: AiModerationCriteria): string {
	return createHash('sha256').update(stableStringify(criteria)).digest('hex').slice(0, 12);
}
