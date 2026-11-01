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
	requireAdmin: true,
	secure: true,
	kind: 'write:admin:ai-moderation',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			canceled: { type: 'boolean', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		scanId: { type: 'string', format: 'misskey:id' },
	},
	required: ['scanId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private aiModerationScanService: AiModerationScanService,
	) {
		super(meta, paramDef, async (ps, me) => {
			return { canceled: await this.aiModerationScanService.cancel(ps.scanId, me) };
		});
	}
}
