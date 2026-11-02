/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { describe, expect, vi as jest, test } from 'vitest';
import HomeEndpoint from '@/server/api/endpoints/notes/timeline.js';
import LocalEndpoint from '@/server/api/endpoints/notes/local-timeline.js';
import SocialEndpoint from '@/server/api/endpoints/notes/hybrid-timeline.js';
import GlobalEndpoint from '@/server/api/endpoints/notes/global-timeline.js';

const me = { id: 'user-1' } as never;

type PrewarmRequest = { prewarm: ReturnType<typeof jest.fn> };

type EndpointSpec = {
	name: string;
	build: (userFeedRequest: PrewarmRequest) => { exec: (ps: Record<string, unknown>, me: unknown, token: unknown) => Promise<unknown> };
	requiresLogin: boolean;
};

function specs(): EndpointSpec[] {
	const settings = { enableFanoutTimeline: false } as never;
	const notes = {} as never;
	const noteEntity = {} as never;
	const active = {} as never;
	const idService = { gen: jest.fn(() => 'id') } as never;
	const cache = {} as never;
	const fanout = {} as never;
	const query = {} as never;
	const metrics = {} as never;
	const roles = {} as never;
	return [
		{ name: 'home', requiresLogin: true, build: (userFeedRequest) => new HomeEndpoint(settings, notes, noteEntity, active, idService, cache, fanout, {} as never, {} as never, {} as never, query, metrics, userFeedRequest as never) as never },
		{ name: 'social', requiresLogin: true, build: (userFeedRequest) => new SocialEndpoint(settings, notes, noteEntity, roles, active, idService, cache, query, {} as never, {} as never, {} as never, fanout, metrics, userFeedRequest as never) as never },
		{ name: 'local', requiresLogin: false, build: (userFeedRequest) => new LocalEndpoint(settings, notes, noteEntity, roles, active, idService, fanout, query, {} as never, metrics, userFeedRequest as never) as never },
		{ name: 'global', requiresLogin: false, build: (userFeedRequest) => new GlobalEndpoint(notes, noteEntity, cache, query, roles, active, metrics, userFeedRequest as never) as never },
	];
}

describe('Hanami timeline prewarm wiring', () => {
	for (const spec of specs()) {
		test(`${spec.name} prewarms only the first logged-in page`, async () => {
			const userFeedRequest = { prewarm: jest.fn() };
			const endpoint = spec.build(userFeedRequest);

			await endpoint.exec({}, spec.requiresLogin ? me : null, null).catch(() => undefined);
			if (spec.requiresLogin) {
				expect(userFeedRequest.prewarm).toHaveBeenCalledWith('user-1');
			} else {
				expect(userFeedRequest.prewarm).not.toHaveBeenCalled();
			}

			userFeedRequest.prewarm.mockClear();
			await endpoint.exec({ untilId: 'abc123' }, spec.requiresLogin ? me : null, null).catch(() => undefined);
			expect(userFeedRequest.prewarm).not.toHaveBeenCalled();

			userFeedRequest.prewarm.mockClear();
			await endpoint.exec({ sinceId: 'abc123' }, spec.requiresLogin ? me : null, null).catch(() => undefined);
			expect(userFeedRequest.prewarm).not.toHaveBeenCalled();

			userFeedRequest.prewarm.mockClear();
			await endpoint.exec({ untilDate: 1 }, spec.requiresLogin ? me : null, null).catch(() => undefined);
			expect(userFeedRequest.prewarm).not.toHaveBeenCalled();

			userFeedRequest.prewarm.mockClear();
			await endpoint.exec({ sinceDate: 1 }, spec.requiresLogin ? me : null, null).catch(() => undefined);
			expect(userFeedRequest.prewarm).not.toHaveBeenCalled();
		});
	}
});
