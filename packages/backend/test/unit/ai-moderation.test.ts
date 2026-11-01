/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect } from 'vitest';
import {
	aiModerationAccountSignals,
	aiModerationGroupKeys,
	aiModerationNamePattern,
	buildAiModerationGroup,
	classifyAiModerationHost,
	computeAiModerationTextFingerprint,
	computeAiModerationTriggers,
	decideAiModerationBulkCount,
	decideAiModerationBulkSuspendSkip,
	collectAiModerationSpamSignals,
	decideAiModerationAutoHide,
	decideAiModerationFlag,
	scoreAiModerationSpamSignals,
	summarizeAiModerationOutcomes,
	buildAiModerationCriteria,
	aiModerationScanPostsPerTick,
	aiModerationScanWallSeconds,
	aiModerationCriteriaVersion,
	aiModerationAccountState,
	type AiModerationOutcomeRow,
	extractAiModerationLinks,
	normalizeAiModerationText,
	type AiModerationGroupSampleInput,
	type AiModerationTriggerInput,
} from '@/misc/ai-moderation.js';

const LOCAL_HOST = 'misskey.example.com';
const NOW = Date.now();

function triggerInput(overrides: Partial<AiModerationTriggerInput> = {}): AiModerationTriggerInput {
	return {
		authorIsRemote: true,
		authorFirstSeenAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000),
		authorHasLocalFollowers: false,
		contacts: [],
		text: null,
		cw: null,
		newAuthorDays: 7,
		localHost: LOCAL_HOST,
		...overrides,
	};
}

const NEW = new Date(NOW - 60 * 60 * 1000); // 1時間前
const OLD = new Date(NOW - 30 * 24 * 60 * 60 * 1000); // 30日前

describe('computeAiModerationTriggers', () => {
	test('他鯖・自鯖フォロワー0・宛先が未フォロー → unsolicitedContact', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: true,
			authorFirstSeenAt: OLD,
			authorHasLocalFollowers: false,
			contacts: [{ userId: 'b', followsAuthor: false }],
		}));
		expect(triggers).toContain('unsolicitedContact');
	});

	test('宛先がフォロー済みなら unsolicitedContact は出ない', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: true,
			authorFirstSeenAt: OLD,
			authorHasLocalFollowers: false,
			contacts: [{ userId: 'b', followsAuthor: true }],
		}));
		expect(triggers).not.toContain('unsolicitedContact');
	});

	test('自鯖フォロワーがいれば unsolicitedContact は出ない', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: true,
			authorFirstSeenAt: OLD,
			authorHasLocalFollowers: true,
			contacts: [{ userId: 'b', followsAuthor: false }],
		}));
		expect(triggers).not.toContain('unsolicitedContact');
	});

	test('新しい他鯖アカウント＋リンク → newAuthorLink', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: true,
			authorFirstSeenAt: NEW,
			text: 'タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 ormh',
		}));
		expect(triggers).toContain('newAuthorLink');
	});

	test('古いアカウント＋リンク → newAuthorLink は出ない', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: true,
			authorFirstSeenAt: OLD,
			text: 'タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 ormh',
		}));
		expect(triggers).not.toContain('newAuthorLink');
	});

	test('本文が空でも CW 内のリンクで newAuthorLink が付く', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: true,
			authorFirstSeenAt: NEW,
			text: null,
			cw: '詳しくは jmty.io/shop/ を見てね',
		}));
		expect(triggers).toContain('newAuthorLink');
	});

	test('新しいローカルアカウントが未フォローの相手へメンション → newLocalContact', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: false,
			authorFirstSeenAt: NEW,
			contacts: [{ userId: 'b', followsAuthor: false }],
		}));
		expect(triggers).toContain('newLocalContact');
	});

	test('宛先が投稿者本人だけ（除外後0件）なら何も出ない', () => {
		const triggers = computeAiModerationTriggers(triggerInput({
			authorIsRemote: false,
			authorFirstSeenAt: NEW,
			contacts: [],
			text: null,
		}));
		expect(triggers).toEqual([]);
	});
});

describe('extractAiModerationLinks', () => {
	test('スキーム無し jmty.io/shop/ を jmty.io/shop にする', () => {
		expect(extractAiModerationLinks('タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 ormh', LOCAL_HOST))
			.toEqual(['jmty.io/shop']);
	});

	test('https://jmty.io/shop/x を jmty.io/shop にする', () => {
		expect(extractAiModerationLinks('見て https://jmty.io/shop/x これ', LOCAL_HOST))
			.toEqual(['jmty.io/shop']);
	});

	test('メンション @a@mi2.icu は拾わない', () => {
		expect(extractAiModerationLinks('あの @a@mi2.icu さんへ', LOCAL_HOST))
			.toEqual([]);
	});

	test('パス無しのスキーム無し example.com は拾わない', () => {
		expect(extractAiModerationLinks('example.com を見て', LOCAL_HOST))
			.toEqual([]);
	});

	test('自サーバーのホストへのリンクは除外する', () => {
		expect(extractAiModerationLinks(`https://${LOCAL_HOST}/notes/abc 見て`, LOCAL_HOST))
			.toEqual([]);
	});

	test('数値のようなパスはリンクとして拾わない（3.5/5点）', () => {
		expect(extractAiModerationLinks('評価は 3.5/5点 でした', LOCAL_HOST))
			.toEqual([]);
	});

	test('数値のようなパスはリンクとして拾わない（v1.2/3）', () => {
		expect(extractAiModerationLinks('バージョン v1.2/3 です', LOCAL_HOST))
			.toEqual([]);
	});

	test('実例の4文で jmty.io/shop だけを拾う', () => {
		expect(extractAiModerationLinks('タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 ormh', LOCAL_HOST))
			.toEqual(['jmty.io/shop']);
		expect(extractAiModerationLinks('フォロバ100% 相互フォローしよう！プロフのリンク見てね', LOCAL_HOST))
			.toEqual([]);
		expect(extractAiModerationLinks('今日のお昼はカレーにしました。辛くておいしい', LOCAL_HOST))
			.toEqual([]);
		expect(extractAiModerationLinks('お前のこと住所まで調べたからな', LOCAL_HOST))
			.toEqual([]);
	});
});

describe('decideAiModerationFlag', () => {
	test('閾値ちょうどで引っかかる（spam+scam）', () => {
		const { flagged, localLabel } = decideAiModerationFlag(
			{ normal: 0.4, spam: 0.6, scam: 0, abuse: 0 }, null, 0.6,
		);
		expect(flagged).toBe(true);
		expect(localLabel).toBe('spam');
	});

	test('spam と scam の合算で引っかかる', () => {
		const { flagged } = decideAiModerationFlag(
			{ normal: 0.2, spam: 0.3, scam: 0.3, abuse: 0 }, null, 0.6,
		);
		expect(flagged).toBe(true);
	});

	test('abuse 単独で引っかかる', () => {
		const { flagged, localLabel } = decideAiModerationFlag(
			{ normal: 0.2, spam: 0, scam: 0, abuse: 0.7 }, null, 0.6,
		);
		expect(flagged).toBe(true);
		expect(localLabel).toBe('abuse');
	});

	test('externalFlagged のみで引っかかる', () => {
		const { flagged, localLabel } = decideAiModerationFlag(null, true, 0.6);
		expect(flagged).toBe(true);
		expect(localLabel).toBeNull();
	});

	test('全部 null なら引っかからない', () => {
		const { flagged, localLabel } = decideAiModerationFlag(null, null, 0.6);
		expect(flagged).toBe(false);
		expect(localLabel).toBeNull();
	});

	test('localLabel は4つの確率の最大', () => {
		const { localLabel } = decideAiModerationFlag(
			{ normal: 0.1, spam: 0.5, scam: 0.3, abuse: 0.1 }, null, 0.9,
		);
		expect(localLabel).toBe('spam');
	});
});

describe('normalizeAiModerationText / computeAiModerationTextFingerprint', () => {
	test('文末英字だけ違う4文の組が同じ指紋になる', () => {
		const a = computeAiModerationTextFingerprint('タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 ormh', LOCAL_HOST);
		const b = computeAiModerationTextFingerprint('タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 gfvg', LOCAL_HOST);
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	test('スキーム付き URL とスキーム無しリンクが同じ指紋に正規化される', () => {
		const a = computeAiModerationTextFingerprint('見て https://jmty.io/shop/x ormh', LOCAL_HOST);
		const b = computeAiModerationTextFingerprint('見て jmty.io/shop/ gfvg', LOCAL_HOST);
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	test('メンションは消える', () => {
		const a = computeAiModerationTextFingerprint('@a@mi2.icu 見て jmty.io/shop/ ormh', LOCAL_HOST);
		const b = computeAiModerationTextFingerprint('見て jmty.io/shop/ gfvg', LOCAL_HOST);
		expect(a).not.toBeNull();
		expect(a).toBe(b);
	});

	test('別の文は別の指紋になる', () => {
		const a = computeAiModerationTextFingerprint('タイムセールやってる店あるよ jmty.io/shop/ アウトレット価格 ormh', LOCAL_HOST);
		const b = computeAiModerationTextFingerprint('今日のお昼はカレーにしました。辛くておいしい', LOCAL_HOST);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a).not.toBe(b);
	});

	test('本文が空なら null', () => {
		expect(computeAiModerationTextFingerprint(null, LOCAL_HOST)).toBeNull();
		expect(computeAiModerationTextFingerprint('   ', LOCAL_HOST)).toBeNull();
	});

	test('正規化は小文字化して返す', () => {
		expect(normalizeAiModerationText('JMty.io/Shop/ 見て ORMH', LOCAL_HOST)).toBe('jmty.io/shop 見て ormh');
	});
});

describe('classifyAiModerationHost', () => {
	test('引っかけ 0 → none', () => {
		expect(classifyAiModerationHost({ localFollowersCount: 0, flaggedCount: 0, flaggedAccountCount: 0 })).toBe('none');
	});

	test('フォロワー 0 かつ アカウント 2 → partial', () => {
		expect(classifyAiModerationHost({ localFollowersCount: 0, flaggedCount: 4, flaggedAccountCount: 2 })).toBe('partial');
	});

	test('フォロワー 0 かつ アカウント 3 → strong', () => {
		expect(classifyAiModerationHost({ localFollowersCount: 0, flaggedCount: 3, flaggedAccountCount: 3 })).toBe('strong');
	});

	test('フォロワーが 1 人でもいれば strong にならない', () => {
		expect(classifyAiModerationHost({ localFollowersCount: 1, flaggedCount: 5, flaggedAccountCount: 5 })).toBe('partial');
	});
});

describe('aiModerationAccountSignals', () => {
	test('aoi_4kyqyj → a+_x6、アイコン無し、文末英字', () => {
		const signals = aiModerationAccountSignals({
			username: 'aoi_4kyqyj',
			avatarId: null,
			text: 'アウトレット価格 ormh',
		});
		expect(signals.namePattern).toBe('a+_x6');
		expect(signals.noAvatar).toBe(true);
		expect(signals.trailingNoise).toBe(true);
	});

	test('英字連続だけなら a+、純数字は長さ付き', () => {
		expect(aiModerationNamePattern('abc')).toBe('a+');
		expect(aiModerationNamePattern('1234')).toBe('x4');
		expect(aiModerationNamePattern('ab12')).toBe('x4');
	});

	test('アイコンあり / 文末英字なし', () => {
		const signals = aiModerationAccountSignals({
			username: 'alice',
			avatarId: 'file1',
			text: '普通の投稿です',
		});
		expect(signals.noAvatar).toBe(false);
		expect(signals.trailingNoise).toBe(false);
	});
});

describe('aiModerationGroupKeys', () => {
	test('host は null をこのサーバー自身として返す', () => {
		expect(aiModerationGroupKeys({ noteUserHost: null, links: [], textFingerprint: null }, 'host')).toEqual([null]);
		expect(aiModerationGroupKeys({ noteUserHost: 'mi2.icu', links: [], textFingerprint: null }, 'host')).toEqual(['mi2.icu']);
	});

	test('link は links を展開する', () => {
		expect(aiModerationGroupKeys({ noteUserHost: 'mi2.icu', links: ['jmty.io/shop', 'x.io/a'], textFingerprint: 'fp' }, 'link')).toEqual(['jmty.io/shop', 'x.io/a']);
	});

	test('fingerprint は textFingerprint を返す', () => {
		expect(aiModerationGroupKeys({ noteUserHost: 'mi2.icu', links: [], textFingerprint: 'fp' }, 'fingerprint')).toEqual(['fp']);
		expect(aiModerationGroupKeys({ noteUserHost: 'mi2.icu', links: [], textFingerprint: null }, 'fingerprint')).toEqual([]);
	});
});

describe('decideAiModerationBulkCount / decideAiModerationBulkSuspendSkip', () => {
	test('件数一致で ok、不一致で countMismatch、上限超えで tooMany', () => {
		expect(decideAiModerationBulkCount(3, 3, 1000)).toEqual({ ok: true });
		expect(decideAiModerationBulkCount(3, 4, 1000)).toEqual({ ok: false, reason: 'countMismatch' });
		expect(decideAiModerationBulkCount(1001, 1001, 1000)).toEqual({ ok: false, reason: 'tooMany' });
	});

	test('凍結済み・管理者・モデレーター・古いローカルユーザーを飛ばす', () => {
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: true, isModerator: true, isLocal: true, isOlderThanNewAuthorDays: false, isAlreadySuspended: false })).toBe('admin');
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: false, isModerator: true, isLocal: true, isOlderThanNewAuthorDays: false, isAlreadySuspended: false })).toBe('moderator');
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: false, isModerator: false, isLocal: true, isOlderThanNewAuthorDays: true, isAlreadySuspended: false })).toBe('localOld');
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: false, isModerator: false, isLocal: true, isOlderThanNewAuthorDays: false, isAlreadySuspended: true })).toBe('alreadySuspended');
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: true, isModerator: true, isLocal: true, isOlderThanNewAuthorDays: false, isAlreadySuspended: true })).toBe('alreadySuspended');
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: false, isModerator: false, isLocal: true, isOlderThanNewAuthorDays: false, isAlreadySuspended: false })).toBeNull();
		expect(decideAiModerationBulkSuspendSkip({ isAdministrator: false, isModerator: false, isLocal: false, isOlderThanNewAuthorDays: true, isAlreadySuspended: false })).toBeNull();
	});
});

describe('buildAiModerationGroup', () => {
	test('2件以上の rec で firstAt / lastAt / peakPerHour が正しい', () => {
		const base: Omit<AiModerationGroupSampleInput, 'noteUserId' | 'createdAt'> = {
			noteUserHost: 'mi2.icu',
			localLabel: 'spam',
			localScores: { normal: 0, spam: 0.8, scam: 0, abuse: 0 },
			noteText: 'リンク見て ormh',
			links: ['jmty.io/shop'],
			textFingerprint: 'fp1',
			contactUserIds: ['local1'],
			triggers: ['newAuthorLink'],
		};

		const hour1a = new Date('2026-01-01T00:30:00Z');
		const hour1b = new Date('2026-01-01T00:45:00Z');
		const hour2 = new Date('2026-01-01T01:10:00Z');

		const group = buildAiModerationGroup('mi2.icu', [
			{ ...base, noteUserId: 'u1', createdAt: hour2 },
			{ ...base, noteUserId: 'u2', createdAt: hour1a },
			{ ...base, noteUserId: 'u3', createdAt: hour1b },
		], 'host');

		expect(group.flaggedCount).toBe(3);
		expect(group.accountCount).toBe(3);
		expect(group.firstAt).toBe(hour1a.toISOString());
		expect(group.lastAt).toBe(hour2.toISOString());
		expect(group.peakPerHour).toBe(2);
		expect(group.peakAccountsPerHour).toBe(2);
	});
});

describe('collectAiModerationSpamSignals / scoreAiModerationSpamSignals', () => {
	const none = {
		strangerContact: false,
		strangers24h: 0,
		sameTextOtherAccounts: 0,
		sameTextSameAccount: 1,
		sameLinkOtherAccounts: 0,
		hostOtherFlaggedAccounts: 0,
		noAvatar: false,
		trailingNoise: false,
	};

	test('新しく来た人がリンクを1回貼っただけなら何も付かない', () => {
		expect(collectAiModerationSpamSignals(none)).toEqual([]);
	});

	test('mi2.icu 型（知らない人への DM・アイコン無し・文末の英字）は 4 点で広げ方あり', () => {
		const signals = collectAiModerationSpamSignals({ ...none, strangerContact: true, noAvatar: true, trailingNoise: true });
		expect(signals).toEqual(['strangerContact', 'noAvatar', 'trailingNoise']);
		expect(scoreAiModerationSpamSignals(signals)).toEqual({ points: 4, hasSpread: true });
	});

	test('同じ文を別アカウントが出していれば付く', () => {
		expect(collectAiModerationSpamSignals({ ...none, sameTextOtherAccounts: 1 })).toEqual(['sameTextOtherAccounts']);
	});

	test('同じリンク・同じサーバーの波・アイコン無しは広げ方に数えない', () => {
		const signals = collectAiModerationSpamSignals({ ...none, sameLinkOtherAccounts: 5, hostOtherFlaggedAccounts: 5, noAvatar: true, trailingNoise: true });
		expect(scoreAiModerationSpamSignals(signals)).toEqual({ points: 4, hasSpread: false });
	});
});

describe('decideAiModerationAutoHide', () => {
	const base = {
		flagged: true,
		localScores: { normal: 0.02, spam: 0.85, scam: 0.1, abuse: 0.03 },
		externalFlagged: null,
		threshold: 0.9,
		signals: ['strangerContact', 'noAvatar', 'trailingNoise'],
		authorIsRemote: true,
		authorIsNew: true,
		authorHasLocalFollowers: false,
	};

	test('すべて満たせば隠す', () => {
		expect(decideAiModerationAutoHide(base)).toBe(true);
	});

	test('引っかかっていなければ隠さない', () => {
		expect(decideAiModerationAutoHide({ ...base, flagged: false })).toBe(false);
	});

	test('spam+scam が閾値未満なら隠さない', () => {
		expect(decideAiModerationAutoHide({ ...base, localScores: { normal: 0.2, spam: 0.6, scam: 0.1, abuse: 0.1 } })).toBe(false);
	});

	test('Qwen が無ければ外部 API の判定に従う', () => {
		expect(decideAiModerationAutoHide({ ...base, localScores: null, externalFlagged: true })).toBe(true);
		expect(decideAiModerationAutoHide({ ...base, localScores: null, externalFlagged: null })).toBe(false);
	});

	test('AI がスパム 100% でも、リンクを貼っただけの新しい人は隠さない（skeb の告知など）', () => {
		const full = { normal: 0, spam: 1, scam: 0, abuse: 0 };
		expect(decideAiModerationAutoHide({ ...base, localScores: full, signals: [] })).toBe(false);
		expect(decideAiModerationAutoHide({ ...base, localScores: full, signals: ['noAvatar'] })).toBe(false);
	});

	test('知らない人に1回送っただけ（点数不足）では隠さない', () => {
		expect(decideAiModerationAutoHide({ ...base, signals: ['strangerContact', 'noAvatar'] })).toBe(false);
	});

	test('広げ方の目印が無ければ、ほかの点数が高くても隠さない', () => {
		expect(decideAiModerationAutoHide({ ...base, signals: ['sameLinkOtherAccounts', 'hostWave', 'noAvatar', 'trailingNoise'] })).toBe(false);
	});

	test('古いアカウントでも根拠がそろえば隠す', () => {
		expect(decideAiModerationAutoHide({ ...base, authorIsNew: false })).toBe(true);
	});

	test('このサーバーでフォローされていれば隠さない', () => {
		expect(decideAiModerationAutoHide({ ...base, authorHasLocalFollowers: true })).toBe(false);
	});

	test('このサーバーの古いユーザーは隠さない（新しいローカルユーザーは隠す）', () => {
		expect(decideAiModerationAutoHide({ ...base, authorIsRemote: false, authorIsNew: false })).toBe(false);
		expect(decideAiModerationAutoHide({ ...base, authorIsRemote: false, authorIsNew: true })).toBe(true);
	});
});

describe('summarizeAiModerationOutcomes', () => {
	const row = (overrides: Partial<AiModerationOutcomeRow>): AiModerationOutcomeRow => ({
		userId: 'u',
		host: 'remote.example',
		auto: 'none',
		signals: [],
		isSuspended: false,
		isDeleted: false,
		isHidden: false,
		wasUnhidden: false,
		...overrides,
	});

	test('状態は 凍結 > 消えた > 外した > 隠している > 何もしていない の順で決まる', () => {
		expect(aiModerationAccountState(row({ isSuspended: true, isDeleted: true, isHidden: true }))).toBe('suspended');
		expect(aiModerationAccountState(row({ isDeleted: true, isHidden: true }))).toBe('deleted');
		expect(aiModerationAccountState(row({ wasUnhidden: true }))).toBe('unhidden');
		expect(aiModerationAccountState(row({ wasUnhidden: true, isHidden: true }))).toBe('hidden');
		expect(aiModerationAccountState(row({}))).toBe('open');
	});

	test('自動の当たりは「凍結か消えた ÷ (それ＋人が外した)」で測る', () => {
		const result = summarizeAiModerationOutcomes([
			row({ userId: 'a', auto: 'hidden', isSuspended: true, signals: ['strangerContact', 'noAvatar'] }),
			row({ userId: 'b', auto: 'hidden', isDeleted: true, signals: ['strangerContact'] }),
			row({ userId: 'c', auto: 'wouldHide', wasUnhidden: true, signals: ['strangerContact'] }),
			row({ userId: 'd', auto: 'hidden', isHidden: true }),
			row({ userId: 'e', auto: 'none', isSuspended: true }),
			row({ userId: 'f', auto: 'none' }),
		]);
		expect(result.accounts).toBe(6);
		expect(result.auto).toMatchObject({ accounts: 4, autoHidden: 3, wouldHide: 1, suspended: 1, deleted: 1, unhidden: 1, hidden: 1 });
		expect(result.notAuto).toMatchObject({ accounts: 2, suspended: 1, open: 1 });
		expect(result.autoConfirmedRate).toBeCloseTo(2 / 3);
		expect(result.bySignal[0]).toEqual({ signal: 'strangerContact', accounts: 3, suspendedOrDeleted: 2, unhidden: 1 });
	});

	test('自動の当たりが無ければ割合は null', () => {
		expect(summarizeAiModerationOutcomes([row({})]).autoConfirmedRate).toBeNull();
	});
});

describe('判定条件の版', () => {
	const base = {
		model: 'Qwen/Qwen3-4B-Instruct-2507',
		judgeScriptSha: 'abcdef0123456789',
		localThreshold: 0.6,
		autoHideThreshold: 0.9,
		newAuthorDays: 7,
		externalEnabled: false,
		externalModel: 'omni-moderation-latest',
	};

	test('同じ条件なら同じ版、キーの順番には左右されない', () => {
		const a = buildAiModerationCriteria(base);
		const b = buildAiModerationCriteria({ ...base });
		const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
		expect(aiModerationCriteriaVersion(a)).toBe(aiModerationCriteriaVersion(b));
		expect(aiModerationCriteriaVersion(a)).toBe(aiModerationCriteriaVersion(reordered));
		expect(aiModerationCriteriaVersion(a)).toMatch(/^[0-9a-f]{12}$/);
	});

	test('判定スクリプト（プロンプト）や閾値を変えたら版が変わる', () => {
		const v = aiModerationCriteriaVersion(buildAiModerationCriteria(base));
		expect(aiModerationCriteriaVersion(buildAiModerationCriteria({ ...base, judgeScriptSha: 'ffff' }))).not.toBe(v);
		expect(aiModerationCriteriaVersion(buildAiModerationCriteria({ ...base, localThreshold: 0.7 }))).not.toBe(v);
		expect(aiModerationCriteriaVersion(buildAiModerationCriteria({ ...base, autoHideThreshold: 0.95 }))).not.toBe(v);
	});

	test('外部 API がオフならモデル名は版に入らない', () => {
		const v = aiModerationCriteriaVersion(buildAiModerationCriteria(base));
		expect(aiModerationCriteriaVersion(buildAiModerationCriteria({ ...base, externalModel: 'other' }))).toBe(v);
	});
});

describe('computeAiModerationTriggers の基準時刻', () => {
	test('過去の投稿は投稿時点で新しいアカウントかを見る', () => {
		const createdAt = new Date(NOW - 100 * 24 * 60 * 60 * 1000);
		const input = triggerInput({ authorFirstSeenAt: createdAt, text: 'セール中 shop.example/sale' });
		expect(computeAiModerationTriggers(input)).not.toContain('newAuthorLink');
		expect(computeAiModerationTriggers({ ...input, now: new Date(createdAt.getTime() + 60 * 60 * 1000) })).toContain('newAuthorLink');
	});
});

describe('全体スキャンの見積もり', () => {
	test('CPU（6件・1件10秒）は1回分が予算90秒に収まるので、2分に6件', () => {
		expect(aiModerationScanPostsPerTick(10, 6)).toBe(6);
		// 600件なら100回 × 2分 = 200分
		expect(aiModerationScanWallSeconds(600, 10, 6)).toBe(100 * 120);
	});

	test('1回分が予算を超えても、1回分は進む（1件20秒・6件 = 120秒）', () => {
		expect(aiModerationScanPostsPerTick(20, 6)).toBe(6);
	});

	test('GPU（96件・1件0.4秒 = 38秒）は1回の定期実行で2回分', () => {
		expect(aiModerationScanPostsPerTick(0.4, 96)).toBe(192);
		expect(aiModerationScanWallSeconds(1000, 0.4, 96)).toBe(6 * 120);
	});

	test('0件なら0秒', () => {
		expect(aiModerationScanWallSeconds(0, 0.4, 96)).toBe(0);
	});
});
