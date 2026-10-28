/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { HanamiTrendSnapshotService, normalizeHanamiTrendDateTime } from '@/core/hanami/HanamiTrendSnapshotService.js';

export const meta = {
	tags: ['notes', 'hashtags'],
	requireCredential: false,
	allowGet: true,
	errors: {
		invalidParam: { message: 'Invalid param.', code: 'INVALID_PARAM', id: '3d81ceae-475f-4600-b2a8-2bc116157532', httpStatusCode: 400 },
	},
	res: {
		type: 'object', optional: false, nullable: false,
		additionalProperties: false,
		properties: {
			blocks: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						from: { type: 'string', format: 'date-time', optional: false, nullable: false },
						to: { type: 'string', format: 'date-time', optional: false, nullable: false },
						items: {
							type: 'array', optional: false, nullable: false,
							items: {
								type: 'object', optional: false, nullable: false,
								properties: {
									topicId: { type: 'string', optional: false, nullable: true },
									term: { type: 'string', optional: false, nullable: false },
									title: { type: 'string', optional: false, nullable: true },
									relatedTerms: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
									startedAt: { type: 'string', format: 'date-time', optional: false, nullable: true },
									daily: { type: 'boolean', optional: false, nullable: false },
									peakAuthors: { type: 'integer', optional: false, nullable: false },
									firstSeenAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
									lastSeenAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
									representativeNote: { type: 'object', optional: false, nullable: true, ref: 'Note' },
								},
							},
						},
					},
				},
			},
			nextUntil: { type: 'string', optional: false, nullable: true },
		},
	},
} as const;

const dateTimeParam = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}[Tt](?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:[Zz]|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$' } as const;

export const paramDef = {
	type: 'object',
	properties: {
		until: { ...dateTimeParam, format: 'date-time' },
		blocks: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
	},
	required: [],
} as const;

// Endpoint's shared AJV only registers misskey:id; retain date-time in OpenAPI.
const runtimeParamDef = { ...paramDef, properties: { ...paramDef.properties, until: dateTimeParam } } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof runtimeParamDef> { // eslint-disable-line import/no-default-export
	constructor(private snapshotService: HanamiTrendSnapshotService) {
		super(meta, runtimeParamDef, async (ps, me) => {
			const until = ps.until == null ? undefined : normalizeHanamiTrendDateTime(ps.until);
			if (until === null) throw new ApiError(meta.errors.invalidParam);
			return await this.snapshotService.getHistory({ until, blocks: ps.blocks, me });
		});
	}
}
