/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import { nullableHanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_user_recommendation_batch', { synchronize: false })
@Index('IDX_hanami_user_recommendation_batch_active_user', { synchronize: false })
@Index('IDX_hanami_user_recommendation_batch_available', ['status', 'availableAt'])
export class MiHanamiUserRecommendationBatch {
	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public userId: MiUser['id'];

	@Column(id())
	public epochId: string;

	@Column('bigint', { nullable: true, transformer: nullableHanamiBigintTransformer })
	public ordinal: string | null;

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
}
