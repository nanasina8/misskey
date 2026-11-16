/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiHanamiForYouModelRun } from './HanamiForYouModelRun.js';
import type { MiUser } from './User.js';

/**
 * reactionSimilar の発見作者 top-N（canonical spec §4/§7.3/§10）。
 * ALS 行列分解で見つけた「未反応だが趣味が近い作者」。serve はこの作者の新着を 7日窓で拾う。
 */
@Entity('hanami_foryou_author_rec')
@Index('IDX_hanami_foryou_author_rec_user_rank', ['runId', 'userId', 'rank'])
export class MiHanamiForYouAuthorRec {
	@PrimaryColumn(id())
	public runId: string;

	// 世代（run）を消すと一緒に消える。制約名は migration（hanamiForYouDataLayer）で付けた名前に合わせる。
	@ManyToOne(() => MiHanamiForYouModelRun, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'runId', foreignKeyConstraintName: 'FK_hanami_foryou_author_rec_run' })
	public run?: MiHanamiForYouModelRun | null;

	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public authorId: MiUser['id'];

	@Column('double precision', { default: 0 })
	public score: number;

	@Column('integer', { default: 0 })
	public rank: number;
}
