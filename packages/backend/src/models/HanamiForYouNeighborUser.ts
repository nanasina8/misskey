/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiHanamiForYouModelRun } from './HanamiForYouModelRun.js';
import type { MiUser } from './User.js';

/**
 * neighborTrending 用の taste 近傍ユーザ（canonical spec §4/§7.3/§10）。
 * ALS で求めた「自分と趣味が近い人」。serve はこの人たちが"今"反応している投稿を拾う。
 */
@Entity('hanami_foryou_neighbor_user')
@Index('IDX_hanami_foryou_neighbor_user_user_rank', ['runId', 'userId', 'rank'])
export class MiHanamiForYouNeighborUser {
	@PrimaryColumn(id())
	public runId: string;

	// 世代（run）を消すと一緒に消える。制約名は migration（hanamiForYouDataLayer）で付けた名前に合わせる。
	@ManyToOne(() => MiHanamiForYouModelRun, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'runId', foreignKeyConstraintName: 'FK_hanami_foryou_neighbor_user_run' })
	public run?: MiHanamiForYouModelRun | null;

	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public neighborUserId: MiUser['id'];

	@Column('double precision', { default: 0 })
	public score: number;

	@Column('integer', { default: 0 })
	public rank: number;
}
