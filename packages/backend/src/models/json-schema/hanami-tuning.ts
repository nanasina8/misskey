/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const hanamiTuningSchema = {
	type: 'object', additionalProperties: false,
	properties: {
		mode: { type: 'string', enum: ['auto', 'direction', 'recommend', 'manual'], optional: true },
		direction: { type: 'integer', minimum: 0, maximum: 2, optional: true },
		drift: { type: 'integer', minimum: 0, maximum: 2, optional: true },
		groups: {
			type: 'object', optional: true, additionalProperties: false,
			properties: {
				close: { type: 'integer', minimum: 0, maximum: 4, optional: true },
				buzz: { type: 'integer', minimum: 0, maximum: 4, optional: true },
				fresh: { type: 'integer', minimum: 0, maximum: 4, optional: true },
			},
		},
		// 旧形式（スライダー 3 本と倍率）。保存済みの値に残っていることがあるので、受け取りと返却だけ許す。
		closeness: { type: 'integer', minimum: 0, maximum: 4, optional: true },
		freshness: { type: 'integer', minimum: 0, maximum: 4, optional: true },
		discovery: { type: 'integer', minimum: 0, maximum: 4, optional: true },
		manual: {
			type: 'object', optional: true, additionalProperties: false,
			properties: {
				amounts: {
					type: 'object', additionalProperties: false, properties: {
						globalPopular: { type: 'number', minimum: 0, maximum: 3, optional: true },
						neighborTrending: { type: 'number', minimum: 0, maximum: 3, optional: true },
						reactionSimilar: { type: 'number', minimum: 0, maximum: 3, optional: true },
						catchup: { type: 'number', minimum: 0, maximum: 3, optional: true },
						trending: { type: 'number', minimum: 0, maximum: 3, optional: true },
						fof: { type: 'number', minimum: 0, maximum: 3, optional: true },
						exploration: { type: 'number', minimum: 0, maximum: 3, optional: true },
					},
				},
				// 旧形式の倍率。保存済みの値に残っていることがあるので、返却だけ許す（使わない）。
				freshWeights: { type: 'array', optional: true, minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 3 } },
				closeWeights: { type: 'array', optional: true, minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 3 } },
				authorCap: { type: 'integer', minimum: 1, maximum: 4 },
			},
			required: ['amounts', 'authorCap'],
		},
	},
} as const;

// Parameter validation uses standard JSON Schema keywords only.
export const hanamiTuningParamDef = {
	type: 'object', additionalProperties: false,
	properties: {
		mode: { type: 'string', enum: ['auto', 'direction', 'recommend', 'manual'] },
		direction: { type: 'integer', minimum: 0, maximum: 2 },
		drift: { type: 'integer', minimum: 0, maximum: 2 },
		groups: {
			type: 'object', additionalProperties: false,
			properties: {
				close: { type: 'integer', minimum: 0, maximum: 4 },
				buzz: { type: 'integer', minimum: 0, maximum: 4 },
				fresh: { type: 'integer', minimum: 0, maximum: 4 },
			},
		},
		// 旧形式。古い画面からの保存を落とさないために受け取るが、新しい形に直して保存する。
		closeness: { type: 'integer', minimum: 0, maximum: 4 },
		freshness: { type: 'integer', minimum: 0, maximum: 4 },
		discovery: { type: 'integer', minimum: 0, maximum: 4 },
		manual: {
			type: 'object', additionalProperties: false,
			properties: {
				amounts: {
					type: 'object', additionalProperties: false, properties: {
						globalPopular: { type: 'number', minimum: 0, maximum: 3 },
						neighborTrending: { type: 'number', minimum: 0, maximum: 3 },
						reactionSimilar: { type: 'number', minimum: 0, maximum: 3 },
						catchup: { type: 'number', minimum: 0, maximum: 3 },
						trending: { type: 'number', minimum: 0, maximum: 3 },
						fof: { type: 'number', minimum: 0, maximum: 3 },
						exploration: { type: 'number', minimum: 0, maximum: 3 },
					},
				},
				freshWeights: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 3 } },
				closeWeights: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 3 } },
				authorCap: { type: 'integer', minimum: 1, maximum: 4 },
			},
			required: ['amounts', 'authorCap'],
		},
	},
} as const;
