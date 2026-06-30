/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { Packed } from '@/misc/json-schema.js';
import { HanamiTimelineChannelService } from '@/server/api/stream/channels/hanami-timeline.js';

// For You-only 化後のストリーム channel（canonical spec §9/§14-D5）。
// home 転送は廃止し、notesStream のハートビートで For You 候補を軽量挿入する。
type ChannelInternals = {
	onTick(): Promise<void>;
};

function note(id: string): Packed<'Note'> {
	return { id, userId: `author-${id}` } as unknown as Packed<'Note'>;
}

function createChannel(notes: Packed<'Note'>[]) {
	const sendMessageToWs = jest.fn();
	const recommendationService = {
		getAutoInjectPreset: jest.fn(async () => ({ homeNotesPerInjection: 1, injectCount: notes.length })),
	};
	const forYouService = {
		getForYouPage: jest.fn(async () => notes),
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
		roleService as never,
		recommendationService as never,
		forYouService as never,
	);
	const channel = channelService.create('channel-1', connection as never);
	return { channel, forYouService, sendMessageToWs };
}

describe('HanamiTimelineChannel (For You-only realtime inject)', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	test('injects For You candidates on tick', async () => {
		const { channel, forYouService, sendMessageToWs } = createChannel([note('note-1')]);
		await channel.init({});

		await (channel as unknown as ChannelInternals).onTick();

		expect(forYouService.getForYouPage).toHaveBeenCalledTimes(1);
		expect(sendMessageToWs).toHaveBeenCalledTimes(1);
	});

	test('does not re-send a note already sent on this connection', async () => {
		const { channel, sendMessageToWs } = createChannel([note('note-1')]);
		await channel.init({});

		await (channel as unknown as ChannelInternals).onTick();
		await (channel as unknown as ChannelInternals).onTick();

		// 2回 tick しても同じ note は1回だけ送る（接続単位 dedup）。
		expect(sendMessageToWs).toHaveBeenCalledTimes(1);
	});
});
