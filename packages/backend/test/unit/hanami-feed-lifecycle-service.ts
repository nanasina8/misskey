/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { HanamiFeedLifecycleService } from '@/core/hanami/HanamiFeedLifecycleService.js';

const transitionedAt = new Date('2026-08-20T12:34:56.000Z');

type QueryCall = {
	sql: string;
	values: unknown[];
};

type RuntimeOptions = {
	hasState?: boolean;
	hasActiveEpoch?: boolean;
	activeWork?: boolean;
	policyAvailable?: boolean;
	profileEnabled?: boolean;
	profileMissing?: boolean;
	common?: 'ready' | 'empty' | 'notReady' | 'missing';
	stateRows?: Array<{ user_id: string; epoch_id: string }>;
};

const compactSql = (sql: string): string => sql.replaceAll(/\s+/g, ' ').trim();

const makeRuntime = (options: RuntimeOptions = {}) => {
	const calls: QueryCall[] = [];
	const events: string[] = [];
	const hasState = options.hasState ?? true;
	const activeWork = options.activeWork ?? false;
	const stateRows = options.stateRows ?? [{ user_id: 'user-1', epoch_id: 'epoch-old' }];
	const query = jest.fn(async (sql: string, values: unknown[] = []): Promise<unknown[]> => {
		const normalized = compactSql(sql);
		calls.push({ sql: normalized, values });

		if (normalized.startsWith('SELECT s."userId" AS user_id, s."epochId" AS epoch_id FROM "hanami_user_feed_state" s')) {
			return hasState ? stateRows : [];
		}
		if (normalized.startsWith('SELECT e."userId" AS user_id')) return options.hasActiveEpoch === false ? [] : stateRows;
		if (normalized.startsWith('SELECT b."id" AS id')) return activeWork ? [{ id: 'batch-active' }] : [];
		if (normalized.startsWith('SELECT r."userId" AS user_id')) return activeWork ? [{ user_id: 'user-1' }] : [];
		if (normalized.startsWith('UPDATE "hanami_user_feed_batch" b')) return activeWork ? [{ id: 'batch-active' }] : [];
		if (normalized.startsWith('UPDATE "hanami_user_feed_refresh" r')) return activeWork ? [{ user_id: 'user-1' }] : [];
		if (normalized.startsWith('SELECT p."hanamiRecommendationEnabled" AS enabled')) {
			events.push('profile');
			return options.profileMissing === true ? [] : [{ enabled: options.profileEnabled ?? true }];
		}
		if (normalized.startsWith('SELECT s."epochId" AS epoch_id, s."latestReadyGenerationId" AS generation_id')) {
			if (options.common === 'missing') return [];
			if (options.common === 'empty') return [{ epoch_id: null, generation_id: null, head_sequence: '0' }];
			return [{
				epoch_id: 'common-epoch',
				generation_id: 'common-generation',
				head_sequence: '9007199254740993',
			}];
		}
		if (normalized.startsWith('SELECT g."id" AS id, g."status" AS status')) {
			return [{ id: 'common-generation', status: options.common === 'notReady' ? 'generating' : 'ready' }];
		}
		if (normalized.startsWith('UPDATE "hanami_user_feed_epoch"')) return [{ epoch_id: 'epoch-old' }];
		if (normalized.startsWith('UPDATE "hanami_user_feed_state"') && normalized.includes('RETURNING "userId"')) {
			return [{ user_id: 'user-1' }];
		}
		if (normalized.startsWith('UPDATE "hanami_user_feed_state" s') && normalized.includes('RETURNING s."userId"')) return stateRows;
		return [];
	});
	const manager = {
		query,
		transaction: jest.fn(() => {
			throw new Error('lifecycle service must not own a transaction');
		}),
		getRepository: jest.fn(() => {
			throw new Error('lifecycle service must not use repositories');
		}),
	};
	const idService = {
		gen: jest.fn(() => 'epoch-new'),
	};
	const roleService = {
		getUserPolicies: jest.fn(async (_userId: string, policyManager: unknown) => {
			expect(policyManager).toBe(manager);
			events.push('policy');
			return { hanamiTlAvailable: options.policyAvailable ?? true };
		}),
	};
	const service = new HanamiFeedLifecycleService(idService as never, roleService as never);

	return { calls, events, idService, manager, query, roleService, service };
};

describe('HanamiFeedLifecycleService', () => {
	test('hibernation deduplicates users and follows the frozen manager-only lock order', async () => {
		const runtime = makeRuntime({
			activeWork: true,
			common: 'ready',
			stateRows: [
				{ user_id: 'user-a', epoch_id: 'epoch-a' },
				{ user_id: 'user-z', epoch_id: 'epoch-z' },
			],
		});

		await runtime.service.hibernateUsers(runtime.manager as never, [], transitionedAt);
		expect(runtime.query).not.toHaveBeenCalled();

		await runtime.service.hibernateUsers(runtime.manager as never, ['user-z', 'user-a', 'user-z'], transitionedAt);

		expect(runtime.calls.at(0)?.values).toEqual([['user-a', 'user-z']]);
		expect(runtime.calls.map((call) => call.sql)).toEqual([
			expect.stringMatching(/FROM "hanami_user_feed_state" s .*ORDER BY s\."userId" ASC .*FOR UPDATE OF s/),
			expect.stringMatching(/FROM "hanami_user_feed_epoch" e .*ORDER BY e\."userId" ASC, e\."epochId" ASC .*FOR UPDATE OF e/),
			expect.stringMatching(/SELECT b\."id" AS id .*ORDER BY b\."userId" ASC, b\."id" ASC .*FOR UPDATE OF b/),
			expect.stringMatching(/^UPDATE "hanami_user_feed_batch" b /),
			expect.stringMatching(/SELECT r\."userId" AS user_id .*ORDER BY r\."userId" ASC, r\."epochId" ASC, r\."refreshTokenDigest" ASC .*FOR UPDATE OF r/),
			expect.stringMatching(/^UPDATE "hanami_user_feed_refresh" r /),
			expect.stringMatching(/FROM "hanami_common_feed_state" s .*FOR UPDATE OF s/),
			expect.stringMatching(/FROM "hanami_common_generation" g .*FOR UPDATE OF g/),
			expect.stringMatching(/^UPDATE "hanami_user_feed_state" s /),
		]);
		expect(runtime.calls.at(6)?.sql).toContain('s."latestSequence"::text AS head_sequence');
		expect(runtime.calls.at(8)?.values).toEqual([
			['user-a', 'user-z'],
			'common-epoch',
			'common-generation',
			'9007199254740993',
			transitionedAt,
		]);
		expect(runtime.manager.transaction).not.toHaveBeenCalled();
		expect(runtime.manager.getRepository).not.toHaveBeenCalled();
		expect(runtime.roleService.getUserPolicies).not.toHaveBeenCalled();
		expect(runtime.idService.gen).not.toHaveBeenCalled();
	});

	test('revival without feed state is a one-query no-op before policy, profile, common, or ID work', async () => {
		const runtime = makeRuntime({ hasState: false });

		await runtime.service.reviveUser(runtime.manager as never, 'unused-user', transitionedAt);

		expect(runtime.calls).toHaveLength(1);
		expect(runtime.calls.at(0)?.sql).toMatch(/FROM "hanami_user_feed_state" s .*FOR UPDATE OF s/);
		expect(runtime.roleService.getUserPolicies).not.toHaveBeenCalled();
		expect(runtime.idService.gen).not.toHaveBeenCalled();
		expect(runtime.calls.some((call) => call.sql.includes('"user_profile"'))).toBe(false);
		expect(runtime.calls.some((call) => call.sql.includes('"hanami_common_feed_state"'))).toBe(false);
	});

	test('role unavailability short-circuits the manager-scoped profile read', async () => {
		const runtime = makeRuntime({ policyAvailable: false, common: 'missing' });

		await runtime.service.reviveUser(runtime.manager as never, 'user-1', transitionedAt);

		expect(runtime.events).toEqual(['policy']);
		expect(runtime.roleService.getUserPolicies).toHaveBeenCalledWith('user-1', runtime.manager);
		expect(runtime.calls.some((call) => call.sql.includes('"user_profile"'))).toBe(false);
		const stateUpdate = runtime.calls.find((call) => call.sql.includes('"initialGenerationState" = $3'));
		expect(stateUpdate?.values[2]).toBe('skippedUnavailable');
		expect(stateUpdate?.values.slice(3, 6)).toEqual([null, null, null]);
	});

	test('profile unavailability is evaluated only after the role policy and skips initial generation', async () => {
		const runtime = makeRuntime({ policyAvailable: true, profileEnabled: false, common: 'empty' });

		await runtime.service.reviveUser(runtime.manager as never, 'user-1', transitionedAt);

		expect(runtime.events).toEqual(['policy', 'profile']);
		const stateUpdate = runtime.calls.find((call) => call.sql.includes('"initialGenerationState" = $3'));
		expect(stateUpdate?.values[2]).toBe('skippedUnavailable');
		expect(stateUpdate?.values.slice(3, 6)).toEqual([null, null, null]);
		expect(runtime.calls.some((call) => call.sql.includes('FROM "hanami_common_generation"'))).toBe(false);
	});

	test('fails safely when a locked state has no matching active epoch', async () => {
		const runtime = makeRuntime({ hasActiveEpoch: false });

		await expect(runtime.service.reviveUser(runtime.manager as never, 'user-1', transitionedAt))
			.rejects.toThrow('Hanami feed state references 1 current epochs, but 0 active epochs were found');

		expect(runtime.calls).toHaveLength(2);
		expect(runtime.idService.gen).not.toHaveBeenCalled();
		expect(runtime.roleService.getUserPolicies).not.toHaveBeenCalled();
	});

	test('fails safely when an available user has no manager-scoped profile', async () => {
		const runtime = makeRuntime({ policyAvailable: true, profileMissing: true });

		await expect(runtime.service.reviveUser(runtime.manager as never, 'user-1', transitionedAt))
			.rejects.toThrow('Hanami revival profile is missing for user user-1');

		expect(runtime.events).toEqual(['policy', 'profile']);
		expect(runtime.calls.some((call) => call.sql.includes('FROM "hanami_common_feed_state"'))).toBe(false);
		expect(runtime.idService.gen).not.toHaveBeenCalled();
	});

	test('rejects a latest-ready common pointer to a non-ready generation', async () => {
		const runtime = makeRuntime({ common: 'notReady' });

		await expect(runtime.service.hibernateUsers(runtime.manager as never, ['user-1'], transitionedAt))
			.rejects.toThrow('Hanami common feed state references generation common-generation with status generating, expected ready');

		expect(runtime.calls.some((call) => call.sql.startsWith('UPDATE "hanami_user_feed_state"'))).toBe(false);
		expect(runtime.idService.gen).not.toHaveBeenCalled();
	});

	test('permitted revival rotates one epoch, pins one ready tuple, and creates no jobs or generation batches', async () => {
		const runtime = makeRuntime({ activeWork: true, common: 'ready' });

		await runtime.service.reviveUser(runtime.manager as never, 'user-1', transitionedAt);

		const sql = runtime.calls.map((call) => call.sql).join('\n');
		const inserts = runtime.calls.filter((call) => call.sql.startsWith('INSERT INTO'));
		expect(runtime.events).toEqual(['policy', 'profile']);
		expect(runtime.idService.gen).toHaveBeenCalledTimes(1);
		expect(runtime.idService.gen).toHaveBeenCalledWith();
		expect(inserts).toHaveLength(1);
		expect(inserts.at(0)?.sql).toContain('INSERT INTO "hanami_user_feed_epoch"');
		expect(sql).not.toMatch(/INSERT INTO "hanami_user_feed_batch"/);
		expect(sql).not.toMatch(/INSERT INTO "hanami_common_generation"/);
		expect(sql).not.toMatch(/queue|job|outbox/i);
		expect(sql).not.toContain('"following"');
		const retireIndex = runtime.calls.findIndex((call) => call.sql.startsWith('UPDATE "hanami_user_feed_epoch"'));
		const insertIndex = runtime.calls.findIndex((call) => call.sql.startsWith('INSERT INTO "hanami_user_feed_epoch"'));
		const stateIndex = runtime.calls.findIndex((call) => call.sql.includes('"initialGenerationState" = $3'));
		expect(retireIndex).toBeLessThan(insertIndex);
		expect(insertIndex).toBeLessThan(stateIndex);
		const stateUpdate = runtime.calls.at(stateIndex);
		expect(stateUpdate?.values).toEqual([
			'user-1',
			'epoch-new',
			'notEvaluated',
			'common-epoch',
			'common-generation',
			'9007199254740993',
			transitionedAt,
			'epoch-old',
		]);
		expect(runtime.manager.transaction).not.toHaveBeenCalled();
		expect(runtime.manager.getRepository).not.toHaveBeenCalled();
	});
});
