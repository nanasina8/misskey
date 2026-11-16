/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';

export type HanamiReason = { reason: string; term?: string; socialCount?: number; clusterId?: number; bucket?: 'cluster' | 'recent' };

// はなみTL おすすめの理由ラベル（投稿の上に出す短い文言）。名前は出さず、人数だけ出す。
export function hanamiReasonLabel(r: HanamiReason): string {
	const reasons = i18n.ts._hana._recommendation._reason;
	const reasonText = reasons as Record<string, string>;
	switch (r.reason) {
		case 'popular': return reasons.popular;
		case 'globalPopular': return reasonText.globalPopular;
		case 'exploration': return reasonText.exploration;
		case 'neighborTrending':
			// 古い並びには socialCount が無いので、そのときは人数なしの文言。
			if (r.socialCount) return i18n.tsx._hana._recommendation._reason.neighborTrendingSocial({ count: r.socialCount });
			return reasonText.neighborTrending;
		case 'reactionSimilar': return reasons.reactionSimilar;
		case 'catchup': return reasons.catchup;
		case 'trending':
			if (r.term && r.socialCount) return i18n.tsx._hana._recommendation._reason.trendingTermSocial({ term: r.term, count: r.socialCount });
			return r.term ? i18n.tsx._hana._recommendation._reason.trendingTerm({ term: r.term }) : reasons.trending;
		case 'fof': return reasons.fof;
		default: return '';
	}
}
