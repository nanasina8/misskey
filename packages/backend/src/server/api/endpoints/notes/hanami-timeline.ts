/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// ホームタイムラインを取得し、中央サービス（HanamiRecommendationService）でおすすめをスロット注入する。
// ページングの主軸はホームTLの untilId/sinceId。おすすめは served 除外＋時間範囲制約で重複/飛び込みを防ぐ。

import { Brackets } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import type { NotesRepository, ChannelFollowingsRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueryService } from '@/core/QueryService.js';
import { DI } from '@/di-symbols.js';
import { RoleService } from '@/core/RoleService.js';
import { IdService } from '@/core/IdService.js';
import { CacheService } from '@/core/CacheService.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { MiLocalUser } from '@/models/User.js';
import { MetaService } from '@/core/MetaService.js';
import { FanoutTimelineEndpointService } from '@/core/FanoutTimelineEndpointService.js';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		HanamiTlDisabled: {
			message: 'Hanami timeline has been disabled.',
			code: 'HanamiTL_DISABLED',
			id: 'ffa57e0f-d14e-48d6-a64c-8fbcba5635ab',
		},
		FttDisabled: {
			message: 'Fanout timeline has been disabled.',
			code: 'FTT_DISABLED',
			id: '31f4d555-f46a-cae8-8e45-9a17740748e8',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		allowPartial: { type: 'boolean', default: false }, // true is recommended but for compatibility false by default
		includeMyRenotes: { type: 'boolean', default: true },
		includeRenotedMyNotes: { type: 'boolean', default: true },
		includeLocalRenotes: { type: 'boolean', default: true },
		withFiles: { type: 'boolean', default: false },
		withRenotes: { type: 'boolean', default: true },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.channelFollowingsRepository)
		private channelFollowingsRepository: ChannelFollowingsRepository,

		private roleService: RoleService,
		private idService: IdService,
		private cacheService: CacheService,
		private fanoutTimelineEndpointService: FanoutTimelineEndpointService,
		private userFollowingService: UserFollowingService,
		private queryService: QueryService,
		private metaService: MetaService,
		private hanamiRecommendationService: HanamiRecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate!) : null);
			const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate!) : null);

			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.hanamiTlAvailable) {
				throw new ApiError(meta.errors.HanamiTlDisabled);
			}

			const serverSettings = await this.metaService.fetch();
			if (!serverSettings.enableFanoutTimeline) {
				throw new ApiError(meta.errors.FttDisabled);
			}

			const followings = await this.cacheService.userFollowingsCache.fetch(me.id);

			// ホームTL（ページングの主軸）
			const homeNotes = await this.fanoutTimelineEndpointService.timeline({
				untilId,
				sinceId,
				limit: ps.limit,
				allowPartial: ps.allowPartial,
				me,
				useDbFallback: serverSettings.enableFanoutTimelineDbFallback,
				redisTimelines: ps.withFiles ? [`homeTimelineWithFiles:${me.id}`] : [`homeTimeline:${me.id}`],
				alwaysIncludeMyNotes: true,
				excludePureRenotes: !ps.withRenotes,
				noteFilter: note => {
					if (note.reply && note.reply.visibility === 'followers') {
						if (!Object.hasOwn(followings, note.reply.userId) && note.reply.userId !== me.id) return false;
					}
					return true;
				},
				dbFallback: async (untilId, sinceId, limit) => await this.getFromDb({
					untilId,
					sinceId,
					limit,
					includeMyRenotes: ps.includeMyRenotes,
					includeRenotedMyNotes: ps.includeRenotedMyNotes,
					includeLocalRenotes: ps.includeLocalRenotes,
					withFiles: ps.withFiles,
					withRenotes: ps.withRenotes,
				}, me),
			});

			// 中央サービスでおすすめをスロット注入（複数軸。ユーザー設定/鯖管設定はサービス内で解決）
			return this.hanamiRecommendationService.mixRecommendations(me, {
				homeNotes,
				untilId,
				sinceId,
				limit: ps.limit,
				withFiles: ps.withFiles,
			});
		});
	}

	private async getFromDb(ps: { untilId: string | null; sinceId: string | null; limit: number; includeMyRenotes: boolean; includeRenotedMyNotes: boolean; includeLocalRenotes: boolean; withFiles: boolean; withRenotes: boolean; }, me: MiLocalUser) {
		const followees = await this.userFollowingService.getFollowees(me.id);
		const followingChannels = await this.channelFollowingsRepository.find({
			where: {
				followerId: me.id,
			},
		});

		//#region Construct query
		const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'), ps.sinceId, ps.untilId)
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		if (followees.length > 0 && followingChannels.length > 0) {
			// ユーザー・チャンネルともにフォローあり
			const meOrFolloweeIds = [me.id, ...followees.map(f => f.followeeId)];
			const followingChannelIds = followingChannels.map(x => x.followeeId);
			query.andWhere(new Brackets(qb => {
				qb
					.where(new Brackets(qb2 => {
						qb2
							.where('note.userId IN (:...meOrFolloweeIds)', { meOrFolloweeIds: meOrFolloweeIds })
							.andWhere('note.channelId IS NULL');
					}))
					.orWhere('note.channelId IN (:...followingChannelIds)', { followingChannelIds });
			}));
		} else if (followees.length > 0) {
			// ユーザーフォローのみ（チャンネルフォローなし）
			const meOrFolloweeIds = [me.id, ...followees.map(f => f.followeeId)];
			query
				.andWhere('note.channelId IS NULL')
				.andWhere('note.userId IN (:...meOrFolloweeIds)', { meOrFolloweeIds: meOrFolloweeIds });
		} else if (followingChannels.length > 0) {
			// チャンネルフォローのみ（ユーザーフォローなし）
			const followingChannelIds = followingChannels.map(x => x.followeeId);
			query.andWhere(new Brackets(qb => {
				qb
					.where('note.channelId IN (:...followingChannelIds)', { followingChannelIds })
					.orWhere('note.userId = :meId', { meId: me.id });
			}));
		} else {
			// フォローなし
			query
				.andWhere('note.channelId IS NULL')
				.andWhere('note.userId = :meId', { meId: me.id });
		}

		query.andWhere(new Brackets(qb => {
			qb
				.where('note.replyId IS NULL') // 返信ではない
				.orWhere(new Brackets(qb => {
					qb // 返信だけど投稿者自身への返信
						.where('note.replyId IS NOT NULL')
						.andWhere('note.replyUserId = note.userId');
				}));
		}));

		this.queryService.generateVisibilityQuery(query, me);
		this.queryService.generateMutedUserQueryForNotes(query, me);
		this.queryService.generateBlockedUserQueryForNotes(query, me);
		this.queryService.generateMutedUserRenotesQueryForNotes(query, me);

		if (ps.includeMyRenotes === false) {
			query.andWhere(new Brackets(qb => {
				qb.orWhere('note.userId != :meId', { meId: me.id });
				qb.orWhere('note.renoteId IS NULL');
				qb.orWhere('note.text IS NOT NULL');
				qb.orWhere('note.fileIds != \'{}\'');
				qb.orWhere('0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)');
			}));
		}

		if (ps.includeRenotedMyNotes === false) {
			query.andWhere(new Brackets(qb => {
				qb.orWhere('note.renoteUserId != :meId', { meId: me.id });
				qb.orWhere('note.renoteId IS NULL');
				qb.orWhere('note.text IS NOT NULL');
				qb.orWhere('note.fileIds != \'{}\'');
				qb.orWhere('0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)');
			}));
		}

		if (ps.includeLocalRenotes === false) {
			query.andWhere(new Brackets(qb => {
				qb.orWhere('note.renoteUserHost IS NOT NULL');
				qb.orWhere('note.renoteId IS NULL');
				qb.orWhere('note.text IS NOT NULL');
				qb.orWhere('note.fileIds != \'{}\'');
				qb.orWhere('0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)');
			}));
		}

		if (ps.withFiles) {
			query.andWhere('note.fileIds != \'{}\'');
		}

		if (ps.withRenotes === false) {
			query.andWhere('note.renoteId IS NULL');
		}
		//#endregion

		return await query.limit(ps.limit).getMany();
	}
}
