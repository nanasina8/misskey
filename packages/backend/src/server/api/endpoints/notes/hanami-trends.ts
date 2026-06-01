/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// テキストトレンド（急上昇用語）。本文をトークナイズした汎用トレンドで、ハッシュタグ集計(hashtags/trend)とは別系統。
// distinct author 数（その用語を投稿した別人の数）と急上昇スコアを添えて返す（[[hanami-tl-osusume-redesign]] step7/8）。

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';

export const meta = {
	tags: ['notes', 'hashtags'],

	requireCredential: false,
	allowGet: true,
	cacheSec: 60 * 1,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				term: { type: 'string', optional: false, nullable: false },
				score: { type: 'number', optional: false, nullable: false },
				distinctAuthors: { type: 'integer', optional: false, nullable: false },
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiRecommendationService: HanamiRecommendationService,
	) {
		super(meta, paramDef, async (ps) => {
			return this.hanamiRecommendationService.getTrendingTerms(ps.limit);
		});
	}
}
