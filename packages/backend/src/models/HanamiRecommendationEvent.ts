/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import type { MiNote } from './Note.js';

export type HanamiRecEventType = 'served' | 'seen' | 'reaction' | 'reply' | 'renote';
export type HanamiRecEventFeedKind = 'personal' | 'common' | 'userRecommendation';

/**
 * For You の provenance event（canonical spec §7.2）。
 * served を全経路(REST/stream)で記録し、反応は served lookup(14日)で rec/normal を判定する。
 * TTL: served・seen=14日 / 個人event(reaction/reply/renote)=180日（batch cleanup）。
 * 集計は scripts/hanami-foryou-review.mjs が "userId"/"eventType"/"source"/"createdAt" を読む。
 */
@Entity('hanami_recommendation_event', { synchronize: false })
@Index(['userId', 'noteId', 'eventType'])
@Index(['eventType', 'createdAt'])
@Index(['userId', 'createdAt'])
@Index('IDX_hanami_rec_event_feed_entry_type', { synchronize: false })
@Index('IDX_hanami_rec_event_feed_lookup', { synchronize: false })
@Index('IDX_hanami_rec_event_note_cascade', { synchronize: false })
@Index('IDX_hanami_rec_event_occurred', { synchronize: false })
@Index('IDX_hanami_rec_event_provenance_fallback', { synchronize: false })
export class MiHanamiRecommendationEvent {
	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public userId: MiUser['id'];

	@Column(id())
	public noteId: MiNote['id'];

	@Column('varchar', { length: 32 })
	public eventType: HanamiRecEventType;

	// 配信時に枠を消費した軸（globalPopular 等）。rec 由来でない反応は 'normal'。NULL は不明。
	@Column('varchar', { length: 64, nullable: true })
	public source: string | null;

	@Column('varchar', { length: 16, nullable: true })
	public feedKind: HanamiRecEventFeedKind | null;

	@Column({ ...id(), nullable: true })
	public feedEpochId: string | null;

	@Column('varchar', { length: 512, nullable: true })
	public feedEntryId: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public occurredAt: Date | null;

	@Column('timestamp with time zone')
	public createdAt: Date;
}
