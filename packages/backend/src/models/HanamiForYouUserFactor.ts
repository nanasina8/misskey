/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiHanamiForYouModelRun } from './HanamiForYouModelRun.js';
import type { MiUser } from './User.js';

/**
 * ALS の user 側 factor（canonical spec §7.3）。
 * evidence が薄い user は作らない。
 */
@Entity('hanami_foryou_user_factor')
export class MiHanamiForYouUserFactor {
	@PrimaryColumn(id())
	public runId: string;

	// 世代（run）を消すと一緒に消える。制約名は migration（hanamiForYouDataLayer）で付けた名前に合わせる。
	@ManyToOne(() => MiHanamiForYouModelRun, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'runId', foreignKeyConstraintName: 'FK_hanami_foryou_user_factor_run' })
	public run?: MiHanamiForYouModelRun | null;

	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@Column('real', { array: true, default: '{}' })
	public factor: number[];

	@Column('integer', { default: 0 })
	public evidenceCount: number;
}
