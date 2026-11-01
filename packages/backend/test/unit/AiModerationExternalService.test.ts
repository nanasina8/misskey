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
	aiModerationExternalIncludeRemote: boolean;
} = {
	aiModerationExternalEnabled: true,
	aiModerationExternalApiKey: 'test-key',
	aiModerationExternalApiUrl: null,
	aiModerationExternalModel: null,
	aiModerationExternalVisibilities: ['public', 'home', 'followers'],
	aiModerationExternalIncludeRemote: false,
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

	describe('check', () => {
		const input = { visibility: 'public', isRemote: false, text: '本文', cw: null };

		test('CW・本文・アンケートの選択肢をまとめて送る（misskey-tempura と同じ形）', async () => {
			sendMock.mockResolvedValue(okResponse({ results: [{ flagged: false }] }));
			await makeService().check({ ...input, cw: '注意', pollChoices: ['A', 'B'] });
			expect(JSON.parse(sendMock.mock.calls[0][1].body).input).toBe('[CW] 注意\n\n本文\n\nPoll: A / B');
		});

		test('リモートの投稿は設定が無ければ送らず、理由を返す。includeRemote で上書きできる', async () => {
			sendMock.mockResolvedValue(okResponse({ results: [{ flagged: false }] }));
			const svc = makeService();
			await expect(svc.check({ ...input, isRemote: true })).resolves.toEqual({ status: 'skipped', reason: 'remote' });
			expect(sendMock).not.toHaveBeenCalled();
			await expect(svc.check({ ...input, isRemote: true }, { includeRemote: true })).resolves.toMatchObject({ status: 'ok' });
		});

		test('回数制限（429）とキーの誤り（401）はやり直す失敗、400 はやり直さない失敗', async () => {
			const { StatusError } = await import('@/misc/status-error.js');
			const svc = makeService();
			sendMock.mockRejectedValueOnce(new StatusError('429 Too Many Requests', 429, 'Too Many Requests'));
			await expect(svc.check(input)).resolves.toMatchObject({ status: 'error', httpStatus: 429, retryable: true });
			sendMock.mockRejectedValueOnce(new StatusError('401 Unauthorized', 401, 'Unauthorized'));
			await expect(svc.check(input)).resolves.toMatchObject({ status: 'error', httpStatus: 401, retryable: true });
			sendMock.mockRejectedValueOnce(new StatusError('400 Bad Request', 400, 'Bad Request'));
			await expect(svc.check(input)).resolves.toMatchObject({ status: 'error', httpStatus: 400, retryable: false });
		});
	});
});
