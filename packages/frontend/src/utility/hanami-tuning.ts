/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const HANAMI_FOR_YOU_AXES = ['globalPopular', 'neighborTrending', 'reactionSimilar', 'catchup', 'trending', 'fof', 'exploration'] as const;
export type HanamiAxis = typeof HANAMI_FOR_YOU_AXES[number];
type HanamiAxisLevel = 'off' | 'low' | 'normal' | 'high';

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

// Kept in sync with high-confidence backend shares by hanami-tuning.contract.ts.
export const HANAMI_TUNING_ORDER: readonly HanamiAxis[] = ['globalPopular', 'neighborTrending', 'reactionSimilar', 'trending', 'catchup', 'fof', 'exploration'];
export const HANAMI_BASE_SHARE: Record<HanamiAxis, number> = { globalPopular: 0.20, neighborTrending: 0.42, reactionSimilar: 0.03, catchup: 0.14, trending: 0.03, fof: 0.10, exploration: 0.08 };
export function computeHanamiCaps(amounts: ReadonlyMap<HanamiAxis, number>, limit = 210): Map<HanamiAxis, number> {
	const natural = HANAMI_TUNING_ORDER.reduce((sum, axis) => sum + HANAMI_BASE_SHARE[axis], 0);
	const total = HANAMI_TUNING_ORDER.reduce((sum, axis) => sum + HANAMI_BASE_SHARE[axis] * (amounts.get(axis) ?? 0), 0);
	return new Map(HANAMI_TUNING_ORDER.map(axis => {
		const weight = HANAMI_BASE_SHARE[axis] * (amounts.get(axis) ?? 0);
		// backend の computeCaps と同じく、浮動小数の誤差で 1 件多く切り上がらないようにする。
		return [axis, total > 0 && weight > 0 ? Math.max(1, Math.ceil(limit * natural * weight / total - 1e-9)) : 0];
	}));
}
/** 種類ごとの割合（%）。driftFactors を渡すと、反応に合わせて寄せたあとの「いま」の割合になる。 */
export function hanamiComposition(tuning: HanamiTuning, config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): Map<HanamiAxis, number> {
	const caps = computeHanamiCaps(resolveHanamiTuning({ hanamiTuning: tuning }, config, driftFactors).amounts);
	const total = [...caps.values()].reduce((a, b) => a + b, 0);
	return new Map([...caps].map(([axis, cap]) => [axis, total > 0 ? 100 * cap / total : 0]));
}
/** まとまりごとの割合（%）。 */
export function hanamiGroupComposition(tuning: HanamiTuning, config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): Record<HanamiAxisGroup, number> {
	const composition = hanamiComposition(tuning, config, driftFactors);
	const sum = (group: HanamiAxisGroup): number => HANAMI_AXIS_GROUPS[group].reduce((total, axis) => total + (composition.get(axis) ?? 0), 0);
	return { close: sum('close'), buzz: sum('buzz'), fresh: sum('fresh') };
}
/** 割合（%）を「10 件のうち何件」に直す。端数の大きい順に配って、合計をちょうど 10 件にする。 */
export function hanamiTenTiles(shares: Record<HanamiAxisGroup, number>): Record<HanamiAxisGroup, number> {
	const total = HANAMI_AXIS_GROUP_NAMES.reduce((sum, group) => sum + shares[group], 0);
	if (total <= 0) return { close: 0, buzz: 0, fresh: 0 };
	const exact = HANAMI_AXIS_GROUP_NAMES.map(group => shares[group] / total * 10);
	const counts = exact.map(value => Math.floor(value));
	const order = exact.map((value, index) => [value - Math.floor(value), index] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	for (let i = 0, rest = 10 - counts.reduce((a, b) => a + b, 0); rest > 0; i++, rest--) counts[order[i % order.length][1]]++;
	return { close: counts[0], buzz: counts[1], fresh: counts[2] };
}
/**
 * 調整のしかたを切り替える。「すべて自分で」へ移るときは、いま出ている量（driftFactors を渡せば寄せたあとの量）を初めの値にする。
 * それ以外へ移るときは、方向・寄せ方・まとまりの量をそのまま残す。
 */
export function switchHanamiMode(tuning: HanamiTuning, mode: HanamiTuning['mode'], config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): HanamiTuning {
	if (mode === tuning.mode) return tuning;
	if (mode !== 'manual') return { ...tuning, mode };
	const resolved = resolveHanamiTuning({ hanamiTuning: tuning }, config, driftFactors);
	return { ...tuning, mode, manual: { amounts: Object.fromEntries([...resolved.amounts].map(([axis, amount]) => [axis, roundHanamiWeight(amount)])), authorCap: resolved.authorCap } };
}
export function adjustHanamiAmount(tuning: HanamiTuning, axis: HanamiAxis, delta: number, config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): HanamiTuning {
	const manual = switchHanamiMode(tuning, 'manual', config, driftFactors);
	const resolved = resolveHanamiTuning({ hanamiTuning: manual }, config);
	return { ...manual, manual: { amounts: { ...Object.fromEntries(resolved.amounts), [axis]: roundHanamiWeight((resolved.amounts.get(axis) ?? 1) + delta) }, authorCap: resolved.authorCap } };
}
export type HanamiTuningUpdate = { hanamiTuning: HanamiTuning; hanamiReduceEphemeralPosts: boolean };
export function resetHanamiTuning(): HanamiTuningUpdate {
	return { hanamiTuning: normalizeHanamiTuning({}), hanamiReduceEphemeralPosts: true };
}

/** Serialized trailing debounce. Edits during a request collapse into one latest snapshot. */
export class HanamiTuningSaveQueue {
	private timer: number | undefined;
	private pending: HanamiTuningUpdate | null = null;
	private sending = false;
	constructor(private save: (value: HanamiTuningUpdate) => Promise<void>, private refresh: () => void, private onError: (error: unknown) => void) {}
	public enqueue(value: HanamiTuningUpdate): void {
		this.pending = structuredClone(value);
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush(); }, 600);
	}
	private async flush(): Promise<void> {
		if (this.sending || this.pending == null) return;
		const value = this.pending;
		this.pending = null;
		this.sending = true;
		try { await this.save(value); this.refresh(); } catch (error) { this.onError(error); } finally {
			this.sending = false;
			if (this.pending != null) { window.clearTimeout(this.timer); this.timer = undefined; void this.flush(); }
		}
	}
}

/** One action, one undo; later edits invalidate it at the client boundary. */
export function createHanamiTuningUndo(previous: HanamiTuning, restore: (tuning: HanamiTuning) => void, now = Date.now): () => boolean {
	const snapshot = structuredClone(previous);
	const expiresAt = now() + 8000;
	let used = false;
	return () => {
		if (used || now() >= expiresAt) return false;
		used = true; restore(snapshot); return true;
	};
}

// ---- 画面で使う補助（backend との一致検査の対象外） ----

type HanamiFactorSource = readonly { axis: HanamiAxis; factor: number }[];
type HanamiSuggestionLike = { axes: HanamiFactorSource; groups: Record<HanamiAxisGroup, number> };

/** i/hanami-tuning-suggestion の axes から、resolveHanamiTuning に渡す「反応からの倍率」を作る。 */
export function hanamiDriftFactors(axes: HanamiFactorSource | null | undefined): Map<HanamiAxis, number> | null {
	return axes ? new Map(axes.map(axis => [axis.axis, axis.factor])) : null;
}

export type HanamiTilesSummary = {
	/** いま実際に使われている「10 件のうち」の件数。 */
	counts: Record<HanamiAxisGroup, number>;
	/** 反応に合わせて寄せる前の件数。 */
	base: Record<HanamiAxisGroup, number>;
	/** 反応に合わせて自動で動くしかたか。 */
	moving: boolean;
	/** 寄せたことで件数が増えたまとまり。 */
	increased: HanamiAxisGroup[];
};

export function hanamiTilesSummary(tuning: HanamiTuning, config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): HanamiTilesSummary {
	const moving = hanamiDriftLevel(tuning) != null;
	const counts = hanamiTenTiles(hanamiGroupComposition(tuning, config, driftFactors));
	const base = moving && driftFactors != null ? hanamiTenTiles(hanamiGroupComposition(tuning, config)) : counts;
	return { counts, base, moving, increased: HANAMI_AXIS_GROUP_NAMES.filter(group => counts[group] > base[group]) };
}

export type HanamiGroupTrend = 'up' | 'down' | 'flat';

/**
 * 反応に合わせて寄せたことで、まとまりごとの割合がどちらへ動いたか（寄せ方の幅に収めたあとの倍率で計算する）。
 * 1 ポイント未満の動きは「そのまま」。自動で動かないしかた・倍率がまだ無いときは null。
 */
export function hanamiGroupTrends(tuning: HanamiTuning, config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): Record<HanamiAxisGroup, HanamiGroupTrend> | null {
	if (hanamiDriftLevel(tuning) == null || driftFactors == null) return null;
	const before = hanamiGroupComposition(tuning, config);
	const after = hanamiGroupComposition(tuning, config, driftFactors);
	const trend = (group: HanamiAxisGroup): HanamiGroupTrend => {
		const diff = after[group] - before[group];
		return diff >= 1 ? 'up' : diff <= -1 ? 'down' : 'flat';
	};
	return { close: trend('close'), buzz: trend('buzz'), fresh: trend('fresh') };
}

/** 方向の 3 択の、帯の上での位置（%）。左が身近、右が広く。 */
export const HANAMI_DIRECTION_POSITIONS = [20, 50, 80] as const;

export type HanamiDirectionBand = { base: number; low: number; high: number; now: number; lean: 'close' | 'wide' | 'none' };

/**
 * 「選んだ方向から、ここまで動きます」の帯。
 * - 動ける幅は HANAMI_DRIFT_BOUNDS[drift] の倍率の幅（対数）に比例させる。寄せ方を強めるほど広がる。
 * - いまの位置は、寄せ方の幅に収めた倍率を、身近（close）とそれ以外（buzz・fresh）で平均した差から出す。
 *   身近が相対的に増えていれば左に、減っていれば右に寄る。倍率が無ければ選んだ方向と同じ位置。
 */
export function hanamiDirectionBand(tuning: HanamiTuning, config: HanamiAxisServerConfig = {}, driftFactors?: ReadonlyMap<HanamiAxis, number> | null): HanamiDirectionBand {
	const base = HANAMI_DIRECTION_POSITIONS[tuning.direction] ?? HANAMI_DIRECTION_POSITIONS[1];
	const [lowBound, highBound] = HANAMI_DRIFT_BOUNDS[tuning.drift] ?? HANAMI_DRIFT_BOUNDS[HANAMI_AUTO_DRIFT];
	const reach = Math.log(highBound / lowBound);
	const half = 16 * reach;
	const low = Math.max(0, base - half);
	const high = Math.min(100, base + half);
	let lean = 0;
	if (driftFactors != null) {
		const amounts = resolveHanamiTuning({ hanamiTuning: { ...tuning, mode: 'direction' } }, config).amounts;
		const side = (axes: readonly HanamiAxis[]): number => {
			let weight = 0;
			let sum = 0;
			for (const axis of axes) {
				const w = HANAMI_BASE_SHARE[axis] * (amounts.get(axis) ?? 0);
				if (w <= 0) continue;
				weight += w;
				sum += w * Math.log(applyHanamiDrift(axis, 1, driftFactors.get(axis), tuning.drift));
			}
			return weight > 0 ? sum / weight : 0;
		};
		lean = side(HANAMI_AXIS_GROUPS.close) - side([...HANAMI_AXIS_GROUPS.buzz, ...HANAMI_AXIS_GROUPS.fresh]);
	}
	const ratio = reach > 0 ? Math.max(-1, Math.min(1, lean / reach)) : 0;
	const now = Math.max(low, Math.min(high, base - ratio * half));
	const round = (value: number): number => Math.round(value * 10) / 10;
	return { base, low: round(low), high: round(high), now: round(now), lean: Math.abs(base - now) < 1 ? 'none' : now < base ? 'close' : 'wide' };
}

/**
 * 調整のしかたを切り替える（画面から）。
 * - 「すべて自分で」へは、いま出ている量（反応に合わせて寄せたあと）を初めの値にする。
 * - ほかのしかたから「おすすめから調整」へ移るときは、おすすめのまとまりの量を初めの値にする。おすすめが無ければいまの値のまま。
 */
export function switchHanamiModeWithSuggestion(tuning: HanamiTuning, mode: HanamiTuningMode, config: HanamiAxisServerConfig = {}, suggestion?: HanamiSuggestionLike | null): HanamiTuning {
	const next = switchHanamiMode(tuning, mode, config, hanamiDriftFactors(suggestion?.axes));
	if (mode !== 'recommend' || tuning.mode === 'recommend' || suggestion == null) return next;
	const level = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4 ? value : fallback;
	return { ...next, groups: {
		close: level(suggestion.groups.close, next.groups.close),
		buzz: level(suggestion.groups.buzz, next.groups.buzz),
		fresh: level(suggestion.groups.fresh, next.groups.fresh),
	} };
}

/** 「おすすめの量を入れる」。「すべて自分で」の量を、反応からの倍率で出したおすすめの量にする。0 にした種類は 0 のまま。 */
export function applyHanamiSuggestedAmounts(tuning: HanamiTuning, axes: HanamiFactorSource, config: HanamiAxisServerConfig = {}): HanamiTuning {
	const manual = switchHanamiMode(tuning, 'manual', config, hanamiDriftFactors(axes));
	const current = resolveHanamiTuning({ hanamiTuning: manual }, config).amounts;
	const base = resolveHanamiSuggestionBase(manual, config);
	const amounts: Partial<Record<HanamiAxis, number>> = Object.fromEntries(current);
	for (const { axis, factor } of axes) amounts[axis] = suggestHanamiAmount(current.get(axis) ?? 0, base.get(axis) ?? 0, factor);
	return { ...manual, manual: { amounts, authorCap: manual.manual?.authorCap ?? 2 } };
}
