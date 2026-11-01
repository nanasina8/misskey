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
import { StatusError } from '@/misc/status-error.js';

export const DEFAULT_AI_MODERATION_EXTERNAL_API_URL = 'https://api.openai.com/v1/moderations';
export const DEFAULT_AI_MODERATION_EXTERNAL_MODEL = 'omni-moderation-latest';

export type AiModerationExternalResult = {
	flagged: boolean;
	categories: string[];
	scores: Record<string, number>;
	model: string;
};

export type AiModerationExternalInput = {
	visibility: string;
	/** リモートの投稿か（設定でリモートを送らないときは送らない） */
	isRemote: boolean;
	text: string | null;
	cw: string | null;
	pollChoices?: readonly string[] | null;
};

/** 送った結果。送らなかった理由と、失敗の HTTP 状態（回数制限なら後でやり直す）を分けて返す */
export type AiModerationExternalOutcome =
	| { status: 'ok'; result: AiModerationExternalResult }
	| { status: 'skipped'; reason: 'off' | 'noKey' | 'visibility' | 'remote' | 'empty' }
	| { status: 'error'; httpStatus: number | null; retryable: boolean; message: string };

/**
 * 外部 moderations API（OpenAI 互換）への送信。misskey-tempura と同じく CW・本文・アンケートの選択肢をまとめて送る。
 * DM（specified）は既定で送らない。リモートの投稿は設定（aiModerationExternalIncludeRemote）でだけ送る。
 * 例外は外に出さない。
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

	/** 使える設定か（有効・キーあり） */
	@bindThis
	public isConfigured(): boolean {
		return this.meta.aiModerationExternalEnabled && this.meta.aiModerationExternalApiKey != null && this.meta.aiModerationExternalApiKey !== '';
	}

	/** 送るかどうかだけを見る（送る前に件数を数えたいとき用）。送るなら null */
	@bindThis
	public skipReason(input: Pick<AiModerationExternalInput, 'visibility' | 'isRemote'>, options: { includeRemote?: boolean } = {}): 'off' | 'noKey' | 'visibility' | 'remote' | null {
		if (!this.meta.aiModerationExternalEnabled) return 'off';
		if (!this.meta.aiModerationExternalApiKey) return 'noKey';
		const visibilities = this.meta.aiModerationExternalVisibilities ?? [];
		if (!visibilities.includes(input.visibility)) return 'visibility';
		const includeRemote = options.includeRemote ?? this.meta.aiModerationExternalIncludeRemote;
		if (input.isRemote && !includeRemote) return 'remote';
		return null;
	}

	/**
	 * 1件送る。options.includeRemote で設定のリモート可否を上書きできる（全体スキャンは管理者が明示して使うので常に送る）。
	 */
	@bindThis
	public async check(input: AiModerationExternalInput, options: { includeRemote?: boolean } = {}): Promise<AiModerationExternalOutcome> {
		const reason = this.skipReason(input, options);
		if (reason != null) return { status: 'skipped', reason };

		const content = buildAiModerationExternalInput(input.text, input.cw, input.pollChoices ?? null);
		if (content == null) return { status: 'skipped', reason: 'empty' };

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
				status: 'ok',
				result: {
					flagged: result?.flagged === true,
					categories: flaggedCategories,
					scores: result?.category_scores ?? {},
					model: data.model ?? model,
				},
			};
		} catch (err) {
			this.logger.error('AI moderation external request failed', { err });
			if (err instanceof StatusError) {
				return { status: 'error', httpStatus: err.statusCode, retryable: err.isRetryable || err.statusCode === 401 || err.statusCode === 403, message: `${err.statusCode} ${err.statusMessage ?? err.message}`.slice(0, 500) };
			}
			return { status: 'error', httpStatus: null, retryable: true, message: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
		}
	}

	/** 互換用（試す画面）。送らなかった・失敗したときは null */
	@bindThis
	public async moderate(visibility: string, text: string | null): Promise<AiModerationExternalResult | null> {
		const outcome = await this.check({ visibility, isRemote: false, text, cw: null });
		return outcome.status === 'ok' ? outcome.result : null;
	}
}

/** 送る文。CW・本文・アンケートの選択肢をまとめ、8000文字で切る（misskey-tempura と同じ形） */
export function buildAiModerationExternalInput(text: string | null, cw: string | null, pollChoices: readonly string[] | null): string | null {
	const parts: string[] = [];
	if (cw != null && cw.trim().length > 0) parts.push(`[CW] ${cw.trim()}`);
	if (text != null && text.trim().length > 0) parts.push(text.trim());
	if (pollChoices != null && pollChoices.length > 0) parts.push(`Poll: ${pollChoices.join(' / ')}`);
	const joined = parts.join('\n\n').trim();
	if (joined.length === 0) return null;
	return joined.slice(0, 8000);
}
