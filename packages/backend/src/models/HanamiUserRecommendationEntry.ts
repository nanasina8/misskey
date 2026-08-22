/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_user_recommendation_entry', { synchronize: false })
@Index('IDX_hanami_user_recommendation_entry_page', { synchronize: false })
export class MiHanamiUserRecommendationEntry {
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

	@Column('bigint', { transformer: hanamiBigintTransformer })
	public rank: string;

	@Column(id())
	public recommendedUserId: MiUser['id'];

	@Column('jsonb', { default: {} })
	public reason: Record<string, unknown>;

	@Column('integer', { default: 0 })
	public mutualCount: number;

	@Column('timestamp with time zone', { nullable: true })
	public shownAt: Date | null;
}
