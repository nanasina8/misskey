/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationQueueRepository, FollowingsRepository, InstancesRepository, MiMeta, UsersRepository } from '@/models/_.js';
import type { MiAiModerationQueue } from '@/models/AiModerationQueue.js';
import type { MiInstance } from '@/models/Instance.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';
import { UtilityService } from '@/core/UtilityService.js';
import {
	aiModerationGroupKeys,
	aiModerationNamePattern,
	buildAiModerationGroup,
	classifyAiModerationHost,
	recommendAiModerationAction,
	type AiModerationGroupBy,
	type AiModerationGroupSampleInput,
} from '@/misc/ai-moderation.js';

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
			properties: {
				key: { type: 'string', optional: false, nullable: true },
				flaggedCount: { type: 'integer', optional: false, nullable: false },
				accountCount: { type: 'integer', optional: false, nullable: false },
				targetCount: { type: 'integer', optional: false, nullable: false },
				deliveryCount: { type: 'integer', optional: false, nullable: false },
				firstAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
				lastAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
				peakPerHour: { type: 'integer', optional: false, nullable: false },
				peakAccountsPerHour: { type: 'integer', optional: false, nullable: false },
				labelCounts: {
					type: 'object', optional: false, nullable: false,
					additionalProperties: { type: 'integer' },
				},
				avgSpamScore: { type: 'number', optional: false, nullable: true },
				maxPerAccount: { type: 'integer', optional: false, nullable: false },
				trailingNoiseRatio: { type: 'number', optional: false, nullable: false },
				instance: {
					type: 'object', optional: true, nullable: true,
					properties: {
						softwareName: { type: 'string', optional: false, nullable: true },
						softwareVersion: { type: 'string', optional: false, nullable: true },
						openRegistrations: { type: 'boolean', optional: false, nullable: true },
						firstRetrievedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
						usersCount: { type: 'integer', optional: false, nullable: false },
						isBlocked: { type: 'boolean', optional: false, nullable: false },
						isSilenced: { type: 'boolean', optional: false, nullable: false },
						isSuspended: { type: 'boolean', optional: false, nullable: false },
						isHidden: { type: 'boolean', optional: false, nullable: false },
					},
				},
				localFollowersCount: { type: 'integer', optional: true, nullable: false },
				unsolicitedRatio: { type: 'number', optional: true, nullable: false },
				newAccountRatio: { type: 'number', optional: true, nullable: false },
				noAvatarRatio: { type: 'number', optional: true, nullable: false },
				topNamePattern: { type: 'string', optional: true, nullable: true },
				topNamePatternRatio: { type: 'number', optional: true, nullable: false },
				severity: { type: 'string', optional: true, nullable: true, enum: ['strong', 'partial', 'none'] },
				recommendation: { type: 'string', optional: true, nullable: true, enum: ['blockHost', 'suspendAccounts'] },
				topLinks: {
					type: 'array', optional: true, nullable: false,
					items: {
						type: 'object', optional: false, nullable: false,
						properties: {
							link: { type: 'string', optional: false, nullable: false },
							accounts: { type: 'integer', optional: false, nullable: false },
						},
					},
				},
				hosts: {
					type: 'array', optional: true, nullable: false,
					items: {
						type: 'object', optional: false, nullable: false,
						properties: {
							host: { type: 'string', optional: false, nullable: true },
							accounts: { type: 'integer', optional: false, nullable: false },
						},
					},
				},
				samples: {
					type: 'array', optional: true, nullable: false,
					items: {
						type: 'object', optional: false, nullable: false,
						properties: {
							text: { type: 'string', optional: false, nullable: false },
							count: { type: 'integer', optional: false, nullable: false },
						},
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		groupBy: { type: 'string', enum: ['host', 'link', 'fingerprint'] },
		windowHours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
		resolved: { type: 'boolean', default: false },
		limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
	},
	required: ['groupBy'],
} as const;

function toRec(row: MiAiModerationQueue, idService: IdService): AiModerationGroupSampleInput {
	return {
		noteUserId: row.noteUserId,
		noteUserHost: row.noteUserHost,
		// 判定時刻（judgedAt）ではなく投稿時刻（noteId）で時間帯を数える（GPU 混雑で判定が遅れても歪まない）
		createdAt: idService.parse(row.noteId).date,
		localLabel: row.localLabel,
		localScores: row.localScores,
		noteText: row.noteText,
		links: row.links,
		textFingerprint: row.textFingerprint,
		contactUserIds: row.contactUserIds,
		triggers: row.triggers,
	};
}

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private idService: IdService,
		private aiModerationHiddenService: AiModerationHiddenService,
		private utilityService: UtilityService,
	) {
		super(meta, paramDef, async (ps) => {
			const groupBy: AiModerationGroupBy = ps.groupBy;
			const windowStart = new Date(Date.now() - ps.windowHours * 60 * 60 * 1000);

			// 窓内の flagged 行だけを取る（resolved は既定 false）
			const rows = await this.aiModerationQueueRepository.createQueryBuilder('queue')
				.where('queue.judgedAt >= :since', { since: windowStart })
				.andWhere('queue.flagged = TRUE')
				.andWhere('queue.resolved = :resolved', { resolved: ps.resolved })
				.getMany();

			// グループへ振り分け
			const groupRows = new Map<string | null, AiModerationGroupSampleInput[]>();
			for (const row of rows) {
				for (const key of aiModerationGroupKeys(row, groupBy)) {
					let list = groupRows.get(key);
					if (list == null) {
						list = [];
						groupRows.set(key, list);
					}
					list.push(toRec(row, this.idService));
				}
			}

			// 集計結果のキーに対してまとめて1回ずつ引く（グループ数×クエリにしない）
			const accountIds = [...new Set(rows.map(row => row.noteUserId))];
			const users = accountIds.length > 0
				? await this.usersRepository.findBy({ id: In(accountIds) })
				: [];
			const userById = new Map(users.map(user => [user.id, user]));

			const hosts = [...groupRows.keys()].filter((key): key is string => key != null);
			let instanceByHost = new Map<string, MiInstance>();
			let followersByHost = new Map<string, number>();
			if (groupBy === 'host' && hosts.length > 0) {
				const [instances, followerRows] = await Promise.all([
					this.instancesRepository.findBy({ host: In(hosts) }),
					this.followingsRepository.createQueryBuilder('following')
						.select('following.followeeHost', 'host')
						.addSelect('COUNT(*)', 'count')
						.where('following.followeeHost IN (:...hosts)', { hosts })
						.andWhere('following.followerHost IS NULL')
						.groupBy('following.followeeHost')
						.getRawMany<{ host: string; count: string }>(),
				]);
				instanceByHost = new Map(instances.map(instance => [instance.host, instance]));
				followersByHost = new Map(followerRows.map(r => [r.host, Number(r.count)]));
			}

			const newAuthorMs = this.serverSettings.aiModerationNewAuthorDays * 24 * 60 * 60 * 1000;

			const results = [...groupRows.entries()]
				.map(([key, recs]) => buildAiModerationGroup(key, recs, groupBy))
				.sort((a, b) => b.flaggedCount - a.flaggedCount)
				.slice(0, ps.limit);

			return results.map(group => {
				if (groupBy !== 'host') return group;
				const host = group.key;
				const recs = groupRows.get(group.key)!;
				const instance = host != null ? (instanceByHost.get(host) ?? null) : null;
				const localFollowersCount = host != null ? (followersByHost.get(host) ?? 0) : 0;

				const accountIds = [...new Set(recs.map(r => r.noteUserId))];
				const accountSignals = accountIds.map(accountId => {
					const user = userById.get(accountId);
					return {
						noAvatar: user?.avatarId == null,
						namePattern: user != null ? aiModerationNamePattern(user.username) : '',
						isNew: user != null && Date.now() - this.idService.parse(user.id).date.getTime() < newAuthorMs,
					};
				});

				const unsolicitedRatio = recs.length === 0 ? 0 : recs.filter(r => r.triggers.includes('unsolicitedContact')).length / recs.length;
				const newAccountRatio = accountSignals.length === 0 ? 0 : accountSignals.filter(s => s.isNew).length / accountSignals.length;
				const noAvatarRatio = accountSignals.length === 0 ? 0 : accountSignals.filter(s => s.noAvatar).length / accountSignals.length;

				const patternCounts = new Map<string, number>();
				for (const signal of accountSignals) {
					patternCounts.set(signal.namePattern, (patternCounts.get(signal.namePattern) ?? 0) + 1);
				}
				const topNamePattern = [...patternCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
				const topNamePatternRatio = topNamePattern != null && accountSignals.length > 0 ? topNamePattern[1] / accountSignals.length : 0;

				const linkAccounts = new Map<string, Set<string>>();
				for (const rec of recs) {
					for (const link of rec.links) {
						let set = linkAccounts.get(link);
						if (set == null) {
							set = new Set();
							linkAccounts.set(link, set);
						}
						set.add(rec.noteUserId);
					}
				}
				const topLinks = [...linkAccounts.entries()]
					.map(([link, accounts]) => ({ link, accounts: accounts.size }))
					.sort((a, b) => b.accounts - a.accounts)
					.slice(0, 3);

				const severity = classifyAiModerationHost({
					localFollowersCount,
					flaggedCount: group.flaggedCount,
					flaggedAccountCount: group.accountCount,
				});

				return {
					...group,
					instance: instance != null ? {
						softwareName: instance.softwareName,
						softwareVersion: instance.softwareVersion,
						openRegistrations: instance.openRegistrations,
						firstRetrievedAt: instance.firstRetrievedAt.toISOString(),
						usersCount: instance.usersCount,
						isBlocked: this.utilityService.isBlockedHost(this.serverSettings.blockedHosts, host),
						isSilenced: this.utilityService.isSilencedHost(this.serverSettings.silencedHosts, host),
						isSuspended: instance.suspensionState !== 'none',
						isHidden: this.aiModerationHiddenService.isHiddenHost(host),
					} : null,
					localFollowersCount,
					unsolicitedRatio,
					newAccountRatio,
					noAvatarRatio,
					topNamePattern: topNamePattern != null ? topNamePattern[0] : null,
					topNamePatternRatio,
					severity,
					recommendation: recommendAiModerationAction(severity),
					topLinks,
				};
			});
		});
	}
}
