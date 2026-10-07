/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import type { PropType } from 'vue';
import { globalEvents } from '@/events.js';
import History from '@/pages/hanami-trends-history.vue';
import Widget from '@/widgets/WidgetHanamiTrends.vue';
import Row from '@/components/HanamiTrendRow.vue';
import type * as Misskey from 'misskey-js';

describe('HanamiTrendRow', () => {
	const base = { trendEntryId: 't1', snapshotId: 's1', snapshotGeneratedAt: '2026-09-14T12:40:00Z', term: '停電', topicId: 'topic', relatedTerms: [], startedAt: null, distinctAuthors: 41, score: 9876 };
	const note = { id: 'n1', createdAt: '2026-09-14T12:10:00Z', text: 'うち一帯まだ復旧してない', user: { id: 'u1', username: 'maruko', name: 'まるこ' } } as unknown as Misskey.entities.Note;

	test('renders term (linked to search), author count, rank and one representative note line, never the score', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: note }, rank: 1 }, global: { stubs: rowStubs } });
		expect(view.getByText('停電').getAttribute('href')).toBe('/search?q=%E5%81%9C%E9%9B%BB');
		expect(view.getByText('41 people')).toBeTruthy();
		expect(view.getByText('1')).toBeTruthy();
		expect(view.getByText('うち一帯まだ復旧してない').closest('a')?.getAttribute('href')).toBe('/notes/n1');
		expect(view.container.textContent).not.toContain('9876');
	});

	test('showAuthors=false hides the authors label while keeping the term and rank', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: null }, rank: 1, showAuthors: false }, global: { stubs: rowStubs } });
		expect(view.getByText('停電')).toBeTruthy();
		expect(view.queryByText('41 people')).toBeNull();
		expect(view.getByText('1')).toBeTruthy();
	});

	test('shows the muted fallback when there is no representative note', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: null }, rank: 4 }, global: { stubs: rowStubs } });
		expect(view.getByText('No note')).toBeTruthy();
		expect(view.container.querySelector('a[href^="/notes/"]')).toBeNull();
	});
});

// Exercise six-hour history and pagination as well as the shared row.
const api = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApiGet: api }));
vi.mock('@@/js/intl-const.js', () => ({ versatileLang: 'ja-JP' }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i18n.js', () => ({
	i18n: {
		ts: { reload: 'Reload', _widgets: { hanamiTrends: 'Word trends' }, somethingHappened: 'Error', retry: 'Retry', _hana: { _trends: { history: 'History', empty: 'Empty', older: 'Older', noRepresentativeNote: 'No note', blockNight0: '深夜', blockMorning: '朝', blockDaytime: '昼', blockEvening: '夜', continuedFromBefore: 'From earlier', showTopicNotes: 'Show posts on this topic', hideTopicNotes: 'Close', noTopicNotes: 'No posts to show', topicNotesFailed: "Couldn't load posts" } } },
		tsx: { _hana: { _trends: { snapshot: ({ time }: { time: string }) => time, group: ({ n }: { n: number }) => `${n} words`, authors: ({ n }: { n: number }) => `${n} people`, blockHeading: ({ date, name, from, to }: Record<string, string>) => `${date} ${name}（${from}〜${to}）`, period: ({ from, to }: Record<string, string>) => `${from}〜${to}`, peakAuthors: ({ n }: { n: number }) => `Up to ${n} people` } } },
	},
}));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
const noteLifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('@/components/MkNote.vue', async () => {
	const { defineComponent, onMounted, onBeforeUnmount, ref } = await import('vue');
	return { default: defineComponent({
		props: { note: { type: Object as PropType<Pick<Misskey.entities.Note, 'id' | 'text'>>, required: true } },
		setup(props) {
			const reacted = ref(false);
			const voted = ref(false);
			onMounted(() => noteLifecycle.mounted(props.note.id));
			onBeforeUnmount(() => noteLifecycle.unmounted(props.note.id));
			return { reacted, voted };
		},
		template: '<article data-testid="topic-post"><span data-testid="post-text">{{ note.text }}</span><button :aria-pressed="reacted" @click="reacted = !reacted">Reaction</button><button :aria-pressed="voted" @click="voted = !voted">Vote</button></article>',
	}) };
});

const rowStubs = {
	MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
	MkAvatar: true,
	MkUserName: true,
	MkTime: true,
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};

const stubs = {
	PageWithHeader: { template: '<main><slot/></main>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
	MkLoading: { props: ['mini'], template: '<div data-testid="loading" :data-mini="mini"/>' },
	MkAvatar: true,
	MkUserName: true,
	MkTime: true,
	Mfm: true,
};
const item = (id: string, snapshotId: string) => ({ trendEntryId: id, snapshotId, snapshotGeneratedAt: '2026-09-14T12:40:00Z', term: id, topicId: null, relatedTerms: [], startedAt: null, distinctAuthors: 2, score: 9876, representativeNote: null });
afterEach(() => { cleanup(); api.mockReset(); noteLifecycle.mounted.mockReset(); noteLifecycle.unmounted.mockReset(); });

const historyItem = (id: string) => ({ topicId: id, term: id, relatedTerms: ['関連1', '関連2', '関連3', '関連4'], peakAuthors: 20, daily: false, firstSeenAt: '2026-10-05T09:40:00Z', lastSeenAt: '2026-10-05T13:00:00Z', startedAt: '2026-10-05T03:00:00Z', representativeNote: null });
const block = (from: string, to: string, ids: string[]) => ({ from, to, items: ids.map(historyItem) });

describe('saved topic posts (U-26, U-27)', () => {
	test('loads posts in order, closes while loading, and reopens without another request', async () => {
		const current = block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['topic']);
		const representative = { id: 'representative', text: 'Representative preview', user: { id: 'user', username: 'author' } } as unknown as Misskey.entities.Note;
		api.mockResolvedValueOnce({ blocks: [{ ...current, items: [{ ...current.items[0], representativeNote: representative }] }], nextUntil: null });
		let resolve!: (value: { notes: { id: string; text: string }[] }) => void;
		api.mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const view = render(History, { global: { stubs: { ...stubs, ...rowStubs } } });
		await fireEvent.click(await view.findByRole('button', { name: 'Show posts on this topic' }));
		expect(view.getByTestId('loading').getAttribute('data-mini')).toBe('');
		expect(view.getByRole('button', { name: 'Close' }).getAttribute('aria-expanded')).toBe('true');
		expect(api.mock.calls[1]).toEqual(['notes/hanami-trend-topic-notes', { from: current.from, to: current.to, topicId: 'topic' }]);
		await fireEvent.click(view.getByRole('button', { name: 'Close' }));
		expect(view.getByTestId('loading').parentElement?.style.display).toBe('none');
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(api).toHaveBeenCalledTimes(2);
		resolve({ notes: [{ id: 'first', text: 'First saved post' }, { id: 'second', text: 'Second saved post' }] });
		await view.findByText('Second saved post');
		expect(view.getAllByTestId('post-text').map(post => post.textContent)).toEqual(['First saved post', 'Second saved post']);
		expect(view.getByText('Representative preview').closest('a')?.getAttribute('href')).toBe('/notes/representative');
		await fireEvent.click(view.getByRole('button', { name: 'Close' }));
		expect(view.getAllByTestId('topic-post').every(post => post.parentElement?.style.display === 'none')).toBe(true);
		expect(view.getByText('Representative preview')).toBeTruthy();
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(view.getAllByTestId('topic-post')).toHaveLength(2);
		expect(api).toHaveBeenCalledTimes(2);
	});
	test('U-28: removes deleted posts from every loaded topic, including closed results', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['first', 'second'])], nextUntil: null });
		api.mockResolvedValueOnce({ notes: [{ id: 'shared', text: 'Shared deleted post' }, { id: 'kept', text: 'Kept post' }] });
		api.mockResolvedValueOnce({ notes: [{ id: 'shared', text: 'Shared deleted post' }] });
		const listenersBefore = globalEvents.listenerCount('noteDeleted');
		const view = render(History, { global: { stubs } });
		await view.findAllByRole('button', { name: 'Show posts on this topic' });
		expect(globalEvents.listenerCount('noteDeleted')).toBe(listenersBefore + 1);
		await fireEvent.click(view.getAllByRole('button', { name: 'Show posts on this topic' })[0]);
		await view.findByText('Kept post');
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		await view.findAllByText('Shared deleted post');
		await fireEvent.click(view.getAllByRole('button', { name: 'Close' })[1]);
		globalEvents.emit('noteDeleted', 'shared');
		await waitFor(() => expect(view.queryAllByText('Shared deleted post')).toHaveLength(0));
		expect(view.getByText('Kept post')).toBeTruthy();
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(view.getByText('No posts to show')).toBeTruthy();
		expect(api).toHaveBeenCalledTimes(3);
		view.unmount();
		expect(globalEvents.listenerCount('noteDeleted')).toBe(listenersBefore);
	});
	test('U-28: filters deletions before and during an in-flight response, even when the topic is closed', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['topic'])], nextUntil: null });
		let resolve!: (value: { notes: { id: string; text: string }[] }) => void;
		api.mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const view = render(History, { global: { stubs } });
		await view.findByRole('button', { name: 'Show posts on this topic' });
		globalEvents.emit('noteDeleted', 'before-request');
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		globalEvents.emit('noteDeleted', 'during-request');
		await fireEvent.click(view.getByRole('button', { name: 'Close' }));
		resolve({ notes: [{ id: 'before-request', text: 'Deleted before request' }, { id: 'during-request', text: 'Deleted during request' }, { id: 'kept', text: 'Late kept post' }] });
		await view.findByText('Late kept post');
		expect(view.queryByText('Deleted before request')).toBeNull();
		expect(view.queryByText('Deleted during request')).toBeNull();
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(view.getAllByTestId('topic-post')).toHaveLength(1);
		expect(api).toHaveBeenCalledTimes(2);
	});
	test('U-29: preserves the same MkNote instance, reaction and vote while closed', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['topic'])], nextUntil: null });
		api.mockResolvedValueOnce({ notes: [{ id: 'stateful', text: 'Stateful post' }] });
		const view = render(History, { global: { stubs } });
		await fireEvent.click(await view.findByRole('button', { name: 'Show posts on this topic' }));
		await view.findByText('Stateful post');
		const post = view.getByTestId('topic-post');
		await fireEvent.click(within(post).getByRole('button', { name: 'Reaction' }));
		await fireEvent.click(within(post).getByRole('button', { name: 'Vote' }));
		await fireEvent.click(view.getByRole('button', { name: 'Close' }));
		expect(post.parentElement?.style.display).toBe('none');
		expect(noteLifecycle.unmounted).not.toHaveBeenCalled();
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(view.getByTestId('topic-post')).toBe(post);
		expect(post.parentElement?.style.display).not.toBe('none');
		expect(within(post).getByRole('button', { name: 'Reaction' }).getAttribute('aria-pressed')).toBe('true');
		expect(within(post).getByRole('button', { name: 'Vote' }).getAttribute('aria-pressed')).toBe('true');
		expect(noteLifecycle.mounted).toHaveBeenCalledTimes(1);
		expect(api).toHaveBeenCalledTimes(2);
	});
	test('shows failure and explicit retry, caching an empty legacy result', async () => {
		const current = block('2026-10-05T03:00:00Z', '2026-10-05T09:00:00Z', ['legacy']);
		api.mockResolvedValueOnce({ blocks: [{ ...current, items: [{ ...current.items[0], topicId: null }] }], nextUntil: null });
		api.mockRejectedValueOnce(new Error('offline'));
		api.mockResolvedValueOnce({ notes: [] });
		const view = render(History, { global: { stubs } });
		await fireEvent.click(await view.findByRole('button', { name: 'Show posts on this topic' }));
		await view.findByText("Couldn't load posts");
		expect(view.getByRole('alert')).toBeTruthy();
		expect(api.mock.calls[1]).toEqual(['notes/hanami-trend-topic-notes', { from: current.from, to: current.to, term: 'legacy' }]);
		await fireEvent.click(view.getByRole('button', { name: 'Close' }));
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(api).toHaveBeenCalledTimes(2);
		await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
		await view.findByText('No posts to show');
		expect(api.mock.calls[2]).toEqual(api.mock.calls[1]);
		expect(view.queryByRole('alert')).toBeNull();
		await fireEvent.click(view.getByRole('button', { name: 'Close' }));
		await fireEvent.click(view.getByRole('button', { name: 'Show posts on this topic' }));
		expect(view.getByText('No posts to show')).toBeTruthy();
		expect(api).toHaveBeenCalledTimes(3);
	});
	test('keeps results separate for the same topic in different six-hour blocks', async () => {
		const latest = block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['topic']);
		const older = block('2026-10-05T03:00:00Z', '2026-10-05T09:00:00Z', ['topic']);
		api.mockResolvedValueOnce({ blocks: [latest, older], nextUntil: null });
		api.mockResolvedValueOnce({ notes: [{ id: 'latest', text: 'Latest block post' }] });
		api.mockResolvedValueOnce({ notes: [{ id: 'older', text: 'Older block post' }] });
		const view = render(History, { global: { stubs } });
		await view.findAllByRole('button', { name: 'Show posts on this topic' });
		const sections = view.container.querySelectorAll('section');
		await fireEvent.click(within(sections[0]).getByRole('button', { name: 'Show posts on this topic' }));
		await within(sections[0]).findByText('Latest block post');
		await fireEvent.click(within(sections[1]).getByRole('button', { name: 'Show posts on this topic' }));
		await within(sections[1]).findByText('Older block post');
		expect(within(sections[0]).queryByText('Older block post')).toBeNull();
		expect(within(sections[1]).queryByText('Latest block post')).toBeNull();
		expect(api.mock.calls.slice(1)).toEqual([
			['notes/hanami-trend-topic-notes', { from: latest.from, to: latest.to, topicId: 'topic' }],
			['notes/hanami-trend-topic-notes', { from: older.from, to: older.to, topicId: 'topic' }],
		]);
	});
});

describe('Hanami trends history pagination', () => {
	test('renders JST block headings, related terms, period, continuation and peak, loading two older blocks', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['one'])], nextUntil: '2026-10-05T09:00:00Z' });
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T03:00:00Z', '2026-10-05T09:00:00Z', ['two'])], nextUntil: null });
		const view = render(History, { global: { stubs } });
		await view.findByText('10月5日 夜（18:00〜24:00）');
		expect(view.getByText('one（関連1・関連2・関連3）')).toBeTruthy();
		expect(view.container.textContent).not.toContain('関連4');
		expect(view.container.textContent).toContain('From earlier 18:40〜22:00');
		expect(view.container.textContent).toContain('Up to 20 people');
		expect(view.queryByText('20 people', { exact: true })).toBeNull();
		await fireEvent.click(await view.findByText('Older'));
		await view.findByText('10月5日 昼（12:00〜18:00）');
		expect(api.mock.calls).toEqual([
			['notes/hanami-trend-history', { blocks: 2 }],
			['notes/hanami-trend-history', { blocks: 2, until: '2026-10-05T09:00:00Z' }],
		]);
		expect(view.queryByText('Older')).toBeNull();
	});
	test('keeps loaded blocks and retries the same boundary after an error', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', ['old'])], nextUntil: '2026-10-05T09:00:00Z' });
		api.mockRejectedValueOnce(new Error('offline'));
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T03:00:00Z', '2026-10-05T09:00:00Z', ['fresh'])], nextUntil: null });
		const view = render(History, { global: { stubs } });
		await fireEvent.click(await view.findByText('Older'));
		expect(view.getByText('old（関連1・関連2・関連3）')).toBeTruthy();
		await fireEvent.click(await view.findByText('Retry'));
		await view.findByText('fresh（関連1・関連2・関連3）');
		expect(api.mock.calls[1]).toEqual(api.mock.calls[2]);
	});
	test('U-20: hides empty headings and keeps pagination through entirely empty blocks', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', []), block('2026-10-05T03:00:00Z', '2026-10-05T09:00:00Z', [])], nextUntil: '2026-10-05T03:00:00Z' });
		api.mockResolvedValueOnce({ blocks: [block('2026-10-04T21:00:00Z', '2026-10-05T03:00:00Z', ['found']), block('2026-10-04T15:00:00Z', '2026-10-04T21:00:00Z', [])], nextUntil: null });
		const view = render(History, { global: { stubs } });
		await view.findByText('Older');
		expect(view.container.querySelectorAll('h2')).toHaveLength(0);
		expect(view.queryByText('Empty')).toBeNull();
		await fireEvent.click(view.getByText('Older'));
		await view.findByText('found（関連1・関連2・関連3）');
		expect(view.container.querySelectorAll('h2')).toHaveLength(1);
		expect(view.getByText('10月5日 朝（06:00〜12:00）')).toBeTruthy();
		expect(view.queryByText('20 people', { exact: true })).toBeNull();
		expect(view.getByText('Up to 20 people', { exact: false })).toBeTruthy();
		expect(api.mock.calls[1]).toEqual(['notes/hanami-trend-history', { blocks: 2, until: '2026-10-05T03:00:00Z' }]);
	});
	test('empty blocks show the empty message only when no older page remains', async () => {
		api.mockResolvedValueOnce({ blocks: [block('2026-10-05T09:00:00Z', '2026-10-05T15:00:00Z', [])], nextUntil: null });
		const view = render(History, { global: { stubs } });
		await view.findByText('Empty');
		expect(view.container.querySelector('h2')).toBeNull();
		expect(view.queryByText('Older')).toBeNull();
	});
	test('empty history has no older button', async () => {
		api.mockResolvedValueOnce({ blocks: [], nextUntil: null });
		const view = render(History, { global: { stubs } });
		await view.findByText('Empty');
		expect(view.queryByText('Older')).toBeNull();
	});
});

const interval = vi.hoisted(() => vi.fn());
vi.mock('@@/js/use-interval.js', () => ({ useInterval: interval }));
vi.mock('@/filters/date.js', () => ({ dateString: (value: string) => value }));
vi.mock('@/widgets/widget.js', () => ({ useWidgetPropsManager: () => ({ widgetProps: { showHeader: true }, configure: vi.fn() }) }));
vi.mock('@/components/MkContainer.vue', () => ({ default: { template: '<div><slot name="header"/><slot name="func" /><slot/></div>' } }));

describe('Hanami trends widget requests', () => {
	test('U-27: retains the single representative preview and note link without topic controls', async () => {
		api.mockResolvedValue({ items: [{ ...item('word', 'a'), representativeNote: { id: 'preview', text: 'Widget representative', user: { id: 'u', username: 'author' } } }], nextCursor: null, hasMore: false });
		const view = render(Widget, { global: { stubs: { ...stubs, ...rowStubs } } });
		await interval.mock.calls.at(-1)![0]();
		expect((await view.findByText('Widget representative')).closest('a')?.getAttribute('href')).toBe('/notes/preview');
		expect(view.container.querySelectorAll('a[href^="/notes/"]')).toHaveLength(1);
		expect(view.queryByRole('button', { name: 'Show posts on this topic' })).toBeNull();
	});
	test('uses the same read request for refresh and the ten minute interval', async () => {
		api.mockResolvedValue({ items: [item('word', 'a')], nextCursor: null, hasMore: false });
		const view = render(Widget, { global: { stubs } });
		const [refresh, delay, options] = interval.mock.calls.at(-1)!;
		expect(delay).toBe(600000);
		expect(options).toEqual({ immediate: true, afterMounted: true });
		await refresh();
		await view.findByText('word');
		await fireEvent.click(view.getByRole('button', { name: 'Reload' }));
		await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
		for (const call of api.mock.calls) {
			expect(call).toEqual(['notes/hanami-trends', { history: false, limit: 10 }]);
		}
	});
});
