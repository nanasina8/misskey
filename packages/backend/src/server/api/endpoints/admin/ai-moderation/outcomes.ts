/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { AiModerationOutcomeService } from '@/core/AiModerationOutcomeService.js';
import { summarizeAiModerationOutcomes } from '@/misc/ai-moderation.js';

const stateCounts = {
	suspended: { type: 'number', optional: false, nullable: false },
	deleted: { type: 'number', optional: false, nullable: false },
	hidden: { type: 'number', optional: false, nullable: false },
	unhidden: { type: 'number', optional: false, nullable: false },
	open: { type: 'number', optional: false, nullable: false },
} as const;

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	secure: true,
	kind: 'read:admin:ai-moderation',

	description: '判定で引っかけたアカウントのその後（このサーバーで凍結・相手のサーバーで消えた・隠している・隠すのをやめた）を集計する。',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			since: { type: 'string', format: 'date-time', optional: false, nullable: false },
			accounts: { type: 'number', optional: false, nullable: false },
			byState: { type: 'object', optional: false, nullable: false, properties: stateCounts },
			auto: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					...stateCounts,
					accounts: { type: 'number', optional: false, nullable: false },
					wouldHide: { type: 'number', optional: false, nullable: false },
					autoHidden: { type: 'number', optional: false, nullable: false },
				},
			},
			notAuto: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					...stateCounts,
					accounts: { type: 'number', optional: false, nullable: false },
				},
			},
			autoConfirmedRate: { type: 'number', optional: false, nullable: true },
			bySignal: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						signal: { type: 'string', optional: false, nullable: false },
						accounts: { type: 'number', optional: false, nullable: false },
						suspendedOrDeleted: { type: 'number', optional: false, nullable: false },
						unhidden: { type: 'number', optional: false, nullable: false },
					},
				},
			},
			byCriteria: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						version: { type: 'string', optional: false, nullable: true },
						accounts: { type: 'number', optional: false, nullable: false },
						autoAccounts: { type: 'number', optional: false, nullable: false },
						suspendedOrDeleted: { type: 'number', optional: false, nullable: false },
						unhidden: { type: 'number', optional: false, nullable: false },
					},
				},
			},
			hosts: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						host: { type: 'string', optional: false, nullable: false },
						accounts: { type: 'number', optional: false, nullable: false },
						suspended: { type: 'number', optional: false, nullable: false },
						deleted: { type: 'number', optional: false, nullable: false },
						hidden: { type: 'number', optional: false, nullable: false },
						isHostHidden: { type: 'boolean', optional: false, nullable: false },
						isBlocked: { type: 'boolean', optional: false, nullable: false },
						suspensionState: { type: 'string', optional: false, nullable: true },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		days: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private aiModerationOutcomeService: AiModerationOutcomeService,
	) {
		super(meta, paramDef, async (ps) => {
			const since = new Date(Date.now() - ps.days * 24 * 60 * 60 * 1000);
			const accounts = await this.aiModerationOutcomeService.loadAccounts(since);
			const summary = summarizeAiModerationOutcomes(accounts);
			const hosts = await this.aiModerationOutcomeService.summarizeHosts(accounts, 20);
			return {
				since: since.toISOString(),
				...summary,
				hosts,
			};
		});
	}
}
