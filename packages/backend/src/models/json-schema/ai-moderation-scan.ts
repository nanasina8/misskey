/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 全体スキャン1回分（admin/ai-moderation/scan/* で使う。ref には登録しない） */
export const packedAiModerationScanSchema = {
	type: 'object',
	optional: false, nullable: false,
	properties: {
		id: { type: 'string', format: 'misskey:id', optional: false, nullable: false },
		createdAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
		status: { type: 'string', optional: false, nullable: false, enum: ['running', 'done', 'canceled'] },
		mode: { type: 'string', optional: false, nullable: false, enum: ['filtered', 'all'] },
		target: { type: 'string', optional: false, nullable: false, enum: ['all', 'local', 'remote'] },
		since: { type: 'string', format: 'date-time', optional: false, nullable: true },
		until: { type: 'string', format: 'date-time', optional: false, nullable: false },
		cursorAt: { type: 'string', format: 'date-time', optional: false, nullable: true },
		maxJudged: { type: 'number', optional: false, nullable: true },
		scannedCount: { type: 'number', optional: false, nullable: false },
		judgedCount: { type: 'number', optional: false, nullable: false },
		flaggedCount: { type: 'number', optional: false, nullable: false },
		wouldHideCount: { type: 'number', optional: false, nullable: false },
		judgeSeconds: { type: 'number', optional: false, nullable: false },
		startedBy: { type: 'string', optional: false, nullable: true },
		finishedAt: { type: 'string', format: 'date-time', optional: false, nullable: true },
		lastError: { type: 'string', optional: false, nullable: true },
		criteriaVersion: { type: 'string', optional: false, nullable: false },
	},
} as const;

export const packedAiModerationScanItemSchema = {
	type: 'object',
	optional: false, nullable: false,
	properties: {
		id: { type: 'string', format: 'misskey:id', optional: false, nullable: false },
		noteId: { type: 'string', format: 'misskey:id', optional: false, nullable: false },
		noteCreatedAt: { type: 'string', format: 'date-time', optional: false, nullable: false },
		noteExists: { type: 'boolean', optional: false, nullable: false },
		noteUserId: { type: 'string', format: 'misskey:id', optional: false, nullable: false },
		noteUserHost: { type: 'string', optional: false, nullable: true },
		noteVisibility: { type: 'string', optional: false, nullable: false },
		noteText: { type: 'string', optional: false, nullable: false },
		triggers: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
		links: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
		localLabel: { type: 'string', optional: false, nullable: true },
		localScores: {
			type: 'object',
			optional: false, nullable: true,
			properties: {
				normal: { type: 'number', optional: false, nullable: false },
				spam: { type: 'number', optional: false, nullable: false },
				scam: { type: 'number', optional: false, nullable: false },
				abuse: { type: 'number', optional: false, nullable: false },
			},
		},
		flagged: { type: 'boolean', optional: false, nullable: false },
		spamSignals: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
		wouldHide: { type: 'boolean', optional: false, nullable: false },
		criteriaVersion: { type: 'string', optional: false, nullable: true },
	},
} as const;
