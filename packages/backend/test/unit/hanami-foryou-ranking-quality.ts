/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from '@jest/globals';
import { hanamiInterleave, type ForYouCandidate, type HanamiAxis } from '@/core/hanami/HanamiForYouInterleave.js';
import { createHanamiQualityShadow } from '@/core/hanami/HanamiForYouQualityContracts.js';
import { HanamiForYouProvenanceService } from '@/core/hanami/HanamiForYouProvenanceService.js';

test('quality shadow enabled or disabled has identical interleave order', () => {
	const base: ForYouCandidate[] = Array.from({ length: 20 }, (_, i) => ({ noteId: `note-${i}`, userId: `author-${i}`, score: 20 - i }));
	const withShadow = base.map(candidate => ({ ...candidate, qualityShadow: createHanamiQualityShadow({
		relationshipClass: 'unknown', standaloneValue: true, socialOnly: false,
	}) }));
	const map = (values: readonly ForYouCandidate[]) => new Map<HanamiAxis, ForYouCandidate[]>([['globalPopular', [...values]]]);
	expect(hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates: map(base) }).map(x => x.noteId))
		.toEqual(hanamiInterleave({ confidence: 'none', limit: 10, axisCandidates: map(withShadow) }).map(x => x.noteId));
});

test('v2 metadata persists only the safe quality shadow', () => {
	const provenance = new HanamiForYouProvenanceService({} as never, {} as never);
	const metadata = provenance.buildReasonMetadata({ qualityShadow: createHanamiQualityShadow({
		relationshipClass: 'unknown', standaloneValue: null, socialOnly: null,
	}) });
	expect(metadata).toMatchObject({ version: 2, qualityShadow: { relationshipClass: 'unknown' } });
	expect(JSON.stringify(metadata)).not.toContain('fingerprint');
	expect(JSON.stringify(metadata)).not.toContain('text');
});
