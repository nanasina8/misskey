/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HANAMI_NOTE_JUDGE_MODEL, createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
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
	backlog: { type: 'integer', optional: false, nullable: false },
} } } as const;
export const paramDef = { type: 'object', properties: {}, required: [] } as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(@Inject(DI.db) private db: DataSource) { super(meta, paramDef, async () => {
		const [metaRow] = await this.db.query(`SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1`) as Array<{ settings: unknown }>;
		const validated = validateHanamiNoteJudgeSettings(metaRow?.settings);
		const settings = validated.ok ? validated.value : createDefaultHanamiNoteJudgeSettings();
		const [latestRun] = await this.db.query(`SELECT id, status, params, "startedAt", "finishedAt" FROM "hanami_foryou_model_run" WHERE kind = 'note-judge' ORDER BY "startedAt" DESC, id DESC LIMIT 1`);
		const [backlog] = await this.db.query(`SELECT count(*)::int AS count FROM "hanami_common_candidate" c LEFT JOIN "hanami_note_judgement" j ON j."noteId" = c."noteId" AND j."promptVersion" = $1 WHERE j."noteId" IS NULL`, [settings.promptVersion]);
		return { model: HANAMI_NOTE_JUDGE_MODEL, promptVersion: settings.promptVersion, latestRun: latestRun ?? null, backlog: Number(backlog?.count ?? 0) };
	}); }
}
