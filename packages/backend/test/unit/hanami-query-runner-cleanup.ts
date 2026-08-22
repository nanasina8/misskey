/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { HanamiUserFeedGenerationService } from '@/core/hanami/HanamiUserFeedGenerationService.js';
import { HanamiUserFeedRequestService } from '@/core/hanami/HanamiUserFeedRequestService.js';

type TransactionHarness = {
	withTransaction<T>(callback: () => Promise<T>): Promise<T>;
};

function queryRunner() {
	const runner = {
		isTransactionActive: false,
		connect: jest.fn(async () => undefined),
		startTransaction: jest.fn(async () => {
			runner.isTransactionActive = true;
		}),
		commitTransaction: jest.fn(async () => {
			runner.isTransactionActive = false;
		}),
		rollbackTransaction: jest.fn(async () => {
			runner.isTransactionActive = false;
		}),
		release: jest.fn(async () => undefined),
	};
	return runner;
}

function services(runner: ReturnType<typeof queryRunner>): TransactionHarness[] {
	const db = { createQueryRunner: () => runner };
	const request = new HanamiUserFeedRequestService(
		db as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ getLogger: () => ({ warn: jest.fn() }) } as never,
		{} as never,
	);
	const provenance = new HanamiForYouProvenanceService(
		{ manager: { connection: db } } as never,
		{} as never,
		{} as never,
		{} as never,
	);
	const generation = new HanamiUserFeedGenerationService(db as never, {} as never, {} as never, {} as never);
	return [request, provenance, generation] as unknown as TransactionHarness[];
}

describe('Hanami QueryRunner cleanup', () => {
	test.each([
		{ name: 'request', index: 0 },
		{ name: 'provenance', index: 1 },
		{ name: 'generation', index: 2 },
	])('releases a connected runner when $name BEGIN fails', async ({ index }) => {
		const runner = queryRunner();
		const error = new Error('BEGIN failed');
		runner.startTransaction.mockRejectedValueOnce(error as never);

		await expect(services(runner)[index]!.withTransaction(async () => undefined)).rejects.toBe(error);

		expect(runner.rollbackTransaction).not.toHaveBeenCalled();
		expect(runner.release).toHaveBeenCalledTimes(1);
	});

	test.each([
		{ name: 'request', index: 0 },
		{ name: 'provenance', index: 1 },
		{ name: 'generation', index: 2 },
	])('rolls back and releases $name after callback failure', async ({ index }) => {
		const runner = queryRunner();
		const error = new Error('callback failed');

		await expect(services(runner)[index]!.withTransaction(async () => {
			throw error;
		})).rejects.toBe(error);

		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);
	});
});
