/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiNote } from './Note.js';

/**
 * ノート埋め込み（canonical spec §7.3/§7.4）。
 * MiniLM(paraphrase-multilingual-MiniLM-L12-v2, 384d) などの vibe ベクトル。
 * note 削除で消す（FK CASCADE）。モデル変更時は別 model 行として持つ。pgvector は使わず real[]。
 */
@Entity('hanami_note_embedding')
export class MiHanamiNoteEmbedding {
	@PrimaryColumn(id())
	public noteId: MiNote['id'];

	@ManyToOne(type => MiNote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'noteId' })
	public note?: MiNote | null;

	@PrimaryColumn('varchar', { length: 64 })
	public model: string;

	@Column('integer')
	public dim: number;

	@Column('real', { array: true, default: '{}' })
	public embedding: number[];

	@Column('timestamp with time zone')
	public updatedAt: Date;
}
