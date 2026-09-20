/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { HanamiMetricsDimension, HanamiMetricsRange, HanamiMetricsResolvedRange, Metric } from './HanamiMetricsContracts.js';

export type HanamiMetricsCaps = { high: number; low: number; none: number };
export interface HanamiMetricsOpportunities {
	range: HanamiMetricsResolvedRange;
	allocation: { axis: string; share: number; engagementShare: number; ratio: number; capNow: HanamiMetricsCaps; verdict: 'under' | 'over' | 'balanced'; suggestedCap: HanamiMetricsCaps }[];
	content: { contentType: number | string; media: string; relationshipClass: string; served: number; engagementRate: number; lift: Metric; share: number; opportunity: Metric; note: string }[];
	supplyWalls: { axis: string; dropped: Record<string, number>; passed: number; note: string }[];
	demand: { axis: string; usersHigh: number; avgServedPerPageHigh: number; avgServedPerPageNormal: number; note: string }[];
	/** Rates use candidate records, NOT normal-TL exposures, as their denominator. */
	hiddenCost: { axis: string; hidden: number; normalEngagementOfHidden: number; normalEngagementOfShown: number }[];
	/** Latest captured day in range; effective level distribution, not a sum of daily users. */
	tuningDrift: Record<string, Record<string, number>>;
	unavailable: string[];
	suppressed: string[];
}

export interface HanamiMetricsWhatIfRequest {
	range?: HanamiMetricsRange;
	axis: 'exploration';
	thresholds: { interest?: number[]; ephemeral?: number[] };
}
export interface HanamiMetricsWhatIfPoint {
	theta: number;
	/** Unique notes in the current-prompt served exploration cohort, not a safety replay. */
	passed: Metric;
	/** Separate 0/1 reaction + reply + renote outcomes per served record; may exceed one. */
	passedEngagementRate: Metric;
}
export interface HanamiMetricsWhatIf {
	range: HanamiMetricsResolvedRange;
	interest: HanamiMetricsWhatIfPoint[];
	ephemeral: HanamiMetricsWhatIfPoint[];
	contentTypeBonus: { contentType: number; engagementRate: Metric; bonusNow: number }[];
	unavailable: string[];
	suppressed: string[];
}

export interface HanamiMetricsNotesRequest {
	range?: HanamiMetricsRange;
	dimension?: HanamiMetricsDimension;
	key?: string;
}
export interface HanamiMetricsNotes {
	range: HanamiMetricsResolvedRange;
	notes: { noteId: string; text: string; authorLocality: string; source: string; contentType: number | string; served: number; reaction: number; reply: number; renote: number; engagementRate: number }[];
	suppressed: string[];
	unavailable: string[];
}
