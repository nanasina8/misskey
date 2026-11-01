/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

/**
 * AI 投稿チェックの「全体を調べる」1回分。既にある投稿を古い順に少しずつ判定する。
 * 結果は参考用で、隠す・通知などは一切しない。
 */
@Entity('ai_moderation_scan')
export class MiAiModerationScan {
	@PrimaryColumn(id())
	public id: string;

	@Index('IDX_ai_moderation_scan_status')
	@Column('varchar', {
		length: 16,
	})
	public status: 'running' | 'done' | 'canceled';

	/** filtered: いつもの絞り込みに当たる投稿だけ / all: 文のある投稿すべて */
	@Column('varchar', {
		length: 16,
	})
	public mode: 'filtered' | 'all';

	@Column('varchar', {
		length: 16,
	})
	public target: 'all' | 'local' | 'remote';

	/** この ID より新しい投稿から（null なら最初から） */
	@Column({
		...id(),
		nullable: true,
	})
	public sinceNoteId: string | null;

	/** 始めた時点。これより新しい投稿はいつもの判定に任せる */
	@Column(id())
	public untilNoteId: string;

	/** ここまで見た */
	@Column({
		...id(),
		nullable: true,
	})
	public cursor: string | null;

	@Column('integer')
	public maxJudged: number;

	@Column('integer', { default: 0 })
	public scannedCount: number;

	@Column('integer', { default: 0 })
	public judgedCount: number;

	@Column('integer', { default: 0 })
	public flaggedCount: number;

	@Column('integer', { default: 0 })
	public wouldHideCount: number;

	/** 判定にかかった秒数の合計（残り時間の見積もりに使う） */
	@Column('real', { default: 0 })
	public judgeSeconds: number;

	@Column({
		...id(),
		nullable: true,
	})
	public startedById: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn({ name: 'startedById', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_ai_moderation_scan_startedBy' })
	public startedBy: MiUser | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public finishedAt: Date | null;

	/** 進まない理由（GPU が無い等）。進めば消す */
	@Column('varchar', {
		length: 1024,
		nullable: true,
	})
	public lastError: string | null;

	/** 始めた時点の判定条件の版。途中で条件が変わったら各項目の criteriaVersion で分かる */
	@Column('varchar', {
		length: 32,
	})
	public criteriaVersion: string;
}
