/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { MiMeta } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';

export const DEFAULT_AI_MODERATION_EXTERNAL_API_URL = 'https://api.openai.com/v1/moderations';
export const DEFAULT_AI_MODERATION_EXTERNAL_MODEL = 'omni-moderation-latest';

export type AiModerationExternalResult = {
	flagged: boolean;
	categories: string[];
	scores: Record<string, number>;
	model: string;
};

/**
 * 外部 moderations API（OpenAI 互換）への送信。DM（specified）は既定で送らない。
 * 送らなかった・失敗した場合は null を返し、例外を外に出さない。
 */
@Injectable()
export class AiModerationExternalService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		private httpRequestService: HttpRequestService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('ai-moderation-external');
	}

	@bindThis
	public async moderate(visibility: string, text: string | null): Promise<AiModerationExternalResult | null> {
		if (!this.meta.aiModerationExternalEnabled) return null;
		if (!this.meta.aiModerationExternalApiKey) return null;

		const visibilities = this.meta.aiModerationExternalVisibilities ?? [];
		if (!visibilities.includes(visibility)) return null;

		const content = this.buildInputText(text);
		if (!content) return null;

		const model = this.meta.aiModerationExternalModel ?? DEFAULT_AI_MODERATION_EXTERNAL_MODEL;
		const apiUrl = this.meta.aiModerationExternalApiUrl ?? DEFAULT_AI_MODERATION_EXTERNAL_API_URL;
		// カスタムURL設定時のみローカルアドレスを許可
		const isLocalAddressAllowed = this.meta.aiModerationExternalApiUrl != null;

		try {
			const response = await this.httpRequestService.send(apiUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.meta.aiModerationExternalApiKey}`,
				},
				body: JSON.stringify({
					model,
					input: content,
				}),
				timeout: 30000,
				isLocalAddressAllowed,
			}, {
				throwErrorWhenResponseNotOk: true,
			});

			const data = await response.json() as {
				id?: string;
				model?: string;
				results?: Array<{
					flagged?: boolean;
					categories?: Record<string, boolean>;
					category_scores?: Record<string, number>;
				}>;
			};

			const result = data.results?.[0];
			const categories = result?.categories ?? {};
			const flaggedCategories = Object.entries(categories)
				.filter(([, value]) => value)
				.map(([key]) => key);

			return {
				flagged: result?.flagged === true,
				categories: flaggedCategories,
				scores: result?.category_scores ?? {},
				model: data.model ?? model,
			};
		} catch (err) {
			this.logger.error('AI moderation external request failed', { err });
			return null;
		}
	}

	private buildInputText(text: string | null): string | null {
		if (text == null) return null;
		const trimmed = text.trim();
		if (trimmed.length === 0) return null;
		return trimmed.slice(0, 8000);
	}
}
