/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_trend_snapshot_entry', { synchronize: false })
@Index('IDX_hanami_trend_snapshot_entry_snapshot', { synchronize: false })
@Index('IDX_hanami_trend_snapshot_entry_topic', { synchronize: false })
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

	@Column('varchar', { length: 32, nullable: true })
	public topicId: string | null;

	@Column('varchar', { length: 256, array: true, default: '{}' })
	public relatedTerms: string[];

	@Column('timestamp with time zone', { nullable: true })
	public startedAt: Date | null;

	@Column('boolean', { default: false })
	public daily: boolean;

	@Column('double precision', { default: 0 })
	public score: number;

	@Column('integer', { default: 0 })
	public distinctAuthors: number;

	@Column('integer', { default: 0 })
	public recentAuthors: number;
}
