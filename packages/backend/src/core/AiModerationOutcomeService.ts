/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { AiModerationQueueRepository, InstancesRepository, MiMeta, ModerationLogsRepository, UsersRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';
import { bindThis } from '@/decorators.js';
import {
	aiModerationAccountState,
	type AiModerationAccountState,
	type AiModerationOutcomeRow,
} from '@/misc/ai-moderation.js';

export type AiModerationOutcomeAccount = AiModerationOutcomeRow & {
	state: AiModerationAccountState;
	flaggedCount: number;
	firstAt: Date;
	lastAt: Date;
	maxSpamScore: number | null;
	userExists: boolean;
};

export type AiModerationOutcomeHost = {
	host: string;
	accounts: number;
	suspended: number;
	deleted: number;
	hidden: number;
	isHostHidden: boolean;
	isBlocked: boolean;
	suspensionState: string | null;
};

/**
 * 判定で引っかけたアカウントの「その後」（凍結・相手のサーバーで消えた・隠す／外す）を集める。
 * 自動で隠す条件の当たり外れを人の判断と相手のサーバーの判断で測るための材料。
 */
@Injectable()
export class AiModerationOutcomeService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.moderationLogsRepository)
		private moderationLogsRepository: ModerationLogsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private idService: IdService,
		private utilityService: UtilityService,
		private aiModerationHiddenService: AiModerationHiddenService,
	) {
	}

	@bindThis
	public async loadAccounts(since: Date): Promise<AiModerationOutcomeAccount[]> {
		const rows = await this.aiModerationQueueRepository.createQueryBuilder('queue')
			.select('queue.noteUserId', 'userId')
			.addSelect('MAX(queue.noteUserHost)', 'host')
			.addSelect('COUNT(*)', 'flaggedCount')
			.addSelect('MIN(queue.judgedAt)', 'firstAt')
			.addSelect('MAX(queue.judgedAt)', 'lastAt')
			.addSelect('MAX(COALESCE(("queue"."localScores"->>\'spam\')::float, 0) + COALESCE(("queue"."localScores"->>\'scam\')::float, 0)) FILTER (WHERE "queue"."localScores" IS NOT NULL)', 'maxSpamScore')
			.addSelect('BOOL_OR(queue.autoAction IN (\'hidden\', \'hiddenHost\'))', 'autoHidden')
			.addSelect('BOOL_OR(queue.autoAction IN (\'wouldHide\', \'wouldHideHost\'))', 'autoWould')
			.addSelect('(ARRAY_AGG("queue"."criteriaVersion" ORDER BY "queue"."judgedAt" DESC))[1]', 'criteriaVersion')
			.addSelect('STRING_AGG(array_to_string("queue"."spamSignals", \',\'), \',\')', 'signals')
			.where('queue.flagged = true')
			.andWhere('queue.judgedAt >= :since', { since })
			.groupBy('queue.noteUserId')
			.getRawMany<{
				userId: string; host: string | null; flaggedCount: string; firstAt: Date; lastAt: Date;
				maxSpamScore: number | null; autoHidden: boolean | null; autoWould: boolean | null; signals: string | null; criteriaVersion: string | null;
			}>();
		if (rows.length === 0) return [];

		const users = new Map<string, { isSuspended: boolean; isDeleted: boolean }>();
		const ids = rows.map(r => r.userId);
		for (let i = 0; i < ids.length; i += 500) {
			const found = await this.usersRepository.find({
				where: { id: In(ids.slice(i, i + 500)) },
				select: { id: true, isSuspended: true, isDeleted: true },
			});
			for (const u of found) users.set(u.id, { isSuspended: u.isSuspended, isDeleted: u.isDeleted });
		}

		const unhidden = await this.loadUnhidden(since);

		return rows.map(r => {
			const user = users.get(r.userId);
			const signals = [...new Set((r.signals ?? '').split(',').filter(s => s.length > 0))];
			const row: AiModerationOutcomeRow = {
				userId: r.userId,
				host: r.host,
				auto: r.autoHidden ? 'hidden' : r.autoWould ? 'wouldHide' : 'none',
				signals,
				isSuspended: user?.isSuspended ?? false,
				isDeleted: user == null || user.isDeleted,
				isHidden: this.aiModerationHiddenService.isHiddenAuthor(r.userId, r.host),
				wasUnhidden: unhidden.userIds.has(r.userId) || (r.host != null && unhidden.hosts.has(r.host)),
				criteriaVersion: r.criteriaVersion,
			};
			return {
				...row,
				state: aiModerationAccountState(row),
				flaggedCount: Number(r.flaggedCount),
				firstAt: new Date(r.firstAt),
				lastAt: new Date(r.lastAt),
				maxSpamScore: r.maxSpamScore == null ? null : Number(r.maxSpamScore),
				userExists: user != null,
			};
		});
	}

	@bindThis
	public async summarizeHosts(accounts: readonly AiModerationOutcomeAccount[], limit: number): Promise<AiModerationOutcomeHost[]> {
		const byHost = new Map<string, AiModerationOutcomeHost>();
		for (const account of accounts) {
			if (account.host == null) continue;
			let entry = byHost.get(account.host);
			if (entry == null) {
				entry = {
					host: account.host,
					accounts: 0,
					suspended: 0,
					deleted: 0,
					hidden: 0,
					isHostHidden: this.aiModerationHiddenService.isHiddenHost(account.host),
					isBlocked: this.utilityService.isBlockedHost(this.meta.blockedHosts, account.host),
					suspensionState: null,
				};
				byHost.set(account.host, entry);
			}
			entry.accounts++;
			if (account.state === 'suspended') entry.suspended++;
			if (account.state === 'deleted') entry.deleted++;
			if (account.state === 'hidden') entry.hidden++;
		}

		const top = [...byHost.values()].sort((a, b) => b.accounts - a.accounts).slice(0, limit);
		if (top.length > 0) {
			const instances = await this.instancesRepository.find({
				where: { host: In(top.map(h => h.host)) },
				select: { host: true, suspensionState: true },
			});
			const states = new Map(instances.map(i => [i.host, i.suspensionState]));
			for (const entry of top) entry.suspensionState = states.get(entry.host) ?? null;
		}
		return top;
	}

	/** 期間内に人が「隠すのをやめる」を押した相手（モデレーションログから） */
	private async loadUnhidden(since: Date): Promise<{ userIds: Set<string>; hosts: Set<string> }> {
		const logs = await this.moderationLogsRepository.createQueryBuilder('log')
			.select('log.info', 'info')
			.where('log.type = :type', { type: 'unhideAiModerationTarget' })
			.andWhere('log.id >= :minId', { minId: this.idService.gen(since.getTime()) })
			.getRawMany<{ info: { userId?: string | null; host?: string | null } }>();
		const userIds = new Set<string>();
		const hosts = new Set<string>();
		for (const { info } of logs) {
			if (info.userId != null) userIds.add(info.userId);
			if (info.host != null) hosts.add(info.host);
		}
		return { userIds, hosts };
	}
}
