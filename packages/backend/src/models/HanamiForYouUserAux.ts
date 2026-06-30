/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

/**
 * 補助集計（活動リズム・メディア嗜好。canonical spec §5/§7.3/§10）。
 * 最終段の弱い boost/filter（夜型 boost・text 偏重なら画像割引）のタイブレーク用。
 */
@Entity('hanami_foryou_user_aux')
export class MiHanamiForYouUserAux {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	// 時間帯ヒストグラム（JST 0-23時の活動量）。{"19":40,"20":55,...} 形式。
	@Column('jsonb', { default: {} })
	public activeHourHist: Record<string, number>;

	@Column('double precision', { default: 0 })
	public mediaReactionRate: number;

	@Column('double precision', { default: 0 })
	public textReactionRate: number;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
