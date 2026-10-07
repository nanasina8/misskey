/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiTrendSnapshotService } from '@/core/hanami/HanamiTrendSnapshotService.js';

export const meta = {
	tags: ['notes', 'hashtags'],
	requireCredential: false,
	allowGet: true,
	res: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, ref: 'Note' } },
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		topicId: { type: 'string', minLength: 1, maxLength: 32 },
		sort: { type: 'string', enum: ['popular', 'recent'], default: 'popular' },
		limit: { type: 'integer', minimum: 1, maximum: 30, default: 20 },
		offset: { type: 'integer', minimum: 0, maximum: 480, default: 0 },
	},
	required: ['topicId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private snapshotService: HanamiTrendSnapshotService) {
		super(meta, paramDef, async (ps, me) => await this.snapshotService.getMemberNotes({ ...ps, me }));
	}
}
