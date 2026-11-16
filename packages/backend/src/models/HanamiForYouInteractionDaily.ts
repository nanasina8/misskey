/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

@Entity('hanami_foryou_interaction_daily')
// 制約は migration（hanamiForYouInteractionDaily）で付けたものと同じ名前にする。
@Check('CHK_hanami_foryou_interaction_daily_signal', `"signal" IN ('reaction', 'reply', 'renote')`)
@Check('CHK_hanami_foryou_interaction_daily_count', '"count" > 0')
export class MiHanamiForYouInteractionDaily {
	@PrimaryColumn('date')
	public day: string;

	@PrimaryColumn('varchar', { length: 16 })
	public signal: 'reaction' | 'reply' | 'renote';

	@PrimaryColumn(id())
	public actorUserId: MiUser['id'];

	@PrimaryColumn(id())
	public targetUserId: MiUser['id'];

	@Column('integer')
	public count: number;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
