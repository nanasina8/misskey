/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const packedAiModerationQueueSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			optional: false, nullable: false,
		},
		createdAt: {
			type: 'string',
			format: 'date-time',
			optional: false, nullable: false,
		},
		noteId: {
			type: 'string',
			optional: false, nullable: false,
			format: 'id',
		},
		note: {
			type: 'object',
			optional: true,
			nullable: true,
			ref: 'Note',
		},
		noteUserId: {
			type: 'string',
			optional: false,
			nullable: false,
			format: 'id',
		},
		noteUser: {
			type: 'object',
			optional: true,
			nullable: true,
			ref: 'UserLite',
		},
		noteUserHost: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		noteVisibility: {
			type: 'string',
			optional: false,
			nullable: false,
		},
		noteText: {
			type: 'string',
			optional: false,
			nullable: false,
		},
		triggers: {
			type: 'array',
			optional: false,
			nullable: false,
			items: {
				type: 'string',
				optional: false,
				nullable: false,
			},
		},
		links: {
			type: 'array',
			optional: false,
			nullable: false,
			items: {
				type: 'string',
				optional: false,
				nullable: false,
			},
		},
		textFingerprint: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		contactUserIds: {
			type: 'array',
			optional: false,
			nullable: false,
			items: {
				type: 'string',
				optional: false,
				nullable: false,
			},
		},
		contactKind: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		contactCount: {
			type: 'integer',
			optional: false,
			nullable: false,
		},
		author: {
			type: 'object',
			optional: false,
			nullable: true,
			properties: {
				createdAt: {
					type: 'string',
					format: 'date-time',
					optional: false,
					nullable: false,
				},
				notesCount: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
				followersCount: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
				followingCount: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
				hasAvatar: {
					type: 'boolean',
					optional: false,
					nullable: false,
				},
				isSuspended: {
					type: 'boolean',
					optional: false,
					nullable: false,
				},
				isHidden: {
					type: 'boolean',
					optional: false,
					nullable: false,
				},
				isHostHidden: {
					type: 'boolean',
					optional: false,
					nullable: false,
				},
			},
		},
		related: {
			type: 'object',
			optional: false,
			nullable: false,
			properties: {
				sameLinkAccounts: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
				sameTextCount: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
				userFlagged: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
				userJudged: {
					type: 'integer',
					optional: false,
					nullable: false,
				},
			},
		},
		localLabel: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		localScores: {
			type: 'object',
			optional: false,
			nullable: true,
			additionalProperties: {
				type: 'number',
			},
		},
		localModel: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		externalFlagged: {
			type: 'boolean',
			optional: false,
			nullable: true,
		},
		externalCategories: {
			type: 'array',
			optional: false,
			nullable: false,
			items: {
				type: 'string',
				optional: false,
				nullable: false,
			},
		},
		externalScores: {
			type: 'object',
			optional: false,
			nullable: true,
			additionalProperties: {
				type: 'number',
			},
		},
		externalModel: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		flagged: {
			type: 'boolean',
			optional: false,
			nullable: false,
		},
		resolved: {
			type: 'boolean',
			optional: false,
			nullable: false,
		},
		assigneeId: {
			type: 'string',
			optional: false,
			nullable: true,
			format: 'id',
		},
		assignee: {
			type: 'object',
			optional: false,
			nullable: true,
			ref: 'UserLite',
		},
		moderationNote: {
			type: 'string',
			optional: false,
			nullable: false,
		},
		autoAction: {
			type: 'string',
			optional: false,
			nullable: true,
			enum: ['hidden', 'wouldHide', 'hiddenHost', 'wouldHideHost'],
		},
		criteriaVersion: {
			type: 'string',
			optional: false,
			nullable: true,
		},
		spamSignals: {
			type: 'array',
			optional: false,
			nullable: false,
			items: {
				type: 'string',
				optional: false,
				nullable: false,
			},
		},
		judgedAt: {
			type: 'string',
			format: 'date-time',
			optional: false,
			nullable: true,
		},
	},
} as const;
