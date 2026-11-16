/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, beforeAll, test } from 'vitest';
import type * as misskey from 'misskey-js';
import { api, signup } from '../utils.js';

type Call = {
	endpoint: string;
	params: Record<string, unknown>;
	/** 管理者（最初のユーザー）が呼んだときに許す応答。既定は 200 か 204。 */
	ok?: number[];
	/** 管理者・モデレーターだけが呼べる（一般ユーザーは 403）。 */
	adminOnly?: boolean;
	/** ログインしていなくても呼べる。 */
	anonymous?: boolean;
};

const range = { days: 7 };

/**
 * このフォークで足した API を、ほぼ空のサーバーで一通り呼ぶ。
 * 目的は「SQL の書き間違い・列の不足・権限の付け忘れ」を見つけること（中身の正しさは各機能のテストが見る）。
 */
const calls: Call[] = [
	// はなみ TL・話題（利用者向け）
	{ endpoint: 'notes/hanami-trends', params: {}, anonymous: true },
	{ endpoint: 'notes/hanami-trends', params: { history: true, limit: 30 }, anonymous: true },
	{ endpoint: 'notes/hanami-trend-history', params: {}, anonymous: true },
	{ endpoint: 'notes/hanami-trend-history', params: { blocks: 4 }, anonymous: true },
	{ endpoint: 'notes/hanami-trend-topic-notes', params: { term: 'はなみ', from: new Date(Date.now() - 60 * 60 * 1000).toISOString(), to: new Date().toISOString() }, anonymous: true },
	{ endpoint: 'notes/hanami-topic', params: { topicId: 'no-such-topic' }, anonymous: true, ok: [200, 400, 404] },
	{ endpoint: 'notes/hanami-topic-notes', params: { topicId: 'no-such-topic' }, anonymous: true, ok: [200, 400, 404] },
	{ endpoint: 'notes/hanami-topic-notes', params: { topicId: 'no-such-topic', sort: 'popular' }, anonymous: true, ok: [200, 400, 404] },
	{ endpoint: 'notes/hanami-timeline-seen', params: { items: [] }, ok: [200, 204, 400] },
	{ endpoint: 'users/hanami-recommendations', params: {} },
	{ endpoint: 'users/hanami-affinity', params: {} },
	{ endpoint: 'i/hanami-tuning-suggestion', params: {} },
	{ endpoint: 'i/hanami-taste-clusters', params: {} },
	{ endpoint: 'i/update-hanami-taste-cluster', params: { clusterId: 0, weight: 1 }, ok: [200, 204, 400, 404] },
	// 統計とチャートは管理者だけ（利用者には出さない裁定）。
	{ endpoint: 'hanami/stats', params: {}, adminOnly: true },
	{ endpoint: 'charts/hanami-timeline', params: { span: 'day', limit: 7 }, adminOnly: true },

	// はなみの管理 API
	{ endpoint: 'admin/hanami/feed-status', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/axis-outlook', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/axis-outlook', params: { days: 30, poolHours: 168, maxUsers: 200 }, adminOnly: true },
	{ endpoint: 'admin/hanami/jobs-status', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/jobs-status', params: { eventsLimit: 300 }, adminOnly: true },
	{ endpoint: 'admin/hanami/judge-status', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/judge-settings', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/judge-aggregate', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/gpu-queue', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/taste-rebuild-status', params: {}, adminOnly: true },
	{ endpoint: 'admin/hanami/metrics/summary', params: { range }, adminOnly: true },
	{ endpoint: 'admin/hanami/metrics/breakdown', params: { range, dimension: 'source' }, adminOnly: true },
	{ endpoint: 'admin/hanami/metrics/errors', params: { range }, adminOnly: true },
	{ endpoint: 'admin/hanami/metrics/opportunities', params: { range }, adminOnly: true },
	{ endpoint: 'admin/hanami/metrics/what-if', params: { range }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/hanami/metrics/notes', params: { range }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/hanami/suggestion-events-export', params: {}, adminOnly: true, ok: [200, 204, 400] },

	// AI 投稿チェック
	{ endpoint: 'admin/ai-moderation/status', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/queue', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/queue', params: { resolved: true, limit: 5 }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/ai-moderation/accounts', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/groups', params: { groupBy: 'host' }, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/groups', params: { groupBy: 'link' }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/ai-moderation/groups', params: { groupBy: 'text' }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/ai-moderation/group-accounts', params: { groupBy: 'host', key: 'example.com' }, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/hidden', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/outcomes', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/criteria', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/scan/show', params: {}, adminOnly: true },
	{ endpoint: 'admin/ai-moderation/scan/estimate', params: {}, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/ai-moderation/scan/estimate', params: { mode: 'filtered', target: 'all', days: 7 }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/ai-moderation/scan/estimate', params: { mode: 'all', target: 'local', days: null }, adminOnly: true, ok: [200, 400] },
	{ endpoint: 'admin/ai-moderation/scan/items', params: { scanId: 'no-such-scan' }, adminOnly: true, ok: [200, 400, 404] },
	{ endpoint: 'admin/ai-moderation/scan/export', params: { scanId: 'no-such-scan' }, adminOnly: true, ok: [200, 400, 404] },
	{ endpoint: 'admin/ai-moderation/scan/cancel', params: { scanId: 'no-such-scan' }, adminOnly: true, ok: [200, 204, 400, 404] },
	{ endpoint: 'admin/ai-moderation/resolve', params: { queueId: 'no-such-row' }, adminOnly: true, ok: [200, 204, 400, 404] },
	{ endpoint: 'admin/ai-moderation/update', params: { queueId: 'no-such-row' }, adminOnly: true, ok: [200, 204, 400, 404] },
	{ endpoint: 'admin/ai-moderation/bulk-resolve', params: { groupBy: 'host', key: 'example.com', expectedCount: 0 }, adminOnly: true, ok: [200, 204, 400] },
	{ endpoint: 'admin/ai-moderation/bulk-suspend', params: { userIds: [], expectedCount: 0 }, adminOnly: true, ok: [200, 204, 400] },
	{ endpoint: 'admin/ai-moderation/unhide', params: { targetType: 'host', host: 'example.com' }, adminOnly: true, ok: [200, 204, 400, 404] },
	// GPU（判定の実行環境）が無いテスト環境では 503 で断る。500 にはならないこと。
	{ endpoint: 'admin/ai-moderation/trial', params: { text: 'これはテストです https://example.com/' }, adminOnly: true, ok: [200, 503] },
	{ endpoint: 'admin/hanami/judge-trial', params: { limit: 1 }, adminOnly: true, ok: [200, 503] },
	{ endpoint: 'admin/emoji/refingerprint', params: { scope: 'local' }, adminOnly: true, ok: [200, 204, 400] },
];

describe('このフォークで足した API を一通り呼ぶ', () => {
	let admin: misskey.entities.SignupResponse;
	let member: misskey.entities.SignupResponse;

	beforeAll(async () => {
		admin = await signup({ username: 'fork_admin' });
		member = await signup({ username: 'fork_member' });
		// 反応・返信・リノートを少しだけ作り、空ではない状態で読む。
		const note = await api('notes/create', { text: 'はなみ の API を一通り呼ぶ https://example.com/a' }, admin);
		assert.strictEqual(note.status, 200);
		const noteId = (note.body as { createdNote: { id: string } }).createdNote.id;
		assert.strictEqual((await api('notes/reactions/create', { noteId, reaction: '👍' }, member)).status, 204);
		assert.strictEqual((await api('notes/create', { replyId: noteId, text: 'へんしん @fork_admin' }, member)).status, 200);
		assert.strictEqual((await api('notes/create', { renoteId: noteId }, member)).status, 200);
	}, 1000 * 60 * 2);

	const describeBody = (body: unknown): string => JSON.stringify(body)?.slice(0, 400) ?? '';

	for (const call of calls) {
		const label = `${call.endpoint} ${JSON.stringify(call.params)}`;

		test(`管理者: ${label}`, async () => {
			const res = await api(call.endpoint as never, call.params as never, admin);
			const allowed = call.ok ?? [200, 204];
			assert.ok(allowed.includes(res.status), `${label} → ${res.status} ${describeBody(res.body)}`);
		});

		test(`一般ユーザー: ${label}`, async () => {
			const res = await api(call.endpoint as never, call.params as never, member);
			if (call.adminOnly) {
				assert.strictEqual(res.status, 403, `${label} は一般ユーザーに 403 を返すこと → ${res.status} ${describeBody(res.body)}`);
			} else {
				assert.ok(res.status < 500, `${label} → ${res.status} ${describeBody(res.body)}`);
			}
		});

		if (call.anonymous) {
			test(`未ログイン: ${label}`, async () => {
				const res = await api(call.endpoint as never, call.params as never);
				assert.ok((call.ok ?? [200, 204]).includes(res.status), `${label} → ${res.status} ${describeBody(res.body)}`);
			});
		} else {
			test(`未ログイン: ${label}`, async () => {
				const res = await api(call.endpoint as never, call.params as never);
				// secure な API は未ログインに 400 ACCESS_DENIED を返す（本家と同じ）。
				const denied = res.status === 401 || res.status === 403
					|| (res.status === 400 && (res.body as { error?: { code?: string } } | null)?.error?.code === 'ACCESS_DENIED');
				assert.ok(denied, `${label} は未ログインを拒むこと → ${res.status} ${describeBody(res.body)}`);
			});
		}
	}

	test('AI 投稿チェック: 全体スキャンを始めて、一覧・書き出し・中止まで通る', async () => {
		const started = await api('admin/ai-moderation/scan/start' as never, { mode: 'all', target: 'local', days: 1, maxJudged: 10 } as never, admin);
		assert.strictEqual(started.status, 200, describeBody(started.body));
		const scanId = (started.body as { id: string }).id;
		assert.ok(typeof scanId === 'string' && scanId.length > 0, describeBody(started.body));

		// 実行中にもう一つは始められない。
		const second = await api('admin/ai-moderation/scan/start' as never, {} as never, admin);
		assert.strictEqual(second.status, 400, describeBody(second.body));

		for (const [endpoint, params] of [
			['admin/ai-moderation/scan/show', {}],
			['admin/ai-moderation/scan/show', { scanId }],
			['admin/ai-moderation/scan/items', { scanId }],
			['admin/ai-moderation/scan/items', { scanId, flagged: null, limit: 5 }],
			['admin/ai-moderation/scan/export', { scanId }],
			['admin/ai-moderation/status', {}],
			['admin/hanami/gpu-queue', {}],
		] as const) {
			const res = await api(endpoint as never, params as never, admin);
			assert.strictEqual(res.status, 200, `${endpoint} ${JSON.stringify(params)} → ${res.status} ${describeBody(res.body)}`);
		}

		const canceled = await api('admin/ai-moderation/scan/cancel' as never, { scanId } as never, admin);
		assert.ok([200, 204].includes(canceled.status), describeBody(canceled.body));
		const after = await api('admin/ai-moderation/scan/show' as never, { scanId } as never, admin);
		assert.strictEqual(after.status, 200, describeBody(after.body));
	});

	test('AI 投稿チェック: サーバーを隠して、一覧に出て、戻せる', async () => {
		const hidden = await api('admin/ai-moderation/hide' as never, { targetType: 'host', host: 'spam.example.com', moderationNote: 'e2e' } as never, admin);
		assert.ok([200, 204].includes(hidden.status), describeBody(hidden.body));
		const list = await api('admin/ai-moderation/hidden' as never, {} as never, admin);
		assert.strictEqual(list.status, 200, describeBody(list.body));
		assert.ok(JSON.stringify(list.body).includes('spam.example.com'), describeBody(list.body));
		const unhidden = await api('admin/ai-moderation/unhide' as never, { targetType: 'host', host: 'spam.example.com' } as never, admin);
		assert.ok([200, 204].includes(unhidden.status), describeBody(unhidden.body));
		const empty = await api('admin/ai-moderation/hidden' as never, {} as never, admin);
		assert.ok(!JSON.stringify(empty.body).includes('spam.example.com'), describeBody(empty.body));
	});

	test('はなみ TL: 開く・更新する・調整を変えるが 5xx にならない', async () => {
		const open = await api('notes/hanami-timeline' as never, {} as never, member);
		// 共通の TL がまだ作られていないサーバーでは 503 HANAMI_COMMON_NOT_READY（想定どおり）。
		assert.ok(open.status === 200 || (open.status === 503 && (open.body as { error?: { code?: string } }).error?.code === 'HANAMI_COMMON_NOT_READY'), `${open.status} ${describeBody(open.body)}`);
		// 先頭だけの軽い確認も同じ決まりで答える（裏の生成が進むので先頭の一致までは見ない）。
		const head = await api('notes/hanami-timeline-head' as never, {} as never, member);
		assert.strictEqual(head.status, open.status, `${head.status} ${describeBody(head.body)}`);
		const tuned = await api('i/update' as never, { hanamiShowRecommendationReason: true } as never, member);
		assert.strictEqual(tuned.status, 200, describeBody(tuned.body));
		for (const endpoint of ['notes/timeline', 'notes/local-timeline', 'notes/hybrid-timeline', 'notes/global-timeline', 'notes/featured'] as const) {
			const res = await api(endpoint as never, { limit: 5 } as never, member);
			assert.strictEqual(res.status, 200, `${endpoint} → ${res.status} ${describeBody(res.body)}`);
		}
	});
});
