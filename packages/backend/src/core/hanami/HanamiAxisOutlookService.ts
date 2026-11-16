/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { HanamiAffinityService } from '@/core/hanami/HanamiAffinityService.js';

/**
 * はなみTL の「軸を足す・直す」判断に使う見込みの集計。
 * いまの指標（admin/hanami/metrics/*）は はなみTL に出した投稿しか数えないので、
 * 「出していない候補がどれだけあるか」「TL の外で何に反応しているか」はここで数える。
 * 返すのは件数と分布だけで、利用者や投稿の ID は返さない。
 */

const STATEMENT_TIMEOUT_MS = 20_000;
const REACTION_ROW_LIMIT = 50_000;
const LAPSED_USER_LIMIT = 30;
const CLOSE_AUTHOR_LIMIT = 30;
const ALS_RUN_KIND = 'als';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type HanamiAxisOutlookInput = {
	days: number;
	poolHours: number;
	maxUsers: number;
	now?: Date;
};

export type HanamiAxisOutlookDistribution = {
	users: number;
	zero: number;
	p25: number | null;
	p50: number | null;
	p75: number | null;
	max: number | null;
};

export type HanamiAxisOutlookAge = {
	under1h: number;
	h1to6: number;
	h6to24: number;
	d1to3: number;
	over3d: number;
};

export type HanamiAxisOutlookPopulation = {
	activeLocalUsers: number;
	activeWithFollowees5: number;
	activeWithAlsNeighbors: number;
	activeWithRelation: number;
	hanamiUsers: number;
	hanamiWithFollowees5: number;
	hanamiWithAlsNeighbors: number;
	hanamiWithRelation: number;
};

export type HanamiAxisOutlookReactions = {
	total: number;
	truncated: boolean;
	users: number;
	largestUserShare: number | null;
	toFollowee: number;
	toLocalAuthor: number;
	onReply: number;
	withFiles: number;
	age: HanamiAxisOutlookAge;
	followeeAge: HanamiAxisOutlookAge;
	nonFollowee: {
		total: number;
		users: number;
		followeeReactedBefore: number;
		twoFolloweesReactedBefore: number;
		followeeRenotedBefore: number;
		followeeRepliedBefore: number;
		authorFollowsMe: number;
		authorReactedToMe: number;
		anySocial: number;
		noPriorReaction: number;
		localAuthor: number;
		age: HanamiAxisOutlookAge;
	};
};

export type HanamiAxisOutlookPools = {
	measuredUsers: number;
	measuredUsersTruncated: boolean;
	followeeReacted1: HanamiAxisOutlookDistribution;
	followeeReacted2: HanamiAxisOutlookDistribution;
	followeeReacted3: HanamiAxisOutlookDistribution;
	conversationReplies: HanamiAxisOutlookDistribution;
	conversationThreads3: HanamiAxisOutlookDistribution;
	closeAuthorNotes: HanamiAxisOutlookDistribution;
	closeAuthorNotesNoReaction: HanamiAxisOutlookDistribution;
	closeAuthorNotesUnreacted: HanamiAxisOutlookDistribution;
	localNonFolloweeNotes: HanamiAxisOutlookDistribution;
};

export type HanamiAxisOutlookLocal = {
	originals: number;
	authors: number;
	withReaction: number;
};

export type HanamiAxisOutlook = {
	range: { from: string; to: string; days: number; poolFrom: string; poolHours: number };
	population: HanamiAxisOutlookPopulation | null;
	reactions: HanamiAxisOutlookReactions | null;
	pools: HanamiAxisOutlookPools | null;
	lapsed: { measuredUsers: number; people: HanamiAxisOutlookDistribution } | null;
	local: HanamiAxisOutlookLocal | null;
	errors: Array<{ section: string; message: string }>;
};

type PopulationRow = { active: boolean; hanami: boolean; followees: number; neighbors: boolean; relation: boolean };

type ReactionRow = {
	rid: string;
	nid: string;
	uid: string;
	local_author: boolean;
	is_reply: boolean;
	has_files: boolean;
	is_followee: boolean;
	followee_reacted: number;
	followee_renoted: boolean;
	followee_replied: boolean;
	author_follows_me: boolean;
	author_reacted_to_me: boolean;
	no_prior_reaction: boolean;
};

type PoolRow = {
	one: number;
	two: number;
	three: number;
	replies: number;
	threads: number;
	close_total: number;
	close_no_reaction: number;
	close_unreacted: number;
	local_notes: number;
};

/** 投稿として TL に出せるもの（公開範囲・チャンネル外）。 */
const VISIBLE_NOTE_SQL = (alias: string) => `${alias}.visibility IN ('public', 'home') AND ${alias}."channelId" IS NULL`;

/** 見逃し（catchup）と同じ「元の投稿」の条件。他人への返信と、本文の無いリノートを除く。 */
const ORIGINAL_NOTE_SQL = (alias: string) => `(${alias}."replyId" IS NULL OR ${alias}."replyUserId" = ${alias}."userId")
	AND (${alias}."renoteId" IS NULL OR ${alias}.text IS NOT NULL OR ${alias}."hasPoll" = TRUE OR ${alias}."fileIds" <> '{}')`;

const POPULATION_SQL = `
	WITH run AS (
		SELECT "id" FROM "hanami_foryou_model_run"
		WHERE "kind" = $2 AND "status" = 'ready'
		ORDER BY "startedAt" DESC, "id" DESC
		LIMIT 1
	),
	active AS (
		SELECT u.id FROM "user" u
		WHERE u.host IS NULL AND u."isDeleted" = FALSE AND u."isSuspended" = FALSE AND u."lastActiveDate" >= $1
	),
	hanami AS (
		SELECT DISTINCT e."userId" AS id FROM "hanami_recommendation_event" e
		WHERE e."eventType" = 'served' AND e."createdAt" >= $1
	),
	people AS (SELECT id FROM active UNION SELECT id FROM hanami)
	SELECT
		(p.id IN (SELECT id FROM active)) AS active,
		(p.id IN (SELECT id FROM hanami)) AS hanami,
		(SELECT count(*)::int FROM following f WHERE f."followerId" = p.id) AS followees,
		EXISTS (SELECT 1 FROM "hanami_foryou_neighbor_user" nu WHERE nu."runId" = (SELECT "id" FROM run) AND nu."userId" = p.id) AS neighbors,
		EXISTS (SELECT 1 FROM "hanami_foryou_relation" hr WHERE hr."userId" = p.id) AS relation
	FROM people p
`;

const MEASURED_USERS_SQL = `
	SELECT u.id FROM "user" u
	WHERE u.host IS NULL AND u."isDeleted" = FALSE AND u."isSuspended" = FALSE AND u."lastActiveDate" >= $1
		AND EXISTS (SELECT 1 FROM following f WHERE f."followerId" = u.id)
	ORDER BY u."lastActiveDate" DESC, u.id ASC
	LIMIT $2
`;

/** ローカルの人が、期間内に他人の投稿へ付けたリアクション 1 件ごとの関係。場所（どの TL か）は問わない。 */
const REACTIONS_SQL = `
	SELECT r.id AS rid, n.id AS nid, r."userId" AS uid,
		(n."userHost" IS NULL) AS local_author,
		(n."replyId" IS NOT NULL) AS is_reply,
		(n."fileIds" <> '{}') AS has_files,
		EXISTS (SELECT 1 FROM following f WHERE f."followerId" = r."userId" AND f."followeeId" = n."userId") AS is_followee,
		(SELECT count(*)::int FROM note_reaction r2
			JOIN following f ON f."followerId" = r."userId" AND f."followeeId" = r2."userId"
			WHERE r2."noteId" = r."noteId" AND r2.id < r.id) AS followee_reacted,
		EXISTS (SELECT 1 FROM note rn
			JOIN following f ON f."followerId" = r."userId" AND f."followeeId" = rn."userId"
			WHERE rn."renoteId" = r."noteId" AND rn.id < r.id) AS followee_renoted,
		EXISTS (SELECT 1 FROM note rp
			JOIN following f ON f."followerId" = r."userId" AND f."followeeId" = rp."userId"
			WHERE rp."replyId" = r."noteId" AND rp.id < r.id) AS followee_replied,
		EXISTS (SELECT 1 FROM following f WHERE f."followerId" = n."userId" AND f."followeeId" = r."userId") AS author_follows_me,
		EXISTS (SELECT 1 FROM note_reaction r3
			JOIN note mine ON mine.id = r3."noteId" AND mine."userId" = r."userId"
			WHERE r3."userId" = n."userId" AND r3.id >= $1 AND r3.id < r.id) AS author_reacted_to_me,
		NOT EXISTS (SELECT 1 FROM note_reaction r4 WHERE r4."noteId" = r."noteId" AND r4.id < r.id) AS no_prior_reaction
	FROM note_reaction r
	JOIN "user" u ON u.id = r."userId" AND u.host IS NULL
	JOIN note n ON n.id = r."noteId"
	WHERE r.id >= $1 AND n."userId" <> r."userId"
	ORDER BY r.id DESC
	LIMIT $2
`;

/** 利用者ごとに、直近 poolHours 時間に出た投稿から各軸の候補が何件集まるか。 */
const POOLS_SQL = `
	WITH local_notes AS MATERIALIZED (
		SELECT n.id, n."userId" FROM note n
		WHERE n.id >= $2 AND n."userHost" IS NULL AND ${VISIBLE_NOTE_SQL('n')}
			AND n."replyId" IS NULL AND (n."renoteId" IS NULL OR n.text IS NOT NULL)
	)
	SELECT a1.one, a1.two, a1.three, a2.replies, a2.threads,
		a3.total AS close_total, a3.no_reaction AS close_no_reaction, a3.unreacted AS close_unreacted,
		loc.c AS local_notes
	FROM unnest($1::varchar[]) AS u(id)
	LEFT JOIN LATERAL (
		SELECT count(*) FILTER (WHERE x.c >= 1)::int AS one,
			count(*) FILTER (WHERE x.c >= 2)::int AS two,
			count(*) FILTER (WHERE x.c >= 3)::int AS three
		FROM (
			SELECT n.id, count(DISTINCT r."userId") AS c
			FROM following f
			JOIN note_reaction r ON r."userId" = f."followeeId" AND r.id >= $2
			JOIN note n ON n.id = r."noteId"
			WHERE f."followerId" = u.id AND n.id >= $2 AND n."userId" <> u.id AND ${VISIBLE_NOTE_SQL('n')}
				AND NOT EXISTS (SELECT 1 FROM following f2 WHERE f2."followerId" = u.id AND f2."followeeId" = n."userId")
			GROUP BY n.id
		) x
	) a1 ON TRUE
	LEFT JOIN LATERAL (
		SELECT COALESCE(sum(t.c), 0)::int AS replies, count(*) FILTER (WHERE t.c >= 3)::int AS threads
		FROM (
			SELECT COALESCE(n."threadId", n."replyId") AS thread, count(*) AS c
			FROM following f
			JOIN note n ON n."userId" = f."followeeId" AND n.id >= $2
			JOIN following f2 ON f2."followerId" = u.id AND f2."followeeId" = n."replyUserId"
			WHERE f."followerId" = u.id AND n."replyId" IS NOT NULL
				AND n."replyUserId" <> n."userId" AND n."replyUserId" <> u.id AND ${VISIBLE_NOTE_SQL('n')}
			GROUP BY 1
		) t
	) a2 ON TRUE
	LEFT JOIN LATERAL (
		SELECT count(*)::int AS total,
			count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM note_reaction r WHERE r."noteId" = n.id))::int AS no_reaction,
			count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM note_reaction r WHERE r."noteId" = n.id AND r."userId" = u.id))::int AS unreacted
		FROM (
			SELECT hr."otherUserId" AS id FROM "hanami_foryou_relation" hr
			WHERE hr."userId" = u.id
			ORDER BY hr."relScore" DESC, hr."otherUserId" ASC
			LIMIT $3
		) c
		JOIN note n ON n."userId" = c.id AND n.id >= $2
		WHERE ${VISIBLE_NOTE_SQL('n')} AND ${ORIGINAL_NOTE_SQL('n')}
	) a3 ON TRUE
	LEFT JOIN LATERAL (
		SELECT count(*)::int AS c FROM local_notes ln
		WHERE ln."userId" <> u.id
			AND NOT EXISTS (SELECT 1 FROM following f3 WHERE f3."followerId" = u.id AND f3."followeeId" = ln."userId")
	) loc ON TRUE
`;

const LOCAL_SQL = `
	SELECT count(*)::int AS originals, count(DISTINCT n."userId")::int AS authors,
		count(*) FILTER (WHERE EXISTS (SELECT 1 FROM note_reaction r WHERE r."noteId" = n.id))::int AS with_reaction
	FROM note n
	WHERE n.id >= $1 AND n."userHost" IS NULL AND ${VISIBLE_NOTE_SQL('n')}
		AND n."replyId" IS NULL AND (n."renoteId" IS NULL OR n.text IS NOT NULL)
`;

export function hanamiAxisOutlookDistribution(values: readonly number[]): HanamiAxisOutlookDistribution {
	const sorted = [...values].sort((a, b) => a - b);
	// 人数が少ないので補間はせず、実際にある値（下側）を返す。
	const at = (ratio: number): number | null => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))]!;
	return {
		users: sorted.length,
		zero: sorted.filter(value => value === 0).length,
		p25: at(0.25),
		p50: at(0.5),
		p75: at(0.75),
		max: sorted.at(-1) ?? null,
	};
}

function emptyAge(): HanamiAxisOutlookAge {
	return { under1h: 0, h1to6: 0, h6to24: 0, d1to3: 0, over3d: 0 };
}

function addAge(age: HanamiAxisOutlookAge, ageMs: number): void {
	if (ageMs < HOUR_MS) age.under1h++;
	else if (ageMs < 6 * HOUR_MS) age.h1to6++;
	else if (ageMs < DAY_MS) age.h6to24++;
	else if (ageMs < 3 * DAY_MS) age.d1to3++;
	else age.over3d++;
}

@Injectable()
export class HanamiAxisOutlookService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		private idService: IdService,
		private hanamiAffinityService: HanamiAffinityService,
	) {}

	@bindThis
	public async outlook(input: HanamiAxisOutlookInput): Promise<HanamiAxisOutlook> {
		const now = input.now ?? new Date();
		const from = new Date(now.getTime() - input.days * DAY_MS);
		const poolFrom = new Date(now.getTime() - input.poolHours * HOUR_MS);
		const fromId = this.idService.gen(from.getTime());
		const poolFromId = this.idService.gen(poolFrom.getTime());
		const errors: HanamiAxisOutlook['errors'] = [];

		const population = await this.section('population', errors, async () => this.population(from));
		const reactions = await this.section('reactions', errors, async () => this.reactions(fromId));
		const measured = await this.section('measuredUsers', errors, async () => (
			await this.query<{ id: string }>(MEASURED_USERS_SQL, [from, input.maxUsers + 1])
		).map(row => row.id));
		const measuredIds = measured?.slice(0, input.maxUsers) ?? null;
		const pools = measured == null || measuredIds == null ? null : await this.section('pools', errors, async () => (
			this.pools(measuredIds, measured.length > input.maxUsers, poolFromId)
		));
		const lapsed = measuredIds == null ? null : await this.section('lapsed', errors, async () => this.lapsed(measuredIds.slice(0, LAPSED_USER_LIMIT)));
		const local = await this.section('local', errors, async () => this.local(poolFromId));

		return {
			range: { from: from.toISOString(), to: now.toISOString(), days: input.days, poolFrom: poolFrom.toISOString(), poolHours: input.poolHours },
			population,
			reactions,
			pools,
			lapsed,
			local,
			errors,
		};
	}

	private async population(from: Date): Promise<HanamiAxisOutlookPopulation> {
		const rows = await this.query<PopulationRow>(POPULATION_SQL, [from, ALS_RUN_KIND]);
		const active = rows.filter(row => row.active);
		const hanami = rows.filter(row => row.hanami);
		const count = (list: readonly PopulationRow[], predicate: (row: PopulationRow) => boolean): number => list.filter(predicate).length;
		return {
			activeLocalUsers: active.length,
			activeWithFollowees5: count(active, row => Number(row.followees) >= 5),
			activeWithAlsNeighbors: count(active, row => row.neighbors),
			activeWithRelation: count(active, row => row.relation),
			hanamiUsers: hanami.length,
			hanamiWithFollowees5: count(hanami, row => Number(row.followees) >= 5),
			hanamiWithAlsNeighbors: count(hanami, row => row.neighbors),
			hanamiWithRelation: count(hanami, row => row.relation),
		};
	}

	private async reactions(fromId: string): Promise<HanamiAxisOutlookReactions> {
		const fetched = await this.query<ReactionRow>(REACTIONS_SQL, [fromId, REACTION_ROW_LIMIT + 1]);
		const rows = fetched.slice(0, REACTION_ROW_LIMIT);
		const perUser = new Map<string, number>();
		const nonFolloweeUsers = new Set<string>();
		const result: HanamiAxisOutlookReactions = {
			total: rows.length,
			truncated: fetched.length > REACTION_ROW_LIMIT,
			users: 0,
			largestUserShare: null,
			toFollowee: 0,
			toLocalAuthor: 0,
			onReply: 0,
			withFiles: 0,
			age: emptyAge(),
			followeeAge: emptyAge(),
			nonFollowee: {
				total: 0, users: 0, followeeReactedBefore: 0, twoFolloweesReactedBefore: 0, followeeRenotedBefore: 0,
				followeeRepliedBefore: 0, authorFollowsMe: 0, authorReactedToMe: 0, anySocial: 0, noPriorReaction: 0,
				localAuthor: 0, age: emptyAge(),
			},
		};
		for (const row of rows) {
			perUser.set(row.uid, (perUser.get(row.uid) ?? 0) + 1);
			const ageMs = Math.max(0, this.idService.parse(row.rid).date.getTime() - this.idService.parse(row.nid).date.getTime());
			addAge(result.age, ageMs);
			if (row.local_author) result.toLocalAuthor++;
			if (row.is_reply) result.onReply++;
			if (row.has_files) result.withFiles++;
			if (row.is_followee) {
				result.toFollowee++;
				addAge(result.followeeAge, ageMs);
				continue;
			}
			const other = result.nonFollowee;
			const followeeReacted = Number(row.followee_reacted);
			other.total++;
			nonFolloweeUsers.add(row.uid);
			addAge(other.age, ageMs);
			if (followeeReacted >= 1) other.followeeReactedBefore++;
			if (followeeReacted >= 2) other.twoFolloweesReactedBefore++;
			if (row.followee_renoted) other.followeeRenotedBefore++;
			if (row.followee_replied) other.followeeRepliedBefore++;
			if (row.author_follows_me) other.authorFollowsMe++;
			if (row.author_reacted_to_me) other.authorReactedToMe++;
			if (followeeReacted >= 1 || row.followee_renoted || row.followee_replied || row.author_follows_me || row.author_reacted_to_me) other.anySocial++;
			if (row.no_prior_reaction) other.noPriorReaction++;
			if (row.local_author) other.localAuthor++;
		}
		result.users = perUser.size;
		result.nonFollowee.users = nonFolloweeUsers.size;
		result.largestUserShare = rows.length === 0 ? null : Math.max(...perUser.values()) / rows.length;
		return result;
	}

	private async pools(userIds: readonly string[], truncated: boolean, poolFromId: string): Promise<HanamiAxisOutlookPools> {
		const rows = userIds.length === 0 ? [] : await this.query<PoolRow>(POOLS_SQL, [userIds, poolFromId, CLOSE_AUTHOR_LIMIT]);
		const dist = (pick: (row: PoolRow) => number) => hanamiAxisOutlookDistribution(rows.map(row => Number(pick(row))));
		return {
			measuredUsers: rows.length,
			measuredUsersTruncated: truncated,
			followeeReacted1: dist(row => row.one),
			followeeReacted2: dist(row => row.two),
			followeeReacted3: dist(row => row.three),
			conversationReplies: dist(row => row.replies),
			conversationThreads3: dist(row => row.threads),
			closeAuthorNotes: dist(row => row.close_total),
			closeAuthorNotesNoReaction: dist(row => row.close_no_reaction),
			closeAuthorNotesUnreacted: dist(row => row.close_unreacted),
			localNonFolloweeNotes: dist(row => row.local_notes),
		};
	}

	private async lapsed(userIds: readonly string[]): Promise<{ measuredUsers: number; people: HanamiAxisOutlookDistribution }> {
		const counts: number[] = [];
		for (const userId of userIds) {
			counts.push((await this.hanamiAffinityService.computeLapsed(userId)).length);
		}
		return { measuredUsers: counts.length, people: hanamiAxisOutlookDistribution(counts) };
	}

	private async local(poolFromId: string): Promise<HanamiAxisOutlookLocal> {
		const [row] = await this.query<{ originals: number; authors: number; with_reaction: number }>(LOCAL_SQL, [poolFromId]);
		return {
			originals: Number(row?.originals ?? 0),
			authors: Number(row?.authors ?? 0),
			withReaction: Number(row?.with_reaction ?? 0),
		};
	}

	/** 1 つの集計が失敗・時間切れになっても、残りは返す。失敗は errors に名前つきで残す。 */
	private async section<T>(name: string, errors: HanamiAxisOutlook['errors'], run: () => Promise<T>): Promise<T | null> {
		try {
			return await run();
		} catch (error) {
			errors.push({ section: name, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
			return null;
		}
	}

	/** 読み取り専用・時間制限つきで 1 文だけ流す。 */
	private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
		return await this.db.transaction(async manager => {
			await manager.query('SET TRANSACTION READ ONLY');
			await manager.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
			return await manager.query(sql, params) as T[];
		});
	}
}
