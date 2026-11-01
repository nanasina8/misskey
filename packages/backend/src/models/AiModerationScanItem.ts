/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiAiModerationScan } from './AiModerationScan.js';

/**
 * 「全体を調べる」で判定した投稿1件。投稿やユーザーが消えても記録は残す（参考用）。
 */
@Entity('ai_moderation_scan_item')
@Index('IDX_ai_moderation_scan_item_scan_flagged', ['scanId', 'flagged'])
export class MiAiModerationScanItem {
	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public scanId: MiAiModerationScan['id'];

	@ManyToOne(() => MiAiModerationScan, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'scanId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_ai_moderation_scan_item_scan' })
	public scan: MiAiModerationScan | null;

	@Column(id())
	public noteId: string;

	@Column(id())
	public noteUserId: string;

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

	@Index('IDX_ai_moderation_scan_item_textFingerprint')
	@Column('varchar', {
		length: 64,
		nullable: true,
	})
	public textFingerprint: string | null;

	@Column('varchar', {
		length: 32,
		nullable: true,
	})
	public localLabel: string | null;

	@Column('jsonb', {
		nullable: true,
	})
	public localScores: Record<string, number> | null;

	@Column('boolean', {
		default: false,
	})
	public flagged: boolean;

	@Column('varchar', {
		length: 32,
		array: true,
		default: '{}',
	})
	public spamSignals: string[];

	/** 自動で隠すモードなら隠していたか */
	@Column('boolean', {
		default: false,
	})
	public wouldHide: boolean;

	/** 判定条件の版（ai_moderation_criteria.id） */
	@Column('varchar', {
		length: 32,
		nullable: true,
	})
	public criteriaVersion: string | null;
}
