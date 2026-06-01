/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';

// フロントが「実際に表示確認した」おすすめノートを seen として記録する（長TTL側の既出除外）。
// served（返した時点・短TTL）に対し、seen は本当に見られたものだけを長く抑制する（仕様5の2段階）。
export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			ok: { type: 'boolean', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteIds: {
			type: 'array',
			items: { type: 'string', format: 'misskey:id' },
			maxItems: 100,
		},
	},
	required: ['noteIds'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiRecommendationService: HanamiRecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.hanamiRecommendationService.recordSeen(me.id, ps.noteIds);
			return { ok: true };
		});
	}
}
