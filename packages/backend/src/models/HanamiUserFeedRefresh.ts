/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import { nullableHanamiBigintTransformer } from './util/hanami-bigint.js';

@Entity('hanami_user_feed_refresh', { synchronize: false })
@Index('IDX_hanami_user_feed_refresh_expires', ['expiresAt'])
export class MiHanamiUserFeedRefresh {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@PrimaryColumn(id())
	public epochId: string;

	@PrimaryColumn('bytea')
	public refreshTokenDigest: Buffer;

	@Column(id())
	public requestedBatchId: string;

	@Column('varchar', { length: 32, nullable: true })
	public resultMode: string | null;

	@Column({ ...id(), nullable: true })
	public resultFeedEpochId: string | null;

	@Column({ ...id(), nullable: true })
	public resultHeadBatchId: string | null;

	@Column('bigint', { nullable: true, transformer: nullableHanamiBigintTransformer })
	public resultHeadSequence: string | null;

	@Column('varchar', { length: 32 })
	public status: string;

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('timestamp with time zone')
	public expiresAt: Date;
}
