/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_FOR_YOU_AXES, type HanamiAxis, type HanamiAxisLevel, type ForYouCandidate } from './HanamiForYouInterleave.js';

export const HANAMI_TUNING_MODES = ['auto', 'direction', 'recommend', 'manual'] as const;
export type HanamiTuningMode = typeof HANAMI_TUNING_MODES[number];
/** 7 つの種類を、画面で見せる 3 つのまとまりに分ける。 */
export const HANAMI_AXIS_GROUP_NAMES = ['close', 'buzz', 'fresh'] as const;
export type HanamiAxisGroup = typeof HANAMI_AXIS_GROUP_NAMES[number];
export const HANAMI_AXIS_GROUPS: Record<HanamiAxisGroup, readonly HanamiAxis[]> = {
	close: ['neighborTrending', 'catchup', 'fof'],
	buzz: ['globalPopular', 'trending'],
	fresh: ['exploration', 'reactionSimilar'],
};

export type HanamiTuning = {
	/** auto = おまかせ / direction = 方向だけ決める / recommend = おすすめから調整 / manual = すべて自分で */
	mode: HanamiTuningMode;
	/** 0 = 身近な人中心 / 1 = バランス / 2 = 広く出会う（direction のときに使う） */
	direction: number;
	/** 反応への寄せ方。0 = ひかえめ / 1 = ふつう / 2 = しっかり（direction のときに使う） */
	drift: number;
	/** まとまりごとの量 0〜4。2 がふつう（recommend のときに使う） */
	groups: Record<HanamiAxisGroup, number>;
	manual?: {
		amounts: Partial<Record<HanamiAxis, number>>;
		authorCap: number;
	};
};
/** 保存されている値。旧形式（スライダー 3 本と倍率）も読めるようにし、読むときだけ新形式に直す。 */
export type HanamiTuningInput = {
	mode?: HanamiTuningMode;
	direction?: number;
	drift?: number;
	groups?: Partial<Record<HanamiAxisGroup, number>>;
	manual?: { amounts?: Partial<Record<HanamiAxis, number>>; authorCap?: number; freshWeights?: number[]; closeWeights?: number[] };
	closeness?: number;
	freshness?: number;
	discovery?: number;
};
export type HanamiTuningProfile = { hanamiTuning?: HanamiTuningInput; hanamiRecommendationAxes?: Record<string, unknown> };
export type HanamiAxisServerConfig = Partial<Record<HanamiAxis | 'popular', { available?: boolean; default?: boolean }>>;
export type ResolvedHanamiTuning = {
	amounts: Map<HanamiAxis, number>;
	freshWeights: [number, number, number];
	closeWeights: [number, number, number];
	authorCap: 1 | 2 | 3 | 4;
};
export const HANAMI_LEVEL_WEIGHT: Record<HanamiAxisLevel, number> = { off: 0, low: 0.55, normal: 1, high: 1.6 };
/** 方向ごとの量。並びは [身近な人から, みんなの話題, 新しい出会い]。初めの割合 66:23:11 に掛けると、およそ 8:1:1 / 7:2:1 / 5:3:2 になる。 */
export const HANAMI_DIRECTION_AMOUNTS = [[1.3, 0.55, 0.8], [1, 1, 1], [0.7, 1.4, 1.8]] as const;
/** 方向ごとの、人気・話題の中での相手との関係の重み。並びは [フォロー中, 知っている人, その他]。 */
export const HANAMI_DIRECTION_CLOSE_WEIGHTS = [[1.8, 1.4, 0.7], [1, 1, 1], [0.7, 0.8, 1.3]] as const;
/** 「おすすめから調整」の 5 段階の量。 */
export const HANAMI_GROUP_LEVEL_AMOUNTS = [0.4, 0.7, 1, 1.4, 1.9] as const;
/** 反応への寄せ方ごとの、動ける幅（下限・上限の倍率）。 */
export const HANAMI_DRIFT_BOUNDS = [[0.85, 1.18], [0.7, 1.4], [0.5, 2]] as const;
/** 「おまかせ」の寄せ方（ふつう）。 */
export const HANAMI_AUTO_DRIFT = 1;
const AXIS_KEYS: Record<HanamiAxis, readonly string[]> = {
	globalPopular: ['globalPopular', 'popular'], exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'], reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'], trending: ['trending'], fof: ['fof'],
};
const step = (value: unknown, max: number, fallback: number): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;
export const roundHanamiWeight = (value: unknown, fallback = 1): number => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(3, value)) * 20) / 20 : fallback;

function axisConfigValue(axis: HanamiAxis, config: HanamiAxisServerConfig, key: 'available' | 'default'): boolean {
	return AXIS_KEYS[axis].map(name => config[name as keyof HanamiAxisServerConfig]?.[key]).find(value => value !== undefined) ?? true;
}

export function getAvailableHanamiAxes(config: HanamiAxisServerConfig = {}): HanamiAxis[] {
	return HANAMI_FOR_YOU_AXES.filter(axis => axisConfigValue(axis, config, 'available'));
}

/** Read-time migration only. The legacy profile is never rewritten. */
export function normalizeHanamiTuning(profile: HanamiTuningProfile, serverAxisConfig: HanamiAxisServerConfig = {}): HanamiTuning {
	const raw = profile.hanamiTuning ?? {};
	// 旧形式の「身近さ」スライダーは、方向の 3 択に引き継ぐ（0・1 = 身近な人中心 / 2 = バランス / 3・4 = 広く出会う）。
	const legacyCloseness = raw.direction === undefined ? step(raw.closeness, 4, 2) : 2;
	const base: HanamiTuning = {
		mode: (HANAMI_TUNING_MODES as readonly unknown[]).includes(raw.mode) ? raw.mode as HanamiTuningMode : 'auto',
		direction: step(raw.direction, 2, legacyCloseness <= 1 ? 0 : legacyCloseness >= 3 ? 2 : 1),
		drift: step(raw.drift, 2, 1),
		groups: { close: step(raw.groups?.close, 4, 2), buzz: step(raw.groups?.buzz, 4, 2), fresh: step(raw.groups?.fresh, 4, 2) },
	};
	// 旧「おまかせ」で身近さを動かしていた人は、その向きを「方向だけ決める」として残す。
	if (base.mode === 'auto' && legacyCloseness !== 2) base.mode = 'direction';
	if (raw.manual) base.manual = {
		amounts: Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, roundHanamiWeight(raw.manual?.amounts?.[axis])])),
		authorCap: [1, 2, 3, 4].includes(raw.manual.authorCap as number) ? raw.manual.authorCap as number : 2,
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
			base.manual = { amounts, authorCap: 2 };
		}
	}
	return base;
}

/** 反応に合わせて自動で寄せる調整のしかたなら、その寄せ方（0〜2）。自動で動かさないなら null。 */
export function hanamiDriftLevel(tuning: HanamiTuning): number | null {
	return tuning.mode === 'auto' ? HANAMI_AUTO_DRIFT : tuning.mode === 'direction' ? tuning.drift : null;
}

/** 反応からの倍率を、寄せ方ごとの幅に収めて量に掛ける。発見は自動では減らさない。 */
export function applyHanamiDrift(axis: HanamiAxis, amount: number, factor: number | undefined, level: number): number {
	if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) return amount;
	const [low, high] = HANAMI_DRIFT_BOUNDS[level] ?? HANAMI_DRIFT_BOUNDS[HANAMI_AUTO_DRIFT];
	const bounded = Math.max(axis === 'exploration' ? 1 : low, Math.min(high, factor));
	return Math.round(amount * bounded * 100) / 100;
}

/** 倍率にいちばん近い「おすすめから調整」の段階（0〜4）。比で比べる。 */
export function nearestHanamiGroupLevel(factor: number): number {
	if (!Number.isFinite(factor) || factor <= 0) return 2;
	let best = 2;
	HANAMI_GROUP_LEVEL_AMOUNTS.forEach((amount, level) => {
		if (Math.abs(Math.log(amount / factor)) < Math.abs(Math.log(HANAMI_GROUP_LEVEL_AMOUNTS[best] / factor)) - 1e-9) best = level;
	});
	return best;
}

/**
 * driftFactors は種類ごとの「反応からの倍率」（HanamiTuningSuggestion が出す）。
 * おまかせ・方向だけ決める のときだけ、寄せ方の幅に収めて掛ける。渡さなければ動かさない量を返す。
 */
export function resolveHanamiTuning(profile: HanamiTuningProfile, serverAxisConfig: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): ResolvedHanamiTuning {
	const tuning = normalizeHanamiTuning(profile, serverAxisConfig);
	const amounts = new Map<HanamiAxis, number>(HANAMI_FOR_YOU_AXES.map(axis => [axis, 1]));
	const manual = tuning.mode === 'manual' ? tuning.manual : undefined;
	if (tuning.mode === 'manual') {
		for (const axis of HANAMI_FOR_YOU_AXES) amounts.set(axis, manual?.amounts[axis] ?? 1);
	} else if (tuning.mode !== 'auto') {
		HANAMI_AXIS_GROUP_NAMES.forEach((group, i) => {
			const amount = tuning.mode === 'direction' ? HANAMI_DIRECTION_AMOUNTS[tuning.direction][i] : HANAMI_GROUP_LEVEL_AMOUNTS[tuning.groups[group]];
			for (const axis of HANAMI_AXIS_GROUPS[group]) amounts.set(axis, amount);
		});
	}
	const driftLevel = hanamiDriftLevel(tuning);
	if (driftLevel != null && driftFactors != null) {
		for (const axis of HANAMI_FOR_YOU_AXES) amounts.set(axis, applyHanamiDrift(axis, amounts.get(axis) ?? 0, driftFactors.get(axis), driftLevel));
	}
	for (const axis of HANAMI_FOR_YOU_AXES) {
		if (!axisConfigValue(axis, serverAxisConfig, 'available')
			|| (tuning.mode !== 'manual' && !axisConfigValue(axis, serverAxisConfig, 'default'))) amounts.set(axis, 0);
	}
	return {
		amounts,
		freshWeights: [1, 1, 1],
		closeWeights: tuning.mode === 'direction' ? [...HANAMI_DIRECTION_CLOSE_WEIGHTS[tuning.direction]] : [1, 1, 1],
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
