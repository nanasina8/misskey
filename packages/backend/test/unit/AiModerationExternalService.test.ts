/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { MiMeta } from '@/models/_.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import type { LoggerService } from '@/core/LoggerService.js';
import { AiModerationExternalService } from '@/core/AiModerationExternalService.js';

const sendMock = vi.fn();

const DEFAULT_META: {
	aiModerationExternalEnabled: boolean;
	aiModerationExternalApiKey: string | null;
	aiModerationExternalApiUrl: string | null;
	aiModerationExternalModel: string | null;
	aiModerationExternalVisibilities: string[];
} = {
	aiModerationExternalEnabled: true,
	aiModerationExternalApiKey: 'test-key',
	aiModerationExternalApiUrl: null,
	aiModerationExternalModel: null,
	aiModerationExternalVisibilities: ['public', 'home', 'followers'],
};

function makeService(metaOverrides: Partial<typeof DEFAULT_META> = {}): AiModerationExternalService {
	const meta = { ...DEFAULT_META, ...metaOverrides } as unknown as MiMeta;
	const httpRequestService = { send: sendMock } as unknown as HttpRequestService;
	const loggerService = {
		getLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
	} as unknown as LoggerService;
	return new AiModerationExternalService(meta, httpRequestService, loggerService);
}

function okResponse(data: unknown) {
	return {
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => data,
	};
}

describe('AiModerationExternalService', () => {
	beforeEach(() => {
		sendMock.mockReset();
	});

	describe('moderate', () => {
		test('フラグされた場合は flagged とカテゴリと点数を取り出す', async () => {
			sendMock.mockResolvedValue(okResponse({
				id: 'mod-1',
				model: 'omni-moderation-latest',
				results: [{
					flagged: true,
					categories: { harassment: true, violence: false },
					category_scores: { harassment: 0.9 },
				}],
			}));

			const svc = makeService();
			const result = await svc.moderate('public', 'hello');

			expect(sendMock).toHaveBeenCalledTimes(1);
			expect(result).not.toBeNull();
			expect(result!.flagged).toBe(true);
			expect(result!.categories).toEqual(['harassment']);
			expect(result!.scores).toEqual({ harassment: 0.9 });
			expect(result!.model).toBe('omni-moderation-latest');
		});

		test('フラグされていない場合も flagged=false を返す', async () => {
			sendMock.mockResolvedValue(okResponse({
				model: 'omni-moderation-latest',
				results: [{ flagged: false, categories: {}, category_scores: {} }],
			}));

			const svc = makeService();
			const result = await svc.moderate('public', 'hello');

			expect(result).not.toBeNull();
			expect(result!.flagged).toBe(false);
		});

		test('公開範囲が設定に含まれない投稿は送らない', async () => {
			const svc = makeService();
			const result = await svc.moderate('specified', 'hello');

			expect(sendMock).not.toHaveBeenCalled();
			expect(result).toBeNull();
		});

		test('API キー無しでは送らない', async () => {
			const svc = makeService({ aiModerationExternalApiKey: null });
			const result = await svc.moderate('public', 'hello');

			expect(sendMock).not.toHaveBeenCalled();
			expect(result).toBeNull();
		});

		test('機能が無効なら送らない', async () => {
			const svc = makeService({ aiModerationExternalEnabled: false });
			const result = await svc.moderate('public', 'hello');

			expect(sendMock).not.toHaveBeenCalled();
			expect(result).toBeNull();
		});

		test('HTTP 失敗では例外を外に出さず null を返す', async () => {
			sendMock.mockRejectedValue(new Error('network down'));

			const svc = makeService();
			await expect(svc.moderate('public', 'hello')).resolves.toBeNull();
		});

		test('カスタム API URL の場合のみローカルアドレスを許可する', async () => {
			sendMock.mockResolvedValue(okResponse({ results: [{ flagged: false }] }));

			await makeService().moderate('public', 'hello');
			expect(sendMock.mock.calls[0][1].isLocalAddressAllowed).toBe(false);

			await makeService({ aiModerationExternalApiUrl: 'http://localhost:3009' }).moderate('public', 'hello');
			expect(sendMock.mock.calls[1][1].isLocalAddressAllowed).toBe(true);
		});
	});
});
