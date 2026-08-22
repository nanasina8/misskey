/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_common_generation', { synchronize: false })
@Index('IDX_hanami_common_generation_status_ordinal', ['status', 'ordinal'])
export class MiHanamiCommonGeneration {
	@PrimaryColumn(id())
	public id: string;

	@Column('bigint', { transformer: hanamiBigintTransformer })
	public ordinal: string;

	@Column('varchar', { length: 32 })
	public status: string;

	@Column('timestamp with time zone')
	public startedAt: Date;

	@Column('timestamp with time zone', { nullable: true })
	public finishedAt: Date | null;

	@Column('varchar', { length: 64 })
	public algorithmVersion: string;

	@Column('varchar', { length: 128, nullable: true })
	public checksum: string | null;

	@Column('jsonb', { default: {} })
	public sourceAsOf: Record<string, unknown>;

	@Column('bigint', { transformer: hanamiBigintTransformer })
	public generationFence: string;
}
