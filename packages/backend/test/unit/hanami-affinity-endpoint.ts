/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { aggregateAffinity } from '@/core/hanami/HanamiAffinityContracts.js';
import type { MiLocalUser } from '@/models/User.js';

jest.unstable_mockModule('../../src/core/entities/UserEntityService.js', () => ({ UserEntityService: class {} }));
jest.unstable_mockModule('../../src/core/hanami/HanamiAffinityService.js', () => ({ HanamiAffinityService: class {} }));

const { default: AffinityEndpoint, meta } = await import('../../src/server/api/endpoints/users/hanami-affinity.js');
const me = { id: 'me' } as MiLocalUser;
const now = new Date('2026-09-15T00:00:00Z');
const peers = Array.from({ length: 100 }, (_, index) => ({ userId: `user${index}`, isBot: false, mutualFollow: false }));
const entries = aggregateAffinity(me.id, peers.map(peer => ({ id: peer.userId, userId: peer.userId, kind: 'reply', direction: 'out', createdAt: now })), peers, now);

function fixture() {
	const computeTop = jest.fn(async () => entries);
	const getComparisonSnapshot = jest.fn(async () => null);
	const packMany = jest.fn(async (ids: string[]) => ids.map(id => ({ id, username: id })));
	return {
		endpoint: new AffinityEndpoint({ packMany } as never, { computeTop, getComparisonSnapshot } as never),
		computeTop,
		packMany,
	};
}

describe('user cloud affinity API', () => {
	test('accepts 72 people and preserves their scores, counts and identities', async () => {
		const target = fixture();
		const result = await target.endpoint.exec({ mode: 'top', limit: 72 }, me, null);
		expect(meta.requireCredential).toBe(true);
		expect(meta.kind).toBe('read:account');
		expect(target.computeTop).toHaveBeenCalledWith(me.id);
		expect(target.packMany).toHaveBeenCalledWith(entries.slice(0, 72).map(entry => entry.userId), me, { schema: 'UserLite' });
		expect(result.items).toHaveLength(72);
		for (const [index, item] of result.items.entries()) {
			expect(item.user.id).toBe(entries[index].userId);
			expect(item.score).toBe(entries[index].score);
			expect(item.counts).toEqual(entries[index].counts);
		}
	});

	test.each([0, 73, 1.5])('rejects invalid count %p before computing', async limit => {
		const target = fixture();
		await expect(target.endpoint.exec({ mode: 'top', limit }, me, null)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
		expect(target.computeTop).not.toHaveBeenCalled();
	});

	test('keeps the default count and existing smaller requests compatible', async () => {
		const target = fixture();
		expect((await target.endpoint.exec({}, me, null)).items).toHaveLength(10);
		expect((await target.endpoint.exec({ mode: 'top', limit: 5 }, me, null)).items).toHaveLength(5);
	});
});
