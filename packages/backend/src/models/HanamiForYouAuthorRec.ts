/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

/**
 * reactionSimilar の発見作者 top-N（canonical spec §4/§7.3/§10）。
 * ALS 行列分解で見つけた「未反応だが趣味が近い作者」。serve はこの作者の新着を 7日窓で拾う。
 */
@Entity('hanami_foryou_author_rec')
@Index(['runId', 'userId', 'rank'])
export class MiHanamiForYouAuthorRec {
	@PrimaryColumn(id())
	public runId: string;

	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public authorId: MiUser['id'];

	@Column('double precision', { default: 0 })
	public score: number;

	@Column('integer', { default: 0 })
	public rank: number;
}
