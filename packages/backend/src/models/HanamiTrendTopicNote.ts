/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { MiNote } from './Note.js';
import { id } from './util/id.js';

@Entity('hanami_trend_topic_note', { synchronize: false })
@Index('IDX_hanami_trend_topic_note_added', ['addedAt'])
@Index('IDX_hanami_trend_topic_note_note', ['noteId'])
// The migration specifies descending creation-time/ID order.
@Index('IDX_hanami_trend_topic_note_recent', { synchronize: false })
export class MiHanamiTrendTopicNote {
	@PrimaryColumn(id())
	public topicId: string;

	@PrimaryColumn(id())
	public noteId: string;

	@Column('timestamp with time zone')
	public addedAt: Date;

	@Column('timestamp with time zone')
	public noteCreatedAt: Date;

	@ManyToOne(() => MiNote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'noteId', foreignKeyConstraintName: 'FK_hanami_trend_topic_note_note' })
	public note: MiNote;
}
