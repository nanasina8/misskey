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
	res: {
		type: 'object', optional: false, nullable: false,
		additionalProperties: false,
		properties: {
			notes: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'Note' } },
		},
	},
	errors: {
		invalidParam: {
			message: 'Invalid param.',
			code: 'INVALID_PARAM',
			id: '3d81ceae-475f-4600-b2a8-2bc116157532',
			httpStatusCode: 400,
		},
	},
} as const;

const dateTimeParam = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}[Tt](?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:[Zz]|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$' } as const;

export const paramDef = {
	type: 'object',
	properties: {
		from: { ...dateTimeParam, format: 'date-time' },
		to: { ...dateTimeParam, format: 'date-time' },
		topicId: { type: 'string', minLength: 1, maxLength: 32 },
		term: { type: 'string', minLength: 1, maxLength: 256 },
	},
	required: ['from', 'to'],
	oneOf: [{ required: ['topicId'] }, { required: ['term'] }],
} as const;

// Endpoint's shared AJV only registers misskey:id; retain date-time in OpenAPI.
const runtimeParamDef = { ...paramDef, properties: { ...paramDef.properties, from: dateTimeParam, to: dateTimeParam } } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof runtimeParamDef> { // eslint-disable-line import/no-default-export
	constructor(private snapshotService: HanamiTrendSnapshotService) {
		super(meta, runtimeParamDef, async (ps, me) => {
			const from = normalizeHanamiTrendDateTime(ps.from);
			const to = normalizeHanamiTrendDateTime(ps.to);
			if (from == null || to == null) throw new ApiError(meta.errors.invalidParam);
			const span = Date.parse(to) - Date.parse(from);
			if (span <= 0 || span > 6 * 60 * 60 * 1000) throw new ApiError(meta.errors.invalidParam);
			return await this.snapshotService.getTopicNotes({ from, to, topicId: ps.topicId, term: ps.term, me });
		});
	}
}
