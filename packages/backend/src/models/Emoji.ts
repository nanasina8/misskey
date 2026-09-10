/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from './util/id.js';

@Entity('emoji')
@Index(['name', 'host'], { unique: true })
@Index('IDX_EMOJI_ROLE_IDS', { synchronize: false }) // GIN for roleIdsThatCanBeUsedThisEmojiAsReaction in production
// フィンガープリント未取得の絵文字だけをid順に走査するバックフィル用の部分インデックス（完了後は空になる）
@Index('IDX_EMOJI_IMAGE_FINGERPRINT_PENDING', ['id'], { where: '"imageFingerprint" IS NULL AND "imageFingerprintAttemptedAt" IS NULL' })
export class MiEmoji {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public updatedAt: Date | null;

	@Index()
	@Column('varchar', {
		length: 128,
	})
	public name: string;

	@Index()
	@Column('varchar', {
		length: 128, nullable: true,
	})
	public host: string | null;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	@Index('IDX_EMOJI_CATEGORY')
	public category: string | null;

	@Column('varchar', {
		length: 512,
	})
	public originalUrl: string;

	@Column('varchar', {
		length: 512,
		default: '',
	})
	public publicUrl: string;

	@Column('varchar', {
		length: 512, nullable: true,
	})
	public uri: string | null;

	// publicUrlの方のtypeが入る
	@Column('varchar', {
		length: 64, nullable: true,
	})
	public type: string | null;

	@Column('varchar', {
		array: true, length: 128, default: '{}',
	})
	public aliases: string[];

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public license: string | null;

	@Column('boolean', {
		default: false,
	})
	public localOnly: boolean;

	@Column('boolean', {
		default: false,
	})
	public isSensitive: boolean;

	// TODO: 定期ジョブで存在しなくなったロールIDを除去するようにする
	@Column('varchar', {
		array: true, length: 128, default: '{}',
	})
	public roleIdsThatCanBeUsedThisEmojiAsReaction: string[];

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public remarks: string | null;

	// ローカル絵文字の画像フィンガープリント（重複検知用）。リモート絵文字は対象外なので部分インデックス。
	@Index('IDX_EMOJI_IMAGE_FINGERPRINT_LOCAL', { where: '"host" IS NULL AND "imageFingerprint" IS NOT NULL' })
	@Column('varchar', {
		length: 80, nullable: true,
	})
	public imageFingerprint: string | null;

	// フィンガープリントの算出を試みた時刻。imageFingerprintがNULLのままでもここが埋まっていれば
	// 「試したが取れなかった」を意味し、バックフィルの対象から外れる。
	@Column('timestamp with time zone', {
		nullable: true,
	})
	public imageFingerprintAttemptedAt: Date | null;
}
