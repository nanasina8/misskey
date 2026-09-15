/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 関係値（affinity）の定数・型・純関数。DB に触る部分は HanamiAffinityService 側。
// 設計: [[relationship-value-system-design]]（2026-06-15 合意）。定数は後でダンプ校正するので全部ここに置く。

export const AFFINITY = {
	dayMs: 86_400_000,
	jstOffsetMs: 9 * 60 * 60 * 1000,
	windowDays: 90,
	/** (相手 × 種別 × 方向) ごとの上限件数。新しいイベントから採る */
	cap: 30,
	weights: {
		reply: { out: 4, in: 1 },
		mention: { out: 4, in: 1 },
		renote: { out: 2, in: 0.5 },
		reaction: { out: 2, in: 0.3 },
	},
	decay: [{ days: 7, factor: 1 }, { days: 30, factor: 0.7 }, { days: 90, factor: 0.4 }],
	botDiscount: 0.5,
	reciprocity: 2,
	daysBonus: 1,
	mutualFollowBonus: 4,
	topLimit: 100,
	apiLimitMax: 72,
	apiLimitDefault: 10,
	topTtlMs: 10 * 60 * 1000,
	lapsedTtlMs: 60 * 60 * 1000,
	snapshotTtlSec: 40 * 86_400,
	snapshotMinDays: 28,
	snapshotMaxDays: 35,
	/** ご無沙汰: 過去窓 = pastStartDays 日前 〜 pastEndDays 日前 */
	pastStartDays: 120,
	pastEndDays: 30,
	pastTopLimit: 20,
	lapsedQuietDays: 21,
	/** ご無沙汰の「最近投稿あり」= この日数以内に public/home の投稿がある */
	recentNoteDays: 7,
	birthdayDays: 14,
} as const;

export type AffinityKind = keyof typeof AFFINITY.weights;
export type AffinityDirection = 'out' | 'in';

export type AffinityEvent = {
	id: string;
	/** 相手のユーザーID（out なら宛先、in なら発信者） */
	userId: string;
	kind: AffinityKind;
	direction: AffinityDirection;
	createdAt: Date;
};

export type AffinityPeer = { userId: string; isBot: boolean; mutualFollow: boolean };

export type AffinityCounts = Record<AffinityKind, Record<AffinityDirection, number>>;

export type AffinityEntry = {
	userId: string;
	score: number;
	out: number;
	in: number;
	days: number;
	types: number;
	mutualFollow: boolean;
	mutualInteraction: boolean;
	lastInteractionAt: Date | null;
	lastOutAt: Date | null;
	lastInAt: Date | null;
	/** 上限適用後に数えた件数 */
	counts: AffinityCounts;
	/** 上限適用前の全イベント数（ご無沙汰の「以前は週n回」用） */
	totalEvents: number;
};

export type AffinityLapsedEntry = {
	userId: string;
	daysSinceLast: number;
	pastPerWeek: number;
	/** 直近 recentNoteDays 日以内の最新 public/home 投稿。無ければ null */
	latestNoteAt: Date | null;
	birthdayWithin14d: boolean;
};

/** 日次スナップショット: [userId, rank][] */
export type AffinitySnapshot = [string, number][];

export function affinityDay(date: Date): string {
	return new Date(date.getTime() + AFFINITY.jstOffsetMs).toISOString().slice(0, 10);
}

export function affinityDecay(ageMs: number): number {
	for (const band of AFFINITY.decay) {
		if (ageMs <= band.days * AFFINITY.dayMs) return band.factor;
	}
	return 0;
}

function emptyCounts(): AffinityCounts {
	return { reply: { out: 0, in: 0 }, mention: { out: 0, in: 0 }, renote: { out: 0, in: 0 }, reaction: { out: 0, in: 0 } };
}

/**
 * DB 非依存の集計。events は窓の外を含んでよい（end からの経過で落とす）。
 * 返信先と同一人物へのメンションは SQL 側で落としてある前提（ここでは種別ごとに独立に数える）。
 */
export function aggregateAffinity(meId: string, events: readonly AffinityEvent[], peers: readonly AffinityPeer[], end: Date): AffinityEntry[] {
	const peerMap = new Map(peers.map(peer => [peer.userId, peer]));
	const groups = new Map<string, { entry: AffinityEntry; days: Set<string>; types: Set<AffinityKind>; seen: Set<string> }>();
	const sorted = [...events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
	const windowMs = AFFINITY.windowDays * AFFINITY.dayMs;

	for (const event of sorted) {
		const peer = peerMap.get(event.userId);
		const age = end.getTime() - event.createdAt.getTime();
		if (peer == null || event.userId === meId || age < 0 || age > windowMs) continue;

		let group = groups.get(event.userId);
		if (group == null) {
			group = {
				entry: {
					userId: event.userId,
					score: 0, out: 0, in: 0, days: 0, types: 0,
					mutualFollow: peer.mutualFollow,
					mutualInteraction: false,
					lastInteractionAt: null, lastOutAt: null, lastInAt: null,
					counts: emptyCounts(),
					totalEvents: 0,
				},
				days: new Set(), types: new Set(), seen: new Set(),
			};
			groups.set(event.userId, group);
		}
		const eventKey = `${event.direction}:${event.kind}:${event.id}`;
		if (group.seen.has(eventKey)) continue;
		group.seen.add(eventKey);

		const entry = group.entry;
		entry.totalEvents++;
		entry.lastInteractionAt ??= event.createdAt;
		if (event.direction === 'out') {
			entry.lastOutAt ??= event.createdAt;
			group.days.add(affinityDay(event.createdAt));
			group.types.add(event.kind);
		} else {
			entry.lastInAt ??= event.createdAt;
		}

		const counts = entry.counts[event.kind];
		if (counts[event.direction] >= AFFINITY.cap) continue;
		counts[event.direction]++;
		const discount = event.direction === 'in' && peer.isBot ? AFFINITY.botDiscount : 1;
		entry[event.direction] += AFFINITY.weights[event.kind][event.direction] * affinityDecay(age) * discount;
	}

	return [...groups.values()].map(({ entry, days, types }) => {
		entry.days = days.size;
		entry.types = types.size;
		entry.mutualInteraction = entry.out > 0 && entry.in > 0;
		entry.score = entry.out + entry.in
			+ AFFINITY.reciprocity * Math.min(entry.out, entry.in)
			+ AFFINITY.daysBonus * entry.days
			+ entry.types
			+ (entry.mutualFollow ? AFFINITY.mutualFollowBonus : 0);
		return entry;
	}).sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
}

export type OutgoingNoteRow = { id: string; replyUserId: string | null; renoteUserId: string | null; mentions: string[] | null };

/**
 * 自分のノート1件を out イベントに展開する（返信・リノート・メンション）。
 * 返信先と同じ相手へのメンションは返信として1回だけ数える。
 */
export function outgoingEventsFromNote(row: OutgoingNoteRow, createdAt: Date): AffinityEvent[] {
	const events: AffinityEvent[] = [];
	if (row.replyUserId != null) events.push({ id: row.id, userId: row.replyUserId, kind: 'reply', direction: 'out', createdAt });
	if (row.renoteUserId != null) events.push({ id: row.id, userId: row.renoteUserId, kind: 'renote', direction: 'out', createdAt });
	for (const mentioned of new Set(row.mentions ?? [])) {
		if (mentioned === row.replyUserId) continue;
		events.push({ id: row.id, userId: mentioned, kind: 'mention', direction: 'out', createdAt });
	}
	return events;
}

/** 先月比。正 = 順位が上がった */
export function affinityRankDelta(userId: string, rank: number, snapshot: AffinitySnapshot | null): number | null {
	const previous = snapshot?.find(([id]) => id === userId);
	return previous ? previous[1] - rank : null;
}

/** user_profile.birthday (YYYY-MM-DD) の月日が now から birthdayDays 日以内か（JST） */
export function affinityBirthdayWithin(birthday: string | null, now: Date): boolean {
	if (birthday == null || birthday.length < 10) return false;
	const target = birthday.slice(5, 10);
	for (let day = 0; day <= AFFINITY.birthdayDays; day++) {
		if (affinityDay(new Date(now.getTime() + day * AFFINITY.dayMs)).slice(5) === target) return true;
	}
	return false;
}

/**
 * ご無沙汰の抽出（純関数）。past = 過去窓で集計した上位、recentActiveIds = 直近 lapsedQuietDays 日に out/in いずれかがある相手。
 */
export function selectLapsed(past: readonly AffinityEntry[], recentActiveIds: ReadonlySet<string>, now: Date): Array<{ userId: string; daysSinceLast: number; pastPerWeek: number }> {
	const pastWeeks = (AFFINITY.pastStartDays - AFFINITY.pastEndDays) / 7;
	return past
		.slice(0, AFFINITY.pastTopLimit)
		.flatMap(entry => {
			if (recentActiveIds.has(entry.userId) || entry.lastInteractionAt == null) return [];
			return [{
				userId: entry.userId,
				daysSinceLast: Math.floor((now.getTime() - entry.lastInteractionAt.getTime()) / AFFINITY.dayMs),
				pastPerWeek: Math.round((entry.totalEvents / pastWeeks) * 10) / 10,
			}];
		});
}
