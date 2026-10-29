/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { HANAMI_TREND_TOPIC_JUDGE_LAST_KEY, type HanamiTrendTopicJudgeResult } from '@/core/hanami/HanamiForYouBatchService.js';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HANAMI_NOTE_JUDGE_MODEL, createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { probeHanamiNoteJudgeRuntime } from '@/core/hanami/HanamiPythonRuntime.js';
export const meta = { tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue', description: 'Get local Hanami note judge status and backlog.', res: { type: 'object', optional: false, nullable: false, properties: {
	model: { type: 'string', optional: false, nullable: false },
	promptVersion: { type: 'integer', optional: false, nullable: false },
	latestRun: { type: 'object', optional: false, nullable: true, properties: {
		id: { type: 'string', optional: false, nullable: false },
		status: { type: 'string', optional: false, nullable: false },
		params: { type: 'object', optional: false, nullable: false, additionalProperties: true },
		startedAt: { type: 'string', optional: false, nullable: false, format: 'date-time' },
		finishedAt: { type: 'string', optional: false, nullable: true, format: 'date-time' },
	} },
	trendTopicJudge: { type: 'object', optional: false, nullable: true, properties: {
		at: { type: 'string', optional: false, nullable: false, format: 'date-time' },
		outcome: { type: 'string', optional: false, nullable: false, enum: ['ok', 'partial', 'noGpu', 'nothingToDo', 'waiting', 'gaveUp', 'rejected', 'failed'] },
		requested: { type: 'object', optional: false, nullable: false, properties: {
			daily: { type: 'integer', optional: false, nullable: false },
			pairs: { type: 'integer', optional: false, nullable: false },
			titles: { type: 'integer', optional: false, nullable: false },
		} },
		saved: { type: 'object', optional: false, nullable: false, properties: {
			daily: { type: 'integer', optional: false, nullable: false },
			same: { type: 'integer', optional: false, nullable: false },
			titles: { type: 'integer', optional: false, nullable: false },
		} },
		rejectedTitles: { type: 'integer', optional: false, nullable: false },
		lastSuccessAt: { type: 'string', optional: false, nullable: true, format: 'date-time' },
		waitedMs: { type: 'integer', optional: true, nullable: false },
		error: { type: 'string', optional: true, nullable: false },
	} },
	backlog: { type: 'integer', optional: false, nullable: true, description: 'Unjudged distinct notes in the latest ready generation and fence; null when no ready inventory exists.' },
	candidateCount: { type: 'integer', optional: true, nullable: false, description: 'Already-judged distinct notes in that same inventory at the current prompt version. Add backlog for a full rejudgement estimate.' },
	secPerNote: { type: 'number', optional: true, nullable: false, description: 'Seconds per item reported by the latest run, or wallDurationMs / processedCount / 1000 when available.' },
	runtime: { type: 'object', optional: false, nullable: false, properties: {
		available: { type: 'boolean', optional: false, nullable: false },
		device: { type: 'string', optional: false, nullable: true },
		deviceName: { type: 'string', optional: false, nullable: true },
		reason: { type: 'string', optional: false, nullable: true },
		probedAt: { type: 'string', optional: false, nullable: false },
	} },
} } } as const;
export const paramDef = { type: 'object', properties: { force: { type: 'boolean', default: false } }, required: [] } as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db) private db: DataSource,
		@Inject(DI.redis) private redisClient: Redis.Redis,
	) {
		super(meta, paramDef, async (ps) => {
			return await getHanamiJudgeStatus(this.db, this.redisClient, ps.force);
		});
	}
}

/** Shared read path: the jobs dashboard and judge settings show the same inventory and runtime. */
export async function getHanamiJudgeStatus(db: DataSource, redisClient: Redis.Redis, force = false) {
	const metaRows = await db.query<{ settings: unknown }[]>('SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1');
	const validated = validateHanamiNoteJudgeSettings(metaRows.at(0)?.settings);
	const settings = validated.ok ? validated.value : createDefaultHanamiNoteJudgeSettings();
	const [latestRun] = await db.query('SELECT id, status, params, "startedAt", "finishedAt" FROM "hanami_foryou_model_run" WHERE kind = \'note-judge\' ORDER BY "startedAt" DESC, id DESC LIMIT 1');
	const inventory = await db.query<{ count: number | string; candidateCount?: number | string }[]>(`WITH latest_ready AS (
		SELECT id, "generationFence" FROM hanami_common_generation WHERE status = 'ready' ORDER BY ordinal DESC LIMIT 1
	) SELECT COUNT(DISTINCT c."noteId") FILTER (WHERE j."noteId" IS NULL)::int AS count,
		COUNT(DISTINCT c."noteId") FILTER (WHERE j."noteId" IS NOT NULL)::int AS "candidateCount"
		FROM latest_ready g LEFT JOIN hanami_common_candidate c
			ON c."generationId" = g.id AND c."generationFence" = g."generationFence"
		LEFT JOIN hanami_note_judgement j ON j."noteId" = c."noteId" AND j."promptVersion" = $1
		GROUP BY g.id`, [settings.promptVersion]);
	const backlog = inventory.at(0);
	const runtime = await probeHanamiNoteJudgeRuntime({ force });
	const params = latestRun?.params as Record<string, unknown> | undefined;
	const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
	const secPerNote = finite(params?.secondsPerItem) ? params.secondsPerItem
		: finite(params?.wallDurationMs) && finite(params.processedCount) && params.processedCount > 0 ? params.wallDurationMs / params.processedCount / 1000 : undefined;
	const topicJudge = await redisClient.get(HANAMI_TREND_TOPIC_JUDGE_LAST_KEY);
	let trendTopicJudge: HanamiTrendTopicJudgeResult | null = null;
	// A corrupt diagnostic record must not take the judge settings page down.
	try { trendTopicJudge = topicJudge == null ? null : JSON.parse(topicJudge) as HanamiTrendTopicJudgeResult; } catch { trendTopicJudge = null; }
	return {
		trendTopicJudge,
		model: HANAMI_NOTE_JUDGE_MODEL, promptVersion: settings.promptVersion, latestRun: latestRun ?? null,
		backlog: backlog ? Number(backlog.count) : null, runtime,
		...(backlog?.candidateCount !== undefined ? { candidateCount: Number(backlog.candidateCount) } : {}),
		...(secPerNote !== undefined && Number.isFinite(secPerNote) ? { secPerNote } : {}),
	};
}
