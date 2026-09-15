/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { expect, test } from '@jest/globals';
import { selectHanamiDiscoveryCandidates, type HanamiDiscoveryCandidate, type HanamiDiscoverySelectionParameters } from '@/core/hanami/HanamiDiscoverySelection.js';

const parameters: HanamiDiscoverySelectionParameters = {
	reactionMax: 3,
	interestMax: 10,
	thetaEphemeral: 0,
	thetaInterest: 2.95,
	poolMaxReactionScore: 10,
};

function candidate(noteId: string, authorId: string, overrides: Partial<HanamiDiscoveryCandidate> = {}): HanamiDiscoveryCandidate {
	return { noteId, authorId, reactionScore: 1, ephemeralScore: -1, interest: 3, ...overrides };
}

test('reproduces the authorized deterministic discovery fixture top 30', () => {
	const fixture = JSON.parse(readFileSync(new URL('../fixtures/hanami-discovery-f0-fixture.json', import.meta.url), 'utf8')) as {
		candidates: HanamiDiscoveryCandidate[];
		params: HanamiDiscoverySelectionParameters;
		expectedTop30: Array<{ noteId: string; score: number }>;
	};
	const selected = selectHanamiDiscoveryCandidates({
		candidates: fixture.candidates,
		parameters: fixture.params,
		viewerFFAuthorIds: new Set(),
	});
	const expectedTop30 = [...fixture.expectedTop30].sort((left, right) => right.score - left.score || left.noteId.localeCompare(right.noteId));
	expect(selected.slice(0, 30).map(candidate => candidate.noteId)).toEqual(expectedTop30.map(candidate => candidate.noteId));
	selected.slice(0, 30).forEach((candidate, index) => expect(candidate.score).toBeCloseTo(expectedTop30[index]!.score, 4));
});

test('excludes FF, self, direct follows, known authors, unjudged, and threshold failures', () => {
	const selected = selectHanamiDiscoveryCandidates({
		candidates: [
			candidate('ok', 'outside'),
			candidate('ff-flag', 'a', { isFF: true }),
			candidate('ff-set', 'ff'),
			candidate('self', 'viewer'),
			candidate('direct', 'b', { relationshipClass: 'directFollow' }),
			candidate('known', 'c', { relationshipClass: 'known' }),
			candidate('unjudged', 'd', { interest: null }),
			candidate('ephemeral', 'e', { ephemeralScore: 0.01 }),
			candidate('low-interest', 'f', { interest: 2.94 }),
			candidate('served', 'g', { isServed: true }),
		],
		parameters: { ...parameters, viewerId: 'viewer' },
		viewerFFAuthorIds: new Set(['ff']),
	});
	expect(selected.map(candidate => candidate.noteId)).toEqual(['ok']);
});

test('viewer OFF bypasses only the ephemeral threshold while preserving interest and FF gates', () => {
	const selected = selectHanamiDiscoveryCandidates({
		candidates: [
			candidate('ephemeral-now-allowed', 'outside', { ephemeralScore: 8, interest: 4 }),
			candidate('still-low-interest', 'low', { ephemeralScore: 8, interest: 2.94 }),
			candidate('still-ff', 'ff', { ephemeralScore: 8, interest: 4 }),
			candidate('still-unjudged', 'unknown', { ephemeralScore: null }),
		],
		parameters: { ...parameters, excludeEphemeral: false },
		viewerFFAuthorIds: new Set(['ff']),
	});
	expect(selected.map(value => value.noteId)).toEqual(['ephemeral-now-allowed']);
});

test('uses pool campaign eligibility, one campaign tag and author per batch, and score note-id tie breaking', () => {
	const selected = selectHanamiDiscoveryCandidates({
		candidates: [
			candidate('a-tag', 'author-a', { reactionScore: 10, interest: 5, campaignTags: ['#campaign'] }),
			candidate('b-tag', 'author-b', { reactionScore: 9, interest: 5, campaignTags: ['#campaign'] }),
			candidate('author-repeat', 'author-a', { reactionScore: 8, interest: 5 }),
			candidate('z-tie', 'author-z', { reactionScore: 0, interest: 3 }),
			candidate('a-tie', 'author-y', { reactionScore: 0, interest: 3 }),
			...Array.from({ length: 6 }, (_, index) => candidate(`qualify-${index}`, `qualify-author-${index}`, { campaignTags: ['#campaign'], interest: 2 })),
		],
		parameters: { ...parameters, campaignTagMinAuthors: 8 },
		viewerFFAuthorIds: new Set(),
	});
	expect(selected.map(candidate => candidate.noteId)).toEqual(['a-tag', 'a-tie', 'z-tie']);
});

test('orders equal displayed scores by note id despite different raw scores', () => {
	const selected = selectHanamiDiscoveryCandidates({
		candidates: [
			candidate('z-raw-higher', 'author-z', { interest: 3.0004 }),
			candidate('a-raw-lower', 'author-a', { interest: 3.0003 }),
		],
		parameters,
		viewerFFAuthorIds: new Set(),
	});

	expect(selected.map(value => value.noteId)).toEqual(['a-raw-lower', 'z-raw-higher']);
});
