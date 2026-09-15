/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { createDefaultHanamiNoteJudgeSettings, validateHanamiNoteJudgeSettings } from '@/core/hanami/HanamiNoteJudgeContracts.js';
export const meta = { tags: ['admin'], requireCredential: true, requireAdmin: true, kind: 'read:admin:queue', description: 'Get local Hanami note judge aggregates.', res: { type: 'object', optional: false, nullable: false, properties: {
	judged: { type: 'integer', optional: false, nullable: false },
	ephemeral: { type: 'integer', optional: false, nullable: false },
	interestFiltered: { type: 'integer', optional: false, nullable: false },
	typeBreakdown: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
		contentType: { type: 'integer', optional: false, nullable: false },
		count: { type: 'integer', optional: false, nullable: false },
	} } },
	topServed: { type: 'array', optional: false, nullable: false, items: { type: 'object', optional: false, nullable: false, properties: {
		noteId: { type: 'string', optional: false, nullable: false },
		text: { type: 'string', optional: false, nullable: false },
		reactionScore: { type: 'number', optional: false, nullable: true },
		interest: { type: 'number', optional: false, nullable: true },
		ephemeralScore: { type: 'number', optional: false, nullable: true },
	} } },
} } } as const;
export const paramDef = { type: 'object', properties: {}, required: [] } as const;
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(@Inject(DI.db) private db: DataSource) { super(meta, paramDef, async () => {
		const [metaRow] = await this.db.query(`SELECT "hanamiNoteJudgeSettings" AS settings FROM meta LIMIT 1`) as Array<{ settings: unknown }>;
		const checked = validateHanamiNoteJudgeSettings(metaRow?.settings); const settings = checked.ok ? checked.value : createDefaultHanamiNoteJudgeSettings();
		const [counts] = await this.db.query(`SELECT count(*)::int AS judged, count(*) FILTER (WHERE "ephemeralScore" > $1)::int AS ephemeral, count(*) FILTER (WHERE interest < $2)::int AS "interestFiltered" FROM "hanami_note_judgement" WHERE "judgedAt" >= clock_timestamp() - INTERVAL '24 hours'`, [settings.ephemeralThreshold, settings.interestThreshold]);
		const typeBreakdown = await this.db.query(`SELECT "contentType", count(*)::int AS count FROM "hanami_note_judgement" WHERE "judgedAt" >= clock_timestamp() - INTERVAL '24 hours' GROUP BY "contentType" ORDER BY "contentType"`);
		const topServed = await this.db.query(`SELECT e."noteId" AS "noteId", left(COALESCE(n.text, ''), 160) AS text, c."baseScore" AS "reactionScore", j.interest, j."ephemeralScore" FROM "hanami_recommendation_event" e JOIN note n ON n.id = e."noteId" LEFT JOIN "hanami_common_candidate" c ON c."noteId" = e."noteId" AND c.axis = 'exploration' LEFT JOIN "hanami_note_judgement" j ON j."noteId" = e."noteId" AND j."promptVersion" = $1 WHERE e."eventType" = 'served' AND e."occurredAt" >= clock_timestamp() - INTERVAL '24 hours' ORDER BY e."occurredAt" DESC LIMIT 20`, [settings.promptVersion]);
		return { ...counts, typeBreakdown, topServed };
	}); }
}
