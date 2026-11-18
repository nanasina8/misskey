/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import {
	TREND_TOPIC_RETIRED_MAX, TREND_TOPIC_RETIRED_MS, TREND_TOPIC_RETIRED_NOTE_MAX,
	assignTrendTopicIds, nextTrendRetiredTopics, pickTrendTopicLeader,
	type TrendRetiredTopic, type TrendTopicIdSource,
} from '@/core/hanami/HanamiTrendTopicIds.js';

const MINUTE = 60 * 1000;
// 2026-11-18 13:40 JST
const NOW = Date.parse('2026-11-18T04:40:00Z');
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `n${from + i}`);
const raw = (term: string, noteIds: string[]) => ({ terms: [term], noteIds });
const prev = (topicId: string, term: string, noteIds: string[], startedMinutesAgo = 60): TrendTopicIdSource => ({
	topicId, startedAt: new Date(NOW - startedMinutesAgo * MINUTE).toISOString(), terms: [term], noteIds,
});
const ids = (assigned: ReturnType<typeof assignTrendTopicIds>) => assigned.map(item => item.source?.topicId ?? null);
const origins = (assigned: ReturnType<typeof assignTrendTopicIds>) => assigned.map(item => item.origin);

describe('assignTrendTopicIds', () => {
	test('そのまま続いている話題は、自分の ID と始まった時刻を引き継ぐ', () => {
		const previous = [prev('x', 'ペンギン', range(1, 10)), prev('y', '地震', range(101, 110))];
		const assigned = assignTrendTopicIds([raw('地震', range(101, 115)), raw('ペンギン', range(1, 12))], previous, [], NOW);

		expect(ids(assigned)).toEqual(['y', 'x']);
		expect(origins(assigned)).toEqual(['live', 'live']);
		expect(assigned[1].source?.startedAt).toBe(previous[0].startedAt);
	});

	test('決まり 1: 割れたときは、前の話題の投稿を多く受け継いだ側が ID を持つ（新しい投稿で大きくなった側でも）', () => {
		const previous = [prev('x', 'ペンギン', range(1, 100))];
		// 片方は古い投稿 40 件だけ。もう片方は古い投稿 60 件に、新しい投稿 100 件が加わっている（Jaccard は小さい側のほうが高い）。
		const assigned = assignTrendTopicIds([raw('津田健次郎', range(1, 40)), raw('ペンギン', range(41, 200))], previous, [], NOW);

		expect(ids(assigned)).toEqual([null, 'x']);
		expect(origins(assigned)).toEqual(['new', 'live']);
	});

	test('決まり 2: まとまり直した話題は、新しくできた片割れではなく、もとの（古い）話題の ID を使う', () => {
		// x がもとの話題（40 分前から）。y は 10 分前に割れてできた片割れで、いまは y のほうが大きい。
		const previous = [prev('y', '生物', range(41, 110), 10), prev('x', 'ペンギン', range(1, 40), 40)];
		const assigned = assignTrendTopicIds([raw('ペンギン', range(1, 120))], previous, [], NOW);

		expect(ids(assigned)).toEqual(['x']);
	});

	test('決まり 2: 小さな古い話題を吸収しただけでは、大きい話題の ID は変わらない', () => {
		// old-small も引き継ぎの相手にはなる（30 / 130 件）が、main の半分に満たない。
		const previous = [prev('old-small', '津田健次郎', range(1, 30), 180), prev('main', 'ペンギン', range(101, 200), 30)];
		const assigned = assignTrendTopicIds([raw('ペンギン', range(1, 30).concat(range(101, 200)))], previous, [], NOW);

		expect(ids(assigned)).toEqual(['main']);
	});

	test('決まり 2: 古い話題に自分の続きがあるときは、ほかの話題がその ID を取らない（ID が入れ替わらない）', () => {
		// x と y は投稿が一部重なっている。x の続きは r-x、y の続きは r-y。
		const previous = [prev('x', '証券', range(1, 60).concat(range(101, 150)), 120), prev('y', '漏洩', range(101, 190), 20)];
		const assigned = assignTrendTopicIds([raw('漏洩', range(101, 195)), raw('証券', range(1, 60).concat(range(101, 110)))], previous, [], NOW);

		expect(ids(assigned)).toEqual(['y', 'x']);
	});

	test('決まり 1: 2 つの話題と重なる話題は、どちらからも指名されなければ新しい ID になる', () => {
		const previous = [prev('x', 'ペンギン', range(1, 10)), prev('y', '生物', range(11, 14))];
		// 2 つ目の話題は x と 6 件、y と 3 件重なるが、x の続きは 1 つ目、y の続きは 3 つ目の話題。
		const assigned = assignTrendTopicIds([raw('ペンギン', range(1, 8)), raw('キャラクター', range(5, 13)), raw('生物', range(11, 14))], previous, [], NOW);
		expect(ids(assigned)).toEqual(['x', null, 'y']);

		// y にほかの続きが無ければ、2 つ目の話題が y の続きになる（いちばん重なる x を取られても、新しい ID にはしない）。
		const withoutHeir = assignTrendTopicIds([raw('ペンギン', range(1, 8)), raw('キャラクター', range(5, 13))], previous, [], NOW);
		expect(ids(withoutHeir)).toEqual(['x', 'y']);
		expect(origins(withoutHeir)).toEqual(['live', 'live']);
	});

	test('決まり 3: まとまり直した話題が古いほうの ID を使ったとき、残った ID は、重なる別の話題が引き継ぐ', () => {
		// x（古い）と y（新しい）がまとまり直して、x の ID を使う。y の投稿の一部を持つ小さな話題が、空いた y を引き継ぐ。
		const previous = [prev('y', '生物', range(41, 110), 10), prev('x', 'ペンギン', range(1, 40), 40)];
		const assigned = assignTrendTopicIds([raw('ペンギン', range(1, 100)), raw('津田健次郎', range(96, 115))], previous, [], NOW);

		expect(ids(assigned)).toEqual(['x', 'y']);
	});

	test('決まり 4: 消えて間もない話題と同じ投稿のまとまりが戻ってきたら、同じ ID と始まった時刻を使う', () => {
		const previous = [prev('x', 'ペンギン', range(1, 100))];
		const retired: TrendRetiredTopic[] = [{ ...prev('y', '生物', range(41, 60), 90), retiredAt: NOW - 100 * MINUTE }];
		const assigned = assignTrendTopicIds([raw('ペンギン', range(1, 40).concat(range(61, 110))), raw('生物', range(41, 62))], previous, retired, NOW);

		expect(ids(assigned)).toEqual(['x', 'y']);
		expect(origins(assigned)).toEqual(['live', 'retired']);
		expect(assigned[1].source?.startedAt).toBe(retired[0].startedAt);
	});

	test('決まり 4: 覚えておく時間を過ぎた話題や、いまも出ている ID は使わない', () => {
		const previous = [prev('x', 'ペンギン', range(1, 100))];
		const expired: TrendRetiredTopic[] = [{ ...prev('y', '生物', range(41, 60)), retiredAt: NOW - TREND_TOPIC_RETIRED_MS }];
		const stale: TrendRetiredTopic[] = [{ ...prev('x', 'ペンギン', range(41, 60)), retiredAt: NOW - 10 * MINUTE }];
		const topics = [raw('ペンギン', range(1, 40).concat(range(61, 110))), raw('生物', range(41, 62))];

		expect(ids(assignTrendTopicIds(topics, previous, expired, NOW))).toEqual(['x', null]);
		expect(ids(assignTrendTopicIds(topics, previous, stale, NOW))).toEqual(['x', null]);
	});

	test('投稿がどの話題とも重ならないときだけ、先頭の語が同じ前回の話題を引き継ぐ', () => {
		const previous = [prev('x', 'ペンギン', range(1, 10))];

		expect(origins(assignTrendTopicIds([raw('ペンギン', range(500, 510))], previous, [], NOW))).toEqual(['heading']);
		// 重なる相手がいたのに取られた話題は、語が同じでも引き継がない（もとの決まりのまま）。
		const assigned = assignTrendTopicIds([raw('ペンギン', range(1, 6)), raw('ペンギン', range(7, 10).concat(range(20, 22)))], previous, [], NOW);
		expect(ids(assigned)).toEqual(['x', null]);
	});

	test('割れる・まとまるを繰り返しても、使う ID は増えない（11-18 の Suica の話題の形）', () => {
		let serial = 0;
		let previous: TrendTopicIdSource[] = [];
		let retired: TrendRetiredTopic[] = [];
		const seen = new Set<string>();
		const history: string[][] = [];
		const step = (minute: number, topics: { terms: string[]; noteIds: string[] }[]): void => {
			const now = NOW + minute * MINUTE;
			const assigned = assignTrendTopicIds(topics, previous, retired, now);
			const next = topics.map((topic, index) => ({
				topicId: assigned[index].source?.topicId ?? `id-${++serial}`,
				startedAt: assigned[index].source?.startedAt ?? new Date(now).toISOString(),
				terms: topic.terms, noteIds: topic.noteIds,
			}));
			retired = nextTrendRetiredTopics(previous, retired, new Set(next.map(topic => topic.topicId)), now - 10 * MINUTE, now);
			previous = next;
			for (const topic of next) seen.add(topic.topicId);
			history.push(next.map(topic => topic.topicId));
		};
		// 10 分ごと。投稿は 1 回に 20 件ずつ増える。3 件に 1 件が「生物」の投稿。偶数回は 1 つの話題、奇数回は「ペンギン」と「生物」に割れる。
		for (let i = 0; i < 12; i++) {
			const all = range(1, 60 + i * 20);
			const creature = all.filter((_, n) => (n + 1) % 3 === 0);
			if (i % 2 === 0) step(i * 10, [raw('ペンギン', all)]);
			else step(i * 10, [raw('ペンギン', all.filter((_, n) => (n + 1) % 3 !== 0)), raw('生物', creature)]);
		}

		// もとの話題の ID（id-1）はずっと残り、片割れは毎回同じ ID（id-2）で戻ってくる。
		expect([...seen]).toEqual(['id-1', 'id-2']);
		expect(history.every(row => row[0] === 'id-1')).toBe(true);
		expect(history.filter(row => row.length === 2).every(row => row[1] === 'id-2')).toBe(true);
	});
});

describe('nextTrendRetiredTopics', () => {
	test('引き継がれなかった前回の話題を足し、使われた ID・期限切れを除いて、あとで消えた順に上限まで覚える', () => {
		const previous = [prev('kept', 'ペンギン', range(1, 10)), prev('gone', '生物', range(11, 20)), prev('big', '機能', range(1000, 1000 + TREND_TOPIC_RETIRED_NOTE_MAX + 50))];
		const retired: TrendRetiredTopic[] = [
			{ ...prev('revived', '津田健次郎', range(21, 30)), retiredAt: NOW - 30 * MINUTE },
			{ ...prev('waiting', 'ウサギ', range(31, 40)), retiredAt: NOW - 60 * MINUTE },
			{ ...prev('expired', '古い話題', range(41, 50)), retiredAt: NOW - TREND_TOPIC_RETIRED_MS },
		];
		const next = nextTrendRetiredTopics(previous, retired, new Set(['kept', 'revived']), NOW - 10 * MINUTE, NOW);

		expect(next.map(topic => [topic.topicId, topic.retiredAt])).toEqual([['gone', NOW - 10 * MINUTE], ['big', NOW - 10 * MINUTE], ['waiting', NOW - 60 * MINUTE]]);
		expect(next[1].noteIds).toHaveLength(TREND_TOPIC_RETIRED_NOTE_MAX);
		expect(next[0]).toEqual({ topicId: 'gone', startedAt: previous[1].startedAt, terms: ['生物'], noteIds: range(11, 20), retiredAt: NOW - 10 * MINUTE });
	});

	test('覚えておく数には上限がある', () => {
		const previous = Array.from({ length: TREND_TOPIC_RETIRED_MAX + 5 }, (_, i) => prev(`t${i}`, `語${i}`, [`m${i}`]));

		expect(nextTrendRetiredTopics(previous, [], new Set(), NOW - 10 * MINUTE, NOW)).toHaveLength(TREND_TOPIC_RETIRED_MAX);
	});
});

describe('pickTrendTopicLeader', () => {
	const topic = (topicId: string, authors6h: number, startedMinutesAgo: number) => ({ topicId, authors6h, startedAt: new Date(NOW - startedMinutesAgo * MINUTE).toISOString() });

	test('人数が近い話題どうしでは、古いほうを代表にする', () => {
		expect(pickTrendTopicLeader([topic('new-bigger', 67, 30), topic('original', 61, 200)]).topicId).toBe('original');
	});

	test('古くても、いちばん大きい話題の半分に満たない話題は代表にしない', () => {
		expect(pickTrendTopicLeader([topic('old-small', 8, 300), topic('main', 100, 20), topic('sibling', 60, 10)]).topicId).toBe('main');
	});

	test('始まった時刻が同じなら人数の多いほう、それも同じなら先に並んでいるほう', () => {
		expect(pickTrendTopicLeader([topic('a', 6, 0), topic('b', 9, 0)]).topicId).toBe('b');
		expect(pickTrendTopicLeader([topic('a', 6, 0), topic('b', 6, 0)]).topicId).toBe('a');
	});
});
