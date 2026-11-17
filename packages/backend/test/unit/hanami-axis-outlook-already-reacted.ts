/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { countHanamiAlreadyReacted } from '@/core/hanami/HanamiAxisOutlookService.js';

describe('countHanamiAlreadyReacted', () => {
	test('出す前の反応と、出したあとの反応を分けて数える', () => {
		const result = countHanamiAlreadyReacted([
			{ source: 'catchup', relationship: 'directFollow', servedAt: 1000, reactedAt: 400 },
			{ source: 'catchup', relationship: 'directFollow', servedAt: 1000, reactedAt: 1000 },
			{ source: 'catchup', relationship: 'directFollow', servedAt: 1000, reactedAt: null },
			{ source: 'fof', relationship: 'unknown', servedAt: 1000, reactedAt: 1500 },
		]);

		expect(result.total).toEqual({ served: 4, reactedBefore: 1, reactedAfter: 2 });
		expect(result.bySource).toEqual([
			{ source: 'catchup', served: 3, reactedBefore: 1, reactedAfter: 1 },
			{ source: 'fof', served: 1, reactedBefore: 0, reactedAfter: 1 },
		]);
		expect(result.byRelationship).toEqual([
			{ relationship: 'directFollow', served: 3, reactedBefore: 1, reactedAfter: 1 },
			{ relationship: 'unknown', served: 1, reactedBefore: 0, reactedAfter: 1 },
		]);
	});

	test('記録が無ければ 0 と空の一覧を返す', () => {
		expect(countHanamiAlreadyReacted([])).toEqual({
			total: { served: 0, reactedBefore: 0, reactedAfter: 0 },
			bySource: [],
			byRelationship: [],
		});
	});
});
