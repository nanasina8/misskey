/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { createHanamiMetricsCandidateRows, HanamiMetricsCaptureService, type HanamiMetricsCandidateDecision } from '@/core/hanami/HanamiMetricsCaptureService.js';
import { HanamiPersonalFeedComputationService } from '@/core/hanami/HanamiPersonalFeedComputationService.js';
import { HANAMI_FOR_YOU_AXES, type HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
import { HANAMI_NOTE_JUDGE_MODEL, createDefaultHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import type { HanamiPersonalFeedCandidate } from '@/core/hanami/HanamiUserFeedContracts.js';

const capturedAt = '2026-09-20T00:00:00.000Z';

function fixture(reduceEphemeralPosts = true) {
	const settings = { ...createDefaultHanamiNoteJudgeSettings(), ephemeralThreshold: 1 };
	const controller = new AbortController();
	const specs: Array<[string, HanamiAxis]> = [
		['hidden-popular', 'globalPopular'], ['hidden-trending', 'trending'],
		['direct', 'globalPopular'], ['media', 'trending'], ['rule', 'globalPopular'],
		['unjudged', 'trending'], ['threshold', 'globalPopular'], ['other-axis', 'catchup'],
		['discovery', 'exploration'], ['seen', 'globalPopular'], ['unsafe', 'trending'],
		['multi', 'globalPopular'], ['multi', 'catchup'],
	];
	const candidates: HanamiPersonalFeedCandidate[] = specs.map(([noteId, axis]) => ({
		noteId, axis, authorId: `author-${noteId}`, origin: 'commonCandidate', score: 1,
	}));
	const query = jest.fn(async (sql: string, parameters?: unknown[]): Promise<unknown[]> => {
		if (sql.includes('set_config(\'statement_timeout\'')) return [{}];
		if (sql.includes('AS before_deadline')) return [{ before_deadline: true }];
		if (sql.includes('FROM meta')) return [{ settings, reduce_ephemeral_posts: reduceEphemeralPosts }];
		if (sql.includes('e."eventType" = \'seen\'')) return [{ note_id: 'seen' }];
		if (sql.includes('FROM note n JOIN "user" u')) return (parameters?.[1] as string[]).map(noteId => ({
			note_id: noteId, author_id: `author-${noteId}`, text: `unique content ${noteId}`, tags: [],
			has_files: noteId === 'media', is_bot: false,
			judgement_model: noteId === 'rule' ? 'rule:bot' : HANAMI_NOTE_JUDGE_MODEL,
			ephemeral_score: noteId === 'unjudged' ? null : noteId === 'threshold' ? 1 : 2,
			interest: noteId === 'unjudged' ? null : 4, content_type: 0,
			relationship_class: noteId === 'direct' ? 'directFollow' : 'unknown',
		}));
		return [];
	});
	const runner = {
		query, isTransactionActive: false, isReleased: false,
		connect: jest.fn(async () => undefined),
		startTransaction: jest.fn(async () => { runner.isTransactionActive = true; }),
		commitTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
		rollbackTransaction: jest.fn(async () => { runner.isTransactionActive = false; }),
		release: jest.fn(async () => { runner.isReleased = true; }),
	};
	const service = new HanamiPersonalFeedComputationService(
		{ createQueryRunner: () => runner } as never,
		{ loadReadyCommonCandidates: async () => [] } as never,
		{
			gatherPersonalFeedCandidates: async () => ({ candidates, confidence: 'high', axisLevels: new Map(HANAMI_FOR_YOU_AXES.map(axis => [axis, 'normal'])) }),
			rankPersonalFeedCandidates: async (_context: unknown, _preparation: unknown, safe: HanamiPersonalFeedCandidate[]) => safe,
		} as never,
		{
			filterCommonEligibleNotes: async () => new Map(),
			filterPersonalEligibleCandidates: async ({ candidates: values }: { candidates: HanamiPersonalFeedCandidate[] }) => values.filter(value => value.noteId !== 'unsafe'),
		} as never,
		{ buildReasonMetadata: () => ({ version: 1 }) } as never,
	);
	return {
		service, runner, query, settings, controller,
		input: {
			userId: 'viewer', epochId: 'epoch', baseCommonGenerationId: 'common', latestReadyBatchId: null,
			generatedAt: capturedAt, databaseDeadlineAt: '2026-09-20T00:00:45.000Z', signal: controller.signal,
		},
	};
}

describe('Hanami real candidate decision capture (mock-only)', () => {
	test('captures actual popular/trending rejections, not safety/seen/discovery exclusions or exemptions', async () => {
		const target = fixture();
		const result = await target.service.computePersonalFeed(target.input);
		expect(result.metricsCandidates.filter(row => row.decision === 'hiddenEphemeral')).toEqual([
			{ noteId: 'hidden-popular', axis: 'globalPopular', decision: 'hiddenEphemeral' },
			{ noteId: 'hidden-trending', axis: 'trending', decision: 'hiddenEphemeral' },
			{ noteId: 'multi', axis: 'globalPopular', decision: 'hiddenEphemeral' },
		]);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.metricsCandidates.filter(row => row.decision === 'shown')).toEqual(
			result.items.map(item => ({ noteId: item.noteId, axis: item.source, decision: 'shown' })),
		);
		expect(result.metricsCandidates.some(row => row.noteId === 'unsafe' || row.noteId === 'seen' || row.noteId === 'discovery')).toBe(false);
		expect(result.items.every(item => !('metricsCandidates' in item.reasonMetadata))).toBe(true);
		expect(Object.isFrozen(result.metricsCandidates)).toBe(true);
		expect(result.metricsCandidates.every(Object.isFrozen)).toBe(true);
		target.settings.ephemeralThreshold = 3;
		expect(result.metricsCandidates.filter(row => row.decision === 'hiddenEphemeral')).toHaveLength(3);
		// Computation retains its read-only transaction and adds no metrics I/O.
		expect(target.query.mock.calls.some(([sql]) => /INSERT|SAVEPOINT|hanami_metrics_candidate/.test(sql))).toBe(false);
		expect(target.runner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(target.runner.release).toHaveBeenCalledTimes(1);
		expect(target.runner.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(target.runner.release.mock.invocationCallOrder[0] ?? 0);
	});

	test('viewer opt-out records no ephemeral-hidden decisions', async () => {
		const target = fixture(false);
		const result = await target.service.computePersonalFeed(target.input);
		expect(result.metricsCandidates.filter(row => row.decision === 'hiddenEphemeral')).toEqual([]);
	});

	test('an aborted computation produces no trace publication or late writes', async () => {
		const target = fixture();
		const reason = new Error('deadline');
		target.runner.commitTransaction.mockImplementation(async () => {
			target.runner.isTransactionActive = false;
			target.controller.abort(reason);
		});
		await expect(target.service.computePersonalFeed(target.input)).rejects.toBe(reason);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(target.query.mock.calls.some(([sql]) => /INSERT|SAVEPOINT/.test(sql))).toBe(false);
		expect(target.runner.release).toHaveBeenCalledTimes(1);
	});

	test('deduplicates by note/axis/decision and uses only the actual selected primary source', () => {
		const hidden = { noteId: 'same', axis: 'globalPopular', decision: 'hiddenEphemeral' } as const;
		const selected = { noteId: 'same', source: 'catchup', sources: ['catchup', 'trending'] } as const;
		expect(createHanamiMetricsCandidateRows([hidden, hidden], [selected, selected])).toEqual([
			hidden, { noteId: 'same', axis: 'catchup', decision: 'shown' },
		]);
	});
});

describe('Hanami candidate persistence adapter (mock-only)', () => {
	const service = new HanamiMetricsCaptureService();
	const rows: readonly HanamiMetricsCandidateDecision[] = [
		{ noteId: 'note\'quoted', axis: 'trending', decision: 'hiddenEphemeral' },
		{ noteId: 'selected', axis: 'catchup', decision: 'shown' },
	];

	test('writes one parameterized batch with the generation actor/time and conflict-safe key', async () => {
		const query = jest.fn(async (_sql: string, _parameters?: unknown[]) => []);
		await expect(service.recordCandidates('batch', 'viewer', rows, capturedAt, query)).resolves.toBe(true);
		expect(query).toHaveBeenCalledTimes(3);
		const [sql, parameters] = query.mock.calls[1] ?? [];
		expect(sql).toContain('ON CONFLICT ("batchId", "userId", "noteId", "axis", "decision") DO NOTHING');
		expect(sql).not.toContain('note\'quoted');
		expect(parameters).toEqual(['batch', 'viewer', ['note\'quoted', 'selected'], ['trending', 'catchup'], ['hiddenEphemeral', 'shown'], capturedAt]);
		expect(query.mock.calls[0]?.[0]).toBe('SAVEPOINT hanami_metrics_candidates');
		expect(query.mock.calls[2]?.[0]).toBe('RELEASE SAVEPOINT hanami_metrics_candidates');
	});

	test('does no I/O for an empty trace', async () => {
		const query = jest.fn(async () => []);
		await expect(service.recordCandidates('batch', 'viewer', [], capturedAt, query)).resolves.toBe(true);
		expect(query).not.toHaveBeenCalled();
	});

	test('recovers the PG transaction before swallowing a metrics insert outage', async () => {
		let poisoned = false;
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('INSERT INTO')) { poisoned = true; throw new Error('missing metrics table'); }
			if (sql.startsWith('ROLLBACK TO')) poisoned = false;
			if (poisoned) throw new Error('transaction aborted');
			return [];
		});
		await expect(service.recordCandidates('batch', 'viewer', rows, capturedAt, query)).resolves.toBe(false);
		expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
			'SAVEPOINT hanami_metrics_candidates', 'INSERT INTO', 'ROLLBACK TO', 'RELEASE SAVEPOINT',
		]);
		expect(poisoned).toBe(false);
	});

	test('does not pretend recovery succeeded when the transaction is unusable', async () => {
		const recoveryError = new Error('connection lost');
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('INSERT INTO')) throw new Error('outage');
			if (sql.startsWith('ROLLBACK TO')) throw recoveryError;
			return [];
		});
		await expect(service.recordCandidates('batch', 'viewer', rows, capturedAt, query)).rejects.toBe(recoveryError);
		expect(query).toHaveBeenCalledTimes(3);
	});
});
