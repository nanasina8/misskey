/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { TASTE_EMBED_MODEL } from '@/core/hanami/HanamiTasteClusterBatchService.js';

// taste-clustered popular（spec v0.2 §3.1）: 設定画面「あなたの興味」用のクラスタ一覧。
// labelTerms は頻出語の機械的抽出、代表例は本人のリアクション/投稿履歴なので本人にのみ返す。
export const meta = {
	tags: ['account'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				clusterId: { type: 'number', optional: false, nullable: false },
				labelTerms: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
				size: { type: 'number', optional: false, nullable: false },
				ownRate: { type: 'number', optional: false, nullable: false },
				weight: { type: 'string', optional: false, nullable: false, enum: ['normal', 'reduce', 'hide'] },
				isMention: { type: 'boolean', optional: false, nullable: false },
				examples: {
					type: 'array', optional: false, nullable: false,
					items: {
						type: 'object', optional: false, nullable: false,
						properties: {
							noteId: { type: 'string', optional: false, nullable: false },
							snippet: { type: 'string', optional: false, nullable: false },
						},
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db)
		private db: DataSource,
	) {
		super(meta, paramDef, async (ps, me) => {
			const rows = await this.db.query(
				`SELECT "clusterId", "labelTerms", size, "ownRate", "userWeight", "exampleNoteIds"
				 FROM "hanami_foryou_user_taste_cluster" WHERE "userId" = $1 AND model = $2 ORDER BY size DESC`,
				[me.id, TASTE_EMBED_MODEL],
			) as { clusterId: number; labelTerms: string[]; size: number; ownRate: number; userWeight: number; exampleNoteIds: string[] }[];

			// 代表例は「今この閲覧者に見えるノート」だけ返す。evidence には鍵(followers)が含まれるため、
			// unfollow/被ブロック後に本文が見え続ける可視性制御の迂回を防ぐ。
			const exampleIds = rows.flatMap(r => r.exampleNoteIds);
			const texts = exampleIds.length === 0 ? [] : await this.db.query(
				`SELECT n.id, n.text FROM note n
				 WHERE n.id = ANY($1)
				   AND NOT EXISTS (SELECT 1 FROM blocking b WHERE b."blockerId" = n."userId" AND b."blockeeId" = $2)
				   AND (
				     n.visibility IN ('public','home')
				     OR n."userId" = $2
				     OR (n.visibility = 'followers' AND EXISTS (
				       SELECT 1 FROM following f WHERE f."followerId" = $2 AND f."followeeId" = n."userId"
				     ))
				   )`,
				[exampleIds, me.id],
			) as { id: string; text: string | null }[];
			const textById = new Map(texts.map(t => [t.id, t.text ?? '']));

			// エゴサ判定はバッチ側の初期 weight=0 に畳まれているため、表示上は ownRate の極端な低さで示す。
			return rows.map(r => ({
				clusterId: r.clusterId,
				labelTerms: r.labelTerms,
				size: r.size,
				ownRate: Number(r.ownRate),
				weight: (Number(r.userWeight) >= 1 ? 'normal' : Number(r.userWeight) > 0 ? 'reduce' : 'hide') as 'normal' | 'reduce' | 'hide',
				isMention: Number(r.ownRate) < 0.05 && Number(r.userWeight) === 0,
				examples: r.exampleNoteIds
					.filter(id => textById.has(id))
					.map(id => ({ noteId: id, snippet: (textById.get(id) ?? '').replace(/\s+/g, ' ').slice(0, 80) })),
			}));
		});
	}
}
