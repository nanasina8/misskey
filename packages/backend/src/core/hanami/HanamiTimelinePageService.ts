/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiUserProfile } from '@/models/UserProfile.js';
import { CacheService } from '@/core/CacheService.js';
import {
	decodeAndVerifyHanamiCursor,
	encodeHanamiCommonFeedEntryLocator,
	encodeHanamiCursor,
	encodeHanamiPersonalFeedEntryLocator,
	HanamiFeedCodecError,
} from '@/core/hanami/HanamiFeedCodec.js';
import {
	HanamiForYouProvenanceService,
	HanamiInvalidFeedEntryError,
} from '@/core/hanami/HanamiForYouProvenanceService.js';
import { refreshHanamiForYouActiveMarker } from '@/core/hanami/HanamiForYouService.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import type {
	HanamiTimelinePageInput,
	HanamiTimelinePageResult,
	HanamiTimelinePackedEntry,
	HanamiTimelineResponse,
} from '@/core/hanami/HanamiTimelineContracts.js';
import {
	HANAMI_PERSISTED_FEED_READ,
	HANAMI_USER_FEED_AXES,
	HANAMI_USER_FEED_REQUEST,
	type HanamiFeedHeadSnapshot,
	type HanamiPersistedFeedEntry,
	type HanamiPersistedFeedReadPort,
	type HanamiUserFeedAxis,
	type HanamiUserFeedAvailabilityResult,
	type HanamiUserFeedRequestPort,
	type HanamiUserFeedRequestResult,
} from '@/core/hanami/HanamiUserFeedContracts.js';

type LegacyHanamiAxis = 'popular';
type HanamiAxisLevel = 'off' | 'low' | 'normal' | 'high';
type HanamiAxisServerConfig = Partial<Record<HanamiUserFeedAxis | LegacyHanamiAxis, { available?: boolean; default?: boolean }>>;
type HanamiAxisUserConfig = Partial<Record<HanamiUserFeedAxis | LegacyHanamiAxis, HanamiAxisLevel | boolean>>;
type HanamiTimelineProfile = Pick<MiUserProfile, 'hanamiRecommendationAxes' | 'hanamiShowRecommendationReason'>;

const AXIS_CONFIG_KEYS: Record<HanamiUserFeedAxis, readonly (HanamiUserFeedAxis | LegacyHanamiAxis)[]> = {
	globalPopular: ['globalPopular', 'popular'],
	exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'],
	reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'],
	trending: ['trending'],
	fof: ['fof'],
};

@Injectable()
export class HanamiTimelinePageService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(HANAMI_USER_FEED_REQUEST)
		private requestPort: HanamiUserFeedRequestPort,

		@Inject(HANAMI_PERSISTED_FEED_READ)
		private readPort: HanamiPersistedFeedReadPort,

		private cacheService: CacheService,
		private safetyService: HanamiForYouSafetyService,
		private provenanceService: HanamiForYouProvenanceService,
	) {}

	@bindThis
	public async serve(input: HanamiTimelinePageInput): Promise<HanamiTimelinePageResult> {
		const limit = Math.min(30, Math.max(1, input.request.limit));
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await this.serveAttempt(input, limit);
			} catch (error) {
				if (!(error instanceof HanamiInvalidFeedEntryError)) throw error;
				if (attempt === 0) continue;
				if (input.request.cursor != null) return { kind: 'cursorExpired' };
				throw error;
			}
		}
		throw new Error('Unreachable Hanami timeline retry state');
	}

	private async serveAttempt(input: HanamiTimelinePageInput, limit: number): Promise<HanamiTimelinePageResult> {
		const scanLimit = Math.min(500, Math.max(200, limit * 5));
		if (input.request.cursor != null) {
			const availability = await this.requestPort.checkAvailability(input.me.id);
			const unavailable = this.mapAvailability(availability);
			if (unavailable != null) return unavailable;

			let cursor;
			try {
				cursor = decodeAndVerifyHanamiCursor(input.request.cursor, this.config.hanamiCursorSigningKeys);
			} catch (error) {
				if (error instanceof HanamiFeedCodecError && error.code === 'CURSOR_KEY_EXPIRED') return { kind: 'cursorExpired' };
				if (error instanceof HanamiFeedCodecError && error.code === 'INVALID_CURSOR') return { kind: 'invalidCursor' };
				throw error;
			}
			if (cursor.userId !== input.me.id) return { kind: 'invalidCursor' };

			const resumed = await this.readPort.resumeReadyEntries({
				requesterUserId: input.me.id,
				cursor: {
					kind: cursor.kind,
					feedEpochId: cursor.epochId,
					sequence: cursor.sequence,
				},
				scanLimit,
			});
			if (resumed.kind === 'cursorExpired') return { kind: 'cursorExpired' };
			if (resumed.kind === 'commonNotReady') return { kind: 'commonNotReady' };
			return await this.packPage(input, resumed.head, resumed.entries, resumed.hasMore, false, limit, cursor.sequence);
		}

		let requested: HanamiUserFeedRequestResult;
		if (input.request.refresh) {
			if (input.request.refreshToken == null) return { kind: 'invalidRefreshToken' };
			requested = await this.requestPort.requestRefresh(input.me.id, input.request.refreshToken);
		} else {
			requested = await this.requestPort.evaluateCursorless(input.me.id);
		}
		const unavailable = this.mapRequestResult(requested);
		if (unavailable != null) return unavailable;
		if (requested.kind !== 'serve') throw new Error('Unreachable Hanami request result');

		const scanned = await this.readPort.scanReadyEntries({
			requesterUserId: input.me.id,
			head: requested.head,
			beforeSequence: null,
			scanLimit,
		});
		if (scanned.kind === 'cursorExpired') return { kind: 'cursorExpired' };
		if (scanned.kind === 'commonNotReady') return { kind: 'commonNotReady' };
		return await this.packPage(input, requested.head, scanned.entries, scanned.hasMore, requested.generationPending, limit, null);
	}

	private mapAvailability(result: HanamiUserFeedAvailabilityResult): HanamiTimelinePageResult | null {
		if (result.kind === 'available') return null;
		if (result.kind === 'roleDisabled') return { kind: 'roleDisabled' };
		return result.head == null ? { kind: 'commonNotReady' } : this.emptyResponse(result.head);
	}

	private mapRequestResult(result: HanamiUserFeedRequestResult): HanamiTimelinePageResult | null {
		switch (result.kind) {
			case 'serve': return null;
			case 'roleDisabled': return { kind: 'roleDisabled' };
			case 'recommendationDisabled': return result.head == null ? { kind: 'commonNotReady' } : this.emptyResponse(result.head);
			case 'commonNotReady': return { kind: 'commonNotReady' };
			case 'invalidRefreshToken': return { kind: 'invalidRefreshToken' };
			case 'refreshTokenExpired': return { kind: 'refreshTokenExpired' };
			case 'refreshRateLimited': return { kind: 'refreshRateLimited' };
		}
	}

	private emptyResponse(head: HanamiFeedHeadSnapshot): HanamiTimelinePageResult {
		return {
			kind: 'ok',
			response: {
				items: [],
				nextCursor: null,
				hasMore: false,
				mode: head.mode,
				generationPending: false,
				feedEpochId: head.feedEpochId,
				headBatchId: head.headBatchId,
			},
		};
	}

	private async packPage(
		input: HanamiTimelinePageInput,
		head: HanamiFeedHeadSnapshot,
		rawEntries: readonly HanamiPersistedFeedEntry[],
		readHasMore: boolean,
		generationPending: boolean,
		limit: number,
		previousSequence: string | null,
	): Promise<HanamiTimelinePageResult> {
		const profile = await this.cacheService.userProfileCache.fetch(input.me.id);
		const entries = head.mode === 'common'
			? this.filterEnabledCommonEntries(profile, rawEntries)
			: rawEntries;
		const packed = await this.safetyService.filterAndPackPersistedEntries({
			me: input.me,
			entries,
			limit,
			withFiles: input.request.withFiles,
		});
		if (packed.length > limit) throw new Error('Hanami safety packing exceeded the page limit');
		this.markRecommendationReasons(packed, profile.hanamiShowRecommendationReason);

		const consumedCount = packed.length === limit
			? this.lastPackedRawIndex(rawEntries, packed) + 1
			: rawEntries.length;
		const consumedSequence = consumedCount > 0 ? rawEntries[consumedCount - 1]?.sequence ?? null : null;
		const unconsumedFetched = consumedCount < rawEntries.length;
		const canAdvance = consumedSequence != null && consumedSequence !== previousSequence;
		const hasMore = (unconsumedFetched || readHasMore) && canAdvance;
		const nextCursor = hasMore
			? encodeHanamiCursor({
				userId: input.me.id,
				kind: head.kind,
				epochId: head.feedEpochId,
				sequence: consumedSequence,
			}, this.config.hanamiCursorSigningKeys)
			: null;

		const items = packed.map(({ entry, note }) => ({
			feedEntryId: this.entryLocator(input.me.id, entry),
			batchId: entry.batchId,
			note,
		}));
		if (items.length > 0) {
			await this.provenanceService.recordServedFeedEntries(input.me.id, packed.map((item, index) => ({
				feedEntryId: items[index]!.feedEntryId,
				entry: item.entry,
			})));
		}
		refreshHanamiForYouActiveMarker(this.redisClient, input.me.id);

		const response: HanamiTimelineResponse = {
			items,
			nextCursor,
			hasMore,
			mode: head.mode,
			generationPending,
			feedEpochId: head.feedEpochId,
			headBatchId: head.headBatchId,
		};
		return { kind: 'ok', response };
	}

	private lastPackedRawIndex(rawEntries: readonly HanamiPersistedFeedEntry[], packed: readonly HanamiTimelinePackedEntry[]): number {
		const lastEntry = packed.at(-1)?.entry;
		const index = lastEntry == null ? -1 : rawEntries.indexOf(lastEntry);
		if (index < 0) throw new Error('Hanami safety packing lost persisted-entry identity');
		return index;
	}

	private entryLocator(userId: string, entry: HanamiPersistedFeedEntry): string {
		return entry.kind === 'personal'
			? encodeHanamiPersonalFeedEntryLocator({ userId, epochId: entry.epochId, sequence: entry.sequence })
			: encodeHanamiCommonFeedEntryLocator({ epochId: entry.epochId, generatedMonth: entry.generatedMonth, rowId: entry.rowId });
	}

	private markRecommendationReasons(packed: readonly HanamiTimelinePackedEntry[], showReason: boolean): void {
		if (!showReason) return;
		for (const { entry, note } of packed) {
			if (entry.kind === 'common') {
				(note as Record<string, unknown>)._hanamiReason = { reason: entry.source };
				continue;
			}
			const metadata = entry.reasonMetadata;
			(note as Record<string, unknown>)._hanamiReason = {
				reason: entry.source,
				...(metadata.term !== undefined ? { term: metadata.term } : {}),
				...(metadata.clusterId !== undefined ? { clusterId: metadata.clusterId } : {}),
				...(metadata.bucket !== undefined ? { bucket: metadata.bucket } : {}),
			};
		}
	}

	private filterEnabledCommonEntries(profile: HanamiTimelineProfile, entries: readonly HanamiPersistedFeedEntry[]): readonly HanamiPersistedFeedEntry[] {
		if (entries.length === 0) return entries;
		const enabled = this.enabledAxes(profile);
		return entries.filter(entry => entry.kind !== 'common' || enabled.has(entry.source));
	}

	private enabledAxes(profile: Pick<MiUserProfile, 'hanamiRecommendationAxes'>): ReadonlySet<HanamiUserFeedAxis> {
		const serverConfig = (this.meta.hanamiRecommendationAxisConfig ?? {}) as HanamiAxisServerConfig;
		const userConfig = (profile.hanamiRecommendationAxes ?? {}) as HanamiAxisUserConfig;
		const enabled = new Set<HanamiUserFeedAxis>();
		for (const axis of HANAMI_USER_FEED_AXES) {
			const keys = AXIS_CONFIG_KEYS[axis];
			const available = keys.map(key => serverConfig[key]?.available).find(value => value !== undefined) ?? true;
			if (!available) continue;
			const defaultEnabled = keys.map(key => serverConfig[key]?.default).find(value => value !== undefined) ?? true;
			const userValue = keys.map(key => userConfig[key]).find(value => value !== undefined);
			const level = this.normalizeAxisLevel(userValue, defaultEnabled);
			if (level !== 'off') enabled.add(axis);
		}
		return enabled;
	}

	private normalizeAxisLevel(value: unknown, defaultEnabled: boolean): HanamiAxisLevel {
		if (value === 'off' || value === 'low' || value === 'normal' || value === 'high') return value;
		if (value === true) return 'normal';
		if (value === false) return 'off';
		return defaultEnabled ? 'normal' : 'off';
	}
}
