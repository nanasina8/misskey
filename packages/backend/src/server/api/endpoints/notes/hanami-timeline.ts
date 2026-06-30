/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// はなみTL = For You-only ページ（canonical spec §1/§9）。ホームTLは混ぜない（home は notes/timeline の責務）。
// 6軸＋quota interleave。sinceId/sinceDate は空配列（For You は時系列でない＝§9/§14-D4。上から引っ張る追加挿入は stream channel が担う）。
// untilId は互換入力（次ページ要求トリガ）としてのみ扱い、重複排除は served/seen で行う。

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RoleService } from '@/core/RoleService.js';
import { HanamiForYouService } from '@/core/hanami/HanamiForYouService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		HanamiTlDisabled: {
			message: 'Hanami timeline has been disabled.',
			code: 'HanamiTL_DISABLED',
			id: 'ffa57e0f-d14e-48d6-a64c-8fbcba5635ab',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		// sinceId/sinceDate: For You は時系列でないため受けても空配列を返す（§9/§14-D4）。
		sinceId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		// untilId/untilDate: 互換入力（次ページ要求トリガ）。重複排除は served/seen。
		untilId: { type: 'string', format: 'misskey:id' },
		untilDate: { type: 'integer' },
		allowPartial: { type: 'boolean', default: false },
		withFiles: { type: 'boolean', default: false },
		withRenotes: { type: 'boolean', default: true },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private roleService: RoleService,
		private hanamiForYouService: HanamiForYouService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.hanamiTlAvailable) {
				throw new ApiError(meta.errors.HanamiTlDisabled);
			}

			// For You は時系列でない。「より新しい」ページは無い（§9/§14-D4）。
			// 上から引っ張る(pull-to-refresh)時の追加挿入は For You stream channel が担う。
			if (ps.sinceId != null || ps.sinceDate != null) return [];

			return this.hanamiForYouService.getForYouPage(me, {
				limit: ps.limit,
				withFiles: ps.withFiles,
			});
		});
	}
}
