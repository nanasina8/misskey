/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

@Entity('hanami_user_recommendation_refresh', { synchronize: false })
@Index('IDX_hanami_user_recommendation_refresh_expires', ['expiresAt'])
export class MiHanamiUserRecommendationRefresh {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public epochId: string;

	@PrimaryColumn('bytea')
	public refreshTokenDigest: Buffer;

	@Column(id())
	public requestedBatchId: string;

	@Column({ ...id(), nullable: true })
	public resultBatchId: string | null;

	@Column('varchar', { length: 32 })
	public status: string;

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('timestamp with time zone')
	public expiresAt: Date;
}
