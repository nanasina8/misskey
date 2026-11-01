/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/_.js';
import { AiModerationService } from '@/core/AiModerationService.js';
import { AiModerationExternalService } from '@/core/AiModerationExternalService.js';
import { decideAiModerationFlag, type AiModerationScores } from '@/misc/ai-moderation.js';
import { probeHanamiNoteJudgeRuntime } from '@/core/hanami/HanamiPythonRuntime.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	errors: {
		llmBusy: {
			message: 'AI moderation local LLM is busy. Retry this trial shortly.',
			code: 'AI_MODERATION_LLM_BUSY',
			id: '7c3e2f1a-4d5b-4e6a-8b9c-0d1e2f3a4b5c',
			kind: 'server',
			httpStatusCode: 503,
		},
		runtimeUnavailable: {
			message: 'AI moderation judge runtime is unavailable (no GPU).',
			code: 'AI_MODERATION_JUDGE_RUNTIME_UNAVAILABLE',
			id: '6b2d1e0c-3a4f-4b5a-9c8d-1e2f3a4b5c6d',
			kind: 'server',
			httpStatusCode: 503,
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			scores: {
				type: 'object',
				optional: false, nullable: true,
				properties: {
					normal: { type: 'number', optional: false, nullable: false },
					spam: { type: 'number', optional: false, nullable: false },
					scam: { type: 'number', optional: false, nullable: false },
					abuse: { type: 'number', optional: false, nullable: false },
				},
			},
			localLabel: {
				type: 'string',
				optional: false, nullable: true,
			},
			externalFlagged: {
				type: 'boolean',
				optional: false, nullable: true,
			},
			externalCategories: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'string',
					optional: false, nullable: false,
				},
			},
			externalScores: {
				type: 'object',
				optional: false, nullable: true,
				additionalProperties: {
					type: 'number',
				},
			},
			externalModel: {
				type: 'string',
				optional: false, nullable: true,
			},
			flagged: {
				type: 'boolean',
				optional: false, nullable: false,
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		text: { type: 'string' },
	},
	required: ['text'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		@Inject(DI.meta)
		private serverSettings: MiMeta,

		private aiModerationService: AiModerationService,
		private aiModerationExternalService: AiModerationExternalService,
	) {
		super(meta, paramDef, async (ps) => {
			const runtime = await probeHanamiNoteJudgeRuntime();
			if (!runtime.available) {
				throw new ApiError(meta.errors.runtimeUnavailable);
			}

			// 常駐の判定係の順番待ちに、いちばん高い優先度で入れて結果を待つ（最大60秒）
			const scores: AiModerationScores | null = await this.aiModerationService.judgeTrialText(ps.text);
			if (scores == null) {
				throw new ApiError(meta.errors.llmBusy);
			}

			// 試行は公開投稿相当として外部 API の公開範囲設定を尊重する。
			const external = await this.aiModerationExternalService.moderate('public', ps.text);

			const { flagged, localLabel } = decideAiModerationFlag(
				scores,
				external?.flagged ?? null,
				this.serverSettings.aiModerationLocalThreshold,
			);

			return {
				scores,
				localLabel,
				externalFlagged: external?.flagged ?? null,
				externalCategories: external?.categories ?? [],
				externalScores: external?.scores ?? null,
				externalModel: external?.model ?? null,
				flagged,
			};
		});
	}
}
