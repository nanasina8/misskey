/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import {
	HANAMI_COMMON_AXES,
	type HanamiCommonAxis,
	type HanamiCommonFeedBuildInput,
	type HanamiCommonFeedItem,
	type HanamiCommonFeedMaterialization,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import {
	hanamiInterleave,
	type ForYouCandidate,
	type HanamiAxis,
	type HanamiAxisLevel,
} from '@/core/hanami/HanamiForYouInterleave.js';

const COMMON_SEGMENT_SIZE = 30;
const COMMON_SEGMENT_MAX = 7;
const RECENT_COMMON_SCORE_MULTIPLIER = 0.5;

const commonAxisSet: ReadonlySet<HanamiAxis> = new Set(HANAMI_COMMON_AXES);

function isCommonAxis(axis: HanamiAxis): axis is HanamiCommonAxis {
	return commonAxisSet.has(axis);
}

/** Pure common-feed ranking. Source candidates and metadata are never mutated. */
export function materializeHanamiCommonFeed(input: HanamiCommonFeedBuildInput): HanamiCommonFeedMaterialization {
	const enabledAxes = HANAMI_COMMON_AXES.filter(axis => input.source.enabledAxes.includes(axis));
	const axisLevels = new Map<HanamiAxis, HanamiAxisLevel>(enabledAxes.map(axis => [axis, 'normal']));
	const adjustedByAxis = new Map<HanamiCommonAxis, ForYouCandidate[]>();

	for (const axis of enabledAxes) {
		const ranked = input.source.candidates[axis]
			.map((candidate, originalRank) => ({
				noteId: candidate.noteId,
				userId: candidate.authorId,
				score: candidate.baseScore * (input.recentCommonNoteIds.has(candidate.noteId) ? RECENT_COMMON_SCORE_MULTIPLIER : 1),
				term: typeof candidate.metadata.term === 'string' ? candidate.metadata.term : undefined,
				originalRank,
			}))
			.filter(candidate => candidate.noteId.length > 0 && candidate.userId.length > 0 && Number.isFinite(candidate.score))
			.sort((a, b) => b.score - a.score || a.originalRank - b.originalRank);

		const seen = new Set<string>();
		const copied: ForYouCandidate[] = [];
		for (const candidate of ranked) {
			if (seen.has(candidate.noteId)) continue;
			seen.add(candidate.noteId);
			copied.push({
				noteId: candidate.noteId,
				userId: candidate.userId,
				score: candidate.score,
				...(candidate.term == null ? {} : { term: candidate.term }),
			});
		}
		adjustedByAxis.set(axis, copied);
	}

	const selectedNoteIds = new Set<string>();
	const items: HanamiCommonFeedItem[] = [];
	const segmentLengths: number[] = [];
	for (let segmentIndex = 0; segmentIndex < COMMON_SEGMENT_MAX; segmentIndex++) {
		const axisCandidates = new Map<HanamiAxis, ForYouCandidate[]>();
		for (const axis of enabledAxes) {
			axisCandidates.set(axis, (adjustedByAxis.get(axis) ?? []).filter(candidate => !selectedNoteIds.has(candidate.noteId)));
		}

		const segment = hanamiInterleave({
			confidence: 'none',
			limit: COMMON_SEGMENT_SIZE,
			axisCandidates,
			axisLevels,
		}).slice(0, COMMON_SEGMENT_SIZE);
		if (segment.length === 0) break;

		let added = 0;
		for (const candidate of segment) {
			if (!isCommonAxis(candidate.source) || candidate.userId == null || candidate.userId.length === 0) continue;
			if (selectedNoteIds.has(candidate.noteId)) continue;
			selectedNoteIds.add(candidate.noteId);
			const sources = Object.freeze(HANAMI_COMMON_AXES.filter(axis => candidate.sources.includes(axis)));
			items.push(Object.freeze({
				noteId: candidate.noteId,
				authorId: candidate.userId,
				source: candidate.source,
				sources,
			}));
			added++;
		}
		if (added === 0) break;
		segmentLengths.push(added);
	}

	return Object.freeze({
		items: Object.freeze(items),
		segmentLengths: Object.freeze(segmentLengths),
	});
}

@Injectable()
export class HanamiCommonFeedMaterializer {
	@bindThis
	public materializeFeed(input: HanamiCommonFeedBuildInput): HanamiCommonFeedMaterialization {
		return materializeHanamiCommonFeed(input);
	}
}
