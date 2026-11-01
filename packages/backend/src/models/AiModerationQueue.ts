/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiNote } from './Note.js';
import { MiUser } from './User.js';

@Entity('ai_moderation_queue')
@Index('IDX_ai_moderation_queue_host_judgedAt', ['noteUserHost', 'judgedAt'])
export class MiAiModerationQueue {
	@PrimaryColumn(id())
	public id: string;

	@Index('UQ_ai_moderation_queue_noteId', { unique: true })
	@Column(id())
	public noteId: MiNote['id'];

	@Index('IDX_ai_moderation_queue_noteUserId')
	@Column(id())
	public noteUserId: MiUser['id'];

	@Index('IDX_ai_moderation_queue_noteUserHost')
	@Column('varchar', {
		length: 128,
		nullable: true,
	})
	public noteUserHost: string | null;

	@Column('varchar', {
		length: 64,
	})
	public noteVisibility: string;

	@Column('varchar', {
		length: 1024,
	})
	public noteText: string;

	@Column('varchar', {
		length: 64,
		array: true,
		default: '{}',
	})
	public triggers: string[];

	@Column('varchar', {
		length: 256,
		array: true,
		default: '{}',
	})
	public links: string[];

	@Index('IDX_ai_moderation_queue_textFingerprint')
	@Column('varchar', {
		length: 64,
		nullable: true,
	})
	public textFingerprint: string | null;

	@Column('varchar', {
		length: 32,
		array: true,
		default: '{}',
	})
	public contactUserIds: string[];

	@Column('varchar', {
		length: 16,
		nullable: true,
	})
	public contactKind: string | null;

	@Column('varchar', {
		length: 32,
		nullable: true,
	})
	public localLabel: string | null;

	@Column('jsonb', {
		nullable: true,
	})
	public localScores: Record<string, number> | null;

	@Column('varchar', {
		length: 128,
		nullable: true,
	})
	public localModel: string | null;

	@Column('boolean', {
		nullable: true,
	})
	public externalFlagged: boolean | null;

	@Column('varchar', {
		length: 128,
		array: true,
		default: '{}',
	})
	public externalCategories: string[];

	@Column('jsonb', {
		nullable: true,
	})
	public externalScores: Record<string, number> | null;

	@Column('varchar', {
		length: 128,
		nullable: true,
	})
	public externalModel: string | null;

	@Index('IDX_ai_moderation_queue_flagged')
	@Column('boolean', {
		default: false,
	})
	public flagged: boolean;

	@Index('IDX_ai_moderation_queue_resolved')
	@Column('boolean', {
		default: false,
	})
	public resolved: boolean;

	@Column({
		...id(),
		nullable: true,
	})
	public assigneeId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn({ name: 'assigneeId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_ai_moderation_queue_assignee' })
	public assignee: MiUser | null;

	@Column('varchar', {
		length: 8192,
		default: '',
	})
	public moderationNote: string;

	/** 自動で隠すモードの結果: hidden（隠した） / wouldHide（試運転で隠すはずだった）。host が付けばサーバー単位 */
	@Column('varchar', {
		length: 16,
		nullable: true,
	})
	public autoAction: 'hidden' | 'wouldHide' | 'hiddenHost' | 'wouldHideHost' | null;

	/** スパムらしさの根拠（行動の目印）。自動で隠すかの判断に使い、管理画面にも出す */
	@Column('varchar', {
		length: 32,
		array: true,
		default: '{}',
	})
	public spamSignals: string[];

	/** 判定条件の版（ai_moderation_criteria.id） */
	@Column('varchar', {
		length: 32,
		nullable: true,
	})
	public criteriaVersion: string | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public judgedAt: Date | null;
}
