/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ValueTransformer } from 'typeorm';

const HANAMI_BIGINT_PATTERN = /^-?(0|[1-9]\d*)$/;
const HANAMI_BIGINT_MIN = BigInt('-9223372036854775808');
const HANAMI_BIGINT_MAX = BigInt('9223372036854775807');

function assertCanonicalPostgresBigint(value: string): string {
	if (!HANAMI_BIGINT_PATTERN.test(value)) {
		throw new Error('Hanami bigint columns must be written as canonical PostgreSQL bigint decimal strings.');
	}

	if (value === '-0') {
		throw new Error('Hanami bigint columns must be written as canonical PostgreSQL bigint decimal strings.');
	}

	const bigint = BigInt(value);
	if (bigint < HANAMI_BIGINT_MIN || bigint > HANAMI_BIGINT_MAX) {
		throw new Error('Hanami bigint columns must stay within the PostgreSQL bigint range.');
	}

	return value;
}

export function createHanamiBigintTransformer(nullable: boolean): ValueTransformer {
	return {
		to(value: unknown): string | null {
			if (value == null) {
				if (nullable) {
					return null;
				}

				throw new Error('Hanami bigint columns are not nullable.');
			}

			if (typeof value !== 'string') {
				throw new Error('Hanami bigint columns must be written as canonical PostgreSQL bigint decimal strings.');
			}

			return assertCanonicalPostgresBigint(value);
		},
		from(): never {
			throw new Error('Hanami bigint entity hydration is disabled because pg int8 values are parsed as Number. Use raw SQL with ::text aliases instead.');
		},
	};
}

export const hanamiBigintTransformer = createHanamiBigintTransformer(false);
export const nullableHanamiBigintTransformer = createHanamiBigintTransformer(true);
