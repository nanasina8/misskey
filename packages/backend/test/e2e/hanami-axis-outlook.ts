/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { beforeAll, describe, test } from 'vitest';
import type * as misskey from 'misskey-js';
import { api, post, react, signup } from '../utils.js';

describe('はなみの軸の見込み（admin/hanami/axis-outlook）', () => {
	let root: misskey.entities.SignupResponse;
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let carol: misskey.entities.SignupResponse;
	let dave: misskey.entities.SignupResponse;
	let erin: misskey.entities.SignupResponse;

	beforeAll(async () => {
		root = await signup({ username: 'root' });
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		carol = await signup({ username: 'carol' });
		dave = await signup({ username: 'dave' });
		erin = await signup({ username: 'erin' });

		// alice は bob と erin をフォローしている。carol と dave はフォローしていない。
		await api('following/create', { userId: bob.id }, alice);
		await api('following/create', { userId: erin.id }, alice);

		const carolNote = await post(carol, { text: 'carol の投稿' });
		const bobNote = await post(bob, { text: 'bob の投稿' });
		const daveNote = await post(dave, { text: 'dave の投稿' });
		// フォロー中どうしの返信（erin → bob）。
		await post(erin, { text: 'bob への返信', replyId: bobNote.id });

		// carol の投稿には、先に bob（alice のフォロー中）が反応し、そのあと alice が反応する。
		await react(bob, carolNote, '👍');
		await react(alice, carolNote, '👍');
		// フォロー中の投稿への反応。
		await react(alice, bobNote, '👍');
		// だれも反応していない、フォロー外の人の投稿への反応。
		await react(alice, daveNote, '👍');
	}, 1000 * 60 * 2);

	test('TL の外も含めた反応と、軸ごとの候補の数を返す', async () => {
		const res = await api('admin/hanami/axis-outlook', { days: 1, poolHours: 6 }, root);
		assert.strictEqual(res.status, 200, JSON.stringify(res.body));
		const body = res.body;
		assert.deepStrictEqual(body.errors, []);

		// 反応 4 件: alice 3 件（carol・bob・dave）＋ bob 1 件（carol）。
		const reactions = body.reactions;
		assert.ok(reactions != null);
		assert.strictEqual(reactions.total, 4);
		assert.strictEqual(reactions.truncated, false);
		assert.strictEqual(reactions.users, 2);
		assert.strictEqual(reactions.largestUserShare, 0.75);
		assert.strictEqual(reactions.toFollowee, 1);
		assert.strictEqual(reactions.toLocalAuthor, 4);
		assert.strictEqual(reactions.onReply, 0);
		assert.strictEqual(reactions.age.under1h, 4);
		assert.strictEqual(reactions.followeeAge.under1h, 1);
		// フォロー外への 3 件のうち、先にフォロー中が反応していたのは alice → carol の 1 件だけ。
		assert.strictEqual(reactions.nonFollowee.total, 3);
		assert.strictEqual(reactions.nonFollowee.users, 2);
		assert.strictEqual(reactions.nonFollowee.followeeReactedBefore, 1);
		assert.strictEqual(reactions.nonFollowee.twoFolloweesReactedBefore, 0);
		assert.strictEqual(reactions.nonFollowee.followeeRenotedBefore, 0);
		assert.strictEqual(reactions.nonFollowee.followeeRepliedBefore, 0);
		assert.strictEqual(reactions.nonFollowee.anySocial, 1);
		// bob → carol と alice → dave は、最初の反応。
		assert.strictEqual(reactions.nonFollowee.noPriorReaction, 2);
		assert.strictEqual(reactions.nonFollowee.localAuthor, 3);

		// 候補を数える対象は、だれかをフォローしている alice だけ。
		const pools = body.pools;
		assert.ok(pools != null);
		assert.strictEqual(pools.measuredUsers, 1);
		assert.strictEqual(pools.measuredUsersTruncated, false);
		// フォロー中（bob）が反応した、フォロー外の人（carol）の投稿が 1 件。
		assert.deepStrictEqual(pools.followeeReacted1, { users: 1, zero: 0, p25: 1, p50: 1, p75: 1, max: 1 });
		assert.strictEqual(pools.followeeReacted2.max, 0);
		assert.strictEqual(pools.followeeReacted2.zero, 1);
		// フォロー中どうしの返信が 1 件。3 件以上続いたやりとりは無い。
		assert.strictEqual(pools.conversationReplies.max, 1);
		assert.strictEqual(pools.conversationThreads3.max, 0);
		// フォローしていないローカルの人（carol・dave）の元投稿が 2 件。
		assert.strictEqual(pools.localNonFolloweeNotes.max, 2);

		// ローカルの元投稿は 3 件・3 人（返信は数えない）。3 件とも反応が付いている。
		assert.deepStrictEqual(body.local, { originals: 3, authors: 3, withReaction: 3 });

		const population = body.population;
		assert.ok(population != null);
		assert.ok(population.activeLocalUsers >= 5, `activeLocalUsers=${population.activeLocalUsers}`);
		assert.strictEqual(population.activeWithFollowees5, 0);
		assert.strictEqual(population.activeWithAlsNeighbors, 0);
		assert.strictEqual(population.hanamiUsers, 0);

		assert.ok(body.lapsed != null);
		assert.strictEqual(body.lapsed.measuredUsers, 1);
		assert.strictEqual(body.lapsed.people.max, 0);

		// リモートの投稿も、はなみTL で見た記録も無いサーバーでは、知らない人の集計は 0 で返る（null や失敗にならない）。
		assert.deepStrictEqual(body.strangerSupply, {
			originals: 0, authors: 0, visibleReaction1: 0, visibleReaction5: 0, visibleReaction10: 0,
			long: 0, longNoReaction: 0, withFiles: 0, judged: 0, interest4: 0, interest4NoReaction: 0,
		});
		assert.deepStrictEqual(body.strangerConversion, {
			total: { pairs: 0, followedAfter: 0, engagedAfter: 0, engagedElsewhereAfter: 0 },
			bySource: [],
		});
		assert.deepStrictEqual(body.strangerInterest?.map(row => row.bucket), ['under3', '3to3.5', '3.5to4', '4to4.5', '4.5plus']);
		assert.ok(body.strangerInterest?.every(row => row.seen === 0 && row.engaged === 0));

		assert.strictEqual(body.range.days, 1);
		assert.strictEqual(body.range.poolHours, 6);
	});

	test('管理者でなければ呼べない', async () => {
		const res = await api('admin/hanami/axis-outlook', {}, alice);
		assert.strictEqual(res.status, 403);
	});

	test('範囲の外の引数は断る', async () => {
		const res = await api('admin/hanami/axis-outlook', { days: 31 }, root);
		assert.strictEqual(res.status, 400);
	});
});
