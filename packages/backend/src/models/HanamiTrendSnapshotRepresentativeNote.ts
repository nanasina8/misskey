/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_trend_snapshot_representative_note', { synchronize: false })
@Index('IDX_hanami_trend_snapshot_rep_note_snapshot', { synchronize: false })
@Index('IDX_hanami_trend_snapshot_rep_note_note', { synchronize: false })
export class MiHanamiTrendSnapshotRepresentativeNote {
	@PrimaryColumn('date')
	public generatedMonth: string;

	@PrimaryColumn(id())
	public snapshotId: string;

	@PrimaryColumn('bigint', { transformer: hanamiBigintTransformer })
	public rank: string;

	@PrimaryColumn('integer')
	public position: number;

	@Column(id())
	public noteId: MiNote['id'];
}
