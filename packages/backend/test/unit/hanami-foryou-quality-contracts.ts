/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { HANAMI_QUALITY_SHADOW_MODEL_VERSION, HANAMI_QUALITY_SHADOW_RULE_VERSION, createHanamiQualityReasonMetadata, createHanamiQualityShadow } from '@/core/hanami/HanamiForYouQualityContracts.js';

describe('Hanami For You quality shadow contract', () => {
	it('keeps undecided high-precision signals null and versions the metadata', () => {
		const shadow = createHanamiQualityShadow({ relationshipClass: 'known', standaloneValue: null, socialOnly: null });
		expect(shadow).toEqual({
			relationshipClass: 'known',
			standaloneValue: null,
			socialOnly: null,
			ruleVersion: HANAMI_QUALITY_SHADOW_RULE_VERSION,
			modelVersion: HANAMI_QUALITY_SHADOW_MODEL_VERSION,
		});
	});

	it('exposes only persistence-safe shadow metadata for reasons', () => {
		const metadata = createHanamiQualityReasonMetadata({ relationshipClass: 'directFollow', standaloneValue: true, socialOnly: false });
		expect(metadata).toEqual({ qualityShadow: expect.objectContaining({ relationshipClass: 'directFollow' }) });
		expect(JSON.stringify(metadata)).not.toMatch(/fingerprint|originalText|normalizedText/i);
	});
});
