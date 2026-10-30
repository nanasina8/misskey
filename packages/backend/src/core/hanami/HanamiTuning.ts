/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_FOR_YOU_AXES, type HanamiAxis, type HanamiAxisLevel, type ForYouCandidate } from './HanamiForYouInterleave.js';

export type HanamiTuning = {
	mode: 'auto' | 'manual';
	closeness: number;
	freshness: number;
	discovery: number;
	manual?: {
		amounts: Partial<Record<HanamiAxis, number>>;
		freshWeights: number[];
		closeWeights: number[];
		authorCap: number;
	};
};
export type HanamiTuningProfile = { hanamiTuning?: Partial<HanamiTuning>; hanamiRecommendationAxes?: Record<string, unknown> };
export type HanamiAxisServerConfig = Partial<Record<HanamiAxis | 'popular', { available?: boolean; default?: boolean }>>;
export type ResolvedHanamiTuning = {
	amounts: Map<HanamiAxis, number>;
	freshWeights: [number, number, number];
	closeWeights: [number, number, number];
	authorCap: 1 | 2 | 3 | 4;
};
export const HANAMI_LEVEL_WEIGHT: Record<HanamiAxisLevel, number> = { off: 0, low: 0.55, normal: 1, high: 1.6 };
export const HANAMI_DISCOVERY_AMOUNTS = [
	[1.6, 1.6, 0.55, 0.55, 0], [1.6, 1, 1, 0.55, 0.55], [1, 1, 1, 1, 1],
	[1, 0.55, 1.6, 1, 1.6], [0.55, 0.55, 1.6, 1.6, 1.6],
] as const;
export const HANAMI_CLOSENESS_AMOUNTS = [[1.6, 1.6], [1.6, 1], [1, 1], [0.55, 1], [0.55, 0.55]] as const;
export const HANAMI_CLOSE_WEIGHTS = [[3, 2, 0.4], [1.8, 1.4, 0.7], [1, 1, 1], [0.7, 0.8, 1.3], [0.4, 0.6, 2]] as const;
export const HANAMI_FRESH_WEIGHTS = [[2.5, 1.5, 0.5], [1.6, 1.2, 0.75], [1, 1, 1], [0.8, 1, 1.25], [0.6, 1, 1.5]] as const;
const AXIS_KEYS: Record<HanamiAxis, readonly string[]> = {
	globalPopular: ['globalPopular', 'popular'], exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'], reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'], trending: ['trending'], fof: ['fof'],
};
const step = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4 ? value : 2;
export const roundHanamiWeight = (value: unknown, fallback = 1): number => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(3, value)) * 20) / 20 : fallback;
const weights = (value?: number[]): [number, number, number] => [0, 1, 2].map(i => roundHanamiWeight(value?.[i])) as [number, number, number];

function axisConfigValue(axis: HanamiAxis, config: HanamiAxisServerConfig, key: 'available' | 'default'): boolean {
	return AXIS_KEYS[axis].map(name => config[name as keyof HanamiAxisServerConfig]?.[key]).find(value => value !== undefined) ?? true;
}

export function getAvailableHanamiAxes(config: HanamiAxisServerConfig = {}): HanamiAxis[] {
	return HANAMI_FOR_YOU_AXES.filter(axis => axisConfigValue(axis, config, 'available'));
}

/** Read-time migration only. The legacy profile is never rewritten. */
export function normalizeHanamiTuning(profile: HanamiTuningProfile, serverAxisConfig: HanamiAxisServerConfig = {}): HanamiTuning {
	const raw = profile.hanamiTuning ?? {};
	const base: HanamiTuning = { mode: raw.mode === 'manual' ? 'manual' : 'auto', closeness: step(raw.closeness), freshness: step(raw.freshness), discovery: step(raw.discovery) };
	if (raw.manual) base.manual = {
		amounts: Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, roundHanamiWeight(raw.manual?.amounts?.[axis])])),
		freshWeights: weights(raw.manual.freshWeights), closeWeights: weights(raw.manual.closeWeights),
		authorCap: [1, 2, 3, 4].includes(raw.manual.authorCap) ? raw.manual.authorCap : 2,
	};
	if (Object.keys(raw).length === 0) {
		const old = profile.hanamiRecommendationAxes ?? {};
		let hasLegacyPreference = false;
		const amounts = Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => {
			const value = AXIS_KEYS[axis].map(key => old[key]).find(v => v !== undefined);
			const defaultEnabled = axisConfigValue(axis, serverAxisConfig, 'default');
			const explicit = typeof value === 'boolean' ? Number(value)
				: typeof value === 'string' && Object.hasOwn(HANAMI_LEVEL_WEIGHT, value) ? HANAMI_LEVEL_WEIGHT[value as HanamiAxisLevel] : undefined;
			// Preserve explicit legacy overrides, including enabling a default-off axis.
			if (explicit !== undefined && (explicit !== 1 || !defaultEnabled)) hasLegacyPreference = true;
			return [axis, explicit ?? Number(defaultEnabled)];
		}));
		if (hasLegacyPreference) {
			base.mode = 'manual';
			base.manual = { amounts, freshWeights: [1, 1, 1], closeWeights: [1, 1, 1], authorCap: 2 };
		}
	}
	return base;
}

export function resolveHanamiTuning(profile: HanamiTuningProfile, serverAxisConfig: HanamiAxisServerConfig = {}): ResolvedHanamiTuning {
	const tuning = normalizeHanamiTuning(profile, serverAxisConfig);
	const amounts = new Map<HanamiAxis, number>(HANAMI_FOR_YOU_AXES.map(axis => [axis, 1]));
	const manual = tuning.mode === 'manual' ? tuning.manual : undefined;
	if (tuning.mode === 'manual') {
		for (const axis of HANAMI_FOR_YOU_AXES) amounts.set(axis, manual?.amounts[axis] ?? 1);
	} else {
		(['globalPopular', 'trending', 'reactionSimilar', 'fof', 'exploration'] as const).forEach((axis, i) => amounts.set(axis, HANAMI_DISCOVERY_AMOUNTS[tuning.discovery][i]));
		amounts.set('catchup', HANAMI_CLOSENESS_AMOUNTS[tuning.closeness][0]);
		amounts.set('neighborTrending', HANAMI_CLOSENESS_AMOUNTS[tuning.closeness][1]);
	}
	for (const axis of HANAMI_FOR_YOU_AXES) {
		if (!axisConfigValue(axis, serverAxisConfig, 'available')
			|| (tuning.mode === 'auto' && !axisConfigValue(axis, serverAxisConfig, 'default'))) amounts.set(axis, 0);
	}
	return {
		amounts,
		freshWeights: tuning.mode === 'manual' ? weights(manual?.freshWeights) : [...HANAMI_FRESH_WEIGHTS[tuning.freshness]],
		closeWeights: tuning.mode === 'manual' ? weights(manual?.closeWeights) : [...HANAMI_CLOSE_WEIGHTS[tuning.closeness]],
		authorCap: (manual?.authorCap ?? 2) as 1 | 2 | 3 | 4,
	};
}

/** Suggestions scale the auto amounts, not the current ones, so re-applying the same suggestion is idempotent. */
export function resolveHanamiSuggestionBase(tuning: HanamiTuning, serverAxisConfig: HanamiAxisServerConfig = {}): Map<HanamiAxis, number> {
	return resolveHanamiTuning({ hanamiTuning: { ...tuning, mode: 'auto' } }, serverAxisConfig).amounts;
}

/** An axis the user turned off stays off; a manually enabled default-off axis scales from the normal amount. */
export function suggestHanamiAmount(current: number, base: number, factor: number): number {
	return current <= 0 ? 0 : roundHanamiWeight((base > 0 ? base : 1) * factor);
}

export function hanamiTuningScore(axis: HanamiAxis, candidate: Pick<ForYouCandidate, 'score' | 'relationshipClass'>, createdAt: number, now: number, tuning: ResolvedHanamiTuning): number {
	if (!(['globalPopular', 'trending', 'neighborTrending', 'reactionSimilar'] as HanamiAxis[]).includes(axis)) return candidate.score;
	const age = now - createdAt;
	const fresh = tuning.freshWeights[age <= 6 * 3600000 ? 0 : age <= 24 * 3600000 ? 1 : 2];
	const close = tuning.closeWeights[candidate.relationshipClass === 'directFollow' ? 0 : candidate.relationshipClass === 'known' ? 1 : 2];
	return candidate.score * fresh * close;
}
