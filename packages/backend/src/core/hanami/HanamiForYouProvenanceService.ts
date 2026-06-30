/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { HanamiRecommendationEventsRepository } from '@/models/_.js';
import type { HanamiRecEventType } from '@/models/HanamiRecommendationEvent.js';
import {
	HANAMI_SERVED_PROVENANCE_LOOKBACK_MS,
	HANAMI_SOURCE_NORMAL,
} from './HanamiForYouKeys.js';

type ServedEntry = { noteId: MiNote['id']; source?: string | null };
type EventRow = { userId: MiUser['id']; noteId: MiNote['id']; eventType: HanamiRecEventType; source: string | null };

/**
 * はなみ For You の provenance 基盤（canonical spec §7.2）。
 *
 * served/seen/反応 を `hanami_recommendation_event` に best-effort で二重書きする。
 * 反応(reaction/reply/renote)は 14日以内の served を lookup して rec/normal を判定する。
 */
@Injectable()
export class HanamiForYouProvenanceService {
	constructor(
		@Inject(DI.hanamiRecommendationEventsRepository)
		private hanamiRecommendationEventsRepository: HanamiRecommendationEventsRepository,

		private idService: IdService,
	) {
	}

	/** served を PG event へ best-effort 記録。source は枠を消費した軸（§6.1-2）。 */
	@bindThis
	public async recordServedEvents(userId: MiUser['id'], entries: ServedEntry[]): Promise<void> {
		if (entries.length === 0) return;
		await this.insertEventsSafe(entries.map(e => ({
			userId,
			noteId: e.noteId,
			eventType: 'served' as const,
			source: e.source ?? null,
		})));
	}

	/** seen を PG event へ best-effort 記録（For You では rec として扱う）。 */
	@bindThis
	public async recordSeenEvents(userId: MiUser['id'], noteIds: MiNote['id'][]): Promise<void> {
		if (noteIds.length === 0) return;
		await this.insertEventsSafe(noteIds.map(noteId => ({
			userId,
			noteId,
			eventType: 'seen' as const,
			source: null,
		})));
	}

	/**
	 * 反応(reaction/reply/renote)を provenance 付きで記録（§7.2）。
	 * 14日以内に served 済みなら source=その軸（rec 由来）、無ければ 'normal'。
	 * hot path から best-effort（fire-and-forget）で呼ぶ前提。
	 */
	@bindThis
	public async recordEngagement(userId: MiUser['id'], noteId: MiNote['id'], eventType: 'reaction' | 'reply' | 'renote'): Promise<void> {
		try {
			const served = await this.lookupServed(userId, noteId);
			await this.insertEventsSafe([{
				userId,
				noteId,
				eventType,
				// served 行が無ければ 'normal'(rec 由来でない)。served だが axis NULL なら NULL(軸不明だが rec)を保持する
				// （'normal' に潰すと rec/normal provenance が壊れる）。
				source: served == null ? HANAMI_SOURCE_NORMAL : (served.source ?? null),
			}]);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: recordEngagement failed', err);
		}
	}

	/** 14日窓で最新の served event を引く（rec/normal 判定の素）。索引 (userId,noteId,eventType) を使う。 */
	@bindThis
	private async lookupServed(userId: MiUser['id'], noteId: MiNote['id']): Promise<{ source: string | null } | null> {
		const cutoff = new Date(Date.now() - HANAMI_SERVED_PROVENANCE_LOOKBACK_MS);
		const row = await this.hanamiRecommendationEventsRepository.createQueryBuilder('e')
			.select('e.source', 'source')
			.where('e.userId = :userId', { userId })
			.andWhere('e.noteId = :noteId', { noteId })
			.andWhere('e.eventType = :t', { t: 'served' })
			.andWhere('e.createdAt > :cutoff', { cutoff })
			.orderBy('e.createdAt', 'DESC')
			.limit(1)
			.getRawOne<{ source: string | null }>();
		if (row == null) return null;
		return { source: row.source ?? null };
	}

	private async insertEvents(rows: EventRow[]): Promise<void> {
		if (rows.length === 0) return;
		const now = new Date();
		const t = now.getTime();
		await this.hanamiRecommendationEventsRepository.insert(rows.map(r => ({
			id: this.idService.gen(t),
			userId: r.userId,
			noteId: r.noteId,
			eventType: r.eventType,
			source: r.source,
			createdAt: now,
		})));
	}

	/** 二重書きは best-effort。失敗しても短期重複排除(Redis)が効くので致命ではない。 */
	private async insertEventsSafe(rows: EventRow[]): Promise<void> {
		try {
			await this.insertEvents(rows);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('hanami foryou: provenance event write failed', err);
		}
	}
}
