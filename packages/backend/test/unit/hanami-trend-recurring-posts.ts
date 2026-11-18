/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi as jest } from 'vitest';
import { TREND_RECURRING_MAX_AUTHORS, TREND_RECURRING_PREFIX_IGNORED, trendRecurringCandidates, trendRecurringDayCounts, trendRecurringMemoUntil, trendRecurringPairKey, trendRecurringPairs, trendRecurringPrefix, trendRecurringTodayStart, trendTemplateKey } from '@/core/hanami/HanamiTrendRecurringPosts.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-11-17 07:20 JST
const NOW = Date.parse('2026-11-16T22:20:00Z');
const template = (user: string) => `📮 質問募集中です！\n匿名の質問を受け付けています。\n👇 送信はこちらから\n🔗 https://example.com/u/${user}`;
// 毎日 0 時に出る活動報告。数字だけが日ごとに変わる。
const report = (notes: number, added: number, followers: string) => `昨日のMisskeyの活動は\n\nノート: ${notes}(+${added})\nフォロー : 361(+0)\nフォロワー :567(${followers})\n\nでした。\nhttps://example.com/ #misshaialert`;

describe('trendTemplateKey', () => {
	test('人ごとに違う URL・メンション・タグ・空白を除いて同じ文にそろえる', () => {
		expect(trendTemplateKey(template('alice'))).toBe(trendTemplateKey(template('bob')));
		expect(trendTemplateKey('質問募集中です！ #質問箱 @someone')).toBe('質問募集中です!');
	});

	test('短いひとことは調べない', () => {
		expect(trendTemplateKey('草')).toBeNull();
		expect(trendTemplateKey('https://example.com/ #tag')).toBeNull();
		expect(trendTemplateKey(null)).toBeNull();
		// 数字だけの文は、伏せると短いひとことになる。
		expect(trendTemplateKey('33637 (+50)')).toBeNull();
	});

	test('数字だけが違う文は、符号・小数・桁区切り・全角も含めて同じ文にそろえる', () => {
		const key = trendTemplateKey(report(27842, 2, '+0'));
		expect(key).toBe('昨日のMisskeyの活動はノート:0(0)フォロー:0(0)フォロワー:0(0)でした。');
		expect(trendTemplateKey(report(27901, 59, '-2'))).toBe(key);
		expect(trendTemplateKey('今日は 8,532 歩あるきました（目標の 106.6%）')).toBe(trendTemplateKey('今日は １２，０１０ 歩あるきました（目標の 150%）'));
		// 数字のほかが違えば、別の文のまま。
		expect(trendTemplateKey('昨日のMisskeyの活動は ノート: 27842(+2) でした！')).not.toBe(trendTemplateKey('昨日のMisskeyの活動は ノート: 27842(+2) でした。'));
	});
});

describe('trendRecurringPrefix', () => {
	test('先頭の近くにある数字と符号を除いてから、先頭の 12 文字を取る', () => {
		expect(trendRecurringPrefix('昨日は ノート / 58089 (+47) フォロー / 413 (+0) でした')).toBe('昨日は ノート /  (');
		expect(trendRecurringPrefix('昨日は ノート / 58136 (-3) フォロー / 414 (+1) でした')).toBe('昨日は ノート /  (');
		expect(trendRecurringPrefix('１２３日目：きょうも走りました')).toBe('日目：きょうも走りました');
		// 絵文字（サロゲートペア）も 1 文字として数える。
		expect(trendRecurringPrefix('📮 質問募集中です！\n匿名の質問を受け付けています。')).toBe('📮 質問募集中です！\n匿');
		expect(Array.from(TREND_RECURRING_PREFIX_IGNORED).every(char => trendRecurringPrefix(`${char}あ`) === 'あ')).toBe(true);
	});
});

describe('trendRecurringMemoUntil', () => {
	test('ふつうは決まった時間だけ覚える。あと 1 日ぶんで定期の投稿になる組だけは、日付（JST）が変わるまで', () => {
		// 23:50 JST に調べた結果。
		const late = Date.parse('2026-11-17T14:50:00Z');
		const midnight = Date.parse('2026-11-17T15:00:00Z');
		// 別の日が 1 日ある組: 0 時を過ぎると今日のぶんが 2 日目に数わるので、0 時で忘れる。
		expect(trendRecurringMemoUntil(late, 3 * HOUR, 1)).toBe(midnight);
		// 別の日が無い組・すでに定期の投稿と分かっている組: 0 時をまたいでも結果は変わらないので、3 時間覚える。
		expect(trendRecurringMemoUntil(late, 3 * HOUR, 0)).toBe(late + 3 * HOUR);
		expect(trendRecurringMemoUntil(late, 3 * HOUR, 2)).toBe(late + 3 * HOUR);
		// 0 時まで 3 時間より長いときは、3 時間。
		expect(trendRecurringMemoUntil(NOW, 3 * HOUR, 1)).toBe(NOW + 3 * HOUR);
	});
});

describe('trendRecurringCandidates', () => {
	test('短いひとこと以外を候補にし、同じ文を出している人が多い順に並べる', () => {
		const notes = [
			{ userId: 'z', text: 'ぜんぜん別の話をしています' },
			{ userId: 'd', text: 'きょうは寒いので鍋にします' },
			...['a', 'b', 'c'].map(user => ({ userId: user, text: template(user) })),
			{ userId: 'e', text: 'きょうは寒いので鍋にします' },
			{ userId: 'f', text: '草' },
		];

		expect(trendRecurringCandidates(notes).map(note => note.userId)).toEqual(['a', 'b', 'c', 'd', 'e', 'z']);
	});

	test('同じ人数どうしは、新しい投稿があるものを先にする', () => {
		const notes = [
			{ userId: 'old', text: 'きのうの夜に書いた、ほかと違う文です', createdAt: NOW - 5 * HOUR },
			{ userId: 'new', text: 'ついさっき書いた、ほかと違う文です', createdAt: NOW - 60 * 1000 },
			{ userId: 'mid', text: 'すこし前に書いた、ほかと違う文です', createdAt: NOW - HOUR },
			...['a', 'b'].map(user => ({ userId: user, text: template(user), createdAt: NOW - 6 * HOUR })),
		];

		expect(trendRecurringCandidates(notes).map(note => note.userId)).toEqual(['a', 'b', 'new', 'mid', 'old']);
	});
});

describe('trendRecurringPairs', () => {
	test('今日より前の 2 日以上に同じ文を出している人だけを定期の投稿とみなす', () => {
		const prior = [
			// alice: きのうとおとといに同じ文 → 定期
			{ userId: 'alice', text: template('alice'), createdAt: NOW - DAY },
			{ userId: 'alice', text: template('alice'), createdAt: NOW - 2 * DAY },
			// bob: きのうに 3 回（同じ日）→ 1 日ぶんにしかならない
			{ userId: 'bob', text: template('bob'), createdAt: NOW - DAY },
			{ userId: 'bob', text: template('bob'), createdAt: NOW - DAY + 5 * HOUR },
			{ userId: 'bob', text: template('bob'), createdAt: NOW - DAY + 11 * HOUR },
			// carol: 今日の朝と、8 日より前 → 数えない
			{ userId: 'carol', text: template('carol'), createdAt: NOW - 2 * HOUR },
			{ userId: 'carol', text: template('carol'), createdAt: NOW - 9 * DAY },
			{ userId: 'carol', text: template('carol'), createdAt: NOW - 10 * DAY },
			// dave: 別の日に 2 回出しているが、文が違う
			{ userId: 'dave', text: 'きのうは鍋にしました。おいしかった', createdAt: NOW - DAY },
			{ userId: 'dave', text: 'おとといはカレーにしました。からかった', createdAt: NOW - 2 * DAY },
		];

		expect([...trendRecurringPairs(prior, NOW)]).toEqual([trendRecurringPairKey('alice', trendTemplateKey(template('alice'))!)]);
	});

	test('組ごとに、同じ文を出していた別の日の数を数える', () => {
		const prior = [
			{ userId: 'alice', text: template('alice'), createdAt: NOW - DAY },
			{ userId: 'alice', text: template('alice'), createdAt: NOW - 2 * DAY },
			{ userId: 'alice', text: template('alice'), createdAt: NOW - 2 * DAY + HOUR },
			{ userId: 'bob', text: template('bob'), createdAt: NOW - 3 * DAY },
			{ userId: 'carol', text: template('carol'), createdAt: NOW - 2 * HOUR },
		];
		const key = (user: string) => trendRecurringPairKey(user, trendTemplateKey(template(user))!);

		expect(Object.fromEntries(trendRecurringDayCounts(prior, NOW))).toEqual({ [key('alice')]: 2, [key('bob')]: 1 });
	});

	test('今日の 0 時（JST）は、その日の朝の投稿より前になる', () => {
		expect(trendRecurringTodayStart(NOW)).toBe(Date.parse('2026-11-16T15:00:00Z'));
	});
});

describe('HanamiTrendService: 定期の投稿を話題の材料から外す', () => {
	type Note = { id: string; userId: string; text: string; at: number };
	const note = (id: string, userId: string, text: string, at: number): Note => ({ id, userId, text, at });

	function serviceWith(prior: Note[]) {
		const all = new Map<string, Note>();
		const query = jest.fn(async (_sql: string, _values: unknown[]) => prior.map(row => ({ id: row.id, userId: row.userId, text: row.text })));
		const ids = { gen: (at?: number) => `bound-${at}`, parse: (id: string) => ({ date: new Date(all.get(id)!.at) }) };
		const service = new HanamiTrendService({} as never, {} as never, {} as never, { query } as never, ids as never);
		for (const row of prior) all.set(row.id, row);
		const drop = (notes: Note[], now: number): Promise<{ id: string }[]> => {
			for (const row of notes) all.set(row.id, row);
			return (service as unknown as { dropRecurringNotes: (notes: unknown[], now: number) => Promise<{ id: string }[]> })
				.dropRecurringNotes(notes.map(row => ({ id: row.id, userId: row.userId, text: row.text, replyId: null, renoteId: null, createdAt: row.at, terms: [], embeddingIndex: null })), now);
		};
		const stats = (): { dropped: number; waiting: number } => (service as unknown as { recurringStats: { dropped: number; waiting: number } }).recurringStats;
		return { drop, query, stats };
	}

	test('毎日同じ文を出している人の投稿だけを外し、過去の投稿は 1 回だけ調べる', async () => {
		const users = ['u1', 'u2', 'u3', 'u4'];
		// u1〜u3 はきのうとおとといにも同じ文。u4 は今日が初めて。
		const prior = ['u1', 'u2', 'u3'].flatMap(user => [1, 2].map(daysAgo => note(`${user}-d${daysAgo}`, user, template(user), NOW - daysAgo * DAY)));
		const { drop, query } = serviceWith(prior);
		const current = [
			...users.map(user => note(`${user}-now`, user, template(user), NOW - 10 * 60 * 1000)),
			note('talk-1', 'u1', '質問箱って、みんなどれを使っているんだろう', NOW - 5 * 60 * 1000),
		];

		const kept = await drop(current, NOW);

		expect(kept.map(row => row.id)).toEqual(['u4-now', 'talk-1']);
		expect(query).toHaveBeenCalledTimes(1);
		const [sql, values] = query.mock.calls[0];
		expect(sql).toContain('left(translate(left(n.text, $6), $7, \'\'), $5) = ANY($4::text[])');
		expect(values).toEqual([
			users,
			`bound-${Date.parse('2026-11-09T15:00:00Z')}`,
			`bound-${Date.parse('2026-11-16T15:00:00Z')}`,
			['📮 質問募集中です！\n匿', '質問箱って、みんなどれを'],
			12,
			48,
			TREND_RECURRING_PREFIX_IGNORED,
		]);

		// 10 分後の次の回は、覚えている結果を使う（DB は読まない）。
		const again = await drop(current, NOW + 10 * 60 * 1000);
		expect(again.map(row => row.id)).toEqual(['u4-now', 'talk-1']);
		expect(query).toHaveBeenCalledTimes(1);
	});

	test('1 人だけが出している定型文も、毎日出していれば外す', async () => {
		const prior = [1, 2, 3].map(daysAgo => note(`qa-d${daysAgo}`, 'qa', 'QA で質問を募集しています！ https://example.com/u/qa', NOW - daysAgo * DAY));
		const { drop } = serviceWith(prior);
		const current = [
			note('qa-now', 'qa', 'QA で質問を募集しています！ https://example.com/u/qa', NOW),
			note('first-now', 'first', 'QA で質問を募集しています！ https://example.com/u/first', NOW),
		];

		expect((await drop(current, NOW)).map(row => row.id)).toEqual(['first-now']);
	});

	test('数字だけが毎日変わる活動報告も、毎日出していれば外す', async () => {
		// daily はきのうとおとといにも出している（数字とフォロワーの増減は毎日違う）。newcomer は今日が初めて。
		const prior = [note('daily-d1', 'daily', report(27840, 14, '-1'), NOW - DAY), note('daily-d2', 'daily', report(27826, 31, '+3'), NOW - 2 * DAY)];
		const { drop, query } = serviceWith(prior);
		const current = [note('daily-now', 'daily', report(27842, 2, '+0'), NOW), note('newcomer-now', 'newcomer', report(120, 5, '+1'), NOW)];

		expect((await drop(current, NOW)).map(row => row.id)).toEqual(['newcomer-now']);
		// 2 人とも同じ形の文なので、絞り込みに使う先頭は 1 つ。
		expect(query.mock.calls[0][1][3]).toEqual(['昨日のMisskeyの活']);
	});

	test('日付が変わったら調べ直す（前の日に「定期ではない」と覚えた結果を持ち越さない）', async () => {
		// 23:50 JST の時点では、同じ文を出したのはきのうの 1 日だけ。
		const late = Date.parse('2026-11-17T14:50:00Z');
		const prior = [note('r-d1', 'r', report(100, 1, '+0'), late - DAY)];
		const { drop, query } = serviceWith(prior);
		const before = note('r-late', 'r', report(101, 1, '+0'), late - 60 * 1000);
		expect((await drop([before], late)).map(row => row.id)).toEqual(['r-late']);

		// 20 分後は次の日。23:49 の投稿は「別の日」になり、0 時すぎの投稿は定期の投稿として外れる。
		prior.push(before);
		const after = note('r-next', 'r', report(102, 1, '+0'), late + 15 * 60 * 1000);
		expect((await drop([before, after], late + 20 * 60 * 1000)).map(row => row.id)).toEqual([]);
		expect(query).toHaveBeenCalledTimes(2);
	});

	test('別の日が無い組は、日付が変わっても調べ直さない（0 時に全員を調べ直して上限からあふれないように）', async () => {
		const late = Date.parse('2026-11-17T14:50:00Z');
		const { drop, query } = serviceWith([]);
		const before = note('n-late', 'n', '今夜は星がよく見えるので外に出てみた', late - 60 * 1000);
		expect((await drop([before], late)).map(row => row.id)).toEqual(['n-late']);

		// 20 分後は次の日。同じ投稿はまだ材料に入っているが、結果は変わらないので DB は読まない。
		expect((await drop([before], late + 20 * 60 * 1000)).map(row => row.id)).toEqual(['n-late']);
		expect(query).toHaveBeenCalledTimes(1);
	});

	test('調べる作者が上限を超えるときは、出たばかりの投稿から先に調べる（人ごとに文を変えた自動投稿を後回しにしない）', async () => {
		// 3 時間前の、ほかと違う文の投稿が 600 人ぶん。その後に、5 分前の活動報告が 3 人ぶん（文は人ごとに違う）。
		// 数字は伏せて比べられるので、人ごとの違いはかな 2 文字で付ける。
		const kana = (i: number) => String.fromCharCode(0x3042 + (i % 60)) + String.fromCharCode(0x3042 + Math.floor(i / 60));
		const crowd = Array.from({ length: TREND_RECURRING_MAX_AUTHORS + 100 }, (_, i) => note(`c${i}-now`, `c${i}`, `これは「${kana(i)}」さんが書いた、ほかと違う文です`, NOW - 3 * HOUR));
		const custom = (user: string, notes: number) => `【${user}の活動報告】 ノート: ${notes}(+${notes % 9}) フォロワー: 100(+1) でしたっ`;
		const reporters = ['r1', 'r2', 'r3'];
		const prior = reporters.flatMap(user => [1, 2].map(daysAgo => note(`${user}-d${daysAgo}`, user, custom(user, 500 - daysAgo), NOW - daysAgo * DAY)));
		const { drop, query } = serviceWith(prior);
		const current = [...crowd, ...reporters.map(user => note(`${user}-now`, user, custom(user, 510), NOW - 5 * 60 * 1000))];

		const kept = await drop(current, NOW);

		const asked = query.mock.calls[0][1][0] as string[];
		expect(asked).toHaveLength(TREND_RECURRING_MAX_AUTHORS);
		expect(asked.slice(0, 3)).toEqual(reporters);
		expect(kept.map(row => row.id).filter(id => id.startsWith('r'))).toEqual([]);
		expect(kept).toHaveLength(crowd.length);
	});

	test('調べ直しが上限で後回しになっても、外していた投稿は戻らない（前の結果を使い続ける）', async () => {
		const custom = (user: string, notes: number) => `【${user}の活動報告】 ノート: ${notes}(+${notes % 9}) フォロワー: 100(+1) でしたっ`;
		const reporters = ['r1', 'r2', 'r3'];
		const prior = reporters.flatMap(user => [1, 2].map(daysAgo => note(`${user}-d${daysAgo}`, user, custom(user, 500 - daysAgo), NOW - daysAgo * DAY)));
		const { drop, query, stats } = serviceWith(prior);
		const reports = reporters.map(user => note(`${user}-now`, user, custom(user, 510), NOW - 5 * 60 * 1000));
		expect(await drop(reports, NOW)).toEqual([]);
		expect(stats()).toEqual({ dropped: 3, waiting: 0 });

		// 3 時間 10 分後。覚えた結果の期限は切れている。そこへ、初めて見る人の投稿が上限より多く入ってくる。
		const later = NOW + 3 * HOUR + 10 * 60 * 1000;
		const kana = (i: number) => String.fromCharCode(0x3042 + (i % 60)) + String.fromCharCode(0x3042 + Math.floor(i / 60));
		const crowd = Array.from({ length: TREND_RECURRING_MAX_AUTHORS + 100 }, (_, i) => note(`c${i}-now`, `c${i}`, `これは「${kana(i)}」さんが書いた、ほかと違う文です`, later - 60 * 1000));
		const kept = await drop([...reports, ...crowd], later);

		// 上限の 500 人は、初めて見る人から埋まる。活動報告の 3 人は調べ直せていないが、外したまま。
		const asked = query.mock.calls[1][1][0] as string[];
		expect(asked).toHaveLength(TREND_RECURRING_MAX_AUTHORS);
		expect(asked.filter(user => user.startsWith('r'))).toEqual([]);
		expect(kept.map(row => row.id).filter(id => id.startsWith('r'))).toEqual([]);
		expect(stats()).toEqual({ dropped: 3, waiting: 103 });

		// 次の回で残りを調べ終える（初めて見る 100 人と、調べ直しの 3 人）。
		const next = await drop([...reports, ...crowd], later + 10 * 60 * 1000);
		expect((query.mock.calls[2][1][0] as string[]).filter(user => user.startsWith('r'))).toEqual(reporters);
		expect(next.map(row => row.id).filter(id => id.startsWith('r'))).toEqual([]);
		expect(stats()).toEqual({ dropped: 3, waiting: 0 });
	});

	test('短いひとことだけなら DB を読まず、何も外さない', async () => {
		const { drop, query } = serviceWith([]);
		const current = [note('a-now', 'a', '草', NOW), note('b-now', 'b', 'ねむい', NOW), note('c-now', 'c', 'https://example.com/ #tag', NOW)];

		expect((await drop(current, NOW)).map(row => row.id)).toEqual(['a-now', 'b-now', 'c-now']);
		expect(query).not.toHaveBeenCalled();
	});

	test('過去の投稿を読めなかったときは、何も外さない', async () => {
		const { drop, query } = serviceWith([]);
		query.mockRejectedValueOnce(new Error('timeout'));
		const current = ['a', 'b', 'c'].map(user => note(`${user}-now`, user, template(user), NOW));

		expect((await drop(current, NOW)).map(row => row.id)).toEqual(['a-now', 'b-now', 'c-now']);
	});
});
