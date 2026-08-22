/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import { hanamiBigintTransformer, nullableHanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_user_feed_state', { synchronize: false })
@Index('IDX_hanami_user_feed_state_generating', { synchronize: false })
export class MiHanamiUserFeedState {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@Column(id())
	public epochId: string;

	@Column('varchar', { length: 32 })
	public mode: string;

	@Column('varchar', { length: 32 })
	public initialGenerationState: string;

	@Column('timestamp with time zone', { nullable: true })
	public initialGenerationAttemptedAt: Date | null;

	@Column({ ...id(), nullable: true })
	public latestReadyBatchId: string | null;

	@Column({ ...id(), nullable: true })
	public generatingBatchId: string | null;

	@Column('bigint', { default: '0', transformer: hanamiBigintTransformer })
	public latestSequence: string;

	@Column('bigint', { default: '0', transformer: hanamiBigintTransformer })
	public earliestRetainedSequence: string;

	@Column({ ...id(), nullable: true })
	public commonEpochId: string | null;

	@Column({ ...id(), nullable: true })
	public commonHeadGenerationId: string | null;

	@Column('bigint', { nullable: true, transformer: nullableHanamiBigintTransformer })
	public commonHeadSequence: string | null;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
