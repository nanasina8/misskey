/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { array, dimensionSchema, object, rangeParamDef, rangeSchema, resolvedRangeSchema } from './schemas.js';

export const opportunitiesParamDef = rangeParamDef;
export const explorationAxisSchema = { type: 'string', enum: ['exploration'] } as const;
export const whatIfParamDef = {
	type: 'object',
	properties: {
		range: rangeSchema,
		axis: explorationAxisSchema,
		thresholds: {
			type: 'object',
			properties: {
				interest: { type: 'array', maxItems: 8, items: { type: 'number', minimum: 1, maximum: 5 } },
				ephemeral: { type: 'array', maxItems: 8, items: { type: 'number', minimum: 0, maximum: 1 } },
			},
			additionalProperties: false,
		},
	},
	required: ['axis', 'thresholds'],
	additionalProperties: false,
} as const;

export const notesParamDef = {
	type: 'object',
	properties: { range: rangeSchema, dimension: dimensionSchema, key: { type: 'string', maxLength: 128 } },
	required: [],
	dependencies: { dimension: ['key'], key: ['dimension'] },
	additionalProperties: false,
} as const;

const string = { type: 'string', optional: false, nullable: false } as const;
const number = { type: 'number', optional: false, nullable: false, minimum: 0 } as const;
const count = { type: 'integer', optional: false, nullable: false, minimum: 0 } as const;
const metric = { ...number, nullable: true } as const;
const numericMap = { type: 'object', optional: false, nullable: false, additionalProperties: count } as const;
const caps = object({ high: number, low: number, none: number });

// Captured unknown/unjudged content types are strings, not invented numeric zeroes.
export const insightsContentTypeSchema = {
	optional: false,
	anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }],
} as const;

export const opportunitiesResponseSchema = object({
	range: resolvedRangeSchema,
	allocation: array(object({
		axis: string, share: number, engagementShare: number, ratio: number, capNow: caps,
		verdict: { ...string, enum: ['under', 'over', 'balanced'] }, suggestedCap: caps,
	})),
	content: array(object({
		contentType: insightsContentTypeSchema, media: string, relationshipClass: string, served: count,
		engagementRate: number, lift: metric, share: number, opportunity: metric, note: string,
	})),
	supplyWalls: array(object({ axis: string, dropped: numericMap, passed: count, note: string })),
	demand: array(object({ axis: string, usersHigh: count, avgServedPerPageHigh: number, avgServedPerPageNormal: number, note: string })),
	hiddenCost: array(object({ axis: string, hidden: count, normalEngagementOfHidden: number, normalEngagementOfShown: number })),
	tuningDrift: { type: 'object', optional: false, nullable: false, additionalProperties: numericMap },
	unavailable: array(string),
	suppressed: array(string),
});

const thresholdPoint = object({ theta: number, passed: { ...count, nullable: true }, passedEngagementRate: metric });
export const whatIfResponseSchema = object({
	range: resolvedRangeSchema,
	interest: array(thresholdPoint),
	ephemeral: array(thresholdPoint),
	contentTypeBonus: array(object({ contentType: number, engagementRate: metric, bonusNow: number })),
	unavailable: array(string),
	suppressed: array(string),
});

export const notesResponseSchema = object({
	range: resolvedRangeSchema,
	notes: {
		...array(object({
			noteId: string, text: { ...string, maxLength: 160 }, authorLocality: string, source: string,
			contentType: insightsContentTypeSchema, served: count, reaction: count, reply: count, renote: count, engagementRate: number,
		})),
		maxItems: 20,
	},
	suppressed: array(string),
	unavailable: array(string),
});

export const judgeCohortSchema = object({
	range: resolvedRangeSchema,
	passed: { ...count, nullable: true },
	suppressed: array(string),
	unavailable: array(string),
});
