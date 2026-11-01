/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationCriteriaRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { AiModerationCriteriaService } from '@/core/AiModerationCriteriaService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	description: 'AI 投稿チェックの判定条件の版（モデル・判定スクリプトのハッシュ・閾値・目印の点数）を新しい順に返す。current はいまの版。',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			current: { type: 'string', optional: false, nullable: false },
			versions: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						version: { type: 'string', optional: false, nullable: false },
						firstUsedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
						criteria: { type: 'object', optional: false, nullable: false },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationCriteriaRepository)
		private aiModerationCriteriaRepository: AiModerationCriteriaRepository,

		private aiModerationCriteriaService: AiModerationCriteriaService,
	) {
		super(meta, paramDef, async (ps) => {
			const { version } = await this.aiModerationCriteriaService.current();
			const rows = await this.aiModerationCriteriaRepository.find({ order: { firstUsedAt: 'DESC' }, take: ps.limit });
			return {
				current: version,
				versions: rows.map(r => ({ version: r.id, firstUsedAt: r.firstUsedAt.toISOString(), criteria: r.criteria })),
			};
		});
	}
}
