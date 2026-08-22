/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// テキストトレンド（急上昇用語）。本文をトークナイズした汎用トレンドで、ハッシュタグ集計(hashtags/trend)とは別系統。
// distinct author 数（その用語を投稿した別人の数）と急上昇スコアを添えて返す（[[hanami-tl-osusume-redesign]] step7/8）。

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiTrendSnapshotService } from '@/core/hanami/HanamiTrendSnapshotService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes', 'hashtags'],

	requireCredential: false,
	allowGet: true,

	res: {
		type: 'object', optional: false, nullable: false,
		additionalProperties: false,
		properties: {
			items: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					additionalProperties: false,
					properties: {
						trendEntryId: { type: 'string', optional: false, nullable: false },
						snapshotId: { type: 'string', optional: false, nullable: false },
						snapshotGeneratedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
						term: { type: 'string', optional: false, nullable: false },
						score: { type: 'number', optional: false, nullable: false },
						distinctAuthors: { type: 'integer', optional: false, nullable: false },
						representativeNote: { type: 'object', optional: false, nullable: true, ref: 'Note' },
					},
				},
			},
			nextCursor: { type: 'string', optional: false, nullable: true },
			hasMore: { type: 'boolean', optional: false, nullable: false },
		},
	},

	errors: {
		invalidCursor: {
			message: 'Invalid Hanami trend cursor.',
			code: 'INVALID_CURSOR',
			id: '3f776435-e1a3-496e-b0e7-0d6f51765daf',
			httpStatusCode: 400,
		},
		cursorExpired: {
			message: 'Hanami trend cursor has expired.',
			code: 'CURSOR_EXPIRED',
			id: '5a5f900b-7fda-47a4-9de0-3c3de3cdaf45',
			httpStatusCode: 400,
		},
		invalidParam: {
			message: 'Invalid param.',
			code: 'INVALID_PARAM',
			id: 'c7354f5f-fb22-4cd7-a6cb-2ccf98b9ecb3',
			httpStatusCode: 400,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
		history: { type: 'boolean', default: false },
		cursor: { type: 'string', minLength: 1, maxLength: 1024 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private snapshotService: HanamiTrendSnapshotService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const cursor = ps.cursor ?? null;
			if (!ps.history && cursor != null) throw new ApiError(meta.errors.invalidParam);
			const result = await this.snapshotService.getPage({
				history: ps.history,
				limit: ps.limit,
				cursor,
				me,
			});
			switch (result.kind) {
				case 'ok': return result.response;
				case 'invalidCursor': throw new ApiError(meta.errors.invalidCursor);
				case 'cursorExpired': throw new ApiError(meta.errors.cursorExpired);
			}
		});
	}
}
