/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';

// taste-clustered popular（spec v0.2 §3）: クラスタ単位の「減らす/表示しない」操作。
export const meta = {
	tags: ['account'],

	requireCredential: true,
	kind: 'write:account',

	errors: {
		noSuchCluster: {
			message: 'No such taste cluster.',
			code: 'NO_SUCH_TASTE_CLUSTER',
			id: 'f1f8a6b2-4c1e-4f6b-9a2d-3c0e51a7b901',
		},
	},

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
		clusterId: { type: 'integer', minimum: 0 },
		weight: { type: 'string', enum: ['normal', 'reduce', 'hide'] },
	},
	required: ['clusterId', 'weight'],
} as const;

const WEIGHT_VALUE = { normal: 1, reduce: 0.3, hide: 0 } as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db)
		private db: DataSource,
	) {
		super(meta, paramDef, async (ps, me) => {
			const result = await this.db.query(
				`UPDATE "hanami_foryou_user_taste_cluster" SET "userWeight" = $1, "updatedAt" = now()
				 WHERE "userId" = $2 AND "clusterId" = $3`,
				[WEIGHT_VALUE[ps.weight], me.id, ps.clusterId],
			) as unknown as [unknown, number];
			if (result[1] === 0) throw new ApiError(meta.errors.noSuchCluster);
			return { ok: true };
		});
	}
}
