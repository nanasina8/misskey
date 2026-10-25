/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { globalEvents } from '@/events.js';
import Trends from '@/pages/hanami-trends.vue';
import Timeline from '@/components/HanamiTopicTimeline.vue';
import Row from '@/components/HanamiTrendRow.vue';
import Sparkline from '@/components/HanamiTopicSparkline.vue';
import { ROUTE_DEF } from '@/router.definition.js';
import { Nirax as Router } from '@/lib/nirax.js';

const api = vi.hoisted(() => vi.fn());
const replaceQuery = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/router.js', () => ({ useRouter: () => ({ replace: replaceQuery }) }));
vi.mock('@/os.js', () => ({ toast: notify }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApiGet: api }));
vi.mock('@@/js/intl-const.js', () => ({ versatileLang: 'en-US' }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: null, iAmModerator: false }));
vi.mock('@/pages/timeline.vue', () => ({ default: {} }));
vi.mock('@/pages/_loading_.vue', () => ({ default: {} }));
vi.mock('@/pages/_error_.vue', () => ({ default: {} }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkNote.vue', () => ({ default: { props: ['note'], template: '<article data-testid="post">{{ note.text }}</article>' } }));
vi.mock('@/i18n.js', () => ({ i18n: {
	ts: { loadMore: 'Load more', retry: 'Retry', somethingHappened: 'Error', _hana: { _trends: {
		title: "What's happening", tabNow: 'Now', tabPast: 'Past', kindNew: 'New', kindRising: 'Rising', kindSteady: 'Ongoing',
		sortPopular: 'Popular', sortRecent: 'Recent', topicNotFound: "This topic wasn't found", noTopicNotes: 'No posts', empty: 'Empty', noRepresentativeNote: 'No note', older: 'Older',
	} } },
	tsx: { _hana: { _trends: {
		authors: ({ n }: { n: number }) => `${n} people`, since: ({ time }: { time: string }) => `Since ${time}`,
		ongoingSince: ({ time }: { time: string }) => `Ongoing since ${time}`, range: ({ from, to }: { from: string; to: string }) => `${from}–${to}`,
		peakAuthorsLong: ({ n }: { n: number }) => `Up to ${n} people talking`,
	} } },
} }));

const stubs = {
	PageWithHeader: { props: ['tab', 'tabs'], emits: ['update:tab'], template: '<main><nav v-if="tabs?.length"><button v-for="item in tabs" :key="item.key" @click="$emit(\'update:tab\', item.key)">{{ item.title }}</button></nav><slot/></main>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
	MkAvatar: { props: ['user'], template: '<span data-testid="avatar">{{ user.id }}</span>' },
	MkUserName: true, MkTime: true,
	MkLoading: { template: '<div data-testid="loading"/>' },
	Mfm: { props: ['text'], template: '<span>{{ text }}</span>' },
};
const appears: Array<() => Promise<void>> = [];
const global = { stubs, directives: { appear: { mounted(_element: Element, binding: { value: () => Promise<void> }) { appears.push(binding.value); } } } };
const at = '2026-10-07T12:00:00Z';
const series = [{ at: '2026-10-07T11:00:00Z', authors: 5 }, { at, authors: 10 }];
const metadata = { topicId: 'topic', term: 'headline', relatedTerms: ['one', 'two', 'three', 'four'], startedAt: '2026-10-07T10:00:00Z', lastSeenAt: at, peakAuthors: 60, series, kind: 'rising', active: true };
const post = (id: string) => ({ id, text: `Post ${id}` });
const trendItem = { ...metadata, trendEntryId: 'entry', snapshotId: 'snapshot', snapshotGeneratedAt: at, distinctAuthors: 10, representativeNote: null, participants: [], score: 1 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); api.mockReset(); replaceQuery.mockReset(); notify.mockReset(); appears.length = 0; });

function controlBodyWidth() {
	let callback: (entries: { contentRect: { width: number } }[]) => void = () => {};
	let observed: Element | undefined;
	const disconnect = vi.fn();
	vi.stubGlobal('ResizeObserver', class {
		constructor(update: typeof callback) { callback = update; }
		observe(element: Element) { observed = element; }
		disconnect = disconnect;
	});
	return { resize: (width: number) => callback([{ contentRect: { width } }]), element: () => observed, disconnect };
}

describe('V-5: current row and momentum graph', () => {
	test('uses topic IDs, two related words, avatars capped at three, badge, since time and note link', () => {
		const view = render(Row, { props: { item: { ...trendItem, kind: 'rising', participants: ['u1', 'u2', 'u3', 'u4'].map(id => ({ id })) as never,
			representativeNote: { id: 'representative', user: { id: 'author' }, text: 'Representative' } as never }, rank: 2 }, global });
		expect(view.getByText('headline（one・two）').getAttribute('href')).toBe('/hanami/trends?topic=topic');
		expect(view.getByText('Representative').closest('a')?.getAttribute('href')).toBe('/notes/representative');
		expect(view.getAllByTestId('avatar').map(avatar => avatar.textContent)).toEqual(['author', 'u1', 'u2', 'u3']);
		expect(view.getByText('Rising')).toBeTruthy();
		expect(view.getByText('Since 10:00')).toBeTruthy();
		expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('64');
		expect(view.container.querySelector('svg')?.getAttribute('height')).toBe('22');
	});
	test('legacy rows have plain headings and no search link; past layout keeps three related words and omits new details', () => {
		const view = render(Row, { props: { item: { ...trendItem, topicId: null } as never, rank: 1, variant: 'past' }, global });
		expect(view.getByText('headline（one・two・three）').tagName).toBe('SPAN');
		expect(view.container.querySelector('a')).toBeNull();
		expect(view.queryByText('Rising')).toBeNull();
		expect(view.container.querySelector('svg')).toBeNull();
	});
	test('graphs require two points, include area/line/latest dot and show first/last ticks only when large', async () => {
		const view = render(Sparkline, { props: { series: [series[0]] }, global });
		expect(view.container.querySelector('svg')).toBeNull();
		await view.rerender({ series, large: true });
		expect(view.container.querySelector('svg')?.getAttribute('height')).toBe('48');
		expect(view.container.querySelector('polygon')).toBeTruthy();
		expect(view.container.querySelector('polyline')).toBeTruthy();
		expect(view.container.querySelector('circle')?.getAttribute('cx')).toBe('638');
		expect(view.getByText('11:00')).toBeTruthy();
		expect(view.getByText('12:00')).toBeTruthy();
	});
});

describe('V-24: split topics by body width', () => {
	test('switches at 760 body pixels regardless of viewport, retaining selection, sort and loaded posts', async () => {
		const width = controlBodyWidth();
		const other = { ...trendItem, topicId: 'other', term: 'other', relatedTerms: [] };
		api.mockResolvedValueOnce({ items: [trendItem, other] }).mockResolvedValueOnce([post('other')]).mockResolvedValueOnce([post('recent')]);
		const view = render(Trends, { props: { initialTopic: 'other' }, global });
		await view.findByText('Post other');
		const viewport = window.innerWidth;
		width.resize(759);
		await waitFor(() => expect(view.getByRole('button', { name: 'headline' })).toBeTruthy());
		width.resize(760);
		await waitFor(() => expect(view.getByRole('button', { name: '1 headline（one・two） Rising 10 people' })).toBeTruthy());
		expect(width.element()).toBe(view.getByRole('group').parentElement);
		expect(window.innerWidth).toBe(viewport);
		expect(view.getByRole('button', { name: '2 other Rising 10 people' }).getAttribute('aria-pressed')).toBe('true');
		expect(view.getByRole('heading', { name: 'other' })).toBeTruthy();
		await fireEvent.click(view.getByRole('tab', { name: 'Recent' }));
		await view.findByText('Post recent');
		const postElement = view.getByTestId('post');
		width.resize(759);
		await waitFor(() => expect(view.getByRole('button', { name: 'other' }).getAttribute('aria-pressed')).toBe('true'));
		expect(view.getByTestId('post')).toBe(postElement);
		expect(view.getByRole('tab', { name: 'Recent' }).getAttribute('aria-selected')).toBe('true');
		width.resize(1000);
		await waitFor(() => expect(view.getByRole('button', { name: '2 other Rising 10 people' }).getAttribute('aria-pressed')).toBe('true'));
		expect(view.getByTestId('post')).toBe(postElement);
		expect(api).toHaveBeenCalledTimes(3);
		expect(replaceQuery).not.toHaveBeenCalled();
		view.unmount();
		expect(width.disconnect).toHaveBeenCalledTimes(1);
		width.resize(360);
		expect(api).toHaveBeenCalledTimes(3);
	});
	test('row selection replaces the query and retains the same list and its vertical position', async () => {
		const width = controlBodyWidth();
		const other = { ...trendItem, topicId: 'other', term: 'other', relatedTerms: [] };
		api.mockResolvedValueOnce({ items: [trendItem, other] }).mockResolvedValueOnce([post('topic')]).mockResolvedValueOnce([post('other')]);
		const view = render(Trends, { global });
		await view.findByText('Post topic');
		width.resize(760);
		const row = await view.findByRole('button', { name: '2 other Rising 10 people' });
		const list = view.getByRole('group');
		list.scrollTop = 180;
		row.focus();
		expect(document.activeElement).toBe(row);
		await fireEvent.click(row);
		await view.findByText('Post other');
		expect(row.getAttribute('aria-pressed')).toBe('true');
		expect(view.getByRole('group')).toBe(list);
		expect(list.scrollTop).toBe(180);
		expect(replaceQuery).toHaveBeenCalledWith('/hanami/trends', { query: { topic: 'other' } });
	});
	test('temporary ended topics and missing-topic fallback use the same selection in both layouts', async () => {
		const width = controlBodyWidth();
		api.mockResolvedValueOnce({ items: [trendItem] }).mockResolvedValueOnce({ ...metadata, topicId: 'past', term: 'ended', active: false }).mockResolvedValueOnce([]);
		const view = render(Trends, { props: { initialTopic: 'past' }, global });
		await view.findByText('No posts');
		width.resize(760);
		await waitFor(() => expect(view.getByRole('button', { name: '1 ended（one・two） Rising Up to 60 people talking' }).getAttribute('aria-pressed')).toBe('true'));
		api.mockRejectedValueOnce({ code: 'NO_SUCH_TOPIC' }).mockResolvedValueOnce([]);
		await view.rerender({ initialTopic: 'missing' });
		await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
		expect(view.getByRole('button', { name: '2 headline（one・two） Rising 10 people' }).getAttribute('aria-pressed')).toBe('true');
		width.resize(759);
		await waitFor(() => expect(view.getByRole('button', { name: 'headline' }).getAttribute('aria-pressed')).toBe('true'));
		expect(replaceQuery).toHaveBeenCalledWith('/hanami/trends', { query: { topic: 'topic' } });
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

describe('V-21 / V-15: topic timeline lifecycle and SQL offsets', () => {
	test('V-15: a late notes response and an old scroll callback after unmount cannot fetch another page', async () => {
		let resolve!: (value: unknown) => void;
		api.mockResolvedValueOnce([post('first')]).mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		await view.findByText('Post first');
		const appear = appears.at(-1)!;
		await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
		view.unmount();
		resolve([post('late')]);
		await new Promise<void>(done => queueMicrotask(() => done()));
		await appear();
		expect(api).toHaveBeenCalledTimes(2);
	});
	test('loads SQL windows at offsets 0 and 20 even after safety filtering; zero response stops and sort restarts', async () => {
		api.mockResolvedValueOnce([post('first')]).mockResolvedValueOnce([]).mockResolvedValueOnce([post('newest')]);
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		await view.findByText('Post first');
		expect(api.mock.calls[0]).toEqual(['notes/hanami-topic-notes', { topicId: 'topic', sort: 'popular', limit: 20, offset: 0 }]);
		// The existing appear directive invokes this when the next-page button enters the viewport.
		await appears.at(-1)!();
		await waitFor(() => expect(view.queryByRole('button', { name: 'Load more' })).toBeNull());
		expect(api.mock.calls[1][1].offset).toBe(20);
		await fireEvent.click(view.getByRole('tab', { name: 'Recent' }));
		await view.findByText('Post newest');
		expect(view.queryByText('Post first')).toBeNull();
		expect(api.mock.calls[2][1]).toEqual({ topicId: 'topic', sort: 'recent', limit: 20, offset: 0 });
	});
	test('stops after 500 SQL positions without requesting offset 500', async () => {
		api.mockImplementation(async (_endpoint, params) => [post(String(params.offset))]);
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		await view.findByText('Post 0');
		for (let offset = 20; offset <= 480; offset += 20) {
			await fireEvent.click(await view.findByRole('button', { name: 'Load more' }));
			await view.findByText(`Post ${offset}`);
		}
		expect(view.queryByRole('button', { name: 'Load more' })).toBeNull();
		expect(api.mock.calls.map(call => call[1].offset)).toEqual(Array.from({ length: 25 }, (_, i) => i * 20));
	});
	test('removes deleted posts, remembers deletions before late results, ignores stale sort responses and releases its listener', async () => {
		let resolve!: (value: unknown) => void;
		api.mockResolvedValueOnce([post('visible')]).mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const listeners = globalEvents.listenerCount('noteDeleted');
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		await view.findByText('Post visible');
		globalEvents.emit('noteDeleted', 'visible');
		globalEvents.emit('noteDeleted', 'before');
		await waitFor(() => expect(view.queryByText('Post visible')).toBeNull());
		await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
		globalEvents.emit('noteDeleted', 'during');
		resolve([post('before'), post('during'), post('kept')]);
		await view.findByText('Post kept');
		expect(view.queryByText('Post before')).toBeNull();
		expect(view.queryByText('Post during')).toBeNull();
		api.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce([post('recent')]);
		await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
		await fireEvent.click(view.getByRole('tab', { name: 'Recent' }));
		await view.findByText('Post recent');
		resolve([post('stale')]);
		await waitFor(() => expect(view.queryByText('Post stale')).toBeNull());
		view.unmount();
		expect(globalEvents.listenerCount('noteDeleted')).toBe(listeners);
	});
	test('retries errors at the same SQL offset and resets when the topic changes', async () => {
		api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		await view.findByRole('alert');
		await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
		await view.findByText('No posts');
		expect(api.mock.calls[0]).toEqual(api.mock.calls[1]);
		api.mockResolvedValueOnce([post('new-topic')]);
		await view.rerender({ topicId: 'other' });
		await view.findByText('Post new-topic');
		expect(api.mock.calls.at(-1)).toEqual(['notes/hanami-topic-notes', { topicId: 'other', sort: 'popular', limit: 20, offset: 0 }]);
	});
});

describe('V-21: one chip page and topic query', () => {
	test('empty and legacy-only lists show the empty state without a timeline request', async () => {
		api.mockResolvedValueOnce({ items: [{ ...trendItem, topicId: null }] });
		const view = render(Trends, { global });
		await view.findByText('Empty');
		expect(view.queryByRole('group')).toBeNull();
		expect(api.mock.calls).toEqual([['notes/hanami-trends', { limit: 30 }]]);
	});
	test('retries current-list and ended-topic errors using the same request parameters', async () => {
		api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [trendItem] }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...metadata, topicId: 'past' }).mockResolvedValueOnce([]);
		const view = render(Trends, { props: { initialTopic: 'past' }, global });
		await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
		await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
		await view.findByText('No posts');
		expect(api.mock.calls[0]).toEqual(api.mock.calls[1]);
		expect(api.mock.calls[2]).toEqual(api.mock.calls[3]);
	});
	test('defaults to the first non-null topic and shows only headings in chips, full summary, tabs and timeline', async () => {
		api.mockResolvedValueOnce({ items: [{ ...trendItem, topicId: null, term: 'legacy' }, trendItem] }).mockResolvedValueOnce([post('first')]);
		const view = render(Trends, { global });
		await view.findByText('Post first');
		expect(view.getByRole('button', { name: 'headline' }).getAttribute('aria-pressed')).toBe('true');
		expect(view.getByRole('heading', { name: 'headline（one・two・three・four）' })).toBeTruthy();
		expect(view.getByText('10 people')).toBeTruthy();
		expect(view.getByText('Rising')).toBeTruthy();
		expect(view.getByText(/Ongoing since.*Oct 7.*10:00/)).toBeTruthy();
		expect(view.container.querySelector('svg')?.getAttribute('height')).toBe('40');
		expect(view.queryByRole('button', { name: 'legacy' })).toBeNull();
		expect(view.queryByRole('button', { name: 'Past' })).toBeNull();
		expect(api.mock.calls).toEqual([['notes/hanami-trends', { limit: 30 }], ['notes/hanami-topic-notes', { topicId: 'topic', sort: 'popular', limit: 20, offset: 0 }]]);
	});
	test('uses ?topic, replaces the query on a chip click and preserves the same strip and scroll position', async () => {
		const other = { ...trendItem, topicId: 'other', term: 'other', relatedTerms: [] };
		api.mockResolvedValueOnce({ items: [trendItem, other] }).mockResolvedValueOnce([post('other')]).mockResolvedValueOnce([post('topic')]);
		const view = render(Trends, { props: { initialTopic: 'other' }, global });
		await view.findByText('Post other');
		const strip = view.getByRole('group');
		strip.scrollLeft = 90;
		await fireEvent.click(view.getByRole('button', { name: 'headline' }));
		await view.findByText('Post topic');
		expect(replaceQuery).toHaveBeenCalledWith('/hanami/trends', { query: { topic: 'topic' } });
		expect(view.getByRole('group')).toBe(strip);
		expect(strip.scrollLeft).toBe(90);
		expect(view.queryByText('Post other')).toBeNull();
		expect(view.getByRole('tab', { name: 'Popular' }).getAttribute('aria-selected')).toBe('true');
	});
	test('adds an ended topic as the first temporary chip and reuses it without refetching metadata', async () => {
		api.mockResolvedValueOnce({ items: [trendItem] }).mockResolvedValueOnce({ ...metadata, topicId: 'past', term: 'ended', active: false }).mockResolvedValueOnce([]);
		const view = render(Trends, { props: { initialTopic: 'past' }, global });
		await view.findByText('No posts');
		expect(Array.from(view.getByRole('group').querySelectorAll('button')).map(button => button.textContent?.trim())).toEqual(['ended', 'headline']);
		expect(view.getByRole('button', { name: 'ended' }).getAttribute('aria-pressed')).toBe('true');
		expect(view.getByText('Up to 60 people talking')).toBeTruthy();
		expect(api.mock.calls[1]).toEqual(['notes/hanami-topic', { topicId: 'past' }]);
		api.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		await fireEvent.click(view.getByRole('button', { name: 'headline' }));
		await waitFor(() => expect(api).toHaveBeenCalledTimes(4));
		await fireEvent.click(view.getByRole('button', { name: 'ended' }));
		await waitFor(() => expect(api).toHaveBeenCalledTimes(5));
		expect(api.mock.calls.filter(([endpoint]) => endpoint === 'notes/hanami-topic')).toHaveLength(1);
	});
	test('NO_SUCH_TOPIC falls back to first place, replaces the query and notifies only once for the same missing ID', async () => {
		api.mockResolvedValueOnce({ items: [trendItem] }).mockRejectedValueOnce({ code: 'NO_SUCH_TOPIC' }).mockResolvedValueOnce([]);
		const view = render(Trends, { props: { initialTopic: 'missing' }, global });
		await view.findByText('No posts');
		expect(replaceQuery).toHaveBeenCalledWith('/hanami/trends', { query: { topic: 'topic' } });
		expect(notify).toHaveBeenCalledTimes(1);
		await view.rerender({ initialTopic: 'topic' });
		api.mockRejectedValueOnce({ code: 'NO_SUCH_TOPIC' }).mockResolvedValueOnce([]);
		await view.rerender({ initialTopic: 'missing' });
		await waitFor(() => expect(api.mock.calls.filter(([endpoint]) => endpoint === 'notes/hanami-topic')).toHaveLength(2));
		expect(notify).toHaveBeenCalledTimes(1);
	});
	test('late current-list and ended-topic responses after departure never start loading posts', async () => {
		let resolve!: (value: unknown) => void;
		api.mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const first = render(Trends, { global });
		first.unmount();
		resolve({ items: [trendItem] });
		await new Promise<void>(done => queueMicrotask(() => done()));
		expect(api).toHaveBeenCalledTimes(1);
		api.mockReset();
		api.mockResolvedValueOnce({ items: [trendItem] }).mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const second = render(Trends, { props: { initialTopic: 'past' }, global });
		await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
		second.unmount();
		resolve(metadata);
		await new Promise<void>(done => queueMicrotask(() => done()));
		expect(api).toHaveBeenCalledTimes(2);
	});
	test('ignores old ended-topic responses after choosing a live chip', async () => {
		let resolve!: (value: unknown) => void;
		api.mockResolvedValueOnce({ items: [trendItem] }).mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce([post('live')]);
		const view = render(Trends, { props: { initialTopic: 'past' }, global });
		await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
		await fireEvent.click(view.getByRole('button', { name: 'headline' }));
		await view.findByText('Post live');
		resolve({ ...metadata, topicId: 'past', term: 'obsolete' });
		await new Promise<void>(done => queueMicrotask(() => done()));
		expect(view.queryByRole('button', { name: 'obsolete' })).toBeNull();
		expect(api).toHaveBeenCalledTimes(3);
	});
	test('public old routes redirect to the one page and preserve the encoded topic query', () => {
		const old = new Router(ROUTE_DEF, '/hanami/trends/history?tab=past', false, {});
		old.init();
		expect(old.getCurrentFullPath()).toBe('/hanami/trends');
		const topic = new Router(ROUTE_DEF, '/hanami/topics/topic', false, {});
		topic.init();
		expect(topic.getCurrentFullPath()).toBe('/hanami/trends?topic=topic');
		expect(topic.current.props.get('initialTopic')).toBe('topic');
		expect(topic.current.route.loginRequired).toBe(false);
	});
});
