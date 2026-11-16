/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import locales from 'i18n';
import { updateI18n } from '@/i18n.js';
import { hanamiReasonLabel } from '@/utility/hanami-reason-label.js';

beforeEach(() => updateI18n(locales['ja-JP']));
afterEach(() => updateI18n(locales['en-US']));

describe('はなみTL の理由ラベル', () => {
	test('近くで話題は反応した近い人の人数だけを出す', () => {
		expect(hanamiReasonLabel({ reason: 'neighborTrending', socialCount: 3 })).toBe('近い 3 人が反応');
	});

	test('近くで話題に人数が無い古い並びは人数なしの文言', () => {
		expect(hanamiReasonLabel({ reason: 'neighborTrending' })).toBe('近い人が反応中');
	});

	test('いま話題の人数つき文言はそのまま', () => {
		expect(hanamiReasonLabel({ reason: 'trending', term: '花見', socialCount: 2 })).toBe('トレンド: 花見 · つながりの2人が話題に');
		expect(hanamiReasonLabel({ reason: 'trending', term: '花見' })).toBe('トレンド: 花見');
	});
});
