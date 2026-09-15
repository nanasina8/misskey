/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import {
	AFFINITY,
	affinityBirthdayWithin,
	affinityDecay,
	affinityRankDelta,
	aggregateAffinity,
	outgoingEventsFromNote,
	selectLapsed,
} from '@/core/hanami/HanamiAffinityContracts.js';
import type { AffinityEntry, AffinityEvent, AffinityKind, AffinityDirection, AffinityPeer } from '@/core/hanami/HanamiAffinityContracts.js';

const ME = 'me';
const END = new Date('2026-09-15T00:00:00Z');
const DAY = AFFINITY.dayMs;

let seq = 0;

function ev(userId: string, kind: AffinityKind, direction: AffinityDirection, ageDays: number): AffinityEvent {
	seq++;
	return { id: `e${String(seq).padStart(6, '0')}`, userId, kind, direction, createdAt: new Date(END.getTime() - ageDays * DAY) };
}

function peer(userId: string, overrides: Partial<AffinityPeer> = {}): AffinityPeer {
	return { userId, isBot: false, mutualFollow: false, ...overrides };
}

function one(events: AffinityEvent[], peers: AffinityPeer[] = [peer('a')]): AffinityEntry {
	const entries = aggregateAffinity(ME, events, peers, END);
	expect(entries).toHaveLength(1);
	return entries[0];
}

describe('aggregateAffinity', () => {
	test('(a) applies the weight table per kind and direction', () => {
		const kinds: AffinityKind[] = ['reply', 'mention', 'renote', 'reaction'];
		for (const kind of kinds) {
			for (const direction of ['out', 'in'] as const) {
				const entry = one([ev('a', kind, direction, 1)]);
				expect(entry[direction]).toBeCloseTo(AFFINITY.weights[kind][direction]);
				expect(entry[direction === 'out' ? 'in' : 'out']).toBe(0);
			}
		}
	});

	test('(b) decays in three bands and drops events outside the 90 day window', () => {
		expect(affinityDecay(7 * DAY)).toBe(1);
		expect(affinityDecay(7 * DAY + 1)).toBe(0.7);
		expect(affinityDecay(30 * DAY)).toBe(0.7);
		expect(affinityDecay(30 * DAY + 1)).toBe(0.4);
		expect(affinityDecay(90 * DAY)).toBe(0.4);
		expect(one([ev('a', 'reply', 'out', 8)]).out).toBeCloseTo(4 * 0.7);
		expect(one([ev('a', 'reply', 'out', 31)]).out).toBeCloseTo(4 * 0.4);
		expect(aggregateAffinity(ME, [ev('a', 'reply', 'out', 91)], [peer('a')], END)).toHaveLength(0);
		expect(aggregateAffinity(ME, [ev('a', 'reply', 'out', -1)], [peer('a')], END)).toHaveLength(0);
	});

	test('(c) caps at 30 per peer × kind × direction, keeping the newest, without crowding out the other direction', () => {
		const events: AffinityEvent[] = [];
		for (let i = 0; i < 40; i++) events.push(ev('a', 'reaction', 'in', i < 20 ? 1 : 20));
		for (let i = 0; i < 3; i++) events.push(ev('a', 'reply', 'out', 2));
		const entry = one(events);
		expect(entry.counts.reaction.in).toBe(30);
		expect(entry.counts.reply.out).toBe(3);
		// 20 newest at ×1.0 and 10 at ×0.7 survive; the remaining 10 old ones are cut
		expect(entry.in).toBeCloseTo(20 * 0.3 + 10 * 0.3 * 0.7);
		expect(entry.out).toBeCloseTo(3 * 4);
		expect(entry.totalEvents).toBe(43);
	});

	test('(d) does not double count: a mention of the reply target is folded into the reply, and the same event id counts once', () => {
		const at = new Date(END.getTime() - DAY);
		const expanded = outgoingEventsFromNote({ id: 'n1', replyUserId: 'a', renoteUserId: null, mentions: ['a', 'b', 'b'] }, at);
		expect(expanded.map(e => `${e.kind}:${e.userId}`).sort()).toEqual(['mention:b', 'reply:a']);
		const quote = outgoingEventsFromNote({ id: 'n2', replyUserId: null, renoteUserId: 'c', mentions: null }, at);
		expect(quote.map(e => `${e.kind}:${e.userId}`)).toEqual(['renote:c']);

		const dup = ev('a', 'reply', 'out', 1);
		const entry = one([dup, { ...dup }]);
		expect(entry.counts.reply.out).toBe(1);
		expect(entry.out).toBeCloseTo(4);
	});

	test('(e) reciprocity bonus is R·min(out,in): zero when one side is silent', () => {
		const silent = one([ev('a', 'reply', 'out', 1)]);
		expect(silent.mutualInteraction).toBe(false);
		expect(silent.score).toBeCloseTo(4 + 0 + AFFINITY.daysBonus * 1 + 1);

		const mutual = one([ev('a', 'reply', 'out', 1), ev('a', 'reply', 'in', 1)]);
		expect(mutual.mutualInteraction).toBe(true);
		expect(mutual.score).toBeCloseTo(4 + 1 + AFFINITY.reciprocity * 1 + 1 + 1);
	});

	test('(f) counts distinct JST days and distinct kinds from outgoing events only', () => {
		// 2026-09-14T14:00Z = 09-14 23:00 JST, 2026-09-14T15:30Z = 09-15 00:30 JST
		const a = ev('a', 'reply', 'out', 0); a.createdAt = new Date('2026-09-14T14:00:00Z');
		const b = ev('a', 'reaction', 'out', 0); b.createdAt = new Date('2026-09-14T15:30:00Z');
		const c = ev('a', 'renote', 'in', 0); c.createdAt = new Date('2026-09-10T00:00:00Z');
		const entry = one([a, b, c]);
		expect(entry.days).toBe(2);
		expect(entry.types).toBe(2);
	});

	test('(g) discounts incoming signals from bots, not outgoing', () => {
		const entry = one([ev('a', 'reply', 'in', 1), ev('a', 'reply', 'out', 1)], [peer('a', { isBot: true })]);
		expect(entry.in).toBeCloseTo(1 * AFFINITY.botDiscount);
		expect(entry.out).toBeCloseTo(4);
	});

	test('(h) adds the mutual follow bonus', () => {
		const plain = one([ev('a', 'reply', 'out', 1)]);
		const mutual = one([ev('a', 'reply', 'out', 1)], [peer('a', { mutualFollow: true })]);
		expect(mutual.score - plain.score).toBeCloseTo(AFFINITY.mutualFollowBonus);
		expect(mutual.mutualFollow).toBe(true);
	});

	test('ignores peers that are not visible and events targeting me', () => {
		const entries = aggregateAffinity(ME, [ev('hidden', 'reply', 'out', 1), ev(ME, 'reply', 'out', 1)], [peer('a')], END);
		expect(entries).toHaveLength(0);
	});

	test('sorts by score descending and records last interaction timestamps per direction', () => {
		const entries = aggregateAffinity(ME, [
			ev('low', 'reaction', 'in', 5),
			ev('high', 'reply', 'out', 1),
			ev('high', 'reply', 'in', 3),
		], [peer('low'), peer('high')], END);
		expect(entries.map(e => e.userId)).toEqual(['high', 'low']);
		expect(entries[0].lastOutAt).toEqual(new Date(END.getTime() - 1 * DAY));
		expect(entries[0].lastInAt).toEqual(new Date(END.getTime() - 3 * DAY));
		expect(entries[0].lastInteractionAt).toEqual(new Date(END.getTime() - 1 * DAY));
	});
});

describe('helpers', () => {
	test('affinityRankDelta is positive when the user moved up', () => {
		expect(affinityRankDelta('a', 1, [['a', 3], ['b', 1]])).toBe(2);
		expect(affinityRankDelta('b', 3, [['a', 3], ['b', 1]])).toBe(-2);
		expect(affinityRankDelta('c', 2, [['a', 3]])).toBeNull();
		expect(affinityRankDelta('a', 2, null)).toBeNull();
	});

	test('affinityBirthdayWithin looks 14 days ahead in JST', () => {
		const now = new Date('2026-09-15T00:00:00Z'); // 09-15 09:00 JST
		expect(affinityBirthdayWithin('1990-09-15', now)).toBe(true);
		expect(affinityBirthdayWithin('1990-09-29', now)).toBe(true);
		expect(affinityBirthdayWithin('1990-09-30', now)).toBe(false);
		expect(affinityBirthdayWithin('1990-09-14', now)).toBe(false);
		expect(affinityBirthdayWithin(null, now)).toBe(false);
	});

	test('selectLapsed keeps past top peers that went quiet and derives per-week frequency', () => {
		const now = new Date('2026-09-15T00:00:00Z');
		const pastEnd = new Date(now.getTime() - AFFINITY.pastEndDays * DAY);
		const past: AffinityEntry[] = [
			{ userId: 'quiet', score: 10, out: 5, in: 5, days: 3, types: 2, mutualFollow: false, mutualInteraction: true, lastInteractionAt: new Date(pastEnd.getTime() - 12 * DAY), lastOutAt: null, lastInAt: null, counts: { reply: { out: 0, in: 0 }, mention: { out: 0, in: 0 }, renote: { out: 0, in: 0 }, reaction: { out: 0, in: 0 } }, totalEvents: 39 },
			{ userId: 'active', score: 9, out: 5, in: 4, days: 3, types: 2, mutualFollow: false, mutualInteraction: true, lastInteractionAt: pastEnd, lastOutAt: null, lastInAt: null, counts: { reply: { out: 0, in: 0 }, mention: { out: 0, in: 0 }, renote: { out: 0, in: 0 }, reaction: { out: 0, in: 0 } }, totalEvents: 10 },
		];
		const result = selectLapsed(past, new Set(['active']), now);
		expect(result).toEqual([{ userId: 'quiet', daysSinceLast: 42, pastPerWeek: 3 }]);
	});
});
