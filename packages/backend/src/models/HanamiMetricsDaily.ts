/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('hanami_metrics_daily', { synchronize: false })
@Index('IDX_hanami_metrics_daily_scope', ['scope', 'dimension', 'day'])
export class MiHanamiMetricsDaily {
	@PrimaryColumn('date') public day: string;
	@PrimaryColumn('varchar', { length: 32 }) public scope: string;
	@PrimaryColumn('varchar', { length: 32 }) public dimension: string;
	@PrimaryColumn('varchar', { length: 128 }) public key: string;
	@Column('integer', { default: 0 }) public users: number;
	@Column('integer', { default: 0 }) public served: number;
	@Column('integer', { default: 0 }) public seen: number;
	@Column('integer', { default: 0 }) public reaction: number;
	@Column('integer', { default: 0 }) public reply: number;
	@Column('integer', { default: 0 }) public renote: number;
	@Column('jsonb', { default: {} }) public extra: Record<string, unknown>;
	@Column('timestamp with time zone') public updatedAt: Date;
}
