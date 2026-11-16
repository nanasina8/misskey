/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HanamiAxisOutlookService } from '@/core/hanami/HanamiAxisOutlookService.js';

const count = (description: string) => ({ type: 'integer', optional: false, nullable: false, description } as const);
const text = (description: string) => ({ type: 'string', optional: false, nullable: false, description } as const);
const date = (description: string) => ({ ...text(description), format: 'date-time' } as const);
const flag = (description: string) => ({ type: 'boolean', optional: false, nullable: false, description } as const);
const numberOrNull = (description: string) => ({ type: 'number', optional: false, nullable: true, description } as const);

const distribution = (description: string) => ({
	type: 'object', optional: false, nullable: false,
	description: `${description} Distribution over the measured users of the per-user count; percentiles are actual values (no interpolation).`,
	properties: {
		users: count('Number of measured users.'),
		zero: count('Measured users whose count is 0.'),
		p25: numberOrNull('25th percentile; null when no user was measured.'),
		p50: numberOrNull('Median; null when no user was measured.'),
		p75: numberOrNull('75th percentile; null when no user was measured.'),
		max: numberOrNull('Maximum; null when no user was measured.'),
	},
} as const);

const age = (description: string) => ({
	type: 'object', optional: false, nullable: false,
	description: `${description} Bucketed by (reaction time - note time).`,
	properties: {
		under1h: count('Less than 1 hour.'),
		h1to6: count('1 hour to less than 6 hours.'),
		h6to24: count('6 hours to less than 24 hours.'),
		d1to3: count('1 day to less than 3 days.'),
		over3d: count('3 days or more.'),
	},
} as const);

export const meta = {
	tags: ['admin'],
	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:queue',
	description: 'Estimate what a new or changed Hanami timeline axis could draw on, from data the timeline metrics do not cover: what local users react to anywhere on the server, and how many candidates each axis idea would collect per user. Returns counts and distributions only (no user or note ids). Every section is read-only with a 20 second statement timeout; a failed section is null and named in errors. All timestamps are UTC ISO 8601.',
	res: {
		type: 'object', optional: false, nullable: false,
		description: 'Hanami axis outlook.',
		properties: {
			range: {
				type: 'object', optional: false, nullable: false, description: 'Measured windows.',
				properties: {
					from: date('Start of the reaction window.'),
					to: date('End of both windows (now).'),
					days: count('Length of the reaction window in days.'),
					poolFrom: date('Start of the candidate-pool window.'),
					poolHours: count('Length of the candidate-pool window in hours.'),
				},
			},
			population: {
				type: 'object', optional: false, nullable: true,
				description: 'Who could be served by axes that need followees, ALS neighbors or relation scores. "active" = local, not suspended or deleted, lastActiveDate inside the reaction window. "hanami" = had a Hanami timeline page served inside the reaction window.',
				properties: {
					activeLocalUsers: count('Active local users.'),
					activeWithFollowees5: count('Active local users following 5 or more accounts.'),
					activeWithAlsNeighbors: count('Active local users with neighbors in the latest ready ALS run (what neighborTrending needs).'),
					activeWithRelation: count('Active local users with at least one relation-score row.'),
					hanamiUsers: count('Users served by the Hanami timeline.'),
					hanamiWithFollowees5: count('Hanami users following 5 or more accounts.'),
					hanamiWithAlsNeighbors: count('Hanami users with neighbors in the latest ready ALS run.'),
					hanamiWithRelation: count('Hanami users with at least one relation-score row.'),
				},
			},
			reactions: {
				type: 'object', optional: false, nullable: true,
				description: 'Reactions local users gave to other people\'s notes inside the reaction window, on any surface (not only the Hanami timeline).',
				properties: {
					total: count('Reactions counted (newest first, capped at 50000).'),
					truncated: flag('True when more than 50000 reactions exist in the window and the oldest were left out.'),
					users: count('Distinct reacting users.'),
					largestUserShare: numberOrNull('Share of the counted reactions given by the single most active user; null when total is 0.'),
					toFollowee: count('Reactions to a note whose author the reacting user follows.'),
					toLocalAuthor: count('Reactions to a note by a local author.'),
					onReply: count('Reactions to a note that is a reply.'),
					withFiles: count('Reactions to a note with attached files.'),
					age: age('All counted reactions.'),
					followeeAge: age('Reactions to followees\' notes.'),
					nonFollowee: {
						type: 'object', optional: false, nullable: false,
						description: 'Reactions to notes whose author the reacting user does not follow. The "before" fields look only at events earlier than the reaction itself.',
						properties: {
							total: count('Reactions to non-followee authors.'),
							users: count('Distinct users who reacted to a non-followee author.'),
							followeeReactedBefore: count('At least one followee had already reacted to the note.'),
							twoFolloweesReactedBefore: count('At least two followees had already reacted to the note.'),
							followeeRenotedBefore: count('A followee had already renoted or quoted the note.'),
							followeeRepliedBefore: count('A followee had already replied to the note.'),
							authorFollowsMe: count('The author follows the reacting user.'),
							authorReactedToMe: count('The author had reacted to one of the reacting user\'s notes earlier inside the window.'),
							anySocial: count('Any of the five social signals above.'),
							noPriorReaction: count('Nobody had reacted to the note before.'),
							localAuthor: count('The author is local.'),
							age: age('Reactions to non-followee authors.'),
						},
					},
				},
			},
			pools: {
				type: 'object', optional: false, nullable: true,
				description: 'Per-user candidate counts from notes posted inside the candidate-pool window, for the most recently active local users who follow at least one account.',
				properties: {
					measuredUsers: count('Users measured.'),
					measuredUsersTruncated: flag('True when more users qualified than maxUsers.'),
					followeeReacted1: distribution('Notes by non-followee authors that at least one followee reacted to.'),
					followeeReacted2: distribution('Notes by non-followee authors that at least two followees reacted to.'),
					followeeReacted3: distribution('Notes by non-followee authors that at least three followees reacted to.'),
					conversationReplies: distribution('Replies from one followee to another followee.'),
					conversationThreads3: distribution('Threads holding three or more such replies.'),
					closeAuthorNotes: distribution('Original notes by the 30 accounts with the highest relation score (same note filter as the catchup axis).'),
					closeAuthorNotesNoReaction: distribution('Of those, notes nobody reacted to (the catchup axis requires a reaction, so it cannot show them today).'),
					closeAuthorNotesUnreacted: distribution('Of those, notes the user has not reacted to.'),
					localNonFolloweeNotes: distribution('Original notes by local authors the user does not follow.'),
				},
			},
			lapsed: {
				type: 'object', optional: false, nullable: true,
				description: 'People each user used to interact with but has not recently (same calculation as the lapsed-users widget), for at most the 30 most recently active measured users.',
				properties: {
					measuredUsers: count('Users measured.'),
					people: distribution('Lapsed people with a recent public note.'),
				},
			},
			local: {
				type: 'object', optional: false, nullable: true,
				description: 'Server-wide stock of local original notes inside the candidate-pool window.',
				properties: {
					originals: count('Local public/home notes that are neither replies nor plain renotes.'),
					authors: count('Distinct authors of those notes.'),
					withReaction: count('Of those notes, how many have at least one reaction.'),
				},
			},
			errors: {
				type: 'array', optional: false, nullable: false,
				description: 'Sections that failed or timed out; their value above is null.',
				items: {
					type: 'object', optional: false, nullable: false, description: 'One failed section.',
					properties: {
						section: text('Section name.'),
						message: text('Error message, truncated to 300 characters.'),
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		days: { type: 'integer', minimum: 1, maximum: 30, default: 14, description: 'Reaction window in days.' },
		poolHours: { type: 'integer', minimum: 6, maximum: 168, default: 48, description: 'Candidate-pool window in hours.' },
		maxUsers: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'How many recently active users to measure candidate pools for.' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiAxisOutlookService: HanamiAxisOutlookService,
	) {
		super(meta, paramDef, async (ps) => {
			return await this.hanamiAxisOutlookService.outlook({ days: ps.days, poolHours: ps.poolHours, maxUsers: ps.maxUsers });
		});
	}
}
