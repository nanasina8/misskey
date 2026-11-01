/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Column } from 'typeorm';

/**
 * AI 投稿チェックの判定条件の版（モデル・判定スクリプト・閾値・点数の組）。
 * 判定記録・全体スキャンの criteriaVersion から引く。中身は変えずに残す。
 */
@Entity('ai_moderation_criteria')
export class MiAiModerationCriteria {
	/** 条件の中身の sha256 先頭12文字 */
	@PrimaryColumn('varchar', {
		length: 32,
	})
	public id: string;

	@Column('jsonb')
	public criteria: Record<string, any>;

	/** 初めて使った時刻 */
	@Column('timestamp with time zone')
	public firstUsedAt: Date;
}
