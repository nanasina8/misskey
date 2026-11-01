/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:ai-moderation',

	description: '全体スキャンを始める前の見積もり（対象の投稿数・判定に回る件数・かかる時間）。',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			notes: { type: 'number', optional: false, nullable: false },
			sampled: { type: 'number', optional: false, nullable: false },
			sampledCandidates: { type: 'number', optional: false, nullable: false },
			candidates: { type: 'number', optional: false, nullable: false },
			secondsPerPost: { type: 'number', optional: false, nullable: false },
			batchSize: { type: 'number', optional: false, nullable: false },
			postsPerHour: { type: 'number', optional: false, nullable: false },
			estimatedSeconds: { type: 'number', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		mode: { type: 'string', enum: ['filtered', 'all'], default: 'filtered' },
		target: { type: 'string', enum: ['all', 'local', 'remote'], default: 'all' },
		days: { type: 'integer', minimum: 1, maximum: 3650, nullable: true, default: null },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private aiModerationScanService: AiModerationScanService,
	) {
		super(meta, paramDef, async (ps) => {
			return await this.aiModerationScanService.estimate({ mode: ps.mode, target: ps.target, days: ps.days ?? null });
		});
	}
}
