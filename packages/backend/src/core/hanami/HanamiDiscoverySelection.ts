/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { HanamiRelationshipClass } from '@/core/hanami/HanamiForYouQualityContracts.js';

/** A transient, text-free candidate from the common discovery pool. */
export type HanamiDiscoveryCandidate = Readonly<{
	noteId: string;
	authorId: string;
	reactionScore: number;
	ephemeralScore?: number | null;
	interest?: number | null;
	/** Q3 の種類 0〜9。未判定/範囲外なら種類ボーナスは 0。 */
	contentType?: number | null;
	campaignTags?: readonly string[];
	/** Compatibility with common-pool rows that already resolved the viewer FF relation. */
	isFF?: boolean;
	isSelf?: boolean;
	relationshipClass?: HanamiRelationshipClass;
	/** Transient integration hooks for the existing hard eligibility filters. */
	passesSafety?: boolean;
	isMuted?: boolean;
	isBlocked?: boolean;
	passesMediaFilter?: boolean;
	isServed?: boolean;
}>;

export type HanamiDiscoverySelectionParameters = Readonly<{
	reactionMax: number;
	interestMax: number;
	thetaEphemeral: number;
	thetaInterest: number;
	/** Per-viewer OFF bypasses only the ephemeral gate; all other gates remain. */
	excludeEphemeral?: boolean;
	/** The maximum reaction score in the common generation's complete pool. */
	poolMaxReactionScore?: number;
	/** index = contentType の加点表。省略時はボーナスなし。 */
	contentTypeBonus?: readonly number[];
	/**
	 * 判定器（GPU）が無い間のフォールバック: 未判定の候補も「興味 = 閾値・その場限りでない」とみなして選ぶ。
	 * ルール除外行（ephemeral=999）は判定済み扱いなので従来どおり落ちる。種類ボーナスは付けない。
	 * 判定済みで合格した候補は興味 ≥ 閾値なので自然に未判定より上に来る。
	 */
	allowUnjudged?: boolean;
	campaignTagMinAuthors?: number;
	authorCapPerBatch?: number;
	batchSize?: number;
	viewerId?: string;
}>;

export type HanamiDiscoverySelectionInput = Readonly<{
	candidates: readonly HanamiDiscoveryCandidate[];
	parameters: HanamiDiscoverySelectionParameters;
	/** Authors followed by, or following, the viewer. */
	viewerFFAuthorIds: ReadonlySet<string>;
	/** Optional adapter for safety, mute, block, media, or served eligibility. */
	isEligible?: (candidate: HanamiDiscoveryCandidate) => boolean;
}>;

export type HanamiScoredDiscoveryCandidate = HanamiDiscoveryCandidate & Readonly<{
	score: number;
}>;

const DEFAULT_BATCH_SIZE = 210;
const DEFAULT_CAMPAIGN_TAG_MIN_AUTHORS = 8;
const DEFAULT_AUTHOR_CAP_PER_BATCH = 1;

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isJudged(candidate: HanamiDiscoveryCandidate): candidate is HanamiDiscoveryCandidate & { ephemeralScore: number; interest: number } {
	return Number.isFinite(candidate.ephemeralScore) && Number.isFinite(candidate.interest);
}

/** 種類ボーナス。未判定・範囲外・表の欠損は 0（減点にはしない: 絵を落とし切らない方針）。 */
function contentTypeBonusOf(candidate: HanamiDiscoveryCandidate, table: readonly number[] | undefined): number {
	if (table == null || !Number.isInteger(candidate.contentType)) return 0;
	const bonus = table[candidate.contentType as number];
	return Number.isFinite(bonus) ? Math.max(0, bonus) : 0;
}

function campaignTagsInPool(candidates: readonly HanamiDiscoveryCandidate[], minimumAuthors: number): ReadonlySet<string> {
	const authorsByTag = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		for (const tag of new Set(candidate.campaignTags ?? [])) {
			const authors = authorsByTag.get(tag) ?? new Set<string>();
			authors.add(candidate.authorId);
			authorsByTag.set(tag, authors);
		}
	}
	return new Set([...authorsByTag].flatMap(([tag, authors]) => authors.size >= minimumAuthors ? [tag] : []));
}

/**
 * Applies the discovery-only eligibility, scoring, and 210-item diversity rules.
 * It intentionally does not call persistence or safety services; callers provide
 * their already-known hard exclusion result through flags or `isEligible`.
 */
export function selectHanamiDiscoveryCandidates(input: HanamiDiscoverySelectionInput): readonly HanamiScoredDiscoveryCandidate[] {
	const { candidates, parameters, viewerFFAuthorIds, isEligible } = input;
	const campaignTags = campaignTagsInPool(candidates, parameters.campaignTagMinAuthors ?? DEFAULT_CAMPAIGN_TAG_MIN_AUTHORS);
	const poolMaximum = parameters.poolMaxReactionScore ?? Math.max(0, ...candidates.map(candidate => finiteNonNegative(candidate.reactionScore)));
	const reactionDenominator = Math.log1p(finiteNonNegative(poolMaximum));
	const scored = candidates.flatMap((candidate) => {
		const judged = isJudged(candidate);
		if ((!judged && parameters.allowUnjudged !== true)
			|| candidate.isFF === true
			|| candidate.isSelf === true
			|| candidate.authorId === parameters.viewerId
			|| viewerFFAuthorIds.has(candidate.authorId)
			|| candidate.relationshipClass === 'directFollow'
			|| candidate.relationshipClass === 'known'
			|| (judged && parameters.excludeEphemeral !== false && candidate.ephemeralScore > parameters.thetaEphemeral)
			|| (judged && candidate.interest < parameters.thetaInterest)
			|| candidate.passesSafety === false
			|| candidate.isMuted === true
			|| candidate.isBlocked === true
			|| candidate.passesMediaFilter === false
			|| candidate.isServed === true
			|| (isEligible != null && !isEligible(candidate))) return [];
		const reactionPoints = reactionDenominator === 0 ? 0 : Math.log1p(finiteNonNegative(candidate.reactionScore)) / reactionDenominator * parameters.reactionMax;
		const normalizedInterest = judged ? Math.round(candidate.interest * 1000) / 1000 : parameters.thetaInterest;
		const interestPoints = (normalizedInterest - 1) / 4 * parameters.interestMax;
		const typeBonus = judged ? contentTypeBonusOf(candidate, parameters.contentTypeBonus) : 0;
		return [{ candidate, score: reactionPoints + interestPoints + typeBonus }];
	});

	scored.sort((left, right) => right.score - left.score || left.candidate.noteId.localeCompare(right.candidate.noteId));
	const batchSize = Math.max(1, Math.floor(parameters.batchSize ?? DEFAULT_BATCH_SIZE));
	const authorCap = Math.max(1, Math.floor(parameters.authorCapPerBatch ?? DEFAULT_AUTHOR_CAP_PER_BATCH));
	const selected: HanamiScoredDiscoveryCandidate[] = [];
	let authorCounts = new Map<string, number>();
	let selectedCampaignTags = new Set<string>();
	for (const { candidate, score } of scored) {
		if (selected.length > 0 && selected.length % batchSize === 0) {
			authorCounts = new Map();
			selectedCampaignTags = new Set();
		}
		const candidateCampaignTags = new Set((candidate.campaignTags ?? []).filter(tag => campaignTags.has(tag)));
		if ((authorCounts.get(candidate.authorId) ?? 0) >= authorCap
			|| [...candidateCampaignTags].some(tag => selectedCampaignTags.has(tag))) continue;
		authorCounts.set(candidate.authorId, (authorCounts.get(candidate.authorId) ?? 0) + 1);
		for (const tag of candidateCampaignTags) selectedCampaignTags.add(tag);
		selected.push({ ...candidate, score });
	}
	return selected;
}
