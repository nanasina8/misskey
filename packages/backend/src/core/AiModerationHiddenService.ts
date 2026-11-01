/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { AiModerationHiddenTargetRepository, MiAiModerationHiddenTarget, MiUser, UsersRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';

export type AiModerationHideTarget =
	| { targetType: 'user'; userId: MiUser['id'] }
	| { targetType: 'host'; host: string };

/**
 * 「ユーザーから隠す」にしたアカウント／サーバーを管理する。
 * 投稿の pack や通知のたびに引くので、一覧はメモリに持ち、変更は internal イベントで全プロセスへ配る。
 */
@Injectable()
export class AiModerationHiddenService implements OnApplicationShutdown {
	private logger: Logger;
	private hiddenUserIds = new Set<string>();
	private hiddenHosts = new Set<string>();
	private loading: Promise<void> | null = null;

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.aiModerationHiddenTargetRepository)
		private aiModerationHiddenTargetRepository: AiModerationHiddenTargetRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private globalEventService: GlobalEventService,
		private moderationLogService: ModerationLogService,
		private utilityService: UtilityService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('ai-moderation-hidden');
		this.redisForSub.on('message', this.onMessage);
		this.loading = this.reload();
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);
		if (obj.channel !== 'internal') return;
		const { type } = obj.message as GlobalEvents['internal']['payload'];
		if (type === 'aiModerationHiddenChanged') {
			this.loading = this.reload();
		}
	}

	@bindThis
	private async reload(): Promise<void> {
		try {
			const rows = await this.aiModerationHiddenTargetRepository.find({ select: { targetType: true, userId: true, host: true } });
			const userIds = new Set<string>();
			const hosts = new Set<string>();
			for (const row of rows) {
				if (row.targetType === 'user' && row.userId != null) userIds.add(row.userId);
				if (row.targetType === 'host' && row.host != null) hosts.add(row.host);
			}
			this.hiddenUserIds = userIds;
			this.hiddenHosts = hosts;
		} catch (err) {
			this.logger.error('failed to load hidden targets', { err });
		}
	}

	/** 起動直後の読み込みを待つ（テストや最初の判定用） */
	@bindThis
	public async ready(): Promise<void> {
		await this.loading;
	}

	/** その作者の投稿を見る人から隠すか（同期。メモリだけを見る） */
	@bindThis
	public isHiddenAuthor(userId: MiUser['id'], host: string | null): boolean {
		if (this.hiddenUserIds.has(userId)) return true;
		if (host != null && this.hiddenHosts.has(host)) return true;
		return false;
	}

	@bindThis
	public isHiddenUser(userId: MiUser['id']): boolean {
		return this.hiddenUserIds.has(userId);
	}

	@bindThis
	public isHiddenHost(host: string | null): boolean {
		return host != null && this.hiddenHosts.has(host);
	}

	/**
	 * 隠す。すでに隠していれば何もしない（false を返す）。
	 * moderator が null のときは自動（reason=auto、モデレーションログは残さない）。
	 */
	@bindThis
	public async hide(target: AiModerationHideTarget, opts: {
		moderator: { id: MiUser['id'] } | null;
		sourceQueueId?: string | null;
		moderationNote?: string;
	}): Promise<boolean> {
		const host = target.targetType === 'host' ? this.utilityService.toPuny(target.host) : null;
		const userId = target.targetType === 'user' ? target.userId : null;
		const exists = await this.aiModerationHiddenTargetRepository.existsBy(userId != null ? { userId } : { host: host! });
		if (exists) return false;

		const reason = opts.moderator == null ? 'auto' : 'manual';
		await this.aiModerationHiddenTargetRepository.insert({
			id: this.idService.gen(),
			targetType: target.targetType,
			userId,
			host,
			reason,
			createdById: opts.moderator?.id ?? null,
			sourceQueueId: opts.sourceQueueId ?? null,
			moderationNote: opts.moderationNote ?? '',
		});
		this.applyLocally(target.targetType, userId, host, true);

		if (opts.moderator != null) {
			await this.moderationLogService.log(opts.moderator, 'hideAiModerationTarget', {
				...(await this.describe(target.targetType, userId, host)),
				reason,
			});
		}
		return true;
	}

	/** 隠すのをやめる。隠していなければ false */
	@bindThis
	public async unhide(target: AiModerationHideTarget, moderator: { id: MiUser['id'] }): Promise<boolean> {
		const host = target.targetType === 'host' ? this.utilityService.toPuny(target.host) : null;
		const userId = target.targetType === 'user' ? target.userId : null;
		const result = await this.aiModerationHiddenTargetRepository.delete(userId != null ? { userId } : { host: host! });
		if ((result.affected ?? 0) === 0) return false;
		this.applyLocally(target.targetType, userId, host, false);

		await this.moderationLogService.log(moderator, 'unhideAiModerationTarget', await this.describe(target.targetType, userId, host));
		return true;
	}

	@bindThis
	public async list(opts: { limit: number; untilId?: string; sinceId?: string; targetType?: 'user' | 'host' }): Promise<MiAiModerationHiddenTarget[]> {
		const query = this.aiModerationHiddenTargetRepository.createQueryBuilder('target')
			.leftJoinAndSelect('target.user', 'user')
			.leftJoinAndSelect('target.createdBy', 'createdBy')
			.orderBy('target.id', 'DESC')
			.limit(opts.limit);
		if (opts.untilId != null) query.andWhere('target.id < :untilId', { untilId: opts.untilId });
		if (opts.sinceId != null) query.andWhere('target.id > :sinceId', { sinceId: opts.sinceId });
		if (opts.targetType != null) query.andWhere('target.targetType = :targetType', { targetType: opts.targetType });
		return await query.getMany();
	}

	private applyLocally(targetType: 'user' | 'host', userId: string | null, host: string | null, hidden: boolean): void {
		// 自プロセスはすぐ反映し、他プロセスにはイベントで読み直してもらう
		const set = targetType === 'user' ? this.hiddenUserIds : this.hiddenHosts;
		const key = targetType === 'user' ? userId : host;
		if (key != null) {
			if (hidden) set.add(key); else set.delete(key);
		}
		this.globalEventService.publishInternalEvent('aiModerationHiddenChanged', {});
	}

	private async describe(targetType: 'user' | 'host', userId: string | null, host: string | null) {
		const user = userId != null ? await this.usersRepository.findOneBy({ id: userId }) : null;
		return {
			targetType,
			userId,
			userUsername: user?.username ?? null,
			userHost: user?.host ?? null,
			host,
		};
	}

	@bindThis
	public onApplicationShutdown(): void {
		this.redisForSub.off('message', this.onMessage);
	}
}
