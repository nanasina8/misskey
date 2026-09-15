/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { getMetadataArgsStorage } from 'typeorm';
import { MiUserProfile } from '@/models/UserProfile.js';
import { packedMeDetailedOnlySchema } from '@/models/json-schema/user.js';
import { paramDef } from '@/server/api/endpoints/i/update.js';
import { getValidator } from '../prelude/get-api-validator.js';

describe('hanamiReduceEphemeralPosts preference', () => {
	test('accepts only boolean i/update values', () => {
		const validate = getValidator(paramDef);

		expect(validate({ hanamiReduceEphemeralPosts: true })).toBe(true);
		expect(validate({ hanamiReduceEphemeralPosts: false })).toBe(true);
		expect(validate({ hanamiReduceEphemeralPosts: 'false' })).toBe(false);
	});

	test('is stored with an enabled default and exposed by MeDetailed', () => {
		const column = getMetadataArgsStorage().columns.find(column =>
			column.target === MiUserProfile && column.propertyName === 'hanamiReduceEphemeralPosts',
		);

		expect(column?.options.default).toBe(true);
		expect(packedMeDetailedOnlySchema.properties.hanamiReduceEphemeralPosts).toEqual({
			type: 'boolean',
			nullable: false,
			optional: true,
		});
	});

	test('migration enables the preference for existing rows', () => {
		const migration = readFileSync(new URL('../../migration/1789430400000-hanamiReduceEphemeralPosts.js', import.meta.url), 'utf8');

		expect(migration).toContain('ADD "hanamiReduceEphemeralPosts" boolean NOT NULL DEFAULT true');
	});
});
