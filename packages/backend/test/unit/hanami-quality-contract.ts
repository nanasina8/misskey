/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from '@jest/globals';
import { createHanamiQualityShadowFromJudgement, mapHanamiQualityJudgement } from '@/core/hanami/HanamiForYouQualityContracts.js';

test('maps judgement values with inclusive interest and exclusive ephemeral thresholds', () => {
	const judgement = { ephemeralScore: 0, interest: 2.95 };
	expect(mapHanamiQualityJudgement(judgement, { thetaEphemeral: 0, thetaInterest: 2.95 }))
		.toEqual({ standaloneValue: true, socialOnly: false });
	expect(createHanamiQualityShadowFromJudgement({
		relationshipClass: 'unknown',
		judgement: { ephemeralScore: 0.01, interest: 2.94 },
		thresholds: { thetaEphemeral: 0, thetaInterest: 2.95 },
	})).toMatchObject({ standaloneValue: false, socialOnly: true });
});
