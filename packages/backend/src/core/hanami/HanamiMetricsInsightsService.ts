/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { HANAMI_FOR_YOU_AXES } from './HanamiForYouInterleave.js';
import { HANAMI_METRICS_DIMENSIONS, METRICS_COHORT_CTE, METRICS_COLLECTION_GAP_SQL, jstDay, shiftMetricsDay, metricRatio, rangeDays, rangeParameters, resolveRange } from './HanamiMetricsContracts.js';
import { HanamiMetricsQueryService } from './HanamiMetricsQueryService.js';
import { HANAMI_DIAGNOSTIC_REASONS, HanamiMetricsDiagnosticsService } from './HanamiMetricsDiagnosticsService.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from './HanamiNoteJudgeContracts.js';
import type { HanamiAxis } from './HanamiForYouInterleave.js';
import type { HanamiMetricsRange, HanamiMetricsResolvedRange, MetricsAggregateRow } from './HanamiMetricsContracts.js';
import type { HanamiMetricsCaps, HanamiMetricsNotes, HanamiMetricsNotesRequest, HanamiMetricsOpportunities, HanamiMetricsWhatIf, HanamiMetricsWhatIfRequest } from './HanamiMetricsInsightsContracts.js';
import type { DataSource } from 'typeorm';

export type { HanamiMetricsOpportunities, HanamiMetricsWhatIf, HanamiMetricsNotes } from './HanamiMetricsInsightsContracts.js';

/** Base caps at normal axis levels, NOT personalized caps. Parity-tested against interleave. */
export const HANAMI_INSIGHTS_CAPS: Readonly<Record<HanamiAxis, Readonly<HanamiMetricsCaps>>> = Object.freeze({
	globalPopular: Object.freeze({ high: 0.30, low: 0.55, none: 0.75 }),
	neighborTrending: Object.freeze({ high: 0.25, low: 0.12, none: 0 }),
	reactionSimilar: Object.freeze({ high: 0.15, low: 0.08, none: 0 }),
	catchup: Object.freeze({ high: 0.07, low: 0.03, none: 0 }),
	trending: Object.freeze({ high: 0.12, low: 0.12, none: 0.12 }),
	fof: Object.freeze({ high: 0.03, low: 0.02, none: 0.03 }),
	exploration: Object.freeze({ high: 0.08, low: 0.08, none: 0.10 }),
});

export function allocationVerdict(ratio: number): 'under' | 'over' | 'balanced' {
	return ratio >= 1.3 ? 'under' : ratio <= 0.7 ? 'over' : 'balanced';
}

/** Round first, then apportion at most twenty 0.05 units by largest remainder. */
export function suggestedCaps(rows: readonly { capNow: HanamiMetricsCaps; ratio: number }[]): HanamiMetricsCaps[] {
	const result = rows.map(() => ({ high: 0, low: 0, none: 0 }));
	for (const confidence of ['high', 'low', 'none'] as const) {
		const units = rows.map(row => Math.round(row.capNow[confidence] * row.ratio * 20));
		const total = units.reduce((sum, value) => sum + value, 0);
		const scaled = units.map(value => total > 20 ? value * 20 / total : value);
		const rounded = scaled.map(Math.floor);
		const remaining = Math.min(total, 20) - rounded.reduce((sum, value) => sum + value, 0);
		const order = scaled.map((value, index) => ({ index, remainder: value - rounded[index] }))
			.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
		for (let i = 0; i < remaining; i++) rounded[order[i].index]++;
		for (let i = 0; i < rows.length; i++) result[i][confidence] = rounded[i] / 20;
	}
	return result;
}

// Extend only the cohort projection. The shared attribution/filter/boundary SQL stays identical.
const NOTE_COHORT_CTE = METRICS_COHORT_CTE.replace('SELECT s."userId",', 'SELECT s."noteId", s."userId",');
export const INSIGHTS_CONTENT_SQL = `${METRICS_COHORT_CTE}
	SELECT COALESCE(dimensions->>'contentType','unjudged') AS "contentType",
		COALESCE(dimensions->>'media','unknown') AS media,
		COALESCE(dimensions->>'relationshipClass','unknown') AS "relationshipClass",
		COUNT(DISTINCT "userId")::int AS users, COUNT(*)::int AS served,
		SUM(seen)::int AS seen, SUM(reaction)::int AS reaction, SUM(reply)::int AS reply, SUM(renote)::int AS renote
	FROM cohort GROUP BY 1,2,3 ORDER BY 1,2,3`;

export const INSIGHTS_DEMAND_SQL = `SELECT a.key AS axis, a.value AS level,
	COUNT(DISTINCT p."userId")::int AS users, COUNT(*)::int AS pages,
	AVG(COALESCE((p.counts->>a.key)::numeric,0))::float8 AS average
	FROM hanami_metrics_page p CROSS JOIN LATERAL jsonb_each_text(p.axes) a
	WHERE p."servedAt">=$1::timestamptz AND p."servedAt"<$2::timestamptz
	AND a.value IN ('high','normal') GROUP BY a.key,a.value`;

export const INSIGHTS_HIDDEN_SQL = `SELECT c.axis, c.decision, COUNT(DISTINCT c."userId")::int AS users,
	COUNT(*)::int AS candidates, SUM(o.engaged)::int AS engaged
	FROM hanami_metrics_candidate c LEFT JOIN LATERAL (
		SELECT COUNT(DISTINCT e."eventType")::int AS engaged FROM hanami_metrics_event e
		WHERE e."userId"=c."userId" AND e."noteId"=c."noteId" AND e.source='normal'
		AND e."eventType" IN ('reaction','reply','renote')
		AND COALESCE(e."occurredAt",e."createdAt")>=c."capturedAt"
		AND COALESCE(e."occurredAt",e."createdAt")<=c."capturedAt"+interval '336 hours'
	) o ON true WHERE c."capturedAt">=$1::timestamptz AND c."capturedAt"<$2::timestamptz
	AND c.decision IN ('hiddenEphemeral','shown') GROUP BY c.axis,c.decision`;

/** Current prompt version, unique served exploration inventory. Judgement date is intentionally
 * unrestricted: rejudging a served note must not silently remove it from the requested cohort.
 * Other threshold stays at its configured value; no safety/diversity replay is claimed.
 */
export const INSIGHTS_WHAT_IF_SQL = `${NOTE_COHORT_CTE}, judged AS (
	SELECT c.*, j.interest, j."ephemeralScore", j."contentType" FROM cohort c
	JOIN hanami_metrics_judgement j ON j."noteId"=c."noteId" AND j."promptVersion"=$4
	WHERE j.model NOT LIKE 'rule:%' AND j.model <> 'rule'
	AND j.interest BETWEEN 1 AND 5 AND j."ephemeralScore" BETWEEN 0 AND 1
), thresholds AS (
	SELECT 'interest'::text AS kind, unnest($5::float8[]) AS theta
	UNION ALL SELECT 'ephemeral', unnest($6::float8[])
), points AS (
	SELECT t.kind,t.theta, COUNT(DISTINCT j."userId")::int AS users,
		COUNT(DISTINCT j."noteId")::int AS passed, COUNT(j."noteId")::int AS served,
		COALESCE(SUM(j.reaction+j.reply+j.renote),0)::int AS engaged
	FROM thresholds t LEFT JOIN judged j ON
		j.interest >= CASE WHEN t.kind='interest' THEN t.theta ELSE $7::float8 END
		AND j."ephemeralScore" <= CASE WHEN t.kind='ephemeral' THEN t.theta ELSE $8::float8 END
	GROUP BY t.kind,t.theta
)
SELECT kind,theta,users,passed,served,engaged FROM points
UNION ALL SELECT 'contentType',"contentType"::float8,COUNT(DISTINCT "userId")::int,
	COUNT(DISTINCT "noteId")::int,COUNT(*)::int,SUM(reaction+reply+renote)::int FROM judged GROUP BY "contentType"
UNION ALL SELECT 'cohort',0,COUNT(DISTINCT "userId")::int,COUNT(DISTINCT "noteId")::int,
	COUNT(*)::int,COALESCE(SUM(reaction+reply+renote),0)::int FROM judged
UNION ALL SELECT 'servedCohort',0,COUNT(DISTINCT "userId")::int,COUNT(DISTINCT "noteId")::int,
	COUNT(*)::int,COALESCE(SUM(reaction+reply+renote),0)::int FROM cohort`;

// A reply/renote must not disclose even a public wrapper around a private/deleted target.
const SAFE_NOTE_JOINS = `JOIN "user" author ON author.id=n."userId"
	LEFT JOIN note reply_target ON reply_target.id=n."replyId"
	LEFT JOIN "user" reply_author ON reply_author.id=reply_target."userId"
	LEFT JOIN note renote_target ON renote_target.id=n."renoteId"
	LEFT JOIN "user" renote_author ON renote_author.id=renote_target."userId"`;
const SAFE_NOTE_WHERE = `n.visibility='public' AND author."isSuspended"=false AND author."isDeleted"=false
	AND (n."replyId" IS NULL OR (reply_target.visibility='public' AND reply_author."isSuspended"=false AND reply_author."isDeleted"=false))
	AND (n."renoteId" IS NULL OR (renote_target.visibility='public' AND renote_author."isSuspended"=false AND renote_author."isDeleted"=false))`;

export const INSIGHTS_NOTES_SQL = `${NOTE_COHORT_CTE}, grouped AS (
	SELECT "noteId",
		CASE WHEN COUNT(DISTINCT COALESCE(dimensions->>'source','unknown'))=1
			THEN MIN(COALESCE(dimensions->>'source','unknown')) ELSE 'mixed' END AS source,
		CASE WHEN COUNT(DISTINCT COALESCE(dimensions->>'contentType','unjudged'))=1
			THEN MIN(COALESCE(dimensions->>'contentType','unjudged')) ELSE 'unjudged' END AS "contentType",
		COUNT(DISTINCT "userId")::int AS users, COUNT(*)::int AS served,
		SUM(reaction)::int AS reaction, SUM(reply)::int AS reply, SUM(renote)::int AS renote
	FROM cohort GROUP BY "noteId"
), safe AS (
	SELECT g.* FROM grouped g JOIN note n ON n.id=g."noteId" ${SAFE_NOTE_JOINS}
	WHERE ${SAFE_NOTE_WHERE}
), ranked AS (
	SELECT * FROM safe WHERE served>=20 AND users>=5
	ORDER BY (reaction+reply+renote)::float8/served DESC, served DESC,"noteId",source,"contentType" LIMIT 20
)
SELECT COALESCE((SELECT jsonb_agg(r ORDER BY (r.reaction+r.reply+r.renote)::float8/r.served DESC,
	r.served DESC,r."noteId",r.source,r."contentType") FROM ranked r),'[]'::jsonb) AS rows,
	EXISTS(SELECT 1 FROM safe WHERE served>=20 AND users<5) AS suppressed`;

const NOTE_DETAILS_SQL = `SELECT n.id AS "noteId", left(COALESCE(n.text,''),160) AS text,
	CASE WHEN author.host IS NULL THEN 'local' ELSE 'remote' END AS "authorLocality"
	FROM note n ${SAFE_NOTE_JOINS} WHERE n.id=ANY($1::varchar[]) AND ${SAFE_NOTE_WHERE}`;

type ContentRow = MetricsAggregateRow & { contentType: string; media: string; relationshipClass: string };
type DemandRow = { axis: string; level: string; users: number; pages: number; average: number };
type HiddenRow = { axis: string; decision: string; users: number; candidates: number; engaged: number };
type WhatIfRow = { kind: string; theta: number; users: number; passed: number; served: number; engaged: number };
type NoteRow = { noteId: string; source: string; contentType: string; users: number; served: number; reaction: number; reply: number; renote: number };
type CaptureState = { startedAt: string | Date | null; insightsStartedAt: string | Date | null };

function contentType(value: string): string | number { return /^[0-9]$/.test(value) ? Number(value) : 'unjudged'; }

function engaged(row: Pick<MetricsAggregateRow, 'reaction' | 'reply' | 'renote'>): number { return row.reaction + row.reply + row.renote; }

function shortRange(input?: HanamiMetricsRange): HanamiMetricsResolvedRange {
	const range = resolveRange(input);
	if (rangeDays(range).length > 30) throw new RangeError('Insights what-if and notes ranges must contain at most 30 days');
	return range;
}

function thresholds(values: number[] | undefined, minimum: number, maximum: number): number[] | undefined {
	if (values === undefined) return undefined;
	if (!Array.isArray(values) || values.length > 8 || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)) {
		throw new RangeError(`Threshold arrays must contain at most 8 finite values in ${minimum}..${maximum}`);
	}
	return [...new Set(values)];
}

/** Read-only admin service. Capture, endpoint guards and DI registration belong to the caller. */
@Injectable()
export class HanamiMetricsInsightsService {
	private readonly cache = new Map<string, { expiresAt: number; value: HanamiMetricsOpportunities | HanamiMetricsWhatIf | HanamiMetricsNotes }>();

	constructor(
		@Inject(DI.db) private readonly db: DataSource,
		private readonly query: HanamiMetricsQueryService,
		private readonly diagnostics: HanamiMetricsDiagnosticsService,
	) {}

	public async opportunities(input?: HanamiMetricsRange): Promise<HanamiMetricsOpportunities> {
		const range = resolveRange(input);
		const key = JSON.stringify(['opportunities', range]);
		const cached = this.cached<HanamiMetricsOpportunities>(key);
		if (cached) return cached;
		const bounds = rangeParameters(range);
		const [breakdown, contentRows, demandRows, hiddenRows, days, state] = await Promise.all([
			this.query.breakdown({ range, dimension: 'source' }),
			this.db.query<ContentRow[]>(INSIGHTS_CONTENT_SQL, [...bounds, '{}']),
			this.db.query<DemandRow[]>(INSIGHTS_DEMAND_SQL, bounds),
			this.db.query<HiddenRow[]>(INSIGHTS_HIDDEN_SQL, bounds),
			this.db.query<{ day: string }[]>(`SELECT to_char(day,'YYYY-MM-DD') AS day FROM hanami_metrics_diagnostic
				WHERE day >= $1::date AND day <= $2::date ORDER BY day DESC LIMIT 1`, [range.from, range.to]),
			this.captureState(),
		]);
		const result: HanamiMetricsOpportunities = {
			range, allocation: [], content: [], supplyWalls: [], demand: [], hiddenCost: [], tuningDrift: {},
			unavailable: [
				...breakdown.coverage.unavailable, ...this.captureUnavailable(range, state, false),
				...this.captureUnavailable(range, state, true), 'hiddenCost.normalExposureDenominator',
			],
			suppressed: breakdown.suppressed.map(key => `allocation.${key}`),
		};
		for (const row of breakdown.rows) {
			if (!(HANAMI_FOR_YOU_AXES as readonly string[]).includes(row.key)) continue;
			const ratio = metricRatio(row.engagementShare, row.share);
			if (ratio === null || row.share === null || row.engagementShare === null) {
				result.unavailable.push(`allocation.${row.key}.ratio`);
				continue;
			}
			result.allocation.push({
				axis: row.key, share: row.share, engagementShare: row.engagementShare, ratio,
				capNow: { ...HANAMI_INSIGHTS_CAPS[row.key as HanamiAxis] }, verdict: allocationVerdict(ratio), suggestedCap: { high: 0, low: 0, none: 0 },
			});
		}
		const caps = suggestedCaps(result.allocation);
		result.allocation.forEach((row, index) => { row.suggestedCap = caps[index]; });
		// All visible joint cells define the denominator, including cells below the 300 minimum.
		const visible = contentRows.filter(row => row.users >= 5);
		const totalServed = visible.reduce((sum, row) => sum + row.served, 0);
		const overallPerSeen = metricRatio(visible.reduce((sum, row) => sum + engaged(row), 0), visible.reduce((sum, row) => sum + row.seen, 0));
		if (contentRows.some(row => row.users < 5)) result.suppressed.push('content');
		for (const row of visible.filter(row => row.served >= 300)) {
			const share = row.served / totalServed;
			const lift = metricRatio(metricRatio(engaged(row), row.seen), overallPerSeen);
			result.content.push({
				contentType: contentType(row.contentType), media: row.media, relationshipClass: row.relationshipClass,
				served: row.served, engagementRate: engaged(row) / row.served, lift, share,
				opportunity: lift === null ? null : lift * (1 - share),
				note: 'Archived joint cohort; lift is engagement per seen relative to visible joint cells.',
			});
		}
		const maxOpportunity = Math.max(0, ...result.content.map(row => row.opportunity ?? 0));
		for (const row of result.content) {
			if (row.opportunity !== null) row.opportunity = maxOpportunity > 0 ? row.opportunity / maxOpportunity : 0;
		}
		result.content.sort((a, b) => (b.opportunity ?? -1) - (a.opportunity ?? -1));
		for (const axis of HANAMI_FOR_YOU_AXES) {
			const high = demandRows.find(row => row.axis === axis && row.level === 'high');
			const normal = demandRows.find(row => row.axis === axis && row.level === 'normal');
			if ((high && high.users < 5) || (normal && normal.users < 5)) result.suppressed.push(`demand.${axis}`);
			if (high && normal && high.users >= 5 && normal.users >= 5 && high.pages > 0 && normal.pages > 0) {
				result.demand.push({
					axis, usersHigh: high.users, avgServedPerPageHigh: Number(high.average), avgServedPerPageNormal: Number(normal.average),
					note: 'Successful REST pages; effective levels and per-source counts captured at serving time (page-weighted).',
				});
			} else if (!high || !normal) result.unavailable.push(`demand.${axis}.comparison`);
			const hidden = hiddenRows.find(row => row.axis === axis && row.decision === 'hiddenEphemeral');
			const shown = hiddenRows.find(row => row.axis === axis && row.decision === 'shown');
			if ((hidden && hidden.users < 5) || (shown && shown.users < 5)) result.suppressed.push(`hiddenCost.${axis}`);
			if (hidden && shown && hidden.users >= 5 && shown.users >= 5 && hidden.candidates > 0 && shown.candidates > 0) {
				result.hiddenCost.push({ axis, hidden: hidden.candidates, normalEngagementOfHidden: hidden.engaged / hidden.candidates, normalEngagementOfShown: shown.engaged / shown.candidates });
			} else if (!hidden || !shown) result.unavailable.push(`hiddenCost.${axis}.comparison`);
		}
		const day = days.at(0)?.day;
		if (day) {
			const diagnostic = await this.diagnostics.query(day);
			result.suppressed.push(...diagnostic.suppressed.map(key => `snapshot.${key}`));
			// Structured numeric distributions only; no arbitrary diagnostic metadata escapes.
			for (const row of diagnostic.rows) {
				if (row.scope === 'dropped' && row.key === 'exploration' && row.data.available === true) {
					const raw = row.data.dropped as Record<string, unknown> | undefined;
					const dropped: Record<string, number> = {};
					for (const reason of HANAMI_DIAGNOSTIC_REASONS.filter(reason => reason !== 'passed')) {
						if (typeof raw?.[reason] === 'number' && Number.isFinite(raw[reason]) && raw[reason] >= 0) dropped[reason] = raw[reason];
					}
					if (typeof row.data.passed === 'number' && Number.isFinite(row.data.passed) && row.data.passed >= 0) {
						result.supplyWalls.push({
							axis: 'exploration', dropped, passed: row.data.passed,
							note: `Snapshot ${day}; viewer-candidate pairs, not unique notes or summed daily users. Safety/diversity replay is limited.`,
						});
					}
				} else if (row.scope === 'tuning') {
					const axis = String(row.data.axis);
					const level = String(row.data.level);
					if (row.data.available === false) continue;
					if (([...HANAMI_FOR_YOU_AXES, 'hideEphemeral'] as string[]).includes(axis) && ['off', 'low', 'normal', 'high', 'on'].includes(level) && row.users >= 5) {
						(result.tuningDrift[axis] ??= {})[level] = row.users;
					}
				}
			}
			result.unavailable.push(`tuningDrift.defaultRelativeDelta:snapshot:${day}:effectiveLevelsOnly`);
		}
		if (result.supplyWalls.length === 0) result.unavailable.push('supplyWalls.snapshot');
		if (Object.keys(result.tuningDrift).length === 0) result.unavailable.push('tuningDrift.snapshot');
		const [health] = await this.db.query<{ gap: boolean }[]>(METRICS_COLLECTION_GAP_SQL, [range.from, range.to]);
		if (health?.gap) {
			result.demand = [];
			result.hiddenCost = [];
			result.unavailable.push('demand.collectionGap', 'hiddenCost.collectionGap');
		}
		result.unavailable = [...new Set(result.unavailable)];
		result.suppressed = [...new Set(result.suppressed)];
		this.remember(key, result);
		return result;
	}

	public async whatIf(request: HanamiMetricsWhatIfRequest): Promise<HanamiMetricsWhatIf> {
		const range = shortRange(request.range);
		if (request.axis !== 'exploration' || !request.thresholds || typeof request.thresholds !== 'object' || Array.isArray(request.thresholds)
			|| Object.keys(request.thresholds).some(key => key !== 'interest' && key !== 'ephemeral')) throw new RangeError('Invalid what-if request');
		const requestedInterest = thresholds(request.thresholds.interest, 1, 5);
		const requestedEphemeral = thresholds(request.thresholds.ephemeral, 0, 1);
		// Normalize request fields and duplicates, but preserve threshold order for the response.
		// Settings (including default thresholds and prompt version) may be stale for 60 seconds.
		const key = JSON.stringify(['whatIf', range, request.axis, requestedInterest, requestedEphemeral]);
		const cached = this.cached<HanamiMetricsWhatIf>(key);
		if (cached) return cached;
		const [meta] = await this.db.query<{ settings: unknown }[]>('SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1');
		const validated = validateHanamiNoteJudgeSettings(meta?.settings);
		const settings = validated.ok ? validated.value : createDefaultHanamiNoteJudgeSettings();
		// Older settings validation allowed out-of-domain thresholds. Never execute such policy silently.
		thresholds([settings.interestThreshold], 1, 5);
		thresholds([settings.ephemeralThreshold], 0, 1);
		const interest = requestedInterest ?? [settings.interestThreshold];
		const ephemeral = requestedEphemeral ?? [settings.ephemeralThreshold];
		const [rows, state] = await Promise.all([
			this.db.query<WhatIfRow[]>(INSIGHTS_WHAT_IF_SQL, [...rangeParameters(range), JSON.stringify({ source: 'exploration' }), settings.promptVersion, interest, ephemeral, settings.interestThreshold, settings.ephemeralThreshold]),
			this.captureState(),
		]);
		const result: HanamiMetricsWhatIf = { range, interest: [], ephemeral: [], contentTypeBonus: [], suppressed: [], unavailable: this.captureUnavailable(range, state, false) };
		if (!validated.ok) result.unavailable.push('settings.invalid:usingDefaults');
		const cohort = rows.find(row => row.kind === 'cohort');
		if (!cohort || cohort.served === 0) result.unavailable.push('whatIf.currentPromptJudgedExplorationCohort');
		if ((rows.find(row => row.kind === 'servedCohort')?.passed ?? 0) > (cohort?.passed ?? 0)) result.unavailable.push('whatIf.currentPromptJudgedExplorationCohort.partial:unjudgedOrRuleExcluded');
		for (const kind of ['interest', 'ephemeral'] as const) {
			for (const theta of kind === 'interest' ? interest : ephemeral) {
				const row = rows.find(item => item.kind === kind && item.theta === theta);
				// Even an empty qualifying group cannot establish the required five-user cohort.
				const visible = row !== undefined && row.users >= 5;
				if (!visible) result.suppressed.push(`${kind}.${theta}`);
				result[kind].push({ theta, passed: visible ? row.passed : null, passedEngagementRate: visible ? metricRatio(row.engaged, row.served) : null });
			}
		}
		for (let type = 0; type < settings.contentTypeBonus.length; type++) {
			const row = rows.find(item => item.kind === 'contentType' && item.theta === type);
			if (row && row.users < 5) result.suppressed.push(`contentTypeBonus.${type}`);
			if (!row) result.unavailable.push(`contentTypeBonus.${type}`);
			result.contentTypeBonus.push({ contentType: type, engagementRate: row && row.users >= 5 ? metricRatio(row.engaged, row.served) : null, bonusNow: settings.contentTypeBonus[type] });
		}
		this.remember(key, result);
		return result;
	}

	public async notes(request: HanamiMetricsNotesRequest = {}): Promise<HanamiMetricsNotes> {
		const range = shortRange(request.range);
		if ((request.dimension === undefined) !== (request.key === undefined)
			|| (request.dimension !== undefined && !HANAMI_METRICS_DIMENSIONS.includes(request.dimension))
			|| (request.key !== undefined && (typeof request.key !== 'string' || request.key.length > 128))) throw new RangeError('Invalid notes dimension/key');
		const key = JSON.stringify(['notes', range, request.dimension, request.key]);
		let result = this.cached<HanamiMetricsNotes>(key);
		if (!result) {
			const filter = request.dimension === undefined ? {} : { [request.dimension]: request.key };
			const [groups, state] = await Promise.all([
				this.db.query<{ rows: NoteRow[]; suppressed: boolean }[]>(INSIGHTS_NOTES_SQL, [...rangeParameters(range), JSON.stringify(filter)]),
				this.captureState(),
			]);
			result = { range, notes: [], suppressed: groups[0]?.suppressed ? ['notes.smallCohort'] : [], unavailable: this.captureUnavailable(range, state, false) };
			for (const row of groups[0]?.rows ?? []) {
				if (row.served < 20 || row.users < 5) continue;
				result.notes.push({
					noteId: row.noteId, text: '', authorLocality: 'unknown', source: row.source, contentType: contentType(row.contentType),
					served: row.served, reaction: row.reaction, reply: row.reply, renote: row.renote, engagementRate: engaged(row) / row.served,
				});
			}
			this.remember(key, result);
		}
		// Cache aggregates only. Recheck visibility, deletion/suspension and target safety on EVERY
		// request, including cache hits; fetch current text rather than retaining deleted/private text.
		if (result.notes.length > 0) {
			const details = await this.db.query<{ noteId: string; text: string; authorLocality: string }[]>(NOTE_DETAILS_SQL, [result.notes.map(row => row.noteId)]);
			const byId = new Map(details.map(row => [row.noteId, row]));
			result.notes = result.notes.flatMap(row => {
				const detail = byId.get(row.noteId);
				return detail ? [{ ...row, text: Array.from(detail.text).slice(0, 160).join(''), authorLocality: detail.authorLocality }] : [];
			});
		}
		return result;
	}

	private async captureState(): Promise<CaptureState | undefined> {
		return (await this.db.query<CaptureState[]>('SELECT "startedAt", "insightsStartedAt" FROM hanami_metrics_state WHERE id=1')).at(0);
	}

	private captureUnavailable(range: HanamiMetricsResolvedRange, state: CaptureState | undefined, insights: boolean): string[] {
		const start = insights ? state?.insightsStartedAt : state?.startedAt;
		const field = insights ? 'demand.hiddenCost.captureHistory' : 'served.captureHistory';
		if (!start || !Number.isFinite(new Date(start).getTime())) return [field];
		const today = jstDay();
		const unavailable: string[] = [];
		if (Date.parse(rangeParameters(range)[0]) < new Date(start).getTime() || range.from < shiftMetricsDay(today, -104)) unavailable.push(`${field}.partial`);
		if (range.to === today) unavailable.push(insights ? 'demand.hiddenCost.currentDayProvisional' : 'served.currentDayProvisional');
		// Match P1 outcomesThrough: the final served/captured instant of a day needs
		// the full inclusive 336-hour attribution window before its rate is final.
		if (range.to > shiftMetricsDay(today, -15)) unavailable.push(insights ? 'hiddenCost.outcomesProvisional' : 'served.outcomesProvisional');
		return unavailable;
	}

	private cached<T extends HanamiMetricsOpportunities | HanamiMetricsWhatIf | HanamiMetricsNotes>(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) { this.cache.delete(key); return undefined; }
		return structuredClone(entry.value) as T;
	}

	private remember(key: string, value: HanamiMetricsOpportunities | HanamiMetricsWhatIf | HanamiMetricsNotes): void {
		for (const [entryKey, entry] of this.cache) if (entry.expiresAt <= Date.now()) this.cache.delete(entryKey);
		this.cache.delete(key);
		while (this.cache.size >= 32) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.cache.delete(oldest.value);
		}
		this.cache.set(key, { expiresAt: Date.now() + 60_000, value: structuredClone(value) });
	}
}
