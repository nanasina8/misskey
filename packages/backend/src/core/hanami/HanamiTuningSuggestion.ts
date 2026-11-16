/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_FOR_YOU_AXES, type HanamiAxis } from './HanamiForYouInterleave.js';
import { HANAMI_AXIS_GROUPS, HANAMI_AXIS_GROUP_NAMES, nearestHanamiGroupLevel, suggestHanamiAmount, type HanamiAxisGroup, type ResolvedHanamiTuning } from './HanamiTuning.js';

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

type HanamiTuningRate = { axis: HanamiAxis; seen: number; reactions: number; rate: number; factor: number; weight: number };

/**
 * 種類ごとの反応率と、「反応からの倍率」を出す。
 * - 反応率は、本人の件数が少ないほどサーバー全体の反応率に寄せる（見た HANAMI_TUNING_PRIOR_SEEN 件ぶんを足す）。
 * - 平均も同じ考え方で、本人が見た件数にサーバー全体の見られ方を足した重みで取る。
 *   こうすると、まだ反応が無い人はサーバー全体の傾向で動き、使うほど本人の反応に置き換わる。
 * - 倍率は「その種類の反応率 ÷ 平均」の平方根で、0.5〜2 に収める。発見は 1 未満にしない。
 */
function computeHanamiTuningRates(rows: readonly HanamiTuningCounts[]): HanamiTuningRate[] {
	const byAxis = new Map(rows.map(row => [row.axis, row]));
	const totalServerSeen = rows.reduce((sum, row) => sum + Math.max(0, Number(row.serverSeen) || 0), 0);
	const rates = HANAMI_FOR_YOU_AXES.map(axis => {
		const row = byAxis.get(axis);
		const seen = Number(row?.seen ?? 0);
		const reactions = Number(row?.reactions ?? 0);
		const serverSeen = Math.max(0, Number(row?.serverSeen ?? 0) || 0);
		const serverRate = row && serverSeen > 0 ? row.serverReactions / serverSeen : 0;
		const rate = (reactions + HANAMI_TUNING_PRIOR_SEEN * serverRate) / (seen + HANAMI_TUNING_PRIOR_SEEN);
		const weight = seen + (totalServerSeen > 0 ? HANAMI_TUNING_PRIOR_SEEN * serverSeen / totalServerSeen : 0);
		return { axis, seen, reactions, rate, factor: 1, weight };
	});
	const totalWeight = rates.reduce((sum, item) => sum + item.weight, 0);
	const mean = totalWeight > 0 ? rates.reduce((sum, item) => sum + item.weight / totalWeight * item.rate, 0) : 0;
	for (const item of rates) {
		item.factor = mean > 0 ? Math.max(0.5, Math.min(2, Math.sqrt(item.rate / mean))) : 1;
		if (item.axis === 'exploration') item.factor = Math.max(1, item.factor);
	}
	return rates;
}

/** 生成のときに使う、種類ごとの「反応からの倍率」。 */
export function computeHanamiDriftFactors(rows: readonly HanamiTuningCounts[]): Map<HanamiAxis, number> {
	return new Map(computeHanamiTuningRates(rows).map(item => [item.axis, item.factor]));
}

/**
 * 設定画面に返す内容。
 * - axes[].factor: 反応からの倍率。おまかせ・方向だけ決める では、寄せ方の幅に収めて量に掛ける。
 * - axes[].suggested: 「すべて自分で」に入れるおすすめの量。
 * - groups: 「おすすめから調整」の初めの値（まとまりごとの 0〜4）。
 * - eligible: 本人の反応だけで判断できる件数があるか。足りない間はサーバー全体の傾向で補っている。
 */
export function suggestHanamiTuning(rows: readonly HanamiTuningCounts[], tuning: ResolvedHanamiTuning, base: ReadonlyMap<HanamiAxis, number>) {
	const rates = computeHanamiTuningRates(rows);
	const axes = rates.map(item => ({
		axis: item.axis, seen: item.seen, reactions: item.reactions, rate: item.rate, factor: item.factor,
		current: tuning.amounts.get(item.axis) ?? 0,
		suggested: suggestHanamiAmount(tuning.amounts.get(item.axis) ?? 0, base.get(item.axis) ?? 0, item.factor),
	}));
	const totalSeen = axes.reduce((sum, axis) => sum + axis.seen, 0);
	const totalReactions = axes.reduce((sum, axis) => sum + axis.reactions, 0);
	const groups = Object.fromEntries(HANAMI_AXIS_GROUP_NAMES.map(group => {
		const members = rates.filter(item => HANAMI_AXIS_GROUPS[group].includes(item.axis));
		const weight = members.reduce((sum, item) => sum + item.weight, 0);
		const factor = weight > 0 ? members.reduce((sum, item) => sum + item.weight / weight * item.factor, 0) : 1;
		// 発見を自動で減らさないのと同じ理由で、新しい出会いは「ふつう」より下をおすすめにしない。
		const level = nearestHanamiGroupLevel(factor);
		return [group, group === 'fresh' ? Math.max(2, level) : level];
	})) as Record<HanamiAxisGroup, number>;
	return { eligible: totalSeen >= HANAMI_TUNING_MIN_SEEN && totalReactions >= HANAMI_TUNING_MIN_REACTIONS,
		minSeen: HANAMI_TUNING_MIN_SEEN, minReactions: HANAMI_TUNING_MIN_REACTIONS, totalSeen, totalReactions, axes, groups };
}
