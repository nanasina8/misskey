/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_trend_snapshot_entry', { synchronize: false })
@Index('IDX_hanami_trend_snapshot_entry_snapshot', { synchronize: false })
export class MiHanamiTrendSnapshotEntry {
	@PrimaryColumn('date')
	public generatedMonth: string;

	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public snapshotId: string;

	@Column('bigint', { transformer: hanamiBigintTransformer })
	public rank: string;

	@Column('varchar', { length: 256 })
	public term: string;

	@Column('double precision', { default: 0 })
	public score: number;

	@Column('integer', { default: 0 })
	public distinctAuthors: number;
}
