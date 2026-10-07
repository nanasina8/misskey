/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { HanamiTrendSnapshotService } from '@/core/hanami/HanamiTrendSnapshotService.js';
import { meta as trendsMeta } from './hanami-trends.js';

export const meta = {
	tags: ['notes', 'hashtags'],
	requireCredential: false,
	allowGet: true,
	res: {
		type: 'object', optional: false, nullable: false, additionalProperties: false,
		properties: {
			topicId: { type: 'string', optional: false, nullable: false },
			term: { type: 'string', optional: false, nullable: false },
			relatedTerms: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
			startedAt: { type: 'string', format: 'date-time', optional: false, nullable: true },
			lastSeenAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
			peakAuthors: { type: 'integer', optional: false, nullable: false },
			series: trendsMeta.res.properties.items.items.properties.series,
			kind: trendsMeta.res.properties.items.items.properties.kind,
			active: { type: 'boolean', optional: false, nullable: false },
		},
	},
	errors: {
		noSuchTopic: { message: 'No such topic.', code: 'NO_SUCH_TOPIC', id: '40bd9c7c-49f2-4a76-9cd3-a6bca6e0be8f', httpStatusCode: 404 },
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: { topicId: { type: 'string', minLength: 1, maxLength: 32 } },
	required: ['topicId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private snapshotService: HanamiTrendSnapshotService) {
		super(meta, paramDef, async ps => {
			const topic = await this.snapshotService.getTopic(ps.topicId);
			if (topic == null) throw new ApiError(meta.errors.noSuchTopic);
			return topic;
		});
	}
}
