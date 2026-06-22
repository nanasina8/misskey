/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { Packed } from '@/misc/json-schema.js';
import type { HanamiAutoInjectItem } from '@/core/HanamiRecommendationService.js';
import { HanamiTimelineChannelService } from '@/server/api/stream/channels/hanami-timeline.js';

type ChannelInternals = {
	maybeAutoInject(): Promise<void>;
};

function makeItem(id: string): HanamiAutoInjectItem {
	return {
		note: { id, userId: `author-${id}` } as unknown as Packed<'Note'>,
		reason: { source: 'popular', reason: 'popular', sources: ['popular'] },
	};
}

function createChannel(items: HanamiAutoInjectItem[]) {
	const sendMessageToWs = jest.fn();
	const recommendationService = {
		getAutoInjectPreset: jest.fn(async () => ({ homeNotesPerInjection: 1, injectCount: items.length })),
		getAutoInjectNotes: jest.fn(async () => items),
		recordAutoInjectedServed: jest.fn(async () => undefined),
	};
	const roleService = {
		getUserPolicies: jest.fn(async () => ({ hanamiTlAvailable: true })),
	};
	const connection = {
		user: { id: 'user-1' },
		subscriber: { on: jest.fn(), off: jest.fn() },
		sendMessageToWs,
	};
	const channelService = new HanamiTimelineChannelService(
		{} as never,
		roleService as never,
		recommendationService as never,
		{} as never,
	);
	const channel = channelService.create('channel-1', connection as never);
	return { channel, recommendationService, sendMessageToWs };
}

describe('HanamiTimelineChannel auto inject', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	test('records served only after the note is sent', async () => {
		const item = makeItem('note-1');
		const { channel, recommendationService, sendMessageToWs } = createChannel([item]);
		await channel.init({});

		await (channel as unknown as ChannelInternals).maybeAutoInject();

		expect(sendMessageToWs).toHaveBeenCalledTimes(1);
		expect(recommendationService.recordAutoInjectedServed).toHaveBeenCalledWith('user-1', [item]);
		expect(sendMessageToWs.mock.invocationCallOrder[0]).toBeLessThan(
			recommendationService.recordAutoInjectedServed.mock.invocationCallOrder[0],
		);
	});

	test('does not record served when sending throws', async () => {
		const item = makeItem('note-1');
		const { channel, recommendationService, sendMessageToWs } = createChannel([item]);
		await channel.init({});
		sendMessageToWs.mockImplementation(() => {
			throw new Error('socket closed');
		});
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		await (channel as unknown as ChannelInternals).maybeAutoInject();

		expect(recommendationService.recordAutoInjectedServed).not.toHaveBeenCalled();
	});
});
