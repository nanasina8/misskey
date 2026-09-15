/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings, type HanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { applyHanamiNoteJudgeRules } from '@/core/hanami/HanamiNoteJudgeRules.js';
import { prepareHanamiPythonCommand, resolveHanamiRepoRoot } from '@/core/hanami/HanamiPythonRuntime.js';

const execFileAsync = promisify(execFile);
const TRIAL_TIMEOUT_MS = 5 * 60 * 1000;
// Must match the process-wide LLM reservation used by judgement and taste jobs.
const LLM_LOCK_KEY = 'hanami:llm:exclusive:v1';
const LLM_LOCK_TTL_SEC = 35 * 60;

const settingsRequestSchema = {
	type: 'object', nullable: true,
	properties: {
		schemaVersion: { type: 'integer' }, promptVersion: { type: 'integer' },
		ephemeralThreshold: { type: 'number' }, interestThreshold: { type: 'number' },
		reactionMax: { type: 'number' }, interestMax: { type: 'number' },
		basis: { type: 'object', properties: {
			ephemeralA: { type: 'string' }, ephemeralB: { type: 'string' },
			interest1: { type: 'string' }, interest2: { type: 'string' }, interest3: { type: 'string' }, interest4: { type: 'string' }, interest5: { type: 'string' },
		}, required: ['ephemeralA', 'ephemeralB', 'interest1', 'interest2', 'interest3', 'interest4', 'interest5'] },
		examples: { type: 'array', items: { type: 'string' } },
		templatePatterns: { type: 'array', items: { type: 'string' } },
	},
	required: ['schemaVersion', 'promptVersion', 'ephemeralThreshold', 'interestThreshold', 'reactionMax', 'interestMax', 'basis', 'examples', 'templatePatterns'],
} as const;
export const meta = {
	tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue', description: 'List recent Hanami note judge trial candidates.',
	errors: {
		llmBusy: {
			message: 'Hanami local LLM is busy. Retry this trial shortly.',
			code: 'HANAMI_LLM_BUSY',
			id: '4f3e9fbc-d850-4d07-b9d5-5cbd21856696',
			kind: 'server',
			httpStatusCode: 503,
		},
	},
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			items: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						noteId: { type: 'string', optional: false, nullable: false },
						text: { type: 'string', optional: false, nullable: false },
						reactionScore: { type: 'number', optional: false, nullable: false },
						ephemeralScore: { type: 'number', optional: false, nullable: true },
						interest: { type: 'number', optional: false, nullable: true },
						contentType: { type: 'integer', optional: false, nullable: true },
						reason: { type: 'string', optional: false, nullable: false, enum: ['unjudged', 'bot', 'reply', 'template', 'emptyText', 'ephemeral', 'lowInterest', 'eligible'] },
					},
				},
			},
		},
	},
} as const;
export const paramDef = { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 }, settings: settingsRequestSchema }, required: [] } as const;

type TrialCandidate = { noteId: string; text: string; reactionScore: number; hasFiles: boolean; isBot: boolean; isReply: boolean };
type TrialJudgement = { noteId: string; ephemeralScore: number; interest: number; contentType: number };

async function evaluateLocally(settings: HanamiNoteJudgeSettings, notes: Array<{ noteId: string; cleanedText: string; hasFiles: boolean }>): Promise<ReadonlyMap<string, TrialJudgement>> {
	if (notes.length === 0) return new Map();
	let directory: string | null = null;
	try {
		directory = await mkdtemp(Path.join(tmpdir(), 'hanami-note-judge-trial-'));
		const inputPath = Path.join(directory, 'input.json');
		const outputPath = Path.join(directory, 'output.json');
		await writeFile(inputPath, JSON.stringify({ settings, notes }), 'utf8');
		const scriptPath = process.env.HANAMI_NOTE_JUDGE_SCRIPT ?? Path.join(resolveHanamiRepoRoot(), 'packages/backend/src/core/hanami/HanamiNoteJudgeCpu.py');
		const command = prepareHanamiPythonCommand([scriptPath, inputPath, outputPath]);
		await execFileAsync(command.file, command.args, { env: command.env, timeout: TRIAL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
		const output = JSON.parse(await readFile(outputPath, 'utf8')) as { status?: string; error?: string; judgements?: unknown[] };
		if (output.status === 'unavailable') throw new Error(`Hanami note judge unavailable: ${output.error ?? 'unknown error'}`);
		if (output.status !== 'ok' && output.status !== 'partial') throw new Error(`Hanami note judge returned invalid status: ${String(output.status)}`);
		const requested = new Set(notes.map(note => note.noteId));
		const judgements = new Map<string, TrialJudgement>();
		for (const value of output.judgements ?? []) {
			if (typeof value !== 'object' || value == null) continue;
			const judgement = value as Partial<TrialJudgement>;
			if (typeof judgement.noteId !== 'string' || !requested.has(judgement.noteId) || !Number.isFinite(judgement.ephemeralScore) || !Number.isFinite(judgement.interest) || !Number.isInteger(judgement.contentType)) continue;
			judgements.set(judgement.noteId, judgement as TrialJudgement);
		}
		return judgements;
	} finally {
		if (directory != null) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db) private db: DataSource,

		@Inject(DI.redis) private redisClient: Redis.Redis,
	) {
		super(meta, paramDef, async (ps) => {
			const supplied = ps.settings == null ? null : validateHanamiNoteJudgeSettings(ps.settings);
			if (supplied != null && !supplied.ok) throw new TypeError(`Invalid Hanami judge trial settings: ${supplied.error}`);
			let settings = supplied?.ok ? supplied.value : null;
			if (settings == null) {
				const [metaRow] = await this.db.query(`SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1`) as Array<{ settings: unknown }>;
				const checked = validateHanamiNoteJudgeSettings(metaRow?.settings);
				settings = checked.ok ? checked.value : createDefaultHanamiNoteJudgeSettings();
			}
			const candidates = await this.db.query(`SELECT c."noteId" AS "noteId", COALESCE(n.text, '') AS text, c."baseScore" AS "reactionScore", n."fileIds" <> '{}' AS "hasFiles", u."isBot" AS "isBot", (n."replyId" IS NOT NULL) AS "isReply" FROM "hanami_common_candidate" c JOIN note n ON n.id = c."noteId" JOIN "user" u ON u.id = n."userId" WHERE c.axis = 'exploration' ORDER BY c."generationId" DESC, c.rank ASC LIMIT $1`, [ps.limit ?? 50]) as TrialCandidate[];
			const ruled = candidates.map(candidate => ({ candidate, rule: applyHanamiNoteJudgeRules({ text: candidate.text, isBot: candidate.isBot, isReply: candidate.isReply, templatePatterns: settings.templatePatterns }) }));
			const notes = ruled.flatMap(({ candidate, rule }) => rule.shouldJudge ? [{ noteId: candidate.noteId, cleanedText: rule.cleanedText, hasFiles: candidate.hasFiles }] : []);
			let judgements: ReadonlyMap<string, TrialJudgement>;
			if (notes.length === 0) {
				judgements = new Map();
			} else {
				const lockToken = await this.acquireLlmLock();
				if (lockToken == null) throw new ApiError(meta.errors.llmBusy);
				try {
					judgements = await evaluateLocally(settings, notes);
				} finally {
					await this.releaseLlmLock(lockToken);
				}
			}
			return { items: ruled.map(({ candidate, rule }) => {
				const judgement = judgements.get(candidate.noteId);
				const reason = !rule.shouldJudge ? rule.reason : judgement == null ? 'unjudged' : judgement.ephemeralScore > settings.ephemeralThreshold ? 'ephemeral' : judgement.interest < settings.interestThreshold ? 'lowInterest' : 'eligible';
				return { noteId: candidate.noteId, text: candidate.text.slice(0, 160), reactionScore: candidate.reactionScore, ephemeralScore: judgement?.ephemeralScore ?? null, interest: judgement?.interest ?? null, contentType: judgement?.contentType ?? null, reason };
			}) };
		});
	}

	private async acquireLlmLock(): Promise<string | null> {
		const token = randomUUID();
		const result = await this.redisClient.set(LLM_LOCK_KEY, token, 'EX', LLM_LOCK_TTL_SEC, 'NX');
		return result == null ? null : token;
	}

	private async releaseLlmLock(token: string): Promise<void> {
		await this.redisClient.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, LLM_LOCK_KEY, token).catch(() => undefined);
	}
}
