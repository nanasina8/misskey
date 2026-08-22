/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_common_feed_entry', { synchronize: false })
@Index('IDX_hanami_common_feed_entry_page', { synchronize: false })
@Index('IDX_hanami_common_feed_entry_generation', { synchronize: false })
@Index('IDX_hanami_common_feed_entry_note', { synchronize: false })
export class MiHanamiCommonFeedEntry {
	@PrimaryColumn('date')
	public generatedMonth: string;

	@PrimaryColumn(id())
	public id: string;

	@Column(id())
	public epochId: string;

	@Column('bigint', { transformer: hanamiBigintTransformer })
	public sequence: string;

	@Column(id())
	public generationId: string;

	@Column('integer')
	public position: number;

	@Column(id())
	public noteId: MiNote['id'];

	@Column('varchar', { length: 64 })
	public source: string;

	@Column('jsonb', { default: [] })
	public sources: unknown[];

	@Column('timestamp with time zone')
	public generatedAt: Date;
}
