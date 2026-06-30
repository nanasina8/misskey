/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

/**
 * 双方向「関係値（親密度）」（canonical spec §5/§7.3）。
 * reaction/reply/renote/スレ共参加の out/in を集計→相互ボーナス・log・時間半減した rel(me, other)。
 * catchup と全軸の「近さ」レイヤに使う。run に紐付かない per-user の現在状態。
 */
@Entity('hanami_foryou_relation')
@Index(['userId', 'relScore'])
export class MiHanamiForYouRelation {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public otherUserId: MiUser['id'];

	@Column('double precision', { default: 0 })
	public relScore: number;

	@Column('double precision', { default: 0 })
	public outScore: number;

	@Column('double precision', { default: 0 })
	public inScore: number;

	@Column('double precision', { default: 0 })
	public mutualScore: number;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
