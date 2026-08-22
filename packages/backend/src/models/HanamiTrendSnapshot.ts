/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column } from 'typeorm';
import { id } from './util/id.js';
import { hanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_trend_snapshot', { synchronize: false })
export class MiHanamiTrendSnapshot {
	@PrimaryColumn(id())
	public id: string;

	@Column('bigint', { transformer: hanamiBigintTransformer })
	public ordinal: string;

	@Column('varchar', { length: 32 })
	public status: string;

	@Column('timestamp with time zone')
	public generatedAt: Date;

	@Column('integer', { default: 0 })
	public itemCount: number;

	@Column(id())
	public commonGenerationId: string;
}
