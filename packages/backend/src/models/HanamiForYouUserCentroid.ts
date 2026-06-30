/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

/**
 * MiniLM taste-centroid（反応先ノート埋め込みの平均。canonical spec §5/§7.4）。
 * trending/popular の taste 再ランク・vibe 補助に使う。
 */
@Entity('hanami_foryou_user_centroid')
export class MiHanamiForYouUserCentroid {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn('varchar', { length: 64 })
	public model: string;

	@Column('real', { array: true, default: '{}' })
	public centroid: number[];

	@Column('integer', { default: 0 })
	public evidenceCount: number;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
