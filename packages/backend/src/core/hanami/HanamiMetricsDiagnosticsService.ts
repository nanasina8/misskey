/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { assertMetricsDay, jstDay } from '@/core/hanami/HanamiMetricsContracts.js';
import { selectHanamiDiscoveryCandidates, type HanamiDiscoveryCandidate, type HanamiDiscoverySelectionParameters } from '@/core/hanami/HanamiDiscoverySelection.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { peekHanamiNoteJudgeRuntime } from '@/core/hanami/HanamiPythonRuntime.js';
import type { DataSource } from 'typeorm';

export const HANAMI_DIAGNOSTIC_REASONS = ['unjudged', 'ephemeral', 'lowInterest', 'ff', 'hideMedia', 'servedSeen', 'otherSafety', 'diversity', 'passed'] as const;
type Reason = typeof HANAMI_DIAGNOSTIC_REASONS[number];
type Counts = Record<Reason, number>;
const emptyCounts = (): Counts => Object.fromEntries(HANAMI_DIAGNOSTIC_REASONS.map(reason => [reason, 0])) as Counts;

// Same compatibility keys/default resolution as HanamiForYouService.resolveAxisLevels.
const AXIS_KEYS = {
	globalPopular: ['globalPopular', 'popular'], exploration: ['exploration', 'popular'],
	neighborTrending: ['neighborTrending', 'reactionSimilar'], reactionSimilar: ['reactionSimilar'],
	catchup: ['catchup'], trending: ['trending'], fof: ['fof'],
} as const;
type Axis = keyof typeof AXIS_KEYS;
type AxisConfig = Record<string, { available?: boolean; default?: boolean } | undefined>;

export function diagnosticAxisLevel(axis: Axis, axes: Record<string, unknown>, config: AxisConfig): string {
	const keys = AXIS_KEYS[axis];
	if ((keys.map(key => config[key]?.available).find(value => value !== undefined) ?? true) === false) return 'off';
	const value = keys.map(key => axes[key]).find(item => item !== undefined);
	if (value === 'off' || value === 'low' || value === 'normal' || value === 'high') return value;
	if (typeof value === 'boolean') return value ? 'normal' : 'off';
	return (keys.map(key => config[key]?.default).find(item => item !== undefined) ?? true) ? 'normal' : 'off';
}

/** First failure follows the personal-generation pipeline, then selector gate order.
 * Only the selector decides pass/diversity; SQL supplies facts, never judgement policy.
 */
export function diagnoseHanamiDiscovery(candidates: readonly HanamiDiscoveryCandidate[], parameters: HanamiDiscoverySelectionParameters): Counts {
	const counts = emptyCounts();
	const safe = candidates.filter(candidate => candidate.passesSafety !== false && candidate.isMuted !== true && candidate.isBlocked !== true
		&& candidate.passesMediaFilter !== false && candidate.isServed !== true);
	// Campaign tags must see the same post-safety/post-recency pool as serving.
	const selected = new Set(selectHanamiDiscoveryCandidates({ candidates: safe, parameters, viewerFFAuthorIds: new Set() }).map(candidate => candidate.noteId));
	for (const candidate of candidates) {
		const judged = Number.isFinite(candidate.ephemeralScore) && Number.isFinite(candidate.interest);
		let reason: Reason;
		if (candidate.passesSafety === false || candidate.isMuted === true || candidate.isBlocked === true) reason = 'otherSafety';
		else if (candidate.passesMediaFilter === false) reason = 'hideMedia';
		else if (candidate.isServed === true) reason = 'servedSeen';
		else if (!judged && parameters.allowUnjudged !== true) reason = 'unjudged';
		else if (candidate.isSelf === true || candidate.isFF === true || candidate.authorId === parameters.viewerId
			|| candidate.relationshipClass === 'directFollow' || candidate.relationshipClass === 'known') reason = 'ff';
		else if (judged && parameters.excludeEphemeral !== false && Number(candidate.ephemeralScore) > parameters.thetaEphemeral) reason = 'ephemeral';
		else if (judged && Number(candidate.interest) < parameters.thetaInterest) reason = 'lowInterest';
		else reason = selected.has(candidate.noteId) ? 'passed' : 'diversity';
		counts[reason]++;
	}
	return counts;
}

export type HanamiMetricsDiagnosticRow = {
	scope: 'dropped' | 'tuning'; key: string; users: number; data: Record<string, unknown>; capturedAt: string;
};

type Viewer = { userId: string; epochId: string; axes: Record<string, unknown> | null; hideEphemeral: boolean };
type Inventory = { noteId: string; authorId: string | null; reactionScore: number; ephemeralScore: number | null; interest: number | null; contentType: number | null; campaignTags: string[] | null };

// A keyset page bounds memory without selecting an unrepresentative fixed user sample.
export const HANAMI_DIAGNOSTIC_VIEWERS_SQL = `SELECT s."userId", s."epochId",
	p."hanamiRecommendationAxes" AS axes, p."hanamiReduceEphemeralPosts" AS "hideEphemeral"
	FROM hanami_user_feed_state s JOIN user_profile p ON p."userId" = s."userId"
	JOIN "user" u ON u.id = s."userId"
	WHERE s.mode = 'personalized' AND p."hanamiRecommendationEnabled" = true
		AND u.host IS NULL AND u."isSuspended" = false AND u."isDeleted" = false
		AND s."userId" > $1 ORDER BY s."userId" LIMIT 100`;

export const HANAMI_DIAGNOSTIC_INVENTORY_SQL = `SELECT c."noteId", n."userId" AS "authorId", c."baseScore" AS "reactionScore",
	j."ephemeralScore", j.interest, j."contentType", n.tags AS "campaignTags"
	FROM hanami_common_candidate c LEFT JOIN note n ON n.id = c."noteId"
	LEFT JOIN hanami_note_judgement j ON j."noteId" = c."noteId" AND j."promptVersion" = $3
	WHERE c."generationId" = $1 AND c."generationFence" = $2 AND c.axis = 'exploration'
	ORDER BY c.rank LIMIT 1200`;

export const HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL = `SELECT n.id AS "noteId",
	EXISTS (SELECT 1 FROM following f WHERE (f."followerId" = $1 AND f."followeeId" = n."userId")
		OR (f."followeeId" = $1 AND f."followerId" = n."userId")) AS "isFF",
	EXISTS (SELECT 1 FROM hanami_recommendation_event e WHERE e."userId" = $1 AND e."noteId" = n.id AND (
		(e."eventType" = 'served' AND e."feedKind" = 'personal' AND e."feedEpochId" = $2)
		OR (e."eventType" = 'seen' AND e."occurredAt" >= $4::timestamptz - INTERVAL '168 hours'
			AND e."occurredAt" <= $4::timestamptz))) AS "isServed"
	FROM note n WHERE n.id = ANY($3::varchar[])`;

@Injectable()
export class HanamiMetricsDiagnosticsService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		private safety: HanamiForYouSafetyService,
	) {}

	/** Immutable, current-JST-day-only capture. Never reconstruct yesterday from today's profiles. */
	@bindThis
	public async capture(day: string): Promise<void> {
		assertMetricsDay(day);
		const now = new Date();
		if (day !== jstDay(now)) return;
		const capturedAt = now.toISOString();
		// A single snapshot/atomic insert keeps tuning and dropped cohorts aligned.
		await this.db.transaction('REPEATABLE READ', async manager => {
			await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hanami-metrics-diagnostics:${day}`]);
			const existing = await manager.query('SELECT 1 FROM hanami_metrics_diagnostic WHERE day = $1::date LIMIT 1', [day]) as unknown[];
			if (existing.length > 0 || day !== jstDay()) return;
			const runner = manager.queryRunner;
			if (runner == null) throw new Error('Diagnostics require a transaction query runner');
			const signal = new AbortController().signal;
			const meta = await manager.query('SELECT "hanamiNoteJudgeSettings" AS settings, "hanamiRecommendationAxisConfig" AS axes FROM meta LIMIT 1') as { settings: unknown; axes: AxisConfig }[];
			const validated = validateHanamiNoteJudgeSettings(meta[0]?.settings);
			const settings = validated.ok ? validated.value : createDefaultHanamiNoteJudgeSettings();
			const config = meta[0]?.axes ?? {};
			const runtime = peekHanamiNoteJudgeRuntime(); // Never probe/start Python.
			const allowUnjudged = runtime != null && !runtime.available;
			const generations = await manager.query(`SELECT id, "generationFence", "finishedAt" FROM hanami_common_generation
				WHERE status = 'ready' ORDER BY ordinal DESC LIMIT 1`) as { id: string; generationFence: string; finishedAt: Date | string | null }[];
			const generation = generations.at(0);
			const inventory = generation == null ? [] : await manager.query(HANAMI_DIAGNOSTIC_INVENTORY_SQL,
				[generation.id, generation.generationFence, settings.promptVersion]) as Inventory[];
			const ids = inventory.map(candidate => candidate.noteId);
			const commonSafe = await this.safety.filterCommonEligibleNotes(ids, signal, runner);
			const personalCandidates = inventory.flatMap(candidate => candidate.authorId == null || commonSafe.get(candidate.noteId) !== candidate.authorId || !Number.isFinite(candidate.reactionScore)
				? [] : [{ noteId: candidate.noteId, authorId: candidate.authorId, score: candidate.reactionScore, axis: 'exploration' as const, origin: 'commonCandidate' as const }]);
			const poolMaxReactionScore = Math.max(0, ...inventory.map(candidate => Number.isFinite(candidate.reactionScore) ? candidate.reactionScore : 0));
			const counts = emptyCounts();
			const reasonUsers = emptyCounts();
			const tuning = new Map<string, { axis: string; level: string; users: number }>();
			let viewers = 0;
			let profileViewers = 0;
			let cursor = '';
			for (;;) {
				const page = await manager.query(HANAMI_DIAGNOSTIC_VIEWERS_SQL, [cursor]) as Viewer[];
				for (const viewer of page) {
					profileViewers++;
					const levels = Object.keys(AXIS_KEYS).map(axis => ({ axis, level: diagnosticAxisLevel(axis as Axis, viewer.axes ?? {}, config) }));
					levels.push({ axis: 'hideEphemeral', level: viewer.hideEphemeral !== false ? 'on' : 'off' });
					for (const { axis, level } of levels) {
						const key = `${axis}:${level}`;
						const group = tuning.get(key) ?? { axis, level, users: 0 };
						group.users++;
						tuning.set(key, group);
					}
					if (levels.find(level => level.axis === 'exploration')?.level === 'off') continue;
					viewers++;
					const personalSafe = new Set((await this.safety.filterPersonalEligibleCandidates({ userId: viewer.userId, candidates: personalCandidates, signal, queryRunner: runner })).map(candidate => candidate.noteId));
					const facts = await manager.query(HANAMI_DIAGNOSTIC_VIEWER_FACTS_SQL, [viewer.userId, viewer.epochId, ids, capturedAt]) as { noteId: string; isFF: boolean; isServed: boolean }[];
					const factsById = new Map(facts.map(fact => [fact.noteId, fact]));
					const candidates = inventory.map(candidate => ({
						...candidate,
						authorId: candidate.authorId ?? '', campaignTags: candidate.campaignTags ?? [],
						isSelf: candidate.authorId === viewer.userId, isFF: factsById.get(candidate.noteId)?.isFF === true,
						isServed: factsById.get(candidate.noteId)?.isServed === true,
						passesSafety: candidate.authorId != null && commonSafe.get(candidate.noteId) === candidate.authorId && Number.isFinite(candidate.reactionScore),
						passesMediaFilter: personalSafe.has(candidate.noteId),
					}));
					const result = diagnoseHanamiDiscovery(candidates, {
						reactionMax: settings.reactionMax, interestMax: settings.interestMax,
						thetaEphemeral: settings.ephemeralThreshold, thetaInterest: settings.interestThreshold, contentTypeBonus: settings.contentTypeBonus,
						excludeEphemeral: viewer.hideEphemeral !== false, allowUnjudged, poolMaxReactionScore });
					for (const reason of HANAMI_DIAGNOSTIC_REASONS) {
						counts[reason] += result[reason];
						if (result[reason] > 0) reasonUsers[reason]++;
					}
				}
				if (page.length < 100) break;
				cursor = page[page.length - 1].userId;
			}
			const { passed, ...dropped } = counts;
			const rows: HanamiMetricsDiagnosticRow[] = [{ scope: 'dropped', key: 'exploration', users: viewers, capturedAt, data: {
				available: generation != null && viewers > 0, currentOnly: true, capturedAt,
				dropped, passed, candidates: inventory.length, viewers, evaluations: inventory.length * viewers, reasonUsers,
				countUnit: 'viewerCandidatePairs', profileViewers,
				limitedReasons: ['crossAxisInterleaveNotReplayed', 'displayTimeMuteBlockWordInstanceSafetyNotReplayed', 'processLocalRuntimeOnly', 'safetyMetaCacheNotTransactional'],
				unavailable: [...(generation == null ? ['readyCommonGeneration'] : []), ...(viewers === 0 ? ['eligibleViewers'] : []), 'generationRuntimeFallbackNotPersisted'],
				generationFinishedAt: generation?.finishedAt ?? null, generationRuntimeFallback: null,
				allowUnjudged, runtimeAvailable: runtime?.available ?? null, runtimeProbedAt: runtime?.probedAt ?? null,
				firstFailureOrder: ['otherSafety', 'hideMedia', 'servedSeen', 'unjudged', 'ff', 'ephemeral', 'lowInterest', 'diversity', 'passed'],
			} }];
			for (const [key, group] of tuning) rows.push({
				scope: 'tuning', key, users: group.users, capturedAt,
				data: { axis: group.axis, level: group.level, currentOnly: true, capturedAt, basis: 'effectiveCurrentPersonalizedProfiles' },
			});
			rows.push({
				scope: 'tuning', key: 'closeness:unavailable', users: 0, capturedAt,
				data: { axis: 'closeness', level: 'unavailable', available: false, currentOnly: true, capturedAt },
			});
			// Refuse to label a capture that crossed midnight as a snapshot of the previous day.
			if (day !== jstDay()) return;
			for (const row of rows) await manager.query(`INSERT INTO hanami_metrics_diagnostic (day,scope,key,users,data,"capturedAt")
				VALUES ($1::date,$2,$3,$4,$5::jsonb,$6::timestamptz) ON CONFLICT (day,scope,key) DO NOTHING`,
			[day, row.scope, row.key, row.users, JSON.stringify(row.data), capturedAt]);
		});
	}

	/** Admin-only diagnostics include all measured cohorts. */
	@bindThis
	public async query(day: string): Promise<{ available: boolean; rows: HanamiMetricsDiagnosticRow[]; suppressed: string[] }> {
		assertMetricsDay(day);
		const stored = await this.db.query('SELECT scope,key,users,data,"capturedAt" FROM hanami_metrics_diagnostic WHERE day = $1::date ORDER BY scope,key', [day]) as HanamiMetricsDiagnosticRow[];
		return { available: stored.length > 0, rows: stored, suppressed: [] };
	}
}
