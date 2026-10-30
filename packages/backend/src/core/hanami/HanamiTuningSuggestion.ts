/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_FOR_YOU_AXES, type HanamiAxis } from './HanamiForYouInterleave.js';
import { roundHanamiWeight, type ResolvedHanamiTuning } from './HanamiTuning.js';

export const HANAMI_TUNING_MIN_SEEN = 200;
export const HANAMI_TUNING_MIN_REACTIONS = 10;
export const HANAMI_TUNING_PRIOR_SEEN = 30;
export type HanamiTuningCounts = { axis: HanamiAxis; seen: number; reactions: number; serverSeen: number; serverReactions: number };

/**
 * Only aggregates leave the database; distinct (user, note) counts preserve each viewer's reaction rate.
 * Engagement rows are written without feedKind (recordEngagement), so a NULL-feedKind engagement counts
 * when the same viewer was served that note on the personal feed under the same axis.
 */
export const HANAMI_TUNING_COUNTS_SQL = `
	SELECT e.source AS axis,
		COUNT(DISTINCT e."noteId") FILTER (WHERE e."userId" = $1 AND e."eventType" = 'seen')::int AS seen,
		COUNT(DISTINCT e."noteId") FILTER (WHERE e."userId" = $1 AND e."eventType" IN ('reaction', 'reply', 'renote'))::int AS reactions,
		COUNT(DISTINCT (e."userId", e."noteId")) FILTER (WHERE e."eventType" = 'seen')::int AS "serverSeen",
		COUNT(DISTINCT (e."userId", e."noteId")) FILTER (WHERE e."eventType" IN ('reaction', 'reply', 'renote'))::int AS "serverReactions"
	FROM hanami_recommendation_event e
	WHERE e.source = ANY($2::varchar[])
		AND COALESCE(e."occurredAt", e."createdAt") >= clock_timestamp() - INTERVAL '14 days' AND COALESCE(e."occurredAt", e."createdAt") <= clock_timestamp()
		AND ((e."eventType" = 'seen' AND e."feedKind" = 'personal')
			OR (e."eventType" IN ('reaction', 'reply', 'renote') AND (e."feedKind" = 'personal' OR (e."feedKind" IS NULL AND EXISTS (
				SELECT 1 FROM hanami_recommendation_event s
				WHERE s."userId" = e."userId" AND s."noteId" = e."noteId" AND s."eventType" = 'served'
					AND s."feedKind" = 'personal' AND s.source = e.source
			)))))
	GROUP BY e.source
`;

export function suggestHanamiTuning(rows: readonly HanamiTuningCounts[], tuning: ResolvedHanamiTuning) {
	const byAxis = new Map(rows.map(row => [row.axis, row]));
	const axes = HANAMI_FOR_YOU_AXES.map(axis => {
		const row = byAxis.get(axis);
		const seen = Number(row?.seen ?? 0);
		const reactions = Number(row?.reactions ?? 0);
		const serverRate = row && row.serverSeen > 0 ? row.serverReactions / row.serverSeen : 0;
		const rate = (reactions + HANAMI_TUNING_PRIOR_SEEN * serverRate) / (seen + HANAMI_TUNING_PRIOR_SEEN);
		return { axis, seen, reactions, rate, current: tuning.amounts.get(axis) ?? 0, suggested: 0 };
	});
	const totalSeen = axes.reduce((sum, axis) => sum + axis.seen, 0);
	const totalReactions = axes.reduce((sum, axis) => sum + axis.reactions, 0);
	const mean = totalSeen > 0 ? axes.reduce((sum, axis) => sum + axis.seen / totalSeen * axis.rate, 0) : 0;
	for (const axis of axes) {
		let factor = mean > 0 ? Math.max(0.5, Math.min(2, Math.sqrt(axis.rate / mean))) : 1;
		if (axis.axis === 'exploration') factor = Math.max(1, factor);
		axis.suggested = roundHanamiWeight(axis.current * factor);
	}
	return { eligible: totalSeen >= HANAMI_TUNING_MIN_SEEN && totalReactions >= HANAMI_TUNING_MIN_REACTIONS,
		minSeen: HANAMI_TUNING_MIN_SEEN, minReactions: HANAMI_TUNING_MIN_REACTIONS, totalSeen, totalReactions, axes };
}
