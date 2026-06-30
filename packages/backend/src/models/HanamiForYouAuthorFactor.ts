/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';

/**
 * ALS の author 側 factor（canonical spec §7.3）。
 */
@Entity('hanami_foryou_author_factor')
export class MiHanamiForYouAuthorFactor {
	@PrimaryColumn(id())
	public runId: string;

	@PrimaryColumn(id())
	public authorId: MiUser['id'];

	@Column('real', { array: true, default: '{}' })
	public factor: number[];

	@Column('integer', { default: 0 })
	public reactionCount: number;
}
