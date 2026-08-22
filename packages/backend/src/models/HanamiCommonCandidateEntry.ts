/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_common_candidate', { synchronize: false })
@Index('IDX_hanami_common_candidate_generation', { synchronize: false })
@Index('IDX_hanami_common_candidate_note', { synchronize: false })
export class MiHanamiCommonCandidateEntry {
	@PrimaryColumn('date')
	public generatedMonth: string;

	@PrimaryColumn(id())
	public generationId: string;

	@PrimaryColumn('bigint', { transformer: hanamiBigintTransformer })
	public generationFence: string;

	@PrimaryColumn('varchar', { length: 64 })
	public axis: string;

	@PrimaryColumn('bigint', { transformer: hanamiBigintTransformer })
	public rank: string;

	@Column(id())
	public noteId: MiNote['id'];

	@Column('double precision', { default: 0 })
	public baseScore: number;

	@Column('jsonb', { default: {} })
	public metadata: Record<string, unknown>;
}
