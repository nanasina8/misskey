/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';
import type { MiUser } from './User.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

export type HanamiUserFeedEntryOrigin = 'commonCandidate' | 'personalCandidate';

@Entity('hanami_user_feed_entry', { synchronize: false })
@Index('IDX_hanami_user_feed_entry_page', { synchronize: false })
@Index('IDX_hanami_user_feed_entry_batch', ['batchId', 'position'])
@Index('IDX_hanami_user_feed_entry_note', ['noteId'])
export class MiHanamiUserFeedEntry {
	@Column(id())
	public id: string;

	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public epochId: string;

	@PrimaryColumn('bigint', { transformer: hanamiBigintTransformer })
	public sequence: string;

	@Column(id())
	public batchId: string;

	@Column('integer')
	public position: number;

	@Column(id())
	public noteId: MiNote['id'];

	@Column('varchar', { length: 64 })
	public source: string;

	@Column('jsonb', { default: [] })
	public sources: unknown[];

	@Column('varchar', { length: 32 })
	public origin: HanamiUserFeedEntryOrigin;

	@Column('jsonb', { default: {} })
	public reasonMetadata: Record<string, unknown>;

	@Column('timestamp with time zone')
	public generatedAt: Date;
}
