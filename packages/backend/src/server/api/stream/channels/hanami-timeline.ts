/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';
import { RoleService } from '@/core/RoleService.js';
import type { JsonObject } from '@/misc/json-value.js';
import { HanamiRecommendationService, type HanamiAutoInjectPreset } from '@/core/HanamiRecommendationService.js';
import { HanamiForYouService } from '@/core/hanami/HanamiForYouService.js';
import Channel, { type MiChannelService } from '../channel.js';

// auto-inject の重複防止に覚えておく直近送信ノート数（接続単位）。
const RECENT_SENT_NOTES_CAP = 200;

// auto-inject の最小間隔（壁時計）。notesStream は instance 全体の note 発火なので、忙しいサーバーでは
// homeNotesPerInjection 閾値が即達する。重い getForYouPage が連発しないよう時間でも絞る。
const MIN_AUTO_INJECT_INTERVAL_MS = 30 * 1000;

/**
 * はなみTL ストリーム = For You feed 専用の realtime 挿入（canonical spec §9/§14-D5）。
 *
 * home/フォローTL のノートは一切転送しない（home は notes/timeline + その channel の責務）。
 * notesStream を「アクティビティのハートビート」としてだけ使い、一定間隔で For You 候補を上部へ軽量挿入する
 * （＝上から引っ張る(pull-to-refresh)で追加のおすすめが差し込まれる挙動。重い候補生成・再ランクはしない）。
 */
class HanamiTimelineChannel extends Channel {
	public readonly chName = 'hanamiTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';
	private withFiles: boolean;

	private autoInjectPreset: HanamiAutoInjectPreset | null = null;
	private ticksSinceLastInject = 0;
	private lastInjectAt = 0;
	private autoInjecting = false;
	private recentSentNoteIds: string[] = [];
	private recentSentNoteIdSet = new Set<string>();

	constructor(
		private roleService: RoleService,
		private hanamiRecommendationService: HanamiRecommendationService,
		private hanamiForYouService: HanamiForYouService,

		id: string,
		connection: Channel['connection'],
	) {
		super(id, connection);
	}

	@bindThis
	public async init(params: JsonObject): Promise<void> {
		const policies = await this.roleService.getUserPolicies(this.user ? this.user.id : null);
		if (!policies.hanamiTlAvailable) return;

		await this.refreshAutoInjectPreset();
		this.withFiles = !!(params.withFiles ?? false);

		// notesStream は「新しいノートが作られた」というアクティビティのハートビートにだけ使う（転送はしない）。
		this.subscriber.on('notesStream', this.onTick);
	}

	@bindThis
	private async refreshAutoInjectPreset(): Promise<void> {
		if (this.user == null) {
			this.autoInjectPreset = null;
			return;
		}
		this.autoInjectPreset = await this.hanamiRecommendationService.getAutoInjectPreset(this.user.id);
	}

	private rememberSentNote(noteId: string): void {
		if (this.recentSentNoteIdSet.has(noteId)) return;
		this.recentSentNoteIds.push(noteId);
		this.recentSentNoteIdSet.add(noteId);
		while (this.recentSentNoteIds.length > RECENT_SENT_NOTES_CAP) {
			const old = this.recentSentNoteIds.shift();
			if (old) this.recentSentNoteIdSet.delete(old);
		}
	}

	@bindThis
	private async onTick(): Promise<void> {
		const user = this.user;
		if (user == null || this.autoInjectPreset == null || this.autoInjecting) return;

		this.ticksSinceLastInject++;
		if (this.ticksSinceLastInject < this.autoInjectPreset.homeNotesPerInjection) return;
		// 壁時計でも絞る（notesStream は instance 全体の発火なので回数だけだと忙しいサーバーで連発する）。
		if (Date.now() - this.lastInjectAt < MIN_AUTO_INJECT_INTERVAL_MS) return;

		this.autoInjecting = true;
		try {
			// For You 候補を取得して上部へ挿入（getForYouPage が served を記録するため REST と重複しない）。
			const notes = await this.hanamiForYouService.getForYouPage(user as MiLocalUser, {
				limit: this.autoInjectPreset.injectCount,
				withFiles: this.withFiles,
			});
			for (const note of notes) this.sendInjectedNote(note);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou stream: auto inject failed', err);
		} finally {
			// カウンタ/時刻のリセットは await 後に（await 中の発火で即再注入されるのを防ぐ）。
			this.ticksSinceLastInject = 0;
			this.lastInjectAt = Date.now();
			this.autoInjecting = false;
		}
	}

	@bindThis
	private sendInjectedNote(note: Packed<'Note'>): boolean {
		if (this.recentSentNoteIdSet.has(note.id)) return false;
		this.send('note', note);
		this.rememberSentNote(note.id);
		return true;
	}

	@bindThis
	public dispose(): void {
		this.subscriber.off('notesStream', this.onTick);
	}
}

@Injectable()
export class HanamiTimelineChannelService implements MiChannelService<true> {
	public readonly shouldShare = HanamiTimelineChannel.shouldShare;
	public readonly requireCredential = HanamiTimelineChannel.requireCredential;
	public readonly kind = HanamiTimelineChannel.kind;

	constructor(
		private roleService: RoleService,
		private hanamiRecommendationService: HanamiRecommendationService,
		private hanamiForYouService: HanamiForYouService,
	) {
	}

	@bindThis
	public create(id: string, connection: Channel['connection']): HanamiTimelineChannel {
		return new HanamiTimelineChannel(
			this.roleService,
			this.hanamiRecommendationService,
			this.hanamiForYouService,
			id,
			connection,
		);
	}
}
