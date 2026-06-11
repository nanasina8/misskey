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
import { HanamiRecommendationService, type HanamiAutoInjectPreset } from '@/core/HanamiRecommendationService.js';
import Channel, { type MiChannelService } from '../channel.js';

// auto-inject の重複防止に覚えておく直近送信ノート数（接続単位）。
const RECENT_SENT_NOTES_CAP = 200;

/**
 * はなみTL ストリーム（[[hanami-tl-osusume-redesign]] step11）。
 *
 * ストリーム経路のおすすめは auto-inject（homeノートがN件流れるごとに中央サービスへ候補を取りに行く）のみ。
 * notesStream に流れるのは「いま作成されたノート」だけで、推薦候補（ランキング/トレンド/FoFに載った既存ノート）
 * と交差することはないため、流れてきたノートを推薦集合と照合してマーキングする方式は機能しない（旧実装の轍）。
 * 既存ノートのスロット注入は REST（notes/hanami-timeline）の責務。
 */
class HanamiTimelineChannel extends Channel {
	public readonly chName = 'hanamiTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';
	private withRenotes: boolean;
	private withFiles: boolean;

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

		await this.refreshAutoInjectPreset();

		this.withRenotes = !!(params.withRenotes ?? true);
		this.withFiles = !!(params.withFiles ?? false);

		this.subscriber.on('notesStream', this.onNote);
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

		if (this.withFiles && (note.fileIds == null || note.fileIds.length === 0)) return;

		const followingSet = new Set(Object.keys(this.following));

		// 通常のフォロー判定（おすすめは auto-inject 経路のみ。新規作成ノートが推薦集合と交差することはない）
		if (note.channelId) {
			if (!this.followingChannels.has(note.channelId)) return;
		} else {
			if (!isMe && !followingSet.has(note.userId)) return;
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

		this.send('note', reactionMutedNote);
		this.rememberSentNote(reactionMutedNote.id);
		this.maybeAutoInject().catch(err => {
			// eslint-disable-next-line no-console
			console.error('hanami rec stream: auto inject failed', err);
		});
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
