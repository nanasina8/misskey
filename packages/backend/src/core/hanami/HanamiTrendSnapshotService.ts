/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { HanamiForYouSafetyService } from './HanamiForYouSafetyService.js';

const CURSOR_PREFIX = 'hts1';
const PG_BIGINT_MAX = '9223372036854775807';

type TrendCursor = {
	ordinal: string;
	rank: string;
};

type TrendRow = {
	trend_entry_id: string;
	snapshot_id: string;
	snapshot_generated_at: Date | string;
	snapshot_ordinal: string;
	rank: string;
	term: string;
	score: number;
	distinct_authors: number;
	representative_note_ids: string[];
};

export type HanamiTrendSnapshotResult = {
	kind: 'ok';
	response: {
		items: Array<{
			trendEntryId: string;
			snapshotId: string;
			snapshotGeneratedAt: string;
			term: string;
			score: number;
			distinctAuthors: number;
			representativeNote: Packed<'Note'> | null;
		}>;
		nextCursor: string | null;
		hasMore: boolean;
	};
} | {
	kind: 'invalidCursor' | 'cursorExpired';
};

@Injectable()
export class HanamiTrendSnapshotService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,
		@Inject(DI.config)
		private config: Config,
		private safetyService: HanamiForYouSafetyService,
	) {}

	@bindThis
	public async getPage(input: {
		history: boolean;
		limit: number;
		cursor: string | null;
		me: MiLocalUser | null;
	}): Promise<HanamiTrendSnapshotResult> {
		let cursor: TrendCursor | null = null;
		if (input.cursor != null) {
			try {
				cursor = this.decodeCursor(input.cursor);
			} catch (error) {
				return { kind: error instanceof TrendCursorKeyExpiredError ? 'cursorExpired' : 'invalidCursor' };
			}
		}

		const limit = input.history ? Math.min(30, Math.max(1, input.limit)) : 10;
		const values: unknown[] = [limit + 1];
		let boundarySql = '';
		let snapshotSql = '';
		if (input.history) {
			if (cursor != null) {
				values.push(cursor.ordinal, cursor.rank);
				boundarySql = `AND (snapshot."ordinal" < $2::bigint OR (snapshot."ordinal" = $2::bigint AND entry."rank" > $3::bigint))`;
			}
		} else {
			snapshotSql = `AND snapshot."id" = (SELECT latest."id" FROM "hanami_trend_snapshot" latest JOIN "hanami_common_generation" latest_generation ON latest_generation."id" = latest."commonGenerationId" AND latest_generation."status" = 'ready' WHERE latest."status" = 'ready' ORDER BY latest."ordinal" DESC LIMIT 1)`;
		}

		const rows = await this.db.query(`
			SELECT entry."id" AS trend_entry_id, snapshot."id" AS snapshot_id,
				snapshot."generatedAt" AS snapshot_generated_at, snapshot."ordinal"::text AS snapshot_ordinal,
				entry."rank"::text AS rank, entry."term" AS term, entry."score" AS score,
				entry."distinctAuthors" AS distinct_authors,
				ARRAY(
					SELECT representative."noteId"
					FROM "hanami_trend_snapshot_representative_note" representative
					WHERE representative."snapshotId" = snapshot."id" AND representative."rank" = entry."rank"
					ORDER BY representative."position" ASC
				) AS representative_note_ids
			FROM "hanami_trend_snapshot_entry" entry
			JOIN "hanami_trend_snapshot" snapshot ON snapshot."id" = entry."snapshotId" AND snapshot."status" = 'ready'
			JOIN "hanami_common_generation" generation ON generation."id" = snapshot."commonGenerationId" AND generation."status" = 'ready'
			WHERE TRUE ${snapshotSql} ${boundarySql}
			ORDER BY snapshot."ordinal" DESC, entry."rank" ASC
			LIMIT $1
		`, values) as TrendRow[];
		const hasMore = input.history && rows.length > limit;
		const pageRows = rows.slice(0, limit);
		const representativeIds = [...new Set(pageRows.flatMap(row => row.representative_note_ids))];
		const packed = await this.safetyService.filterAndPackPublic(representativeIds, input.me);
		const packedById = new Map(packed.map(note => [note.id, note]));
		const last = pageRows.at(-1);
		const nextCursor = hasMore && last != null ? this.encodeCursor({ ordinal: last.snapshot_ordinal, rank: last.rank }) : null;

		return {
			kind: 'ok',
			response: {
				items: pageRows.map(row => ({
					trendEntryId: row.trend_entry_id,
					snapshotId: row.snapshot_id,
					snapshotGeneratedAt: this.toIsoString(row.snapshot_generated_at),
					term: row.term,
					score: Number(row.score),
					distinctAuthors: Number(row.distinct_authors),
					representativeNote: row.representative_note_ids.map(id => packedById.get(id)).find(note => note != null) ?? null,
				})),
				nextCursor,
				hasMore: nextCursor != null,
			},
		};
	}

	private toIsoString(value: Date | string): string {
		return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
	}

	private encodeCursor(cursor: TrendCursor): string {
		this.validateDecimal(cursor.ordinal);
		this.validateDecimal(cursor.rank);
		const key = this.config.hanamiCursorSigningKeys[0]!;
		const payload = Buffer.from(JSON.stringify(['HTS', 1, key.id, 'history', cursor.ordinal, cursor.rank]), 'utf8').toString('base64url');
		const input = `${CURSOR_PREFIX}.${payload}`;
		const signature = createHmac('sha256', key.secret).update(input, 'ascii').digest('base64url');
		return `${input}.${signature}`;
	}

	private decodeCursor(cursor: string): TrendCursor {
		const parts = cursor.split('.');
		if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX || parts[1]!.includes('=') || parts[2]!.includes('=')) throw new Error('Invalid trend cursor');
		const payloadBuffer = Buffer.from(parts[1]!, 'base64url');
		if (payloadBuffer.toString('base64url') !== parts[1]) throw new Error('Non-canonical trend cursor');
		const value = JSON.parse(payloadBuffer.toString('utf8')) as unknown;
		if (!Array.isArray(value) || value.length !== 6 || value[0] !== 'HTS' || value[1] !== 1
			|| typeof value[2] !== 'string' || value[3] !== 'history' || typeof value[4] !== 'string' || typeof value[5] !== 'string') {
			throw new Error('Invalid trend cursor payload');
		}
		const key = this.config.hanamiCursorSigningKeys.find(candidate => candidate.id === value[2]);
		if (key == null) throw new TrendCursorKeyExpiredError();
		const expected = createHmac('sha256', key.secret).update(`${CURSOR_PREFIX}.${parts[1]}`, 'ascii').digest();
		const signature = Buffer.from(parts[2]!, 'base64url');
		if (signature.toString('base64url') !== parts[2] || signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('Invalid trend cursor signature');
		this.validateDecimal(value[4]);
		this.validateDecimal(value[5]);
		return { ordinal: value[4], rank: value[5] };
	}

	private validateDecimal(value: string): void {
		if (!/^(?:0|[1-9]\d*)$/.test(value) || value.length > PG_BIGINT_MAX.length || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
			throw new Error('Invalid trend cursor decimal');
		}
	}
}

class TrendCursorKeyExpiredError extends Error {}
