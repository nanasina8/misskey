/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { trendRelatedTopicPairs } from '@/core/hanami/HanamiTrendRelatedPairs.js';

const topic = (topicId: string, authors: string[], terms = [topicId], center: number[] | null = null) => ({
	topicId, terms, center, noteIds: authors.map(author => `${topicId}:${author}`),
});

function authorMap(topics: readonly { noteIds: readonly string[] }[]): Map<string, string> {
	return new Map(topics.flatMap(item => item.noteIds.map(id => [id, id.split(':')[1]] as const)));
}

describe('trendRelatedTopicPairs', () => {
	test('共通の人が 2 人以上いて、小さい側の 3 割以上なら候補にする', () => {
		const big = topic('outlook', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
		const half = topic('fukkyuu', ['a', 'b', 'x', 'y']);
		const other = topic('ramen', ['p', 'q', 'r']);
		const one = topic('coffee', ['a', 's', 't']);
		const topics = [big, half, other, one];

		expect(trendRelatedTopicPairs(topics, authorMap(topics))).toEqual([['outlook', 'fukkyuu']]);
	});

	test('共通の人が多くても、小さい側の 3 割に満たなければ候補にしない', () => {
		const a = topic('a', Array.from({ length: 20 }, (_, i) => `u${i}`));
		const b = topic('b', [...Array.from({ length: 10 }, (_, i) => `v${i}`), 'u0', 'u1']);
		const topics = [a, b];

		expect(trendRelatedTopicPairs(topics, authorMap(topics))).toEqual([]);
	});

	test('前回は 1 つの話題だった組・共通の投稿・共通の語・内容の近さを手がかりにし、強い順に並べる', () => {
		const first = topic('first', ['a', 'b', 'c'], ['不倫']);
		const second = topic('second', ['d', 'e', 'f'], ['革ジャン']);
		const sameTerm = topic('same-term', ['g', 'h', 'i'], ['不倫', '辞任']);
		const near = topic('near', ['j', 'k', 'l'], ['近い'], [1, 0]);
		const nearToo = topic('near-too', ['m', 'n', 'o'], ['近い話'], [0.9, 0.1]);
		const far = topic('far', ['p', 'q', 'r'], ['遠い'], [0, 1]);
		const topics = [first, second, sameTerm, near, nearToo, far];
		// first と second の投稿は、前回は同じ話題に入っていた。
		const previous = [{ topicId: 'before', noteIds: [...first.noteIds, ...second.noteIds] }];

		expect(trendRelatedTopicPairs(topics, authorMap(topics), previous)).toEqual([
			['first', 'second'],
			['first', 'same-term'],
			['near', 'near-too'],
		]);
	});

	test('相手の話題から投稿が移ってきた新しい話題を、いちばん強い手がかりとして挙げる', () => {
		// 前回は「障害」1 つだった。今回は「障害」（同じ ID を引き継ぐ）と、新しい ID の「復旧」に分かれた。
		const kept = topic('shougai', ['a', 'b', 'c', 'd']);
		const moved = { topicId: 'fukkyuu', terms: ['復旧'], center: null, noteIds: ['shougai:e', 'shougai:f', 'fukkyuu:g'] };
		const unrelated = topic('ramen', ['p', 'q', 'r']);
		const topics = [kept, unrelated, moved];
		const previous = [{ topicId: 'shougai', noteIds: [...kept.noteIds, 'shougai:e', 'shougai:f'] }, { topicId: 'ramen', noteIds: unrelated.noteIds }];

		expect(trendRelatedTopicPairs(topics, authorMap(topics), previous)).toEqual([['shougai', 'fukkyuu']]);
	});

	test('挙げる組は上限までにする', () => {
		const topics = Array.from({ length: 12 }, (_, i) => topic(`t${i}`, ['a', 'b', 'c']));

		expect(trendRelatedTopicPairs(topics, authorMap(topics), [], 5)).toHaveLength(5);
	});
});
