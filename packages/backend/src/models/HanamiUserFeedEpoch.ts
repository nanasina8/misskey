/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

@Entity('hanami_user_feed_epoch', { synchronize: false })
@Index('IDX_hanami_user_feed_epoch_active_user', { synchronize: false })
@Index('IDX_hanami_user_feed_epoch_user_created', ['userId', 'createdAt'])
export class MiHanamiUserFeedEpoch {
	@PrimaryColumn(id())
	public epochId: string;

	@Column(id())
	public userId: MiUser['id'];

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('timestamp with time zone', { nullable: true })
	public retiredAt: Date | null;
}
