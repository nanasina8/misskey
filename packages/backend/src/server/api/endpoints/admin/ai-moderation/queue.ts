/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository, UsersRepository } from '@/models/_.js';
import type { MiAiModerationQueue } from '@/models/AiModerationQueue.js';
import { DI } from '@/di-symbols.js';
import { QueryService } from '@/core/QueryService.js';
import { IdService } from '@/core/IdService.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';
import { AiModerationQueueEntityService, type AiModerationQueueComputed } from '@/core/entities/AiModerationQueueEntityService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:ai-moderation',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'AiModerationQueue',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		resolved: { type: 'boolean' },
		onlyFlagged: { type: 'boolean', default: true },
		host: { type: 'string', nullable: true },
		textFingerprint: { type: 'string', nullable: true },
		link: { type: 'string', nullable: true },
		autoAction: { type: 'string', enum: ['hidden', 'wouldHide'] },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private aiModerationQueueEntityService: AiModerationQueueEntityService,
		private queryService: QueryService,
		private idService: IdService,
		private aiModerationHiddenService: AiModerationHiddenService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = this.queryService.makePaginationQuery(
				this.aiModerationQueueRepository.createQueryBuilder('queue'),
				ps.sinceId,
				ps.untilId,
			);

			// 既定は resolved=false かつ flagged=true
			if (ps.resolved != null) {
				query.andWhere('queue.resolved = :resolved', { resolved: ps.resolved });
			} else {
				query.andWhere('queue.resolved = FALSE');
			}

			if (ps.onlyFlagged ?? true) {
				query.andWhere('queue.flagged = TRUE');
			}

			if (ps.host != null) {
				query.andWhere('queue.noteUserHost = :host', { host: ps.host });
			}
			if (ps.textFingerprint != null) {
				query.andWhere('queue.textFingerprint = :textFingerprint', { textFingerprint: ps.textFingerprint });
			}
			if (ps.autoAction === 'hidden') {
				query.andWhere('queue.autoAction IN (:...autoActions)', { autoActions: ['hidden', 'hiddenHost'] });
			} else if (ps.autoAction === 'wouldHide') {
				query.andWhere('queue.autoAction IN (:...autoActions)', { autoActions: ['wouldHide', 'wouldHideHost'] });
			}
			if (ps.link != null) {
				query.andWhere(':link = ANY(queue.links)', { link: ps.link });
			}

			const queues = await query.limit(ps.limit).getMany();
			if (queues.length === 0) return [];

			// author と related はページ内の行の分をまとめて取得する（行ごとにクエリにしない）
			const computed = await this.computeComputed(queues);

			return await this.aiModerationQueueEntityService.packMany(queues, me, computed);
		});
	}

	private async computeComputed(queues: MiAiModerationQueue[]): Promise<Map<string, AiModerationQueueComputed>> {
		const computed = new Map<string, AiModerationQueueComputed>();
		const now24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

		// sameLinkAccounts: 同じリンクを24h窓で投稿した他アカウント数
		const pageLinks = [...new Set(queues.flatMap(queue => queue.links))];
		const sameLinkByQueue = new Map<string, Set<string>>();
		if (pageLinks.length > 0) {
			const linkRows = await this.aiModerationQueueRepository.createQueryBuilder('queue')
				.select(['queue.id', 'queue.noteUserId', 'queue.links'])
				.where('queue.judgedAt >= :since', { since: now24h })
				.andWhere('queue.links && ARRAY[:...links]::VARCHAR[]', { links: pageLinks })
				.getMany();

			for (const queue of queues) {
				const others = new Set<string>();
				for (const row of linkRows) {
					if (row.noteUserId === queue.noteUserId) continue;
					if (queue.links.some(link => row.links.includes(link))) others.add(row.noteUserId);
				}
				sameLinkByQueue.set(queue.id, others);
			}
		}

		// sameTextCount: 同じ指紋の他の行数
		const fingerprints = [...new Set(queues.map(queue => queue.textFingerprint).filter((fp): fp is string => fp != null))];
		const fingerprintCounts = new Map<string, number>();
		if (fingerprints.length > 0) {
			const rows = await this.aiModerationQueueRepository.createQueryBuilder('queue')
				.select('queue.textFingerprint', 'fp')
				.addSelect('COUNT(*)', 'count')
				.where('queue.textFingerprint IN (:...fingerprints)', { fingerprints })
				.groupBy('queue.textFingerprint')
				.getRawMany<{ fp: string; count: string }>();
			for (const row of rows) fingerprintCounts.set(row.fp, Number(row.count));
		}

		// userFlagged / userJudged: この投稿者の引っかけ数 / 判定数
		const userIds = [...new Set(queues.map(queue => queue.noteUserId))];
		const userCounts = new Map<string, { judged: number; flagged: number }>();
		if (userIds.length > 0) {
			const rows = await this.aiModerationQueueRepository.createQueryBuilder('queue')
				.select('queue.noteUserId', 'uid')
				.addSelect('COUNT(*)', 'judged')
				.addSelect('COUNT(*) FILTER (WHERE queue.flagged = TRUE)', 'flagged')
				.where('queue.noteUserId IN (:...userIds)', { userIds })
				.groupBy('queue.noteUserId')
				.getRawMany<{ uid: string; judged: string; flagged: string }>();
			for (const row of rows) userCounts.set(row.uid, { judged: Number(row.judged), flagged: Number(row.flagged) });
		}

		// author 情報
		const authors = userIds.length > 0 ? await this.usersRepository.findBy({ id: In(userIds) }) : [];
		const authorById = new Map(authors.map(author => [author.id, author]));

		for (const queue of queues) {
			const author = authorById.get(queue.noteUserId) ?? null;
			const counts = userCounts.get(queue.noteUserId) ?? { judged: 0, flagged: 0 };
			const sameTextTotal = queue.textFingerprint != null ? (fingerprintCounts.get(queue.textFingerprint) ?? 0) : 0;

			computed.set(queue.id, {
				author: author != null ? {
					createdAt: this.idService.parse(author.id).date.toISOString(),
					notesCount: author.notesCount,
					followersCount: author.followersCount,
					followingCount: author.followingCount,
					hasAvatar: author.avatarId != null,
					isSuspended: author.isSuspended,
					isHidden: this.aiModerationHiddenService.isHiddenUser(author.id),
					isHostHidden: this.aiModerationHiddenService.isHiddenHost(author.host),
				} : null,
				related: {
					sameLinkAccounts: sameLinkByQueue.get(queue.id)?.size ?? 0,
					sameTextCount: Math.max(0, sameTextTotal - 1),
					userFlagged: counts.flagged,
					userJudged: counts.judged,
				},
			});
		}

		return computed;
	}
}
