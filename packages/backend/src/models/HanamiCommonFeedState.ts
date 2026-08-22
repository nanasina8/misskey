/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column } from 'typeorm';
import { id } from './util/id.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_common_feed_state', { synchronize: false })
export class MiHanamiCommonFeedState {
	@PrimaryColumn(id())
	public singletonId: string;

	@Column({ ...id(), nullable: true })
	public epochId: string | null;

	@Column('bigint', { default: '0', transformer: hanamiBigintTransformer })
	public latestSequence: string;

	@Column('bigint', { default: '0', transformer: hanamiBigintTransformer })
	public earliestRetainedSequence: string;

	@Column({ ...id(), nullable: true })
	public latestReadyGenerationId: string | null;

	@Column({ ...id(), nullable: true })
	public generatingGenerationId: string | null;

	@Column('varchar', { length: 128, nullable: true })
	public generationLeaseOwner: string | null;

	@Column('timestamp with time zone', { nullable: true })
	public generationLeaseExpiresAt: Date | null;

	@Column('bigint', { default: '0', transformer: hanamiBigintTransformer })
	public generationFence: string;

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
