/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Schema } from '@/misc/json-schema.js';
import { ApiError } from '@/server/api/error.js';

export const metricsDimensions = ['source', 'contentType', 'relationshipClass', 'media', 'freshness', 'authorLocality', 'trendTerm', 'cluster'] as const;
export const dimensionSchema = { type: 'string', enum: metricsDimensions } as const;

const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

// Calendar validity, ordering and the inclusive 90-day limit belong to the query service.
// Separate closed branches prevent silently accepting a mixed days/from/to range.
export const rangeSchema = {
	oneOf: [
		{
			type: 'object',
			properties: {
				days: {
					type: 'integer',
					anyOf: [{ type: 'integer', const: 7 }, { type: 'integer', const: 14 }, { type: 'integer', const: 30 }, { type: 'integer', const: 90 }],
				},
			},
			required: ['days'],
			additionalProperties: false,
		},
		{
			type: 'object',
			properties: { from: dateSchema, to: dateSchema },
			required: ['from', 'to'],
			additionalProperties: false,
		},
	],
} as const;

export const rangeParamDef = {
	type: 'object',
	properties: { range: rangeSchema },
	required: [],
	additionalProperties: false,
} as const;

export const filterSchema = {
	type: 'object',
	properties: {
		source: { type: 'string', maxLength: 128 },
		contentType: { type: 'string', maxLength: 128 },
		relationshipClass: { type: 'string', maxLength: 128 },
		media: { type: 'string', maxLength: 128 },
		freshness: { type: 'string', maxLength: 128 },
		authorLocality: { type: 'string', maxLength: 128 },
		trendTerm: { type: 'string', maxLength: 128 },
		cluster: { type: 'string', maxLength: 128 },
	},
	additionalProperties: false,
} as const;

export const breakdownParamDef = {
	type: 'object',
	properties: { range: rangeSchema, dimension: dimensionSchema, filter: filterSchema },
	required: ['dimension'],
	additionalProperties: false,
} as const;

export const metricsEndpointMeta = {
	tags: ['admin'],
	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:queue',
} as const;

// Numeric const inference is not supported by the backend's SchemaType utility.
// Endpoint has already validated the closed literal set before this adapter runs.
export function queryRange(range: { days: number } | { from: string; to: string } | undefined) {
	if (range === undefined) return undefined;
	if ('days' in range) return { days: range.days as 7 | 14 | 30 | 90 };
	return range;
}

/** Service-owned calendar/filter validation must be a client error, not a 500. */
export async function metricsQuery<T>(query: () => Promise<T>): Promise<T> {
	try {
		return await query();
	} catch (error) {
		if (error instanceof RangeError) {
			throw new ApiError({
				message: 'Invalid metrics range or filter.',
				code: 'INVALID_PARAM',
				id: 'aaf39a02-4f7d-4c32-b381-1a58be7edb60',
				httpStatusCode: 400,
			});
		}
		throw error;
	}
}

export function object<const P extends Record<string, Schema>>(properties: P) {
	return { type: 'object', optional: false, nullable: false, properties, required: Object.keys(properties) as (keyof P & string)[], additionalProperties: false } as const;
}

export function array<const S extends Schema>(items: S) {
	return { type: 'array', optional: false, nullable: false, items } as const;
}

const count = { type: 'integer', optional: false, nullable: true, minimum: 0 } as const;
const metric = { type: 'number', optional: false, nullable: true, minimum: 0 } as const;
const string = { type: 'string', optional: false, nullable: false } as const;
export const resolvedRangeSchema = object({ from: dateSchema, to: dateSchema });
const hanamiUsersSchema = object({ day: count, week: count, month: count });
const tlShareSchema = object({ home: metric, local: metric, social: metric, global: metric, hanami: metric });
const failureKindsSchema = object({ emptyResult: count, candidateLimit: count, lockTimeout: count, exception: count, unknown: count });

const coverageStatusSchema = { ...string, enum: ['complete', 'partial', 'unavailable'] } as const;
const denominatorSchema = { ...string, enum: ['visible'], description: 'Shares and lift use all observed cells; the visible value is retained for compatibility.' } as const;

export const coverageSchema = object({
	status: coverageStatusSchema,
	startedAt: { ...string, nullable: true },
	retainedFrom: dateSchema,
	completeDays: array(dateSchema),
	partialDays: array(dateSchema),
	outcomesThrough: dateSchema,
	unavailable: array(string),
});

export const summaryResponseSchema = object({
	range: resolvedRangeSchema,
	coverage: coverageSchema,
	suppressed: array(string),
	denominator: denominatorSchema,
	usage: object({ hanamiUsers: hanamiUsersSchema, tlShare: tlShareSchema, manualRefreshPerUserDay: metric, rateLimited429: count }),
	engagement: object({
		users: count, served: count, seen: count, reaction: count, reply: count, renote: count,
		engagementRate: metric, seenRate: metric,
		normalBaseline: object({ reaction: count, reply: count, renote: count }),
	}),
	generation: object({
		personal: object({ batches: count, failed: count, failedRate: metric, p50Ms: metric, p95Ms: metric, failedByKind: failureKindsSchema }),
		common: object({ generations: count, failed: count, p50Ms: metric, p95Ms: metric }),
		judge: object({ runs: count, failed: count, p50Ms: metric, p95Ms: metric, backlog: count, secPerNote: metric, runtime: { ...string, nullable: true } }),
	}),
	series: object({ day: array(dateSchema), hanamiUsers: array(count), engagementRate: array(metric), failedBatches: array(count) }),
});

export const breakdownResponseSchema = object({
	range: resolvedRangeSchema,
	dimension: dimensionSchema,
	coverage: coverageSchema,
	denominator: denominatorSchema,
	rows: array(object({
		key: string, users: count, served: count, seen: count, reaction: count, reply: count, renote: count,
		share: metric, engagementRate: metric, seenRate: metric, engagementPerSeen: metric, lift: metric, engagementShare: metric,
	})),
	suppressed: array(string),
});

const errorDaySchema = object({ day: dateSchema, count });
const recentErrorSchema = object({
	at: string,
	kind: { ...string, enum: ['emptyResult', 'candidateLimit', 'lockTimeout', 'exception', 'unknown'] },
	attempts: { ...count, nullable: false },
	message: string,
	userBucket: { ...string, pattern: '^u#[0-9a-f]{4}$' },
});

export const errorsResponseSchema = object({
	range: resolvedRangeSchema,
	coverage: coverageSchema,
	suppressed: array(string),
	personal: object({ byKind: failureKindsSchema, byDay: array(object({ day: dateSchema, failed: count })), recent: array(recentErrorSchema) }),
	common: object({ recent: array(object({ at: string, status: { ...string, enum: ['failed'] }, message: string })) }),
	judge: object({ recent: array(object({ at: string, status: { ...string, enum: ['failed'] }, message: string })), backlog: count }),
	rateLimited: object({ byDay: array(errorDaySchema) }),
});

export const statsResponseSchema = object({
	range: resolvedRangeSchema,
	coverage: object({ status: coverageStatusSchema, unavailable: array(string) }),
	suppressed: array(string),
	denominator: denominatorSchema,
	usage: object({ hanamiUsers: hanamiUsersSchema, tlShare: tlShareSchema }),
	engagement: object({ engagementRate: metric }),
	sources: array(object({ key: string, share: metric, engagementRate: metric, lift: metric })),
	series: array(object({ week: dateSchema, hanamiUsers: count, engagementRate: metric })),
});
