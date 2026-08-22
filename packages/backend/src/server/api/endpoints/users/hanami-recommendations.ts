/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiUserRecommendationPageService } from '@/core/hanami/HanamiUserRecommendationPageService.js';
import { ApiError } from '../../error.js';

// フォロー候補（おすすめユーザー）。FoF（友達の友達）をスコア順に返す（[[hanami-tl-osusume-redesign]] step10）。
// 各候補に reason（fof）と mutualCount（共通の知り合い数）を添える。
export const meta = {
	tags: ['users'],

	requireCredential: true,
	kind: 'read:account',

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
						recommendationEntryId: { type: 'string', optional: false, nullable: false },
						batchId: { type: 'string', optional: false, nullable: false },
						batchGeneratedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
						user: { type: 'object', optional: false, nullable: false, ref: 'UserDetailed' },
						reason: { type: 'string', optional: false, nullable: false },
						mutualCount: { type: 'integer', optional: false, nullable: false },
					},
				},
			},
			nextCursor: { type: 'string', optional: false, nullable: true },
			hasMore: { type: 'boolean', optional: false, nullable: false },
		},
	},

	errors: {
		invalidCursor: {
			message: 'Invalid Hanami user recommendation cursor.',
			code: 'INVALID_CURSOR',
			id: '7284406f-9e92-4de9-b5fd-50fa369a63da',
			httpStatusCode: 400,
		},
		cursorExpired: {
			message: 'Hanami user recommendation cursor has expired.',
			code: 'CURSOR_EXPIRED',
			id: 'f52ee9ee-a823-4dcc-aa5a-35a084de1ed5',
			httpStatusCode: 400,
		},
		invalidParam: {
			message: 'Invalid param.',
			code: 'INVALID_PARAM',
			id: '136b0a5a-3ed0-493e-94f1-a30b0423a409',
			httpStatusCode: 400,
		},
		refreshTokenExpired: {
			message: 'Hanami user recommendation refresh token has expired.',
			code: 'REFRESH_TOKEN_EXPIRED',
			id: '3692d037-c5d8-462e-a752-9304e56c678a',
			httpStatusCode: 400,
		},
		refreshRateLimited: {
			message: 'Hanami user recommendation refresh rate limit exceeded.',
			code: 'HANAMI_REFRESH_RATE_LIMITED',
			id: '5cca6fe8-bf5f-4c3f-beb2-4d65fd918a70',
			httpStatusCode: 429,
		},
		hanamiTlDisabled: {
			message: 'Hanami timeline has been disabled.',
			code: 'HanamiTL_DISABLED',
			id: 'c5e14c52-ad18-4676-8905-e353d7b24581',
			httpStatusCode: 403,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
		cursor: { type: 'string', minLength: 1, maxLength: 1024 },
		history: { type: 'boolean', default: false },
		refresh: { type: 'boolean', default: false },
		refreshToken: { type: 'string' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private pageService: HanamiUserRecommendationPageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const cursor = ps.cursor ?? null;
			const refreshToken = ps.refreshToken ?? null;
			if ((ps.refresh && (ps.history || cursor != null || refreshToken == null)) || (!ps.refresh && refreshToken != null)) {
				throw new ApiError(meta.errors.invalidParam);
			}
			const result = await this.pageService.serve(me, {
				limit: ps.limit,
				cursor,
				history: ps.history,
				refresh: ps.refresh,
				refreshToken,
			});
			switch (result.kind) {
				case 'ok': return result.response;
				case 'invalidCursor': throw new ApiError(meta.errors.invalidCursor);
				case 'cursorExpired': throw new ApiError(meta.errors.cursorExpired);
				case 'invalidRefreshToken': throw new ApiError(meta.errors.invalidParam);
				case 'refreshTokenExpired': throw new ApiError(meta.errors.refreshTokenExpired);
				case 'refreshRateLimited': throw new ApiError(meta.errors.refreshRateLimited);
				case 'roleDisabled': throw new ApiError(meta.errors.hanamiTlDisabled);
			}
		});
	}
}
