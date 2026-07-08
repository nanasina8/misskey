/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { QueueService } from '@/core/QueueService.js';
import { HanamiTasteClusterBatchService, HanamiTasteRebuildAlreadyRunningError } from '@/core/hanami/HanamiTasteClusterBatchService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'write:admin:queue',

	errors: {
		alreadyRunning: {
			message: 'Hanami taste rebuild is already running.',
			code: 'HANAMI_TASTE_REBUILD_ALREADY_RUNNING',
			id: '6841be52-573f-4f09-b5e0-e18a9a6a69d1',
		},
	},

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
	properties: {
		force: { type: 'boolean', default: false },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private queueService: QueueService,
		private hanamiTasteClusterBatchService: HanamiTasteClusterBatchService,
	) {
		super(meta, paramDef, async (ps) => {
			try {
				const data = await this.hanamiTasteClusterBatchService.startTasteRebuild(ps.force ?? false);
				await this.queueService.enqueueHanamiTasteRebuild(data);
				return await this.hanamiTasteClusterBatchService.getTasteRebuildStatus();
			} catch (err) {
				if (err instanceof HanamiTasteRebuildAlreadyRunningError) throw new ApiError(meta.errors.alreadyRunning);
				throw err;
			}
		});
	}
}
