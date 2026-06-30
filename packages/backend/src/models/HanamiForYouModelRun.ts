/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';

/**
 * はなみ For You バッチ世代（canonical spec §7.3）。
 * status='ready' の最新世代だけを serve が読む。途中失敗した半端な factor は配信に混ざらない。
 */
@Entity('hanami_foryou_model_run')
@Index(['kind', 'status', 'startedAt'])
export class MiHanamiForYouModelRun {
	@PrimaryColumn(id())
	public id: string;

	// 'als' | 'relation' | 'embedding' | 'aux' など。種別ごとに最新 ready を引く。
	@Column('varchar', { length: 32 })
	public kind: string;

	@Column('jsonb', { default: {} })
	public params: Record<string, unknown>;

	// 'pending' | 'ready' | 'failed'
	@Column('varchar', { length: 32, default: 'pending' })
	public status: string;

	@Column('timestamp with time zone')
	public startedAt: Date;

	@Column('timestamp with time zone', { nullable: true })
	public finishedAt: Date | null;
}
