/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { getMetadataArgsStorage } from 'typeorm';
import type { Packed } from '@/misc/json-schema.js';
import { CoreModule } from '@/core/CoreModule.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DEFAULT_POLICIES } from '@/core/RoleService.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { packedMetaDetailedOnlySchema } from '@/models/json-schema/meta.js';
import { packedRolePoliciesSchema } from '@/models/json-schema/role.js';
import { packedMeDetailedOnlySchema } from '@/models/json-schema/user.js';
import { ServerModule } from '@/server/ServerModule.js';
import { paramDef as updateParamDef } from '@/server/api/endpoints/i/update.js';
import { ChannelsService } from '@/server/api/stream/ChannelsService.js';
import { getValidator } from '../prelude/get-api-validator.js';

const obsoleteSettings = [
	['hanamiRecommendationAutoInjectEnabled', true],
	['hanamiRecommendationAutoInjectStrength', 'high'],
	['hanamiRecommendationStrength', 'veryHigh'],
] as const;
const obsoleteSettingNames = obsoleteSettings.map(([property]) => property);
const obsoleteCoreServices = ['HanamiCatchupService', 'HanamiReactionSimilarService'];

function providerIdentities(provider: unknown): string[] {
	if (typeof provider === 'function') return [provider.name];
	if (typeof provider !== 'object' || provider == null) return [];

	const candidate = provider as { provide?: unknown; useExisting?: unknown };
	return [
		typeof candidate.provide === 'string' ? candidate.provide : null,
		typeof candidate.useExisting === 'function' ? candidate.useExisting.name : null,
	].filter((identity): identity is string => identity != null);
}

describe('Hanami Phase 5 backend cleanup workstream E', () => {
	test('hanamiTimeline is not registered as a channel or ServerModule provider', () => {
		const mainChannel = {};
		const channelsService = Reflect.construct(
			ChannelsService,
			[mainChannel, ...Array.from({ length: 17 }, () => ({}))],
		) as ChannelsService;
		const channelDependencies = (Reflect.getMetadata('design:paramtypes', ChannelsService) as Array<{ name?: string }> | undefined) ?? [];
		const serverProviders = (Reflect.getMetadata('providers', ServerModule) as Array<{ name?: string }> | undefined) ?? [];

		expect(channelsService.getChannelService('main')).toBe(mainChannel);
		expect(() => channelsService.getChannelService('hanamiTimeline')).toThrow('no such channel: hanamiTimeline');
		expect(channelDependencies.map(dependency => dependency.name)).not.toContain('HanamiTimelineChannelService');
		expect(serverProviders.map(provider => provider.name)).not.toContain('HanamiTimelineChannelService');
	});

	test('the shared notesStream publication remains available to other channels', () => {
		const redisForPub = { publish: jest.fn() };
		const service = new GlobalEventService({ host: 'example.test' } as never, redisForPub as never);
		const note = { id: 'note-1' } as Packed<'Note'>;

		service.publishNotesStream(note);

		expect(redisForPub.publish).toHaveBeenCalledWith('example.test', JSON.stringify({
			channel: 'notesStream',
			message: note,
		}));
	});

	test('i/update rejects all obsolete settings as additional properties', () => {
		expect(updateParamDef.additionalProperties).toBe(false);
		for (const [property, value] of obsoleteSettings) {
			const validate = getValidator(updateParamDef);
			expect(validate({ [property]: value })).toBe(false);
			expect(validate.errors).toContainEqual(expect.objectContaining({
				keyword: 'additionalProperties',
				params: { additionalProperty: property },
			}));
		}
	});

	test('user output schemas and ORM runtime metadata omit obsolete settings', () => {
		for (const [property] of obsoleteSettings) {
			expect(packedMeDetailedOnlySchema.properties).not.toHaveProperty(property);
		}

		const profileColumns = getMetadataArgsStorage().columns
			.filter(column => column.target === MiUserProfile)
			.map(column => column.propertyName);
		for (const property of obsoleteSettingNames) {
			expect(profileColumns).not.toContain(property);
		}
	});

	test('forward migrations retain the obsolete physical columns for one release', () => {
		const migrationDirectory = new URL('../../migration/', import.meta.url);
		const migrationFiles = readdirSync(migrationDirectory)
			.filter(fileName => fileName.endsWith('.js') && Number.parseInt(fileName, 10) >= 1780300000000);
		const introduction = readFileSync(new URL('1780300000000-hanamiRecommendation.js', migrationDirectory), 'utf8');
		const introductionUp = introduction.slice(introduction.indexOf('async up('), introduction.indexOf('async down('));

		for (const property of obsoleteSettingNames) {
			expect(introductionUp).toContain(`ALTER TABLE "user_profile" ADD "${property}"`);
		}
		for (const fileName of migrationFiles) {
			const migration = readFileSync(new URL(fileName, migrationDirectory), 'utf8');
			const upStart = migration.indexOf('async up(');
			const downStart = migration.indexOf('async down(', upStart);
			expect(upStart).toBeGreaterThanOrEqual(0);
			expect(downStart).toBeGreaterThan(upStart);
			const forwardMigration = migration.slice(upStart, downStart);
			for (const property of obsoleteSettingNames) {
				expect(forwardMigration).not.toContain(`DROP COLUMN "${property}"`);
			}
		}
	});

	test('CoreModule has no provider, alias, or export for obsolete services', () => {
		const providers = (Reflect.getMetadata('providers', CoreModule) as readonly unknown[] | undefined) ?? [];
		const exports = (Reflect.getMetadata('exports', CoreModule) as readonly unknown[] | undefined) ?? [];
		const identities = [...providers, ...exports].flatMap(providerIdentities);

		for (const service of obsoleteCoreServices) {
			expect(identities).not.toContain(service);
		}
	});

	test('Hanami timeline feature and role policy contracts remain', () => {
		expect(DEFAULT_POLICIES.hanamiTlAvailable).toBe(true);
		expect(packedRolePoliciesSchema.properties).toHaveProperty('hanamiTlAvailable');
		expect(packedMetaDetailedOnlySchema.properties.features.properties).toHaveProperty('hanamiTimeline');
	});
});
