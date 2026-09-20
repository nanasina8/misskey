/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
import type { HanamiPersonalFeedItem } from '@/core/hanami/HanamiUserFeedContracts.js';

/** Internal generation diagnostics, never public per-item reason metadata. */
export type HanamiMetricsCandidateDecision = Readonly<{
	noteId: string;
	axis: HanamiAxis;
	decision: 'hiddenEphemeral' | 'shown';
}>;

/** Hidden rows come from the actual judge rejection branch, not a replay. */
export function createHanamiMetricsCandidateRows(
	hidden: readonly HanamiMetricsCandidateDecision[],
	items: readonly Pick<HanamiPersonalFeedItem, 'noteId' | 'source'>[],
): readonly HanamiMetricsCandidateDecision[] {
	const rows = new Map<string, HanamiMetricsCandidateDecision>();
	for (const row of [...hidden, ...items.map(item => ({ noteId: item.noteId, axis: item.source, decision: 'shown' as const }))]) {
		const key = JSON.stringify([row.noteId, row.axis, row.decision]);
		rows.set(key, Object.freeze({ noteId: row.noteId, axis: row.axis, decision: row.decision }));
	}
	return Object.freeze([...rows.values()]);
}

export type HanamiMetricsCaptureQuery = (sql: string, parameters?: unknown[]) => Promise<unknown>;

@Injectable()
export class HanamiMetricsCaptureService {
	/**
	 * Caller owns the guarded publish transaction and must call only after its CAS.
	 * No connection, transaction, background task or retry is started here.
	 * The query port must enforce the caller's deadline, but execute ROLLBACK TO
	 * directly: issuing timeout-configuration SQL in an aborted PG transaction
	 * before recovering the savepoint would itself fail.
	 * Ordinary INSERT failures are isolated; failed savepoint recovery propagates
	 * because the caller's transaction can no longer safely be used/committed.
	 * Calls on one transaction must be serial (the savepoint name is fixed).
	 */
	public async recordCandidates(
		batchId: string,
		userId: string,
		rows: readonly HanamiMetricsCandidateDecision[],
		capturedAt: string,
		query: HanamiMetricsCaptureQuery,
	): Promise<boolean> {
		if (rows.length === 0) return true;
		await query('SAVEPOINT hanami_metrics_candidates');
		try {
			await query(`
				INSERT INTO "hanami_metrics_candidate" ("batchId", "userId", "noteId", "axis", "decision", "capturedAt")
				SELECT $1, $2, input.note_id, input.axis, input.decision, $6::timestamptz
				FROM unnest($3::varchar[], $4::varchar[], $5::varchar[]) AS input(note_id, axis, decision)
				ON CONFLICT ("batchId", "userId", "noteId", "axis", "decision") DO NOTHING
			`, [batchId, userId, rows.map(row => row.noteId), rows.map(row => row.axis), rows.map(row => row.decision), capturedAt]);
		} catch {
			await query('ROLLBACK TO SAVEPOINT hanami_metrics_candidates');
			await query('RELEASE SAVEPOINT hanami_metrics_candidates');
			return false;
		}
		await query('RELEASE SAVEPOINT hanami_metrics_candidates');
		return true;
	}
}
