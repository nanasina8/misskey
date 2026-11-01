/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { AiModerationScanAlreadyRunningError, AiModerationScanService } from '@/core/AiModerationScanService.js';
import { packedAiModerationScanSchema } from '@/models/json-schema/ai-moderation-scan.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	secure: true,
	kind: 'write:admin:ai-moderation',

	description: '既にある投稿を古い順に判定する全体スキャンを始める。結果は参考用で、隠す・通知はしない。',

	res: packedAiModerationScanSchema,

	errors: {
		alreadyRunning: {
			message: 'A scan is already running.',
			code: 'ALREADY_RUNNING',
			id: '0b55c40c-a700-45f8-b1cb-bf060288dcd8',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		mode: { type: 'string', enum: ['filtered', 'all'], default: 'filtered' },
		target: { type: 'string', enum: ['all', 'local', 'remote'], default: 'all' },
		days: { type: 'integer', minimum: 1, maximum: 3650, nullable: true, default: null },
		maxJudged: { type: 'integer', minimum: 1, maximum: 10000000, nullable: true, default: 5000, description: '判定する上限。null なら上限なし（終わりまで）' },
		useExternal: { type: 'boolean', default: false, description: '判定した投稿を外部 API（OpenAI 互換の moderations）にも送る。DM は送らない。リモートの投稿も送る' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private aiModerationScanService: AiModerationScanService,
	) {
		super(meta, paramDef, async (ps, me) => {
			try {
				const scan = await this.aiModerationScanService.start({
					mode: ps.mode,
					target: ps.target,
					days: ps.days ?? null,
					maxJudged: ps.maxJudged ?? null,
					useExternal: ps.useExternal,
				}, me);
				return await this.aiModerationScanService.packScan(scan);
			} catch (err) {
				if (err instanceof AiModerationScanAlreadyRunningError) throw new ApiError(meta.errors.alreadyRunning);
				throw err;
			}
		});
	}
}
