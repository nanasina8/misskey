/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const hanamiTuningSchema = {
	type: 'object', additionalProperties: false,
	properties: {
		mode: { type: 'string', enum: ['auto', 'manual'], optional: true },
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
				freshWeights: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 3 } },
				closeWeights: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 3 } },
				authorCap: { type: 'integer', minimum: 1, maximum: 4 },
			},
			required: ['amounts', 'freshWeights', 'closeWeights', 'authorCap'],
		},
	},
} as const;

// Parameter validation uses standard JSON Schema keywords only.
export const hanamiTuningParamDef = {
	type: 'object', additionalProperties: false,
	properties: {
		mode: { type: 'string', enum: ['auto', 'manual'] },
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
			required: ['amounts', 'freshWeights', 'closeWeights', 'authorCap'],
		},
	},
} as const;
