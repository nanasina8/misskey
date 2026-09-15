/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
import { QueueService } from '@/core/QueueService.js';

const basisSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		ephemeralA: { type: 'string', optional: false, nullable: false },
		ephemeralB: { type: 'string', optional: false, nullable: false },
		interest1: { type: 'string', optional: false, nullable: false },
		interest2: { type: 'string', optional: false, nullable: false },
		interest3: { type: 'string', optional: false, nullable: false },
		interest4: { type: 'string', optional: false, nullable: false },
		interest5: { type: 'string', optional: false, nullable: false },
	},
} as const;

const settingsSchema = {
	type: 'object', optional: false, nullable: false,
	properties: {
		schemaVersion: { type: 'integer', optional: false, nullable: false },
		promptVersion: { type: 'integer', optional: false, nullable: false },
		ephemeralThreshold: { type: 'number', optional: false, nullable: false },
		interestThreshold: { type: 'number', optional: false, nullable: false },
		reactionMax: { type: 'number', optional: false, nullable: false },
		interestMax: { type: 'number', optional: false, nullable: false },
		basis: basisSchema,
		examples: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
		templatePatterns: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
	},
} as const;

export const meta = { tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'write:admin:queue', description: 'Read or update local Hanami note judge settings.', res: settingsSchema } as const;
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
export const paramDef = { type: 'object', properties: { settings: settingsRequestSchema }, required: [] } as const;

function responseSettings(settings: ReturnType<typeof createDefaultHanamiNoteJudgeSettings>) {
	return { ...settings, basis: { ...settings.basis }, examples: [...settings.examples], templatePatterns: [...settings.templatePatterns] };
}

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(@Inject(DI.db) private db: DataSource, private queueService: QueueService) {
		super(meta, paramDef, async (ps) => {
			if (ps.settings == null) {
				const rows = await this.db.query(`SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1`) as Array<{ settings: unknown }>;
				const existing = validateHanamiNoteJudgeSettings(rows[0]?.settings);
				return responseSettings(existing.ok ? existing.value : createDefaultHanamiNoteJudgeSettings());
			}
			const requested = validateHanamiNoteJudgeSettings(ps.settings);
			if (!requested.ok) throw new TypeError(`Invalid Hanami judge settings: ${requested.error}`);
			const next = await this.db.transaction(async (manager) => {
				// Meta is the singleton serialization row. FOR UPDATE makes competing admin
				// updates observe the committed predecessor before allocating a version.
				const rows = await manager.query(`SELECT id, "hanamiNoteJudgeSettings" AS settings FROM meta ORDER BY id DESC LIMIT 1 FOR UPDATE`) as Array<{ id: string; settings: unknown }>;
				if (rows[0] == null) throw new Error('Hanami judge settings require a Meta row');
				const existing = validateHanamiNoteJudgeSettings(rows[0].settings);
				const current = existing.ok ? existing.value : createDefaultHanamiNoteJudgeSettings();
				const versions = await manager.query(`SELECT COALESCE(MAX("promptVersion"), 0)::integer AS "promptVersion" FROM "hanami_note_judge_settings"`) as Array<{ promptVersion: number }>;
				const promptVersion = Math.max(current.promptVersion, Number(versions[0]?.promptVersion ?? 0)) + 1;
				const saved = { ...requested.value, promptVersion };
				await manager.query(`UPDATE meta SET "hanamiNoteJudgeSettings" = $1::jsonb WHERE id = $2`, [JSON.stringify(saved), rows[0].id]);
				await manager.query(`INSERT INTO "hanami_note_judge_settings" ("promptVersion", "settings") VALUES ($1, $2::jsonb)`, [saved.promptVersion, JSON.stringify(saved)]);
				return saved;
			});
			// Enqueue only after the committed current setting and its exact history exist.
			await this.queueService.enqueueHanamiGenerationReconcile();
			return responseSettings(next);
		});
	}
}
