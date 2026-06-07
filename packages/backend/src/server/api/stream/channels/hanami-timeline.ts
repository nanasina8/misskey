/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { bindThis } from '@/decorators.js';
import { RoleService } from '@/core/RoleService.js';
import { isRenotePacked, isQuotePacked } from '@/misc/is-renote.js';
import type { JsonObject } from '@/misc/json-value.js';
import { HanamiRecommendationService, type HanamiAutoInjectPreset, type RecReasonMeta } from '@/core/HanamiRecommendationService.js';
import Channel, { type MiChannelService } from '../channel.js';

// 推薦集合の取得件数とローカルキャッシュ寿命（接続単位）。
const REC_SET_SIZE = 200;
const REC_SET_TTL_MS = 1000 * 60 * 5;

/**
 * はなみTL ストリーム（[[hanami-tl-osusume-redesign]] step11）。
 *
 * REST とおすすめの意味を揃えるため、中央サービス（HanamiRecommendationService）が選んだ
 * 「推薦ノートID集合」に含まれるノートだけを推薦として流す。集合はユーザー設定（ON/OFF・軸）・
 * served/seen・各軸（人気/低露出/急上昇/FoF）を反映済み。
 * 旧実装（featured の純RN を 20% でランダム表示）は廃止。
 */
class HanamiTimelineChannel extends Channel {
	public readonly chName = 'hanamiTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';
	private withRenotes: boolean;
	private withFiles: boolean;

	private recNoteReasons: Map<string, RecReasonMeta> = new Map();
	private showRecommendationReason = false;
	private recSetFetchedAt = 0;
	private autoInjectPreset: HanamiAutoInjectPreset | null = null;
	private homeNotesSinceLastAutoRec = 0;
	private autoInjecting = false;
	private recentSentNoteIds: string[] = [];
	private recentSentNoteIdSet = new Set<string>();

	constructor(
		private noteEntityService: NoteEntityService,
		private roleService: RoleService,
		private hanamiRecommendationService: HanamiRecommendationService,
		private noteStreamingHidingService: NoteStreamingHidingService,

		id: string,
		connection: Channel['connection'],
	) {
		super(id, connection);
	}

	@bindThis
	public async init(params: JsonObject): Promise<void> {
		const policies = await this.roleService.getUserPolicies(this.user ? this.user.id : null);
		if (!policies.hanamiTlAvailable) return;

		await this.refreshRecSet();
		await this.refreshAutoInjectPreset();

		this.withRenotes = !!(params.withRenotes ?? true);
		this.withFiles = !!(params.withFiles ?? false);

		this.subscriber.on('notesStream', this.onNote);
	}

	@bindThis
	private async refreshRecSet(): Promise<void> {
		if (this.user == null) return;
		if (this.recSetFetchedAt !== 0 && (Date.now() - this.recSetFetchedAt < REC_SET_TTL_MS)) return;
		const { reasonOf, showReason } = await this.hanamiRecommendationService.getRecommendationNoteReasons(this.user.id, REC_SET_SIZE);
		this.recNoteReasons = reasonOf;
		this.showRecommendationReason = showReason;
		this.recSetFetchedAt = Date.now();
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
		while (this.recentSentNoteIds.length > REC_SET_SIZE) {
			const old = this.recentSentNoteIds.shift();
			if (old) this.recentSentNoteIdSet.delete(old);
		}
	}

	@bindThis
	private async maybeAutoInject(): Promise<void> {
		await this.refreshAutoInjectPreset();
		if (this.user == null || this.autoInjectPreset == null) return;

		this.homeNotesSinceLastAutoRec++;
		if (this.homeNotesSinceLastAutoRec < this.autoInjectPreset.homeNotesPerInjection || this.autoInjecting) return;

		this.homeNotesSinceLastAutoRec = 0;
		this.autoInjecting = true;
		try {
			const notes = await this.hanamiRecommendationService.getAutoInjectNotes(this.user as MiLocalUser, {
				limit: this.autoInjectPreset.injectCount,
				withFiles: this.withFiles,
				excludedNoteIds: this.recentSentNoteIdSet,
			});
			for (const note of notes) {
				await this.sendAutoInjectedNote(note);
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami rec stream: auto inject failed', err);
		} finally {
			this.autoInjecting = false;
		}
	}

	@bindThis
	private async sendAutoInjectedNote(note: Packed<'Note'>): Promise<void> {
		if (this.withFiles && (note.fileIds == null || note.fileIds.length === 0)) return;
		if (this.recentSentNoteIdSet.has(note.id)) return;
		if (this.isNoteMutedOrBlocked(note)) return;

		let reactionMutedNote = await this.removeMutedReactions(note);
		const filtered = await this.noteStreamingHidingService.filter(reactionMutedNote, this.user?.id ?? null);
		if (!filtered) return;
		// eslint-disable-next-line no-param-reassign -- 通常ノートと同じく filter 後の Note だけを送る
		reactionMutedNote = filtered;

		this.send('note', reactionMutedNote);
		this.rememberSentNote(reactionMutedNote.id);
	}

	@bindThis
	private async onNote(note: Packed<'Note'>) {
		const isMe = this.user!.id === note.userId;

		// 推薦集合を期限切れなら更新（接続単位の軽量キャッシュ）
		await this.refreshRecSet();

		if (this.withFiles && (note.fileIds == null || note.fileIds.length === 0)) return;

		const followingSet = new Set(Object.keys(this.following));

		// このノートが「推薦」に該当するか（中央サービスの集合に含まれる public/home のオリジナル）。
		const isRecommended = this.recNoteReasons.has(note.id)
			&& (note.visibility === 'public' || note.visibility === 'home')
			&& !isMe;

		if (!isRecommended) {
			// 推薦でなければ通常のフォロー判定
			if (note.channelId) {
				if (!this.followingChannels.has(note.channelId)) return;
			} else {
				if (!isMe && !followingSet.has(note.userId)) return;
			}
		}

		if (note.visibility === 'followers') {
			if (!isMe && !followingSet.has(note.userId)) return;
		} else if (note.visibility === 'specified') {
			const visibleUserIdsSet = new Set(note.visibleUserIds ?? []);
			if (!isMe && !visibleUserIdsSet.has(this.user!.id)) return;
		}

		if (note.reply) {
			const reply = note.reply;
			if (this.following[note.userId]?.withReplies) {
				if (reply.visibility === 'followers' && !followingSet.has(reply.userId) && reply.userId !== this.user!.id) return;
			} else {
				if (reply.userId !== this.user!.id && !isMe && reply.userId !== note.userId) return;
			}
		}

		// 純粋なリノート（引用リノートでないリノート）の場合
		if (isRenotePacked(note) && !isQuotePacked(note) && note.renote) {
			if (!this.withRenotes) return;
			if (note.renote.reply) {
				const reply = note.renote.reply;
				if (reply.visibility === 'followers' && !followingSet.has(reply.userId) && reply.userId !== this.user!.id) return;
			}
		}

		if (this.isNoteMutedOrBlocked(note)) return;

		let reactionMutedNote = await this.removeMutedReactions(note);

		const filtered = await this.noteStreamingHidingService.filter(reactionMutedNote, this.user?.id ?? null);
		if (!filtered) return;
		// eslint-disable-next-line no-param-reassign -- これ以降元の Note オブジェクトは見てはいけないので、いっそ再代入した方が安全
		reactionMutedNote = filtered;

		if (this.user) {
			if (isRenotePacked(reactionMutedNote) && !isQuotePacked(reactionMutedNote)) {
				if (reactionMutedNote.renote && Object.keys(reactionMutedNote.renote.reactions).length > 0) {
					const myRenoteReaction = await this.noteEntityService.populateMyReaction(reactionMutedNote.renote, this.user.id);
					reactionMutedNote.renote.myReaction = myRenoteReaction;
				}
			}
		}

		if (isRecommended) {
			const reason = this.recNoteReasons.get(note.id);
			const meta = reactionMutedNote as Record<string, unknown>;
			meta._hanamiRecommended = true;
			if (this.showRecommendationReason && reason) meta._hanamiReason = reason;

			this.recNoteReasons.delete(note.id);
			this.hanamiRecommendationService.recordServedWithLog(
				this.user!.id,
				[note.id],
				reason ? new Map([[note.id, reason]]) : new Map(),
				[reactionMutedNote.userId],
			).catch(err => {
				// eslint-disable-next-line no-console
				console.error('hanami rec stream: recordServed/log failed', err);
			});
		}

		this.send('note', reactionMutedNote);
		this.rememberSentNote(reactionMutedNote.id);
		if (!isRecommended) {
			this.maybeAutoInject().catch(err => {
				// eslint-disable-next-line no-console
				console.error('hanami rec stream: auto inject failed', err);
			});
		}
	}

	@bindThis
	public dispose() {
		this.subscriber.off('notesStream', this.onNote);
	}
}

@Injectable()
export class HanamiTimelineChannelService implements MiChannelService<true> {
	public readonly shouldShare = HanamiTimelineChannel.shouldShare;
	public readonly requireCredential = HanamiTimelineChannel.requireCredential;
	public readonly kind = HanamiTimelineChannel.kind;

	constructor(
		private noteEntityService: NoteEntityService,
		private roleService: RoleService,
		private hanamiRecommendationService: HanamiRecommendationService,
		private noteStreamingHidingService: NoteStreamingHidingService,
	) {
	}

	@bindThis
	public create(id: string, connection: Channel['connection']): HanamiTimelineChannel {
		return new HanamiTimelineChannel(
			this.noteEntityService,
			this.roleService,
			this.hanamiRecommendationService,
			this.noteStreamingHidingService,
			id,
			connection,
		);
	}
}
