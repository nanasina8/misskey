/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { HanamiForYouBatchService, hanamiRelationDecayForUtcDay } from '@/core/hanami/HanamiForYouBatchService.js';

function serviceWith(db: Record<string, unknown>): HanamiForYouBatchService {
	const idService = { gen: (time?: number) => `id-${time ?? 0}` };
	return new HanamiForYouBatchService(db as never, {} as never, idService as never, {} as never);
}

describe('Hanami For You interaction daily rollup', () => {
	it('cleans durable served and seen retention by refreshed occurredAt', async () => {
		const db = { query: jest.fn(async (_sql: string, _parameters?: unknown[]) => []) };
		const service = serviceWith(db);

		await service.cleanupEvents();

		expect(db.query).toHaveBeenNthCalledWith(1,
			expect.stringContaining(`"eventType" IN ('served','seen') AND "occurredAt" < $1`),
			[expect.any(Date)],
		);
		expect(db.query.mock.calls[0]![0]).not.toContain('"createdAt" <');
	});

	it('uses UTC day buckets at the four relation decay boundaries', () => {
		const now = new Date('2026-07-19T15:30:00.000Z');
		expect(hanamiRelationDecayForUtcDay('2026-06-19', now)).toBe(0.9);
		expect(hanamiRelationDecayForUtcDay('2026-06-18', now)).toBe(0.65);
		expect(hanamiRelationDecayForUtcDay('2026-04-20', now)).toBe(0.65);
		expect(hanamiRelationDecayForUtcDay('2026-04-19', now)).toBe(0.45);
		expect(hanamiRelationDecayForUtcDay('2026-01-20', now)).toBe(0.45);
		expect(hanamiRelationDecayForUtcDay('2026-01-19', now)).toBe(0.28);
	});

	it('does a 240 UTC-day initial backfill and only seven days later the same day', async () => {
		const runnerQueries: { sql: string; params?: unknown[] }[] = [];
		const runner = {
			isTransactionActive: false,
			connect: jest.fn(),
			startTransaction: jest.fn(async function(this: { isTransactionActive: boolean }) { this.isTransactionActive = true; }),
			commitTransaction: jest.fn(async function(this: { isTransactionActive: boolean }) { this.isTransactionActive = false; }),
			rollbackTransaction: jest.fn(async function(this: { isTransactionActive: boolean }) { this.isTransactionActive = false; }),
			release: jest.fn(),
			query: jest.fn(async (sql: string, params?: unknown[]) => {
				runnerQueries.push({ sql, params });
				if (sql.includes('pg_try_advisory')) return [{ locked: true }];
				return [];
			}),
		};
		let stats = { c: 0, latest: null as Date | null };
		const db = {
			query: jest.fn(async (sql: string) => sql.includes('count(*)') ? [stats] : [{ ready: true }]),
			createQueryRunner: () => runner,
		};
		const service = serviceWith(db);
		const now = new Date('2026-01-15T12:00:00.000Z');

		expect(await service.refreshInteractionRollup(now)).toBe(true);
		const firstDelete = runnerQueries.find(q => q.sql.includes('DELETE FROM'))!;
		expect(firstDelete.params).toEqual([]);
		const firstInsert = runnerQueries.find(q => q.sql.includes('INSERT INTO'))!;
		expect(firstInsert.params).toHaveLength(241 * 3 + 1);

		runnerQueries.length = 0;
		stats = { c: 10, latest: new Date('2026-01-15T01:00:00.000Z') };
		expect(await service.refreshInteractionRollup(now)).toBe(true);
		const recentDelete = runnerQueries.find(q => q.sql.includes('DELETE FROM'))!;
		expect(recentDelete.params).toEqual(['2026-01-08']);
		const recentInsert = runnerQueries.find(q => q.sql.includes('INSERT INTO'))!;
		expect(recentInsert.params).toHaveLength(8 * 3 + 1);
	});

	it('falls back to the existing raw relation queries when the rollup is unavailable', async () => {
		const inserted: unknown[] = [];
		const db = {
			query: jest.fn(async (sql: string) => {
				if (sql.includes('hanami_foryou_interaction_daily')) throw new Error('relation does not exist');
				if (sql.includes('SELECT r."userId" AS me')) return [{ me: 'local', other: 'remote', w: '1' }];
				return [];
			}),
			transaction: jest.fn(async (callback: (em: { query: () => Promise<void>; insert: (_entity: unknown, rows: unknown[]) => Promise<void> }) => Promise<void>) => callback({
				query: async () => undefined,
				insert: async (_entity, rows) => { inserted.push(...rows); },
			})),
		};
		const service = serviceWith(db);

		expect(await service.runRelationBatch()).toBe(1);
		expect(inserted).toHaveLength(1);
		expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM note_reaction r'), expect.any(Array));
	});

	it('falls back to the raw reaction matrix for ALS when rollup preparation fails', async () => {
		const repository = {
			insert: jest.fn(),
			update: jest.fn(),
		};
		const db = {
			query: jest.fn(async (sql: string) => {
				if (sql.includes('hanami_foryou_interaction_daily')) throw new Error('relation does not exist');
				return [];
			}),
		};
		const service = new HanamiForYouBatchService(db as never, repository as never, { gen: () => 'run-id' } as never, {} as never);
		const logger = { warn: jest.fn() };

		expect(await service.runAlsBatch(logger as never)).toEqual({ runId: 'run-id', status: 'failed' });
		expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM note_reaction r'), expect.any(Array));
		expect(repository.update).toHaveBeenCalledWith({ id: 'run-id' }, expect.objectContaining({ status: 'failed' }));
	});
});
