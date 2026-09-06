/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { RoleService } from '@/core/RoleService.js';
import { HanamiSuggestionExportError, HanamiSuggestionExportService } from '@/core/hanami/HanamiSuggestionExportService.js';

export const meta = {
	tags: ['admin'],
	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:account',
	errors: {
		invalidRequest: { message: 'Invalid suggestion export request.', code: 'HANAMI_SUGGESTION_EXPORT_INVALID_REQUEST', id: '75f7c4db-8c15-4a46-bd25-b9996c9517d3' },
		invalidCursor: { message: 'Invalid or expired suggestion export cursor.', code: 'HANAMI_SUGGESTION_EXPORT_INVALID_CURSOR', id: '9a5d4ee4-635b-48e3-935d-5a6c71e49145' },
	},
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			exportId: { type: 'string', optional: false, nullable: false }, expiresAt: { type: 'string', optional: false, nullable: false }, cursor: { type: 'string', optional: false, nullable: true }, hasMore: { type: 'boolean', optional: false, nullable: false },
			events: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: { user: { type: 'string', optional: false, nullable: false }, note: { type: 'string', optional: false, nullable: false }, author: { type: 'string', optional: false, nullable: false }, timeBucket: { type: 'string', optional: false, nullable: false }, eventType: { type: 'string', enum: ['served', 'seen', 'reaction', 'reply', 'renote'], optional: false, nullable: false }, feedKind: { type: 'string', enum: ['personal', 'common', 'userRecommendation'], optional: false, nullable: true }, source: { type: 'string', enum: ['globalPopular', 'neighborTrending', 'reactionSimilar', 'catchup', 'trending', 'fof', 'exploration', 'normal'], optional: false, nullable: true }, sources: { type: 'array', optional: false, nullable: false, items: { type: 'string', enum: ['globalPopular', 'neighborTrending', 'reactionSimilar', 'catchup', 'trending', 'fof', 'exploration', 'normal'], optional: false, nullable: false } }, origin: { type: 'string', enum: ['commonCandidate', 'personalCandidate', 'userRecommendation'], optional: false, nullable: true }, reactionOutcome: { type: 'boolean', optional: false, nullable: false }, replyOutcome: { type: 'boolean', optional: false, nullable: false }, renoteOutcome: { type: 'boolean', optional: false, nullable: false } } } },
		},
	},
} as const;

export const paramDef = { type: 'object', properties: { startAt: { type: 'string', nullable: true }, endAt: { type: 'string', nullable: true }, limit: { type: 'integer', minimum: 1, maximum: 500, nullable: true }, cursor: { type: 'string', nullable: true } }, required: [] } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	public constructor(service: HanamiSuggestionExportService, roleService: RoleService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				return await service.export({ id: me.id, isAdmin: await roleService.isAdministrator(me) }, { startAt: ps.startAt ?? undefined, endAt: ps.endAt ?? undefined, limit: ps.limit ?? undefined, cursor: ps.cursor ?? undefined });
			} catch (error) {
				if (error instanceof HanamiSuggestionExportError) throw new ApiError(error.code === 'INVALID_REQUEST' ? meta.errors.invalidRequest : meta.errors.invalidCursor);
				throw error;
			}
		});
	}
}
