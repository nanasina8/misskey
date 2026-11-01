/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, type SelectQueryBuilder } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository, UsersRepository } from '@/models/_.js';
import type { MiAiModerationQueue } from '@/models/AiModerationQueue.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import {
	aiModerationAccountSignals,
	aiModerationNamePattern,
	type AiModerationGroupBy,
} from '@/misc/ai-moderation.js';

const TRAILING_NOISE_RE = /\s+[a-z]{2,6}$/;

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				user: { type: 'object', optional: false, nullable: true, ref: 'UserLite' },
				createdAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
				notesCount: { type: 'integer', optional: false, nullable: false },
				followersCount: { type: 'integer', optional: false, nullable: false },
				followingCount: { type: 'integer', optional: false, nullable: false },
				judgedCount: { type: 'integer', optional: false, nullable: false },
				flaggedCount: { type: 'integer', optional: false, nullable: false },
				targetCount: { type: 'integer', optional: false, nullable: false },
				contactKinds: {
					type: 'array', optional: false, nullable: false,
					items: { type: 'string', optional: false, nullable: false },
				},
				topLabel: { type: 'string', optional: false, nullable: true },
				topScore: { type: 'number', optional: false, nullable: true },
				signals: {
					type: 'object', optional: false, nullable: false,
					properties: {
						noAvatar: { type: 'boolean', optional: false, nullable: false },
						namePattern: { type: 'string', optional: false, nullable: false },
						trailingNoise: { type: 'boolean', optional: false, nullable: false },
						namePatternMatchesTop: { type: 'boolean', optional: false, nullable: false },
					},
				},
				isSuspended: { type: 'boolean', optional: false, nullable: false },
				isHidden: { type: 'boolean', optional: false, nullable: false },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		groupBy: { type: 'string', enum: ['host', 'link', 'fingerprint'] },
		key: { type: 'string', nullable: true },
		windowHours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
		resolved: { type: 'boolean', default: false },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		offset: { type: 'integer', minimum: 0, default: 0 },
	},
	required: ['groupBy', 'key'],
} as const;

function applyKeyCondition(query: SelectQueryBuilder<MiAiModerationQueue>, groupBy: AiModerationGroupBy, key: string | null): void {
	switch (groupBy) {
		case 'host':
			if (key == null) {
				query.andWhere('queue.noteUserHost IS NULL');
			} else {
				query.andWhere('queue.noteUserHost = :key', { key });
			}
			break;
		case 'link':
			query.andWhere(':key = ANY(queue.links)', { key });
			break;
		case 'fingerprint':
			query.andWhere('queue.textFingerprint = :key', { key });
			break;
	}
}

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private aiModerationHiddenService: AiModerationHiddenService,
		private userEntityService: UserEntityService,
	) {
		super(meta, paramDef, async (ps) => {
			const groupBy: AiModerationGroupBy = ps.groupBy;
			const windowStart = new Date(Date.now() - ps.windowHours * 60 * 60 * 1000);

			// グループのキーに一致する行を窓で取得（flagged も含む全行。judged/flagged を分けて数えるため）
			const query = this.aiModerationQueueRepository.createQueryBuilder('queue')
				.where('queue.judgedAt >= :since', { since: windowStart })
				.andWhere('queue.resolved = :resolved', { resolved: ps.resolved });
			applyKeyCondition(query, groupBy, ps.key);
			const rows = await query.getMany();

			type Acc = {
				userId: string;
				judgedCount: number;
				flaggedCount: number;
				targetIds: Set<string>;
				contactKinds: Set<string>;
				rows: MiAiModerationQueue[];
			};
			const accs = new Map<string, Acc>();
			for (const row of rows) {
				let acc = accs.get(row.noteUserId);
				if (acc == null) {
					acc = { userId: row.noteUserId, judgedCount: 0, flaggedCount: 0, targetIds: new Set(), contactKinds: new Set(), rows: [] };
					accs.set(row.noteUserId, acc);
				}
				acc.judgedCount++;
				if (row.flagged) acc.flaggedCount++;
				for (const targetId of row.contactUserIds) acc.targetIds.add(targetId);
				if (row.contactKind != null) acc.contactKinds.add(row.contactKind);
				acc.rows.push(row);
			}

			// 引っかけた（flagged=true）アカウントだけを対象に、多い順で並べる
			const ordered = [...accs.values()]
				.filter(acc => acc.flaggedCount > 0)
				.sort((a, b) => b.flaggedCount - a.flaggedCount || a.userId.localeCompare(b.userId));

			const page = ordered.slice(ps.offset, ps.offset + ps.limit);
			if (page.length === 0) return [];

			// 全アカウントの username で topNamePattern を求める（1回の users 取得でまとめる）
			const allUserIds = [...new Set(ordered.map(acc => acc.userId))];
			const users = await this.usersRepository.findBy({ id: In(allUserIds) });
			const userById = new Map(users.map(user => [user.id, user]));

			const patternCounts = new Map<string, number>();
			for (const user of users) {
				const pattern = aiModerationNamePattern(user.username);
				patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
			}
			const topNamePattern = [...patternCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

			const packedUsers = new Map(
				(await this.userEntityService.packMany(page.map(acc => userById.get(acc.userId)).filter(user => user != null), null, { schema: 'UserLite' }))
					.map(packed => [packed.id, packed]),
			);

			return page.map(acc => {
				const user = userById.get(acc.userId);
				const rowsSorted = [...acc.rows].sort((a, b) => (b.judgedAt?.getTime() ?? 0) - (a.judgedAt?.getTime() ?? 0));
				const representativeText = rowsSorted[0]?.noteText ?? null;

				// 最高スコア（spam+scam）の行を topLabel / topScore に使う
				let topLabel: string | null = null;
				let topScore: number | null = null;
				for (const row of acc.rows) {
					if (row.localScores == null) continue;
					const score = (row.localScores.spam ?? 0) + (row.localScores.scam ?? 0);
					if (topScore == null || score > topScore) {
						topScore = score;
						topLabel = row.localLabel;
					}
				}

				const trailingNoise = acc.rows.some(row => TRAILING_NOISE_RE.test(row.noteText));
				const namePattern = user != null ? aiModerationNamePattern(user.username) : '';

				const baseSignals = aiModerationAccountSignals({
					username: user?.username ?? '',
					avatarId: user?.avatarId ?? null,
					text: representativeText,
				});

				return {
					user: user != null ? (packedUsers.get(user.id) ?? null) : null,
					createdAt: user != null ? this.idService.parse(user.id).date.toISOString() : new Date(0).toISOString(),
					notesCount: user?.notesCount ?? 0,
					followersCount: user?.followersCount ?? 0,
					followingCount: user?.followingCount ?? 0,
					judgedCount: acc.judgedCount,
					flaggedCount: acc.flaggedCount,
					targetCount: acc.targetIds.size,
					contactKinds: [...acc.contactKinds],
					topLabel,
					topScore,
					signals: {
						noAvatar: baseSignals.noAvatar,
						namePattern,
						trailingNoise,
						namePatternMatchesTop: namePattern !== '' && namePattern === topNamePattern,
					},
					isSuspended: user?.isSuspended ?? false,
					isHidden: user != null && this.aiModerationHiddenService.isHiddenUser(user.id),
				};
			});
		});
	}
}
