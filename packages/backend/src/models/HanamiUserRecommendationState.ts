/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_user_recommendation_state', { synchronize: false })
@Index('IDX_hanami_user_recommendation_state_generating', { synchronize: false })
export class MiHanamiUserRecommendationState {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@Column(id())
	public epochId: string;

	@Column({ ...id(), nullable: true })
	public latestReadyBatchId: string | null;

	@Column('bigint', { default: '0', transformer: hanamiBigintTransformer })
	public latestOrdinal: string;

	@Column({ ...id(), nullable: true })
	public generatingBatchId: string | null;

	@Column('varchar', { length: 32 })
	public initialGenerationState: string;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
