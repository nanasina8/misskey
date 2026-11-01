/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

/**
 * AI 投稿チェックで「ユーザーから隠す」にしたアカウント／サーバー。
 * 行を消せば元に戻る（可逆）。
 */
@Entity('ai_moderation_hidden_target')
export class MiAiModerationHiddenTarget {
	@PrimaryColumn(id())
	public id: string;

	@Column('varchar', {
		length: 16,
	})
	public targetType: 'user' | 'host';

	@Index('UQ_ai_moderation_hidden_target_userId', { unique: true })
	@Column({
		...id(),
		nullable: true,
	})
	public userId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'userId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_ai_moderation_hidden_target_user' })
	public user: MiUser | null;

	@Index('UQ_ai_moderation_hidden_target_host', { unique: true })
	@Column('varchar', {
		length: 128,
		nullable: true,
	})
	public host: string | null;

	@Column('varchar', {
		length: 16,
	})
	public reason: 'manual' | 'auto';

	@Column({
		...id(),
		nullable: true,
	})
	public createdById: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn({ name: 'createdById', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_ai_moderation_hidden_target_createdBy' })
	public createdBy: MiUser | null;

	@Column({
		...id(),
		nullable: true,
	})
	public sourceQueueId: string | null;

	@Column('varchar', {
		length: 8192,
		default: '',
	})
	public moderationNote: string;
}
