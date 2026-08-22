import { describe, test } from 'vitest';
import { expectType } from 'tsd';
import * as Misskey from '../src/index.js';

describe('Streaming', () => {
	test('emit type', async () => {
		const stream = new Misskey.Stream('https://misskey.test', { token: 'TOKEN' });
		const mainChannel = stream.useChannel('main');
		mainChannel.on('notification', notification => {
			expectType<Misskey.entities.Notification>(notification);
		});

		// @ts-expect-error The Hanami timeline has no compatibility streaming channel.
		stream.useChannel('hanamiTimeline');
	});
});
