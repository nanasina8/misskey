/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { validateHanamiRefreshTokenFormat } from '@/core/hanami/HanamiFeedCodec.js';
import { HanamiTimelinePageService } from '@/core/hanami/HanamiTimelinePageService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'object',
		optional: false, nullable: false,
		additionalProperties: false,
		properties: {
			items: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					additionalProperties: false,
					properties: {
						feedEntryId: { type: 'string', optional: false, nullable: false },
						batchId: { type: 'string', optional: false, nullable: false },
						note: { type: 'object', optional: false, nullable: false, ref: 'Note' },
					},
				},
			},
			nextCursor: { type: 'string', optional: false, nullable: true },
			hasMore: { type: 'boolean', optional: false, nullable: false },
			mode: { type: 'string', enum: ['personalized', 'common'], optional: false, nullable: false },
			generationPending: { type: 'boolean', optional: false, nullable: false },
			feedEpochId: { type: 'string', optional: false, nullable: false },
			headBatchId: { type: 'string', optional: false, nullable: false },
		},
	},

	errors: {
		hanamiTlDisabled: {
			message: 'Hanami timeline has been disabled.',
			code: 'HanamiTL_DISABLED',
			id: 'ffa57e0f-d14e-48d6-a64c-8fbcba5635ab',
			httpStatusCode: 403,
		},
		invalidCursor: {
			message: 'Invalid Hanami timeline cursor.',
			code: 'INVALID_CURSOR',
			id: '0b737d4e-e23f-449c-bf73-ec51f7a8573e',
			httpStatusCode: 400,
		},
		cursorExpired: {
			message: 'Hanami timeline cursor has expired.',
			code: 'CURSOR_EXPIRED',
			id: 'b700843a-41a4-4962-b0a8-1a28c202a679',
			httpStatusCode: 400,
		},
		refreshTokenExpired: {
			message: 'Hanami refresh token has expired.',
			code: 'REFRESH_TOKEN_EXPIRED',
			id: '0bc81395-04fd-4d3f-9d08-b5c27bd3236c',
			httpStatusCode: 400,
		},
		refreshRateLimited: {
			message: 'Hanami timeline refresh rate limit exceeded.',
			code: 'HANAMI_REFRESH_RATE_LIMITED',
			id: 'b10e0254-3108-48ed-a821-26f3eb270ab1',
			httpStatusCode: 429,
		},
		commonNotReady: {
			message: 'Hanami common timeline is not ready.',
			code: 'HANAMI_COMMON_NOT_READY',
			id: '64e6e77c-19e0-4623-bc0e-31115f73e381',
			kind: 'server',
			httpStatusCode: 503,
		},
		invalidParam: {
			message: 'Invalid param.',
			code: 'INVALID_PARAM',
			id: '3d81ceae-475f-4600-b2a8-2bc116157532',
			httpStatusCode: 400,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	additionalProperties: false,
	properties: {
		limit: { type: 'integer', minimum: 1 },
		cursor: { type: 'string', minLength: 1, maxLength: 1024 },
		refresh: { type: 'boolean', default: false },
		refreshToken: { type: 'string' },
		withFiles: { type: 'boolean', default: false },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiTimelinePageService: HanamiTimelinePageService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const cursor = ps.cursor ?? null;
			const refreshToken = ps.refreshToken ?? null;
			if ((ps.refresh && (cursor != null || refreshToken == null)) || (!ps.refresh && refreshToken != null)) {
				throw new ApiError(meta.errors.invalidParam);
			}
			if (refreshToken != null) {
				try {
					validateHanamiRefreshTokenFormat(refreshToken);
				} catch {
					throw new ApiError(meta.errors.invalidParam);
				}
			}

			const result = await this.hanamiTimelinePageService.serve({
				me,
				request: {
					limit: ps.limit ?? (cursor == null ? 15 : 30),
					cursor,
					refresh: ps.refresh,
					refreshToken,
					withFiles: ps.withFiles,
				},
			});
			switch (result.kind) {
				case 'ok': return { ...result.response, items: [...result.response.items] };
				case 'roleDisabled': throw new ApiError(meta.errors.hanamiTlDisabled);
				case 'invalidCursor': throw new ApiError(meta.errors.invalidCursor);
				case 'cursorExpired': throw new ApiError(meta.errors.cursorExpired);
				case 'commonNotReady': throw new ApiError(meta.errors.commonNotReady);
				case 'invalidRefreshToken': throw new ApiError(meta.errors.invalidParam);
				case 'refreshTokenExpired': throw new ApiError(meta.errors.refreshTokenExpired);
				case 'refreshRateLimited': throw new ApiError(meta.errors.refreshRateLimited);
			}
		});
	}
}
