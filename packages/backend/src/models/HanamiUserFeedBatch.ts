/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

@Entity('hanami_user_feed_batch', { synchronize: false })
@Index('IDX_hanami_user_feed_batch_active_user', { synchronize: false })
@Index('IDX_hanami_user_feed_batch_available', ['status', 'availableAt'])
export class MiHanamiUserFeedBatch {
	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public userId: MiUser['id'];

	@Column(id())
	public epochId: string;

	@Column('varchar', { length: 32 })
	public trigger: string;

	@Column('varchar', { length: 32 })
	public status: string;

	@Column('integer', { default: 0 })
	public attempts: number;

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('timestamp with time zone')
	public availableAt: Date;

	@Column('varchar', { length: 128, nullable: true })
	public leaseOwner: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public leaseExpiresAt: Date | null;

	@Column('timestamp with time zone', { nullable: true })
	public startedAt: Date | null;

	@Column('timestamp with time zone', { nullable: true })
	public finishedAt: Date | null;

	@Column('integer', { default: 0 })
	public itemCount: number;

	@Column('varchar', { length: 128, nullable: true })
	public checksum: string | null;

	@Column(id())
	public baseCommonGenerationId: string;
}
