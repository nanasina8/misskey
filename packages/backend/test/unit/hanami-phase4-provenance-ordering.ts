/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import {
	HANAMI_GENERATION_CANDIDATE_LIMIT,
	HanamiRecommendationService,
} from '@/core/hanami/HanamiRecommendationService.js';
import {
	HanamiForYouProvenanceService,
	type HanamiForYouReasonEventInput,
	type HanamiForYouReasonEventType,
} from '@/core/hanami/HanamiForYouProvenanceService.js';

type DatabaseRow = {
	eventId: string;
	noteId: string;
	eventType: string;
	source: string | null;
	occurredAt: string;
};

class FakeEventQueryBuilder {
	public readonly selections: Array<{ selection: string; alias?: string }> = [];
	public readonly conditions: string[] = [];
	public readonly order: Array<{ selection: string; direction: string }> = [];
	public parameters: Record<string, unknown> = {};
	public rowLimit = 0;

	constructor(
		private readonly rowsByType: ReadonlyMap<string, readonly DatabaseRow[]>,
		private readonly onRead?: () => void,
	) {
	}

	public select(selection: string, alias?: string): this { this.selections.push({ selection, alias }); return this; }
	public addSelect(selection: string, alias?: string): this { this.selections.push({ selection, alias }); return this; }
	public where(condition: string, parameters?: Record<string, unknown>): this {
		this.conditions.push(condition);
		this.parameters = { ...this.parameters, ...parameters };
		return this;
	}
	public andWhere(condition: string, parameters?: Record<string, unknown>): this {
		this.conditions.push(condition);
		this.parameters = { ...this.parameters, ...parameters };
		return this;
	}
	public orderBy(selection: string, direction: string): this { this.order.push({ selection, direction }); return this; }
	public addOrderBy(selection: string, direction: string): this { this.order.push({ selection, direction }); return this; }
	public limit(limit: number): this { this.rowLimit = limit; return this; }
	public async getRawMany<T>(): Promise<T[]> {
		this.onRead?.();
		const eventType = this.parameters.eventType as string;
		return [...(this.rowsByType.get(eventType) ?? [])].slice(0, this.rowLimit) as T[];
	}
}

function createProvenanceService(): HanamiForYouProvenanceService {
	return new HanamiForYouProvenanceService({} as never, {} as never);
}

function createRecommendationService(
	rowsByType: ReadonlyMap<string, readonly DatabaseRow[]>,
	onRead?: () => void,
) {
	const queries: FakeEventQueryBuilder[] = [];
	const durableQueries: Array<{ sql: string; parameters: unknown[] }> = [];
	const durableQuery = jest.fn(async (sql: string, parameters: unknown[]) => {
		onRead?.();
		durableQueries.push({ sql, parameters });
		const noteIds = new Set(parameters[1] as string[]);
		return [...rowsByType.values()].flat()
			.filter(row => noteIds.has(row.noteId))
			.map(row => ({ event_type: row.eventType, note_id: row.noteId }));
	});
	const repository = {
		createQueryBuilder: jest.fn(() => {
			const query = new FakeEventQueryBuilder(rowsByType, onRead);
			queries.push(query);
			return query;
		}),
		manager: { connection: { query: durableQuery } },
	};
	const provenance = createProvenanceService();
	return {
		service: new HanamiRecommendationService(repository as never, provenance),
		durableQueries,
		durableQuery,
		queries,
		repository,
		provenance,
	};
}

describe('Phase 4 recommendation provenance', () => {
	test('keeps a separate 30-minute ordered cap per event type and merges by occurredAt', async () => {
		const rows = new Map<HanamiForYouReasonEventType, readonly DatabaseRow[]>([
			['reaction', [
				{ eventId: 'r-2', noteId: 'shared', eventType: 'reaction', source: 'reactionSimilar:c2', occurredAt: '2026-08-20T09:40:00.000Z' },
				{ eventId: 'r-1', noteId: 'reaction-capped', eventType: 'reaction', source: null, occurredAt: '2026-08-20T09:35:00.000Z' },
			]],
			['reply', [
				{ eventId: 'p-1', noteId: 'shared', eventType: 'reply', source: 'catchup', occurredAt: '2026-08-20T09:50:00.000Z' },
			]],
			['renote', [
				{ eventId: 'n-1', noteId: 'other', eventType: 'renote', source: 'fof', occurredAt: '2026-08-20T09:45:00.000Z' },
			]],
		]);
		const fixture = createRecommendationService(rows);

		const history = await fixture.service.getRecentReasonEventHistory({
			userId: 'user-1',
			generatedAt: '2026-08-20T10:00:00.000Z',
			perEventTypeLimit: 1,
			signal: new AbortController().signal,
		});

		expect(fixture.queries).toHaveLength(3);
		for (const query of fixture.queries) {
			expect(query.parameters).toMatchObject({
				userId: 'user-1',
				cutoff: '2026-08-20T09:30:00.000Z',
				asOf: '2026-08-20T10:00:00.000Z',
			});
			expect(query.rowLimit).toBe(1);
			expect(query.selections).toContainEqual({
				selection: 'event.occurredAt',
				alias: 'occurredAt',
			});
			expect(query.order).toEqual([
				{ selection: 'event.occurredAt', direction: 'DESC' },
				{ selection: 'event.id', direction: 'DESC' },
				{ selection: 'event.noteId', direction: 'ASC' },
			]);
		}
		expect(fixture.queries.map(query => query.parameters.eventType)).toEqual(['reaction', 'reply', 'renote']);
		expect(history.events.map(event => event.eventId)).toEqual(['p-1', 'n-1', 'r-2']);
		expect(history.byNoteId.get('shared')?.latestEvent.eventType).toBe('reply');
		expect(history.byNoteId.get('shared')?.events.map(event => event.eventType)).toEqual(['reply', 'reaction']);
		expect(history.events.some(event => event.noteId === 'reaction-capped')).toBe(false);
	});

	test('uses stable ties while retaining exact events behind the latest-by-Note projection', () => {
		const provenance = createProvenanceService();
		const input: HanamiForYouReasonEventInput[] = [
			{ eventId: 'event-a', noteId: 'note-2', eventType: 'renote', source: null, occurredAt: '2026-08-20T10:00:00.000Z' },
			{ eventId: 'event-z', noteId: 'note-1', eventType: 'reaction', source: 'reactionSimilar:r', occurredAt: '2026-08-20T10:00:00.000Z' },
			{ eventId: 'event-m', noteId: 'note-1', eventType: 'reply', source: 'catchup', occurredAt: '2026-08-20T09:59:59.000Z' },
		];

		const history = provenance.buildReasonEventHistory(input);

		expect(history.events.map(event => event.eventId)).toEqual(['event-z', 'event-a', 'event-m']);
		expect(history.byNoteId.get('note-1')?.latestEvent.eventId).toBe('event-z');
		expect(history.byNoteId.get('note-1')?.events.map(event => event.eventId)).toEqual(['event-z', 'event-m']);
		expect(history.events).toHaveLength(input.length);
	});

	test('reads recency for actual candidates despite more than the candidate limit of unrelated newer events', async () => {
		const unrelatedRows: DatabaseRow[] = Array.from({ length: HANAMI_GENERATION_CANDIDATE_LIMIT + 100 }, (_, index) => ({
			eventId: `served-${String(index).padStart(3, '0')}`,
			noteId: `unrelated-${String(index).padStart(4, '0')}`,
			eventType: 'served',
			source: null,
			occurredAt: '2026-08-20T09:59:59.000Z',
		}));
		const rows = new Map<string, readonly DatabaseRow[]>([
			['served', [...unrelatedRows, {
				eventId: 'candidate-served-event', noteId: 'candidate-served', eventType: 'served', source: null, occurredAt: '2026-08-20T09:31:00.000Z',
			}]],
			['seen', [
				{ eventId: 'candidate-seen-event', noteId: 'candidate-seen', eventType: 'seen', source: null, occurredAt: '2026-08-13T10:00:01.000Z' },
			]],
		]);
		const fixture = createRecommendationService(rows);

		const result = await fixture.service.getDurableServedSeenForCandidates({
			userId: 'user-1',
			generatedAt: '2026-08-20T10:00:00.000Z',
			noteIds: ['candidate-served', 'candidate-seen', 'fresh', 'candidate-served'],
			signal: new AbortController().signal,
		});

		expect(fixture.durableQueries).toHaveLength(1);
		expect(fixture.durableQueries[0]!.parameters).toEqual([
			'user-1',
			['candidate-served', 'candidate-seen', 'fresh'],
			'2026-08-20T10:00:00.000Z',
			'2026-08-20T09:30:00.000Z',
			'2026-08-13T10:00:00.000Z',
		]);
		expect(fixture.durableQueries[0]!.sql).toContain('event."noteId" = ANY($2::varchar[])');
		expect(fixture.durableQueries[0]!.sql).toContain('GROUP BY event."noteId", event."eventType"');
		expect(fixture.durableQueries[0]!.sql).not.toContain('LIMIT');
		expect(result.served).toEqual(new Set(['candidate-served']));
		expect(result.seen).toEqual(new Set(['candidate-seen']));
	});

	test('builds only the versioned reason fields supplied by generation', () => {
		const provenance = createProvenanceService();
		expect(provenance.buildReasonMetadata({
			term: 'typescript',
			clusterId: 7,
			bucket: 'cluster',
		}, true)).toEqual({
			version: 1,
			term: 'typescript',
			clusterId: 7,
			bucket: 'cluster',
			fallbackOverflow: true,
		});
		expect(provenance.buildReasonMetadata({})).toEqual({ version: 1 });
	});

	test('bounds candidate input and stops candidate recency reads on abort', async () => {
		const beforeController = new AbortController();
		const beforeReason = new Error('already expired');
		beforeController.abort(beforeReason);
		const before = createRecommendationService(new Map());
		await expect(before.service.getDurableServedSeenForCandidates({
			userId: 'user-1',
			generatedAt: '2026-08-20T10:00:00.000Z',
			noteIds: ['candidate'],
			signal: beforeController.signal,
		})).rejects.toBe(beforeReason);
		expect(before.repository.createQueryBuilder).not.toHaveBeenCalled();

		const controller = new AbortController();
		const reason = new Error('deadline expired');
		const fixture = createRecommendationService(new Map(), () => controller.abort(reason));

		await expect(fixture.service.getDurableServedSeenForCandidates({
			userId: 'user-1',
			generatedAt: '2026-08-20T10:00:00.000Z',
			noteIds: ['candidate'],
			signal: controller.signal,
		})).rejects.toBe(reason);
		expect(fixture.repository.createQueryBuilder).not.toHaveBeenCalled();
		expect(fixture.durableQuery).toHaveBeenCalledTimes(1);
		await expect(before.service.getDurableServedSeenForCandidates({
			userId: 'user-1',
			generatedAt: '2026-08-20T10:00:00.000Z',
			noteIds: Array.from({ length: HANAMI_GENERATION_CANDIDATE_LIMIT + 1 }, (_, index) => `candidate-${index}`),
			signal: new AbortController().signal,
		})).rejects.toThrow(`Candidate Note count exceeds ${HANAMI_GENERATION_CANDIDATE_LIMIT}`);
	});

	test('routes reason and durable event queries through a caller-owned QueryRunner', async () => {
		const rows = new Map<string, readonly DatabaseRow[]>();
		const queries: FakeEventQueryBuilder[] = [];
		const runnerRepository = {
			createQueryBuilder: jest.fn(() => {
				const query = new FakeEventQueryBuilder(rows);
				queries.push(query);
				return query;
			}),
		};
		const getRepository = jest.fn(() => runnerRepository);
		const queryRunner = {
			manager: { getRepository },
			query: jest.fn(async () => []),
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(),
			rollbackTransaction: jest.fn(),
			release: jest.fn(),
		};
		const injectedRepository = { createQueryBuilder: jest.fn() };
		const service = new HanamiRecommendationService(injectedRepository as never, createProvenanceService());
		const input = {
			userId: 'user-1',
			generatedAt: '2026-08-20T10:00:00.000Z',
			noteIds: ['candidate'],
			signal: new AbortController().signal,
			queryRunner: queryRunner as never,
		};

		await service.getRecentReasonEventHistory(input);
		await service.getDurableServedSeenForCandidates(input);

		expect(queries).toHaveLength(3);
		expect(getRepository).toHaveBeenCalledTimes(3);
		expect(injectedRepository.createQueryBuilder).not.toHaveBeenCalled();
		expect(queryRunner.query).toHaveBeenCalledTimes(1);
		expect(queryRunner.startTransaction).not.toHaveBeenCalled();
		expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
		expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
		expect(queryRunner.release).not.toHaveBeenCalled();
	});
});
