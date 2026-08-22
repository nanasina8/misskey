/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DI } from '@/di-symbols.js';
import { CacheService } from '@/core/CacheService.js';
import { CoreModule } from '@/core/CoreModule.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { HanamiRecommendationService as LegacyHanamiRecommendationService } from '@/core/HanamiRecommendationService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { QueryService } from '@/core/QueryService.js';
import { QueueService } from '@/core/QueueService.js';
import { RoleService } from '@/core/RoleService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import {
	HANAMI_COMMON_GENERATION_LIFECYCLE,
	HANAMI_COMMON_GENERATION_READ,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { HanamiCommonHeadQueries } from '@/core/hanami/HanamiCommonHeadQueries.js';
import { HanamiFeedLifecycleService } from '@/core/hanami/HanamiFeedLifecycleService.js';
import { HanamiForYouBatchService } from '@/core/hanami/HanamiForYouBatchService.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import { HanamiForYouService } from '@/core/hanami/HanamiForYouService.js';
import { HanamiPersistedFeedReadService } from '@/core/hanami/HanamiPersistedFeedReadService.js';
import { HanamiPersonalFeedComputationService } from '@/core/hanami/HanamiPersonalFeedComputationService.js';
import { HanamiRecommendationService as HanamiGenerationRecommendationService } from '@/core/hanami/HanamiRecommendationService.js';
import { HanamiTimelinePageService } from '@/core/hanami/HanamiTimelinePageService.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import {
	HANAMI_PERSISTED_FEED_READ,
	HANAMI_PERSONAL_FEED_COMPUTATION,
	HANAMI_USER_FEED_GENERATION_LIFECYCLE,
	HANAMI_USER_FEED_REQUEST,
} from '@/core/hanami/HanamiUserFeedContracts.js';
import { HanamiUserFeedGenerationService } from '@/core/hanami/HanamiUserFeedGenerationService.js';
import { HanamiUserFeedRequestService } from '@/core/hanami/HanamiUserFeedRequestService.js';
import { HanamiUserRecommendationService } from '@/core/hanami/HanamiUserRecommendationService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { QueueProcessorService } from '@/queue/QueueProcessorService.js';
import { HanamiCommonGenerationProcessorService } from '@/queue/processors/HanamiCommonGenerationProcessorService.js';
import { HanamiGenerationReconcileProcessorService } from '@/queue/processors/HanamiGenerationReconcileProcessorService.js';
import { HanamiRecommendationEventCacheRepairProcessorService } from '@/queue/processors/HanamiRecommendationEventCacheRepairProcessorService.js';
import { HanamiUserFeedGenerationProcessorService } from '@/queue/processors/HanamiUserFeedGenerationProcessorService.js';
import { ServerModule } from '@/server/ServerModule.js';
import type { Provider, Type } from '@nestjs/common';

type ExistingAlias = {
	provide: symbol;
	useExisting: Type<unknown>;
};

const phase4Aliases = [
	[HANAMI_PERSONAL_FEED_COMPUTATION, HanamiPersonalFeedComputationService],
	[HANAMI_USER_FEED_REQUEST, HanamiUserFeedRequestService],
	[HANAMI_USER_FEED_GENERATION_LIFECYCLE, HanamiUserFeedGenerationService],
	[HANAMI_PERSISTED_FEED_READ, HanamiPersistedFeedReadService],
] as const;

function moduleMetadata(module: Type<unknown>, key: 'providers' | 'exports'): readonly unknown[] {
	return (Reflect.getMetadata(key, module) as readonly unknown[] | undefined) ?? [];
}

function existingAlias(providers: readonly unknown[], token: symbol): ExistingAlias {
	const matches = providers.filter((provider): provider is ExistingAlias => (
		typeof provider === 'object'
		&& provider != null
		&& 'provide' in provider
		&& provider.provide === token
		&& 'useExisting' in provider
	));
	expect(matches).toHaveLength(1);
	const match = matches.at(0);
	if (match == null) throw new Error(`Missing useExisting provider for ${String(token)}`);
	return match;
}

async function loadQueueProcessorModule(): Promise<Type<unknown>> {
	const previousConfigPath = process.env.MISSKEY_CONFIG_YML;
	const previousSigningKeys = process.env.HANAMI_CURSOR_SIGNING_KEYS_JSON;
	process.env.MISSKEY_CONFIG_YML = 'example.yml';
	process.env.HANAMI_CURSOR_SIGNING_KEYS_JSON = JSON.stringify([{
		id: 'module-smoke',
		secret: 'module-smoke-signing-secret-32-bytes',
	}]);
	try {
		return (await import('@/queue/QueueProcessorModule.js')).QueueProcessorModule;
	} finally {
		if (previousConfigPath == null) delete process.env.MISSKEY_CONFIG_YML;
		else process.env.MISSKEY_CONFIG_YML = previousConfigPath;
		if (previousSigningKeys == null) delete process.env.HANAMI_CURSOR_SIGNING_KEYS_JSON;
		else process.env.HANAMI_CURSOR_SIGNING_KEYS_JSON = previousSigningKeys;
	}
}

describe('Hanami Phase 4/5 integration wiring workstream F', () => {
	test('production modules register and export the Phase 4/5 graph exactly once', async () => {
		const coreProviders = moduleMetadata(CoreModule, 'providers');
		const coreExports = moduleMetadata(CoreModule, 'exports');
		const QueueProcessorModule = await loadQueueProcessorModule();
		const queueProviders = moduleMetadata(QueueProcessorModule, 'providers');
		const serverProviders = moduleMetadata(ServerModule, 'providers');
		const concreteProviders = [
			HanamiGenerationRecommendationService,
			HanamiCommonHeadQueries,
			HanamiFeedLifecycleService,
			HanamiForYouService,
			HanamiForYouProvenanceService,
			HanamiForYouSafetyService,
			HanamiPersonalFeedComputationService,
			HanamiUserFeedRequestService,
			HanamiUserFeedGenerationService,
			HanamiPersistedFeedReadService,
			HanamiTimelinePageService,
		];

		for (const provider of concreteProviders) {
			expect(coreProviders.filter(candidate => candidate === provider)).toHaveLength(1);
			expect(coreExports.filter(candidate => candidate === provider)).toHaveLength(1);
		}
		for (const [token, implementation] of phase4Aliases) {
			expect(existingAlias(coreProviders, token).useExisting).toBe(implementation);
			expect(coreExports.filter(candidate => candidate === token)).toHaveLength(1);
		}
		expect(coreProviders.filter(candidate => candidate === LegacyHanamiRecommendationService)).toHaveLength(1);
		expect(HanamiGenerationRecommendationService).not.toBe(LegacyHanamiRecommendationService);

		expect(queueProviders.filter(provider => provider === HanamiCommonGenerationProcessorService)).toHaveLength(1);
		expect(queueProviders.filter(provider => provider === HanamiUserFeedGenerationProcessorService)).toHaveLength(1);
		expect(queueProviders.filter(provider => provider === HanamiGenerationReconcileProcessorService)).toHaveLength(1);
		expect(queueProviders.filter(provider => provider === HanamiRecommendationEventCacheRepairProcessorService)).toHaveLength(1);
		expect(queueProviders.filter(provider => provider === QueueProcessorService)).toHaveLength(1);
		expect(serverProviders.some(provider => (
			typeof provider === 'function' && provider.name === 'HanamiTimelineChannelService'
		))).toBe(false);
	});

	test('compiles the real Phase 4/5 services and queue consumers with minimal infrastructure', async () => {
		const coreProviders = moduleMetadata(CoreModule, 'providers');
		const aliasProviders = phase4Aliases.map(([token]) => existingAlias(coreProviders, token));
		const logger = {
			debug: jest.fn(),
			info: jest.fn(),
			succ: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			createSubLogger: jest.fn<() => unknown>(),
		};
		logger.createSubLogger.mockReturnValue(logger);
		const queueLoggerService = { logger };
		const legacyRecommendation = { legacy: true };
		const queueService = {};
		const qpsConcreteDependencies = new Set<unknown>([
			QueueLoggerService,
			HanamiCommonGenerationProcessorService,
			HanamiUserFeedGenerationProcessorService,
			HanamiGenerationReconcileProcessorService,
			HanamiRecommendationEventCacheRepairProcessorService,
		]);
		const qpsParameterTypes = (Reflect.getMetadata('design:paramtypes', QueueProcessorService) as readonly unknown[] | undefined) ?? [];
		const qpsDependencyMocks: Provider[] = [...new Set(qpsParameterTypes)]
			.filter((token): token is Type<unknown> => typeof token === 'function'
				&& token !== Object
				&& !qpsConcreteDependencies.has(token))
			.map(provide => ({ provide, useValue: {} }));

		// The alias objects come from CoreModule metadata; infrastructure and
		// unrelated queue processors are the only replaced parts of this graph.
		const module = await Test.createTestingModule({
			providers: [
				{ provide: DI.db, useValue: {} },
				{ provide: DI.config, useValue: {
					redisForJobQueue: { host: '127.0.0.1', port: 6379 },
					sentryForBackend: false,
					hanamiGenerationQueueConcurrency: 1,
					hanamiGenerationLeaseMs: 2000,
					hanamiGenerationWorkerTimeoutMs: 1000,
					hanamiGenerationMaxAttempts: 3,
					hanamiGenerationSyncWaitMs: 0,
				} },
				{ provide: DI.meta, useValue: {} },
				{ provide: DI.redis, useValue: {} },
				{ provide: DI.notesRepository, useValue: {} },
				{ provide: DI.hanamiRecommendationEventsRepository, useValue: {} },
				{ provide: FeaturedService, useValue: {} },
				{ provide: CacheService, useValue: {} },
				{ provide: IdService, useValue: { gen: jest.fn() } },
				{ provide: NoteEntityService, useValue: {} },
				{ provide: QueryService, useValue: {} },
				{ provide: RoleService, useValue: {} },
				{ provide: QueueService, useValue: queueService },
				{ provide: LoggerService, useValue: { getLogger: jest.fn(() => logger) } },
				{ provide: HanamiTrendService, useValue: {} },
				{ provide: HanamiUserRecommendationService, useValue: {} },
				{ provide: HanamiForYouBatchService, useValue: {} },
				{ provide: LegacyHanamiRecommendationService, useValue: legacyRecommendation },
				{ provide: HANAMI_COMMON_GENERATION_READ, useValue: {} },
				{ provide: HANAMI_COMMON_GENERATION_LIFECYCLE, useValue: {} },
				{ provide: QueueLoggerService, useValue: queueLoggerService },
				HanamiGenerationRecommendationService,
				HanamiCommonHeadQueries,
				HanamiFeedLifecycleService,
				HanamiForYouProvenanceService,
				HanamiForYouSafetyService,
				HanamiForYouService,
				HanamiPersonalFeedComputationService,
				HanamiUserFeedRequestService,
				HanamiUserFeedGenerationService,
				HanamiPersistedFeedReadService,
				...aliasProviders,
				HanamiTimelinePageService,
				HanamiCommonGenerationProcessorService,
				HanamiUserFeedGenerationProcessorService,
				HanamiGenerationReconcileProcessorService,
				HanamiRecommendationEventCacheRepairProcessorService,
				...qpsDependencyMocks,
				QueueProcessorService,
			],
		}).compile();

		try {
			for (const [token, implementation] of phase4Aliases) {
				expect(module.get(token)).toBe(module.get(implementation));
			}
			for (const provider of [
				HanamiGenerationRecommendationService,
				HanamiCommonHeadQueries,
				HanamiFeedLifecycleService,
				HanamiForYouService,
				HanamiForYouProvenanceService,
				HanamiForYouSafetyService,
				HanamiPersonalFeedComputationService,
				HanamiUserFeedRequestService,
				HanamiUserFeedGenerationService,
				HanamiPersistedFeedReadService,
				HanamiTimelinePageService,
				HanamiCommonGenerationProcessorService,
				HanamiUserFeedGenerationProcessorService,
				HanamiGenerationReconcileProcessorService,
				HanamiRecommendationEventCacheRepairProcessorService,
				QueueProcessorService,
			]) {
				expect(module.get(provider)).toBeInstanceOf(provider);
			}

			const commonHeadQueries = module.get(HanamiCommonHeadQueries);
			const lifecycle = module.get(HanamiFeedLifecycleService) as unknown as { commonHeadQueries: unknown };
			expect(lifecycle.commonHeadQueries).toBe(commonHeadQueries);

			const generationRecommendation = module.get(HanamiGenerationRecommendationService);
			const provenance = module.get(HanamiForYouProvenanceService) as unknown as { queueService: unknown };
			const page = module.get(HanamiTimelinePageService) as unknown as {
				redisClient: unknown;
				requestPort: unknown;
				readPort: unknown;
				safetyService: unknown;
				provenanceService: unknown;
			};
			const forYou = module.get(HanamiForYouService) as unknown as {
				hanamiRecommendationService: unknown;
				hanamiGenerationRecommendationService: unknown;
			};
			expect(forYou.hanamiRecommendationService).toBe(legacyRecommendation);
			expect(forYou.hanamiGenerationRecommendationService).toBe(generationRecommendation);
			expect(provenance.queueService).toBe(queueService);
			expect(page.redisClient).toBe(module.get(DI.redis));
			expect(page.requestPort).toBe(module.get(HANAMI_USER_FEED_REQUEST));
			expect(page.readPort).toBe(module.get(HANAMI_PERSISTED_FEED_READ));
			expect(page.safetyService).toBe(module.get(HanamiForYouSafetyService));
			expect(page.provenanceService).toBe(provenance);

			const userFeedGenerationProcessor = module.get(HanamiUserFeedGenerationProcessorService);
			const reconcileProcessor = module.get(HanamiGenerationReconcileProcessorService);
			const repairProcessor = module.get(HanamiRecommendationEventCacheRepairProcessorService) as unknown as {
				hanamiForYouProvenanceService: unknown;
			};
			const queueProcessor = module.get(QueueProcessorService) as unknown as {
				hanamiUserFeedGenerationProcessorService: unknown;
				hanamiGenerationReconcileProcessorService: unknown;
				hanamiRecommendationEventCacheRepairProcessorService: unknown;
			};
			expect((userFeedGenerationProcessor as unknown as { lifecycle: unknown }).lifecycle)
				.toBe(module.get(HANAMI_USER_FEED_GENERATION_LIFECYCLE));
			expect((reconcileProcessor as unknown as { userFeedLifecycle: unknown }).userFeedLifecycle)
				.toBe(module.get(HANAMI_USER_FEED_GENERATION_LIFECYCLE));
			expect(repairProcessor.hanamiForYouProvenanceService).toBe(provenance);
			expect(queueProcessor.hanamiUserFeedGenerationProcessorService).toBe(userFeedGenerationProcessor);
			expect(queueProcessor.hanamiGenerationReconcileProcessorService).toBe(reconcileProcessor);
			expect(queueProcessor.hanamiRecommendationEventCacheRepairProcessorService).toBe(repairProcessor);
		} finally {
			await module.close();
		}
	});
});
