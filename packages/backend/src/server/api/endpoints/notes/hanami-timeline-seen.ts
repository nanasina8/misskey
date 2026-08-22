/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiForYouProvenanceService, HanamiInvalidFeedEntryError } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { ApiError } from '../../error.js';

// フロントが「実際に表示確認した」永続 feed entry を記録する。
export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'object',
		optional: false, nullable: false,
		additionalProperties: false,
		properties: {
			ok: { type: 'boolean', optional: false, nullable: false },
		},
	},

	errors: {
		invalidFeedEntry: {
			message: 'Invalid Hanami feed entry.',
			code: 'INVALID_FEED_ENTRY',
			id: '58419e1c-46ab-4306-8dc7-c668c1668d75',
			httpStatusCode: 400,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			minItems: 1,
			maxItems: 100,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					feedEntryId: { type: 'string', minLength: 1, maxLength: 512 },
					noteId: { type: 'string', format: 'misskey:id' },
				},
				required: ['feedEntryId', 'noteId'],
			},
		},
	},
	required: ['items'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiForYouProvenanceService: HanamiForYouProvenanceService,
	) {
		super(meta, paramDef, async (ps, me) => {
			try {
				await this.hanamiForYouProvenanceService.recordSeenFeedEntries(me.id, ps.items);
			} catch (error) {
				if (error instanceof HanamiInvalidFeedEntryError) throw new ApiError(meta.errors.invalidFeedEntry);
				throw error;
			}
			return { ok: true };
		});
	}
}
