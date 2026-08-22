/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import { DataSource, getMetadataArgsStorage } from 'typeorm';
import * as modelExports from '@/models/_.js';
import { MiHanamiCommonCandidateEntry } from '@/models/HanamiCommonCandidateEntry.js';
import { MiHanamiCommonFeedEntry } from '@/models/HanamiCommonFeedEntry.js';
import { MiHanamiCommonFeedState } from '@/models/HanamiCommonFeedState.js';
import { MiHanamiCommonGeneration } from '@/models/HanamiCommonGeneration.js';
import { MiHanamiRecommendationEvent } from '@/models/HanamiRecommendationEvent.js';
import { MiHanamiTrendSnapshot } from '@/models/HanamiTrendSnapshot.js';
import { MiHanamiTrendSnapshotEntry } from '@/models/HanamiTrendSnapshotEntry.js';
import { MiHanamiTrendSnapshotRepresentativeNote } from '@/models/HanamiTrendSnapshotRepresentativeNote.js';
import { MiHanamiUserFeedBatch } from '@/models/HanamiUserFeedBatch.js';
import { MiHanamiUserFeedEntry } from '@/models/HanamiUserFeedEntry.js';
import { MiHanamiUserFeedEpoch } from '@/models/HanamiUserFeedEpoch.js';
import { MiHanamiUserFeedRefresh } from '@/models/HanamiUserFeedRefresh.js';
import { MiHanamiUserFeedState } from '@/models/HanamiUserFeedState.js';
import { MiHanamiUserRecommendationBatch } from '@/models/HanamiUserRecommendationBatch.js';
import { MiHanamiUserRecommendationEntry } from '@/models/HanamiUserRecommendationEntry.js';
import { MiHanamiUserRecommendationRefresh } from '@/models/HanamiUserRecommendationRefresh.js';
import { MiHanamiUserRecommendationState } from '@/models/HanamiUserRecommendationState.js';
import { entities } from '@/postgres.js';
import {
	createHanamiBigintTransformer,
	hanamiBigintTransformer,
	nullableHanamiBigintTransformer,
} from '@/models/util/hanami-bigint.js';

class MetadataOnlyDataSource extends DataSource {
	public async buildMetadatasForTest(): Promise<void> {
		await this.buildMetadatas();
	}
}

const hanamiEntities = [
	MiHanamiCommonGeneration,
	MiHanamiCommonCandidateEntry,
	MiHanamiCommonFeedEntry,
	MiHanamiCommonFeedState,
	MiHanamiTrendSnapshot,
	MiHanamiTrendSnapshotEntry,
	MiHanamiTrendSnapshotRepresentativeNote,
	MiHanamiUserFeedEpoch,
	MiHanamiUserFeedState,
	MiHanamiUserFeedBatch,
	MiHanamiUserFeedEntry,
	MiHanamiUserFeedRefresh,
	MiHanamiUserRecommendationState,
	MiHanamiUserRecommendationBatch,
	MiHanamiUserRecommendationEntry,
	MiHanamiUserRecommendationRefresh,
] as const;

describe('Hanami bigint metadata contracts', () => {
	test('accepts canonical bigint strings and rejects invalid writes', () => {
		expect(hanamiBigintTransformer.to('0')).toBe('0');
		expect(hanamiBigintTransformer.to('-9223372036854775808')).toBe('-9223372036854775808');
		expect(hanamiBigintTransformer.to('9223372036854775807')).toBe('9223372036854775807');
		expect(nullableHanamiBigintTransformer.to(null)).toBeNull();

		for (const value of [null, '', '-0', '01', '+1', '1.5', '9223372036854775808', 1, 1n]) {
			expect(() => hanamiBigintTransformer.to(value)).toThrow();
		}
	});

	test('hard-fails bigint hydration', () => {
		expect(() => hanamiBigintTransformer.from(123)).toThrow('Use raw SQL with ::text aliases instead');
		expect(() => createHanamiBigintTransformer(true).from('123')).toThrow('Use raw SQL with ::text aliases instead');
	});

	test('all 16 Hanami entities stay synchronize:false, registered once, and exported once', () => {
		const tableMetadata = getMetadataArgsStorage().tables;

		expect(hanamiEntities).toHaveLength(16);

		for (const entity of hanamiEntities) {
			const table = tableMetadata.find((entry) => entry.target === entity);
			expect(table?.synchronize).toBe(false);
			expect(entities.filter((candidate) => candidate === entity)).toHaveLength(1);
			expect(Object.values(modelExports).filter((candidate) => candidate === entity)).toHaveLength(1);
		}
	});

	test('only the common feed state allows a nullable epoch before the first seed', () => {
		const columns = getMetadataArgsStorage().columns;
		const nullable = (entity: typeof MiHanamiCommonFeedState | typeof MiHanamiUserFeedEpoch | typeof MiHanamiUserFeedState): boolean => {
			return columns.find((column) => column.target === entity && column.propertyName === 'epochId')?.options.nullable === true;
		};

		expect(nullable(MiHanamiCommonFeedState)).toBe(true);
		expect(nullable(MiHanamiUserFeedEpoch)).toBe(false);
		expect(nullable(MiHanamiUserFeedState)).toBe(false);
	});

	test('lifecycle transition columns retain the nullable shapes guarded by phase-1 CHECKs', () => {
		const columns = getMetadataArgsStorage().columns;
		const expectedNullable = [
			{ entity: MiHanamiUserFeedState, propertyNames: ['initialGenerationAttemptedAt', 'latestReadyBatchId', 'generatingBatchId', 'commonEpochId', 'commonHeadGenerationId', 'commonHeadSequence'] },
			{ entity: MiHanamiUserFeedBatch, propertyNames: ['leaseOwner', 'leaseExpiresAt', 'finishedAt'] },
			{ entity: MiHanamiUserFeedRefresh, propertyNames: ['resultMode', 'resultFeedEpochId', 'resultHeadBatchId', 'resultHeadSequence'] },
		];

		for (const { entity, propertyNames } of expectedNullable) {
			for (const propertyName of propertyNames) {
				expect(columns.find((column) => column.target === entity && column.propertyName === propertyName)?.options.nullable).toBe(true);
			}
		}
	});

	test('MiHanamiRecommendationEvent stays synchronize:false and remains registered/getRepository-compatible', async () => {
		const table = getMetadataArgsStorage().tables.find((entry) => entry.target === MiHanamiRecommendationEvent);
		const dataSource = new MetadataOnlyDataSource({
			type: 'postgres',
			host: '127.0.0.1',
			port: 5432,
			username: 'unused',
			password: 'unused',
			database: 'unused',
			synchronize: false,
			entities,
		});

		expect(table?.synchronize).toBe(false);
		expect(entities.filter((candidate) => candidate === MiHanamiRecommendationEvent)).toHaveLength(1);
		expect(Object.values(modelExports).filter((candidate) => candidate === MiHanamiRecommendationEvent)).toHaveLength(1);

		await dataSource.buildMetadatasForTest();

		expect(dataSource.hasMetadata(MiHanamiRecommendationEvent)).toBe(true);
		expect(dataSource.getRepository(MiHanamiRecommendationEvent).metadata.target).toBe(MiHanamiRecommendationEvent);

		await dataSource.destroy().catch(() => undefined);
	});

	test('every Hanami bigint column uses the runtime guard transformer', () => {
		const columns = getMetadataArgsStorage().columns.filter((column) => column.options.type === 'bigint');
		const expected = [
			{ entity: MiHanamiCommonGeneration, propertyNames: ['ordinal', 'generationFence'], nullable: new Set<string>() },
			{ entity: MiHanamiCommonCandidateEntry, propertyNames: ['generationFence', 'rank'], nullable: new Set<string>() },
			{ entity: MiHanamiCommonFeedEntry, propertyNames: ['sequence'], nullable: new Set<string>() },
			{ entity: MiHanamiCommonFeedState, propertyNames: ['latestSequence', 'earliestRetainedSequence', 'generationFence'], nullable: new Set<string>() },
			{ entity: MiHanamiTrendSnapshot, propertyNames: ['ordinal'], nullable: new Set<string>() },
			{ entity: MiHanamiTrendSnapshotEntry, propertyNames: ['rank'], nullable: new Set<string>() },
			{ entity: MiHanamiTrendSnapshotRepresentativeNote, propertyNames: ['rank'], nullable: new Set<string>() },
			{ entity: MiHanamiUserFeedState, propertyNames: ['latestSequence', 'earliestRetainedSequence', 'commonHeadSequence'], nullable: new Set(['commonHeadSequence']) },
			{ entity: MiHanamiUserFeedEntry, propertyNames: ['sequence'], nullable: new Set<string>() },
			{ entity: MiHanamiUserFeedRefresh, propertyNames: ['resultHeadSequence'], nullable: new Set(['resultHeadSequence']) },
			{ entity: MiHanamiUserRecommendationState, propertyNames: ['latestOrdinal'], nullable: new Set<string>() },
			{ entity: MiHanamiUserRecommendationBatch, propertyNames: ['ordinal'], nullable: new Set(['ordinal']) },
			{ entity: MiHanamiUserRecommendationEntry, propertyNames: ['sequence', 'rank'], nullable: new Set<string>() },
		] as const;

		for (const { entity, propertyNames, nullable } of expected) {
			for (const propertyName of propertyNames) {
				const column = columns.find((entry) => entry.target === entity && entry.propertyName === propertyName);
				expect(column).toBeDefined();
				expect(column?.options.transformer).toBe(nullable.has(propertyName)
					? nullableHanamiBigintTransformer
					: hanamiBigintTransformer);
			}
		}
	});
});
