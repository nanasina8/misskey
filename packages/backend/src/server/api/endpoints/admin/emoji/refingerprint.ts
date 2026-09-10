/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, IsNull } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { EmojisRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { QueueService } from '@/core/QueueService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requiredRolePolicy: 'canManageCustomEmojis',
	kind: 'write:admin:emoji',

	errors: {
		noTarget: {
			message: 'Specify emojiIds, or scope, or host.',
			code: 'NO_TARGET',
			id: '4e0cf1c9-1f4e-4a4b-9d0a-0f2e4a2c9d31',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			/** 再照合の対象として印を消した件数。実際の算出はキューで非同期に行われる。 */
			reset: { type: 'integer', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		/** 個別に選んだ絵文字。ホスト単位より優先される。 */
		emojiIds: {
			type: 'array',
			items: { type: 'string', format: 'misskey:id' },
			minItems: 1,
			maxItems: 100,
		},
		/**
		 * 'local' はローカル絵文字全件。自ホストのストレージしか読まないので一括で安全。
		 * リモートを一括で洗い直す指定は用意しない（他インスタンスを一斉に叩くことになるため）。
		 */
		scope: { type: 'string', enum: ['local'] },
		/** 特定ホストのリモート絵文字。相手サーバーへの負荷がホスト単位に収まる。 */
		host: { type: 'string' },
		/** ホスト指定時に、失敗したものだけに絞るか。既定は指紋が無いもの全部。 */
		onlyFailed: { type: 'boolean', default: false },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,
		private queueService: QueueService,
		private utilityService: UtilityService,
	) {
		super(meta, paramDef, async (ps) => {
			// 指紋そのものは消さない。消すと算出し直すまでの間だけ照合できない絵文字が生まれる。
			// 印(attemptedAt / errorCode)だけを外して、バックフィルの対象に戻す。
			const cleared = { imageFingerprintAttemptedAt: null, imageFingerprintErrorCode: null };

			if (ps.emojiIds != null) {
				const emojis = await this.emojisRepository.findBy({ id: In(ps.emojiIds) });
				if (emojis.length === 0) return { reset: 0 };

				await this.emojisRepository.update({ id: In(emojis.map(x => x.id)) }, cleared);
				for (const emoji of emojis) {
					await this.queueService.createEmojiImageFingerprintJob({
						emojiId: emoji.id, sourceUrl: emoji.publicUrl, host: emoji.host,
					});
				}
				return { reset: emojis.length };
			}

			if (ps.scope === 'local') {
				const result = await this.emojisRepository.update({ host: IsNull() }, cleared);
				// 件数が多いので個別にジョブを積まず、ローカル限定のバックフィルに拾わせる。
				await this.queueService.createEmojiImageFingerprintBackfillJob({ scope: 'local' });
				return { reset: result.affected ?? 0 };
			}

			if (ps.host != null) {
				const host = this.utilityService.toPuny(ps.host);
				const result = ps.onlyFailed
					? await this.emojisRepository.createQueryBuilder().update()
						.set(cleared)
						.where('"host" = :host', { host })
						.andWhere('"imageFingerprint" IS NULL')
						.andWhere('"imageFingerprintAttemptedAt" IS NOT NULL')
						.execute()
					: await this.emojisRepository.createQueryBuilder().update()
						.set(cleared)
						.where('"host" = :host', { host })
						.andWhere('"imageFingerprint" IS NULL')
						.execute();
				// ホスト限定のバックフィルに拾わせる。全体走査(19万件規模)の順番待ちにしない。
				await this.queueService.createEmojiImageFingerprintBackfillJob({ scope: 'all', host });
				return { reset: result.affected ?? 0 };
			}

			throw new ApiError(meta.errors.noTarget);
		});
	}
}
