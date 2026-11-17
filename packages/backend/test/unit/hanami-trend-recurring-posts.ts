/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi as jest } from 'vitest';
import { trendRecurringCandidates, trendRecurringPairKey, trendRecurringPairs, trendRecurringTodayStart, trendTemplateKey } from '@/core/hanami/HanamiTrendRecurringPosts.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-11-17 07:20 JST
const NOW = Date.parse('2026-11-16T22:20:00Z');
const template = (user: string) => `📮 質問募集中です！\n匿名の質問を受け付けています。\n👇 送信はこちらから\n🔗 https://example.com/u/${user}`;

describe('trendTemplateKey', () => {
	test('人ごとに違う URL・メンション・タグ・空白を除いて同じ文にそろえる', () => {
		expect(trendTemplateKey(template('alice'))).toBe(trendTemplateKey(template('bob')));
		expect(trendTemplateKey('質問募集中です！ #質問箱 @someone')).toBe('質問募集中です!');
	});

	test('短いひとことは調べない', () => {
		expect(trendTemplateKey('草')).toBeNull();
		expect(trendTemplateKey('https://example.com/ #tag')).toBeNull();
		expect(trendTemplateKey(null)).toBeNull();
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
		return { drop, query };
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
		expect(sql).toContain('left(n.text, $5) = ANY($4::text[])');
		expect(values).toEqual([
			users,
			`bound-${Date.parse('2026-11-09T15:00:00Z')}`,
			`bound-${Date.parse('2026-11-16T15:00:00Z')}`,
			['📮 質問募集中です！\n匿', '質問箱って、みんなどれを'],
			12,
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
