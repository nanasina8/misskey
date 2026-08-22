import { describe, test } from 'vitest';
import { expectType } from 'tsd';
import * as Misskey from '../src/index.js';

describe('API', () => {
	test('success', async () => {
		const cli = new Misskey.api.APIClient({
			origin: 'https://misskey.test',
			credential: 'TOKEN'
		});
		const res = await cli.request('meta', { detail: true });
		expectType<Misskey.entities.MetaResponse>(res);
	});

	test('conditional response type (meta)', async () => {
		const cli = new Misskey.api.APIClient({
			origin: 'https://misskey.test',
			credential: 'TOKEN'
		});

		const res = await cli.request('meta', { detail: true });
		expectType<Misskey.entities.MetaResponse>(res);

		const res2 = await cli.request('meta', { detail: false });
		expectType<Misskey.entities.MetaResponse>(res2);

		const res3 = await cli.request('meta', { });
		expectType<Misskey.entities.MetaResponse>(res3);

		const res4 = await cli.request('meta', { detail: true as boolean });
		expectType<Misskey.entities.MetaResponse>(res4);
	});

	test('conditional response type (users/show)', async () => {
		const cli = new Misskey.api.APIClient({
			origin: 'https://misskey.test',
			credential: 'TOKEN'
		});

		const res = await cli.request('users/show', { userId: 'xxxxxxxx' });
		expectType<Misskey.entities.UserDetailed>(res);

		const res2 = await cli.request('users/show', { userIds: ['xxxxxxxx'] });
		expectType<Misskey.entities.UserDetailed[]>(res2);
	});

	test('Hanami timeline contracts', async () => {
		const cli = new Misskey.api.APIClient({
			origin: 'https://misskey.test',
			credential: 'TOKEN'
		});

		expectType<{
			limit?: number;
			cursor?: string;
			refresh?: boolean;
			refreshToken?: string;
			withFiles?: boolean;
		}>({} as Misskey.entities.NotesHanamiTimelineRequest);

		const timeline = await cli.request('notes/hanami-timeline', {
			limit: 30,
			cursor: 'cursor',
			refresh: false,
			withFiles: true,
		});
		expectType<{
			items: {
				feedEntryId: string;
				batchId: string;
				note: Misskey.entities.Note;
			}[];
			nextCursor: string | null;
			hasMore: boolean;
			mode: 'personalized' | 'common';
			generationPending: boolean;
			feedEpochId: string;
			headBatchId: string;
		}>(timeline);

		const refreshRequest: Misskey.entities.NotesHanamiTimelineRequest = {
			refresh: true,
			refreshToken: 'refresh-token',
		};
		expectType<Misskey.entities.NotesHanamiTimelineRequest>(refreshRequest);

		expectType<{
			items: {
				feedEntryId: string;
				noteId: string;
			}[];
		}>({} as Misskey.entities.NotesHanamiTimelineSeenRequest);

		const seen = await cli.request('notes/hanami-timeline-seen', {
			items: [{
				feedEntryId: 'feed-entry-id',
				noteId: 'note-id',
			}],
		});
		expectType<{ ok: boolean }>(seen);

		const legacyRequest: Misskey.entities.NotesHanamiTimelineRequest = {
			// @ts-expect-error Legacy timeline request fields are not accepted.
			sinceId: 'note-id',
		};
		void legacyRequest;

		const nullCursorRequest: Misskey.entities.NotesHanamiTimelineRequest = {
			// @ts-expect-error An optional cursor cannot be explicitly null.
			cursor: null,
		};
		void nullCursorRequest;

		const nullRefreshTokenRequest: Misskey.entities.NotesHanamiTimelineRequest = {
			// @ts-expect-error An optional refresh token cannot be explicitly null.
			refreshToken: null,
		};
		void nullRefreshTokenRequest;
	});

	test('Hanami account and meta contracts', () => {
		const update: Misskey.entities.IUpdateRequest = {
			hanamiRecommendationEnabled: true,
			hanamiShowRecommendationReason: true,
			hanamiRecommendationAxes: {
				globalPopular: 'normal',
				exploration: 'low',
			},
		};
		expectType<Misskey.entities.IUpdateRequest>(update);
		expectType<boolean | undefined>(({} as Misskey.entities.MeDetailed).hanamiRecommendationEnabled);
		expectType<boolean | undefined>(({} as Misskey.entities.MeDetailed).hanamiShowRecommendationReason);
		expectType<boolean | undefined>(({} as Misskey.entities.MetaDetailed).features?.hanamiTimeline);

		// @ts-expect-error Obsolete recommendation strength is not exposed.
		({} as Misskey.entities.MeDetailed).hanamiRecommendationStrength;
		// @ts-expect-error Obsolete auto-injection setting is not exposed.
		({} as Misskey.entities.MeDetailed).hanamiRecommendationAutoInjectEnabled;
		// @ts-expect-error Obsolete auto-injection strength is not exposed.
		({} as Misskey.entities.IUpdateRequest).hanamiRecommendationAutoInjectStrength;
	});
});
