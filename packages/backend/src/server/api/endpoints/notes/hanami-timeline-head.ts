/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import {
	HANAMI_USER_FEED_REQUEST,
	type HanamiUserFeedRequestPort,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { ApiError } from '../../error.js';

// はなみTL の「今の先頭」だけを返す軽い確認用。更新後に裏の生成ができたかを確かめるのに使う。
// 投稿は詰めず、表示の記録・指標・チャート・「前回見た」の目印は書かず、生成も始めない。
export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	// 画面は 1 回の待ちで最大 22 回（1・2・3 秒後、以後 3 秒おき、約 60 秒まで）確かめる。
	// デッキで列が複数あっても足りる回数にしつつ、外からの連打は止める。
	limit: {
		duration: 60 * 1000,
		max: 120,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		additionalProperties: false,
		properties: {
			mode: { type: 'string', enum: ['personalized', 'common'], optional: false, nullable: false },
			feedEpochId: { type: 'string', optional: false, nullable: false },
			headBatchId: { type: 'string', optional: false, nullable: false },
			generationPending: { type: 'boolean', optional: false, nullable: false },
		},
	},

	errors: {
		hanamiTlDisabled: {
			message: 'Hanami timeline has been disabled.',
			code: 'HanamiTL_DISABLED',
			id: 'e3abfb14-3ec0-442d-ae70-cac607ac8df8',
			httpStatusCode: 403,
		},
		commonNotReady: {
			message: 'Hanami common timeline is not ready.',
			code: 'HANAMI_COMMON_NOT_READY',
			id: 'bd0e3d7d-d488-4682-acf5-01d026d9f4c5',
			kind: 'server',
			httpStatusCode: 503,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	additionalProperties: false,
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(HANAMI_USER_FEED_REQUEST)
		private userFeedRequest: HanamiUserFeedRequestPort,
	) {
		super(meta, paramDef, async (ps, me) => {
			const result = await this.userFeedRequest.readHead(me.id);
			switch (result.kind) {
				case 'head': return {
					mode: result.head.mode,
					feedEpochId: result.head.feedEpochId,
					headBatchId: result.head.headBatchId,
					generationPending: result.generationPending,
				};
				case 'roleDisabled': throw new ApiError(meta.errors.hanamiTlDisabled);
				case 'commonNotReady': throw new ApiError(meta.errors.commonNotReady);
			}
		});
	}
}
