/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiTasteClusterBatchService } from '@/core/hanami/HanamiTasteClusterBatchService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:queue',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			state: { type: 'string', optional: false, nullable: false, enum: ['idle', 'running', 'done', 'error'] },
			phase: { type: 'string', optional: false, nullable: true, enum: ['embeddings', 'evidence'] },
			reembedded: { type: 'number', optional: false, nullable: false },
			purged: { type: 'number', optional: false, nullable: false },
			evidenceUpdated: { type: 'number', optional: false, nullable: false },
			evidencePurged: { type: 'number', optional: false, nullable: false },
			startedAt: { type: 'number', optional: false, nullable: true },
			updatedAt: { type: 'number', optional: false, nullable: true },
			error: { type: 'string', optional: false, nullable: true },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiTasteClusterBatchService: HanamiTasteClusterBatchService,
	) {
		super(meta, paramDef, async () => {
			return await this.hanamiTasteClusterBatchService.getTasteRebuildStatus();
		});
	}
}
