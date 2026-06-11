/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiRecommendationService } from '@/core/HanamiRecommendationService.js';

// フロントが「実際に表示確認した」ノートを記録する。
// kind=rec: おすすめノートの seen（served の長TTL側・仕様5の2段階）。
// kind=home: はなみTLに表示されたホーム由来ノート（catchup軸の「見逃し」判定と一般の再推薦除外に使う）。
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
		kind: { type: 'string', enum: ['rec', 'home'], default: 'rec' },
	},
	required: ['noteIds'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiRecommendationService: HanamiRecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (ps.kind === 'home') {
				await this.hanamiRecommendationService.recordHomeSeen(me.id, ps.noteIds);
			} else {
				await this.hanamiRecommendationService.recordSeen(me.id, ps.noteIds);
			}
			return { ok: true };
		});
	}
}
