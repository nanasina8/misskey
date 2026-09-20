/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import type { HanamiDiscoveryCandidate } from '@/core/hanami/HanamiDiscoverySelection.js';
import type { HanamiNoteJudgeRuntimeStatus } from '@/core/hanami/HanamiPythonRuntime.js';
import { createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import type { DataSource, EntityManager } from 'typeorm';

const peek = jest.fn<() => HanamiNoteJudgeRuntimeStatus | null>();
jest.unstable_mockModule('../../src/core/hanami/HanamiPythonRuntime.js', () => ({ peekHanamiNoteJudgeRuntime: peek }));
// No safety dependency graph, DB, cache, Python process or packing is started in these tests.
jest.unstable_mockModule('../../src/core/hanami/HanamiForYouSafetyService.js', () => ({ HanamiForYouSafetyService: class {} }));
const {
	HanamiMetricsDiagnosticsService, diagnoseHanamiDiscovery, diagnosticAxisLevel,
	HANAMI_DIAGNOSTIC_INVENTORY_SQL, HANAMI_DIAGNOSTIC_VIEWERS_SQL, HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL,
} = await import('@/core/hanami/HanamiMetricsDiagnosticsService.js');
type StoredRow = import('@/core/hanami/HanamiMetricsDiagnosticsService.js').HanamiMetricsDiagnosticRow;

const parameters = { reactionMax: 3, interestMax: 2, thetaEphemeral: 2, thetaInterest: 3 };
const candidate = (noteId: string, overrides: Partial<HanamiDiscoveryCandidate> = {}): HanamiDiscoveryCandidate => ({
	noteId, authorId: `author-${noteId}`, reactionScore: 10, ephemeralScore: 1, interest: 4, ...overrides,
});

function fixture(viewerCount = 5) {
	const stored: StoredRow[] = [];
	const viewers = Array.from({ length: viewerCount }, (_, index) => ({ userId: `viewer-${String(index).padStart(4, '0')}`, epochId: `epoch-${index}`, axes: {}, hideEphemeral: true }));
	const inventory = [candidate('pass'), candidate('unsafe'), candidate('media'), candidate('served'), candidate('ff'), candidate('unjudged', { ephemeralScore: null, interest: null })]
		.map(item => ({ ...item, ephemeralScore: item.ephemeralScore == null ? null : 0 }));
	let hasGeneration = true;
	const query = jest.fn(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
		if (sql.includes('pg_advisory_xact_lock')) return [];
		if (sql.startsWith('SELECT 1 FROM hanami_metrics_diagnostic')) return stored.length ? [{ exists: true }] : [];
		if (sql.includes('FROM meta')) return [{ settings: createDefaultHanamiNoteJudgeSettings(), axes: {} }];
		if (sql.includes('FROM hanami_common_generation')) return hasGeneration ? [{ id: 'generation-secret', generationFence: '12', finishedAt: '2026-09-20T14:00:00Z' }] : [];
		if (sql === HANAMI_DIAGNOSTIC_INVENTORY_SQL) return inventory;
		if (sql === HANAMI_DIAGNOSTIC_VIEWERS_SQL) return viewers.filter(viewer => viewer.userId > String(params[0])).slice(0, 100);
		if (sql === HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL) return inventory.map(item => ({ noteId: item.noteId, isFF: item.noteId === 'ff', isServed: item.noteId === 'served' }));
		if (sql.startsWith('INSERT INTO hanami_metrics_diagnostic')) {
			stored.push({ scope: params[1] as StoredRow['scope'], key: String(params[2]), users: Number(params[3]), data: JSON.parse(String(params[4])) as Record<string, unknown>, capturedAt: String(params[5]) });
			return [];
		}
		if (sql.startsWith('SELECT scope,key,users,data')) return stored;
		throw new Error(`Unexpected SQL: ${sql}`);
	});
	const runner = {};
	const manager = { query, queryRunner: runner } as unknown as EntityManager;
	const transaction = jest.fn(async (_isolation: string, callback: (manager: EntityManager) => Promise<void>) => callback(manager));
	const db = { query, transaction } as unknown as DataSource;
	const common = jest.fn(async () => new Map(inventory.filter(item => item.noteId !== 'unsafe').map(item => [item.noteId, item.authorId])));
	const personal = jest.fn(async (input: { candidates: { noteId: string }[] }) => input.candidates.filter(item => item.noteId !== 'media'));
	const safety = { filterCommonEligibleNotes: common, filterPersonalEligibleCandidates: personal } as unknown as HanamiForYouSafetyService;
	return { service: new HanamiMetricsDiagnosticsService(db, safety), stored, query, transaction, common, personal, runner, viewers, inventory, noGeneration: () => { hasGeneration = false; } };
}

beforeEach(() => {
	jest.useFakeTimers().setSystemTime(new Date('2026-09-20T15:00:00Z')); // Sep 21 in JST, Sep 20 UTC.
	peek.mockReset().mockReturnValue(null);
});
afterEach(() => { jest.useRealTimers(); });

describe('discovery diagnostic gates (real selector)', () => {
	test('assigns exactly one first failure and honors serving safety/media/recency stage order', () => {
		const result = diagnoseHanamiDiscovery([
			candidate('unsafe', { passesSafety: false, passesMediaFilter: false, isServed: true, interest: null }),
			candidate('media', { passesMediaFilter: false, isServed: true }),
			candidate('served', { isServed: true, isFF: true }),
			candidate('unjudged', { interest: null, isFF: true }),
			candidate('ff', { isFF: true, ephemeralScore: 99 }),
			candidate('ephemeral', { ephemeralScore: 99, interest: 1 }),
			candidate('interest', { interest: 1 }),
			candidate('pass'),
		], parameters);
		expect(result).toEqual({ otherSafety: 1, hideMedia: 1, servedSeen: 1, unjudged: 1, ff: 1, ephemeral: 1, lowInterest: 1, diversity: 0, passed: 1 });
		expect(Object.values(result).reduce((a, b) => a + b, 0)).toBe(8);
	});

	test('judge-down allows only unjudged fallback, not judged rule exclusions or low interest', () => {
		const input = [candidate('unjudged', { interest: null }), candidate('rule', { ephemeralScore: 999, interest: 0 }), candidate('low', { interest: 2 })];
		expect(diagnoseHanamiDiscovery(input, { ...parameters, allowUnjudged: true })).toMatchObject({ passed: 1, unjudged: 0, ephemeral: 1, lowInterest: 1 });
		expect(diagnoseHanamiDiscovery(input, { ...parameters, allowUnjudged: true, excludeEphemeral: false })).toMatchObject({ passed: 1, ephemeral: 0, lowInterest: 2 });
	});

	test('ephemeral opt-out bypasses only that gate; threshold equality passes', () => {
		const input = [candidate('boundary', { interest: 3, ephemeralScore: 2 }), candidate('ephemeral', { ephemeralScore: 999 }), candidate('self', { isSelf: true }), candidate('muted', { isMuted: true }), candidate('blocked', { isBlocked: true })];
		expect(diagnoseHanamiDiscovery(input, parameters)).toMatchObject({ passed: 1, ephemeral: 1, ff: 1, otherSafety: 2 });
		expect(diagnoseHanamiDiscovery(input, { ...parameters, excludeEphemeral: false })).toMatchObject({ passed: 2, ephemeral: 0, ff: 1, otherSafety: 2 });
	});

	test('self, both FF representations and known/direct relations are excluded', () => {
		const input = [candidate('self', { authorId: 'viewer' }), candidate('flag', { isFF: true }), candidate('known', { relationshipClass: 'known' }), candidate('direct', { relationshipClass: 'directFollow' })];
		expect(diagnoseHanamiDiscovery(input, { ...parameters, viewerId: 'viewer' }).ff).toBe(4);
	});

	test('delegates author and campaign diversity to selection, with post-safety tag population', () => {
		const campaign = Array.from({ length: 8 }, (_, index) => candidate(`campaign-${index}`, { campaignTags: ['tag'] }));
		expect(diagnoseHanamiDiscovery(campaign, parameters)).toMatchObject({ passed: 1, diversity: 7 });
		expect(diagnoseHanamiDiscovery(campaign.map((item, index) => ({ ...item, passesSafety: index !== 0 })), parameters)).toMatchObject({ passed: 7, otherSafety: 1, diversity: 0 });
		expect(diagnoseHanamiDiscovery([candidate('a'), candidate('b', { authorId: 'author-a' })], parameters)).toMatchObject({ passed: 1, diversity: 1 });
	});
});

describe('diagnostic SQL and profile contracts', () => {
	test('pins latest ready inventory fence/prompt, bounds candidates and keyset viewer pages', () => {
		expect(HANAMI_DIAGNOSTIC_INVENTORY_SQL).toContain('c."generationFence" = $2');
		expect(HANAMI_DIAGNOSTIC_INVENTORY_SQL).toContain('j."promptVersion" = $3');
		expect(HANAMI_DIAGNOSTIC_INVENTORY_SQL).toContain('c.axis = \'exploration\'');
		expect(HANAMI_DIAGNOSTIC_INVENTORY_SQL).toContain('ORDER BY c.rank LIMIT 1200');
		expect(HANAMI_DIAGNOSTIC_INVENTORY_SQL).not.toContain('CASE');
		expect(HANAMI_DIAGNOSTIC_VIEWERS_SQL).toContain('s.mode = \'personalized\'');
		expect(HANAMI_DIAGNOSTIC_VIEWERS_SQL).toContain('p."hanamiRecommendationEnabled" = true');
		expect(HANAMI_DIAGNOSTIC_VIEWERS_SQL).toContain('s."userId" > $1 ORDER BY s."userId" LIMIT 100');
	});

	test('served is personal/current epoch; seen has both inclusive seven-day time bounds, FF is bidirectional', () => {
		expect(HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL).toContain('e."feedKind" = \'personal\' AND e."feedEpochId" = $2');
		expect(HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL).toContain('e."occurredAt" >= $4::timestamptz - INTERVAL \'168 hours\'');
		expect(HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL).toContain('e."occurredAt" <= $4::timestamptz');
		expect(HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL).toContain('f."followeeId" = $1 AND f."followerId" = n."userId"');
	});

	test('actual axis values, legacy booleans/aliases and server availability/defaults are resolved', () => {
		expect(diagnosticAxisLevel('exploration', { popular: false }, {})).toBe('off');
		expect(diagnosticAxisLevel('exploration', { popular: false, exploration: 'high' }, {})).toBe('high');
		expect(diagnosticAxisLevel('neighborTrending', { reactionSimilar: true }, {})).toBe('normal');
		expect(diagnosticAxisLevel('exploration', {}, { popular: { default: false } })).toBe('off');
		expect(diagnosticAxisLevel('exploration', { exploration: 'high' }, { exploration: { available: false } })).toBe('off');
		expect(diagnosticAxisLevel('exploration', {}, {})).toBe('normal');
	});
});

describe('current-only atomic captures (mock persistence)', () => {
	test('historical/future captures do not access DB, safety or runtime; invalid dates reject', async () => {
		const mock = fixture();
		await mock.service.capture('2026-09-20');
		await mock.service.capture('2026-09-22');
		expect(mock.transaction).not.toHaveBeenCalled();
		expect(mock.common).not.toHaveBeenCalled();
		expect(peek).not.toHaveBeenCalled();
		await expect(mock.service.capture('2026-02-30')).rejects.toThrow(RangeError);
	});

	test('captures individual safety/facts with unique viewers, aggregate-only data and honest limitations', async () => {
		const mock = fixture();
		await mock.service.capture('2026-09-21');
		const summary = mock.stored[0];
		expect(summary).toMatchObject({ users: 5, data: {
			currentOnly: true, available: true, viewers: 5, candidates: 6, evaluations: 30,
			passed: 5, dropped: { otherSafety: 5, hideMedia: 5, servedSeen: 5, ff: 5, unjudged: 5 }, runtimeAvailable: null, allowUnjudged: false,
		} });
		expect(summary.data.reasonUsers).toMatchObject({ passed: 5, otherSafety: 5 });
		expect(summary.data.limitedReasons).toContain('displayTimeMuteBlockWordInstanceSafetyNotReplayed');
		expect(summary.data.unavailable).toContain('generationRuntimeFallbackNotPersisted');
		expect(mock.personal).toHaveBeenCalledTimes(5);
		expect(mock.personal.mock.calls[0][0]).toMatchObject({ userId: 'viewer-0000', queryRunner: mock.runner });
		expect(mock.query.mock.calls.find(([sql]) => sql === HANAMI_DIAGNOSTIC_INVENTORY_SQL)?.[1]).toEqual(['generation-secret', '12', createDefaultHanamiNoteJudgeSettings().promptVersion]);
		expect(mock.transaction.mock.calls[0][0]).toBe('REPEATABLE READ');
		const json = JSON.stringify(mock.stored);
		for (const secret of ['viewer-0000', 'epoch-0', 'generation-secret', 'author-pass', 'noteId', 'userId']) expect(json).not.toContain(secret);
		expect(mock.stored.find(row => row.key === 'hideEphemeral:on')).toMatchObject({ users: 5, data: { axis: 'hideEphemeral', level: 'on' } });
		expect(mock.stored.find(row => row.key === 'closeness:unavailable')?.data.available).toBe(false);
	});

	test('preserves existing records even on repeated capture and when the day becomes historical', async () => {
		const mock = fixture();
		await mock.service.capture('2026-09-21');
		const saved = JSON.stringify(mock.stored);
		await mock.service.capture('2026-09-21');
		jest.setSystemTime(new Date('2026-09-22T00:00:00Z'));
		await mock.service.capture('2026-09-21');
		expect(JSON.stringify(mock.stored)).toBe(saved);
		expect(peek).toHaveBeenCalledTimes(1);
		expect(mock.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT')).every(([sql]) => sql.includes('ON CONFLICT (day,scope,key) DO NOTHING'))).toBe(true);
	});

	test('does not manufacture old snapshots; reads retained history and suppresses small groups', async () => {
		const mock = fixture(4);
		expect(await mock.service.query('2026-09-20')).toEqual({ available: false, rows: [], suppressed: [] });
		await mock.service.capture('2026-09-21');
		jest.setSystemTime(new Date('2026-09-22T00:00:00Z'));
		const result = await mock.service.query('2026-09-21');
		expect(result.suppressed).toContain('dropped/exploration');
		expect(result.suppressed).toContain('tuning/hideEphemeral:on');
		expect(result.rows.every(row => row.users === 0)).toBe(true);
	});

	test('five users pass privacy threshold, but any small reason subgroup hides the whole summary', async () => {
		const mock = fixture();
		await mock.service.capture('2026-09-21');
		expect((await mock.service.query('2026-09-21')).suppressed).toEqual([]);
		(mock.stored[0].data.reasonUsers as Record<string, number>).ff = 1;
		expect((await mock.service.query('2026-09-21')).suppressed).toEqual(['dropped/exploration']);
	});

	test('reads every eligible viewer through bounded pages, not a fixed sample', async () => {
		const mock = fixture(101);
		await mock.service.capture('2026-09-21');
		expect(mock.stored[0].users).toBe(101);
		expect(mock.query.mock.calls.filter(([sql]) => sql === HANAMI_DIAGNOSTIC_VIEWERS_SQL).map(([, params]) => params)).toEqual([[''], ['viewer-0099']]);
	});

	test('uses current per-viewer preference, excludes off-axis viewers but retains their tuning', async () => {
		const mock = fixture();
		mock.viewers[0].axes = { exploration: 'off' };
		mock.viewers[1].hideEphemeral = false;
		await mock.service.capture('2026-09-21');
		expect(mock.stored[0]).toMatchObject({ users: 4, data: { viewers: 4, profileViewers: 5 } });
		expect(mock.stored.find(row => row.key === 'exploration:off')?.users).toBe(1);
		expect(mock.stored.find(row => row.key === 'hideEphemeral:off')?.users).toBe(1);
	});

	test('runtime peek down enables fallback, while missing generation remains unavailable', async () => {
		peek.mockReturnValue({ available: false, device: null, deviceName: null, reason: 'not persisted', probedAt: '2026-09-20T14:59:00Z' });
		const mock = fixture();
		await mock.service.capture('2026-09-21');
		expect(mock.stored[0].data).toMatchObject({ allowUnjudged: true, runtimeAvailable: false, passed: 10, dropped: { unjudged: 0 } });
		const missing = fixture();
		missing.noGeneration();
		await missing.service.capture('2026-09-21');
		expect(missing.stored[0].data).toMatchObject({ available: false, candidates: 0 });
		expect(missing.stored[0].data.unavailable).toContain('readyCommonGeneration');
	});

	test('an empty viewer cohort is unavailable rather than an observed passing cohort', async () => {
		const mock = fixture(0);
		await mock.service.capture('2026-09-21');
		expect(mock.stored[0]).toMatchObject({ users: 0, data: { available: false, viewers: 0, passed: 0, evaluations: 0 } });
		expect(mock.stored[0].data.unavailable).toContain('eligibleViewers');
	});

	test('capture crossing JST midnight does not write old-day results', async () => {
		const mock = fixture();
		mock.personal.mockImplementation(async input => {
			jest.setSystemTime(new Date('2026-09-21T15:00:00Z'));
			return input.candidates;
		});
		await mock.service.capture('2026-09-21');
		expect(mock.stored).toEqual([]);
	});

	test('safety failures abort capture instead of persisting manufactured passed counts', async () => {
		const mock = fixture();
		mock.personal.mockRejectedValue(new Error('safety unavailable'));
		await expect(mock.service.capture('2026-09-21')).rejects.toThrow('safety unavailable');
		expect(mock.stored).toEqual([]);
	});
});
