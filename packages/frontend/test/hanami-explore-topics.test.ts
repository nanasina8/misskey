/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import Explore from '@/pages/explore.vue';
import Topics from '@/pages/explore.topics.vue';
import Timeline from '@/components/HanamiTopicTimeline.vue';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApiGet: api }));
vi.mock('@@/js/intl-const.js', () => ({ versatileLang: 'ja-JP' }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/pages/explore.featured.vue', () => ({ default: { template: '<div>Featured tab</div>' } }));
vi.mock('@/pages/explore.users.vue', () => ({ default: { template: '<div>Users tab</div>' } }));
vi.mock('@/pages/explore.roles.vue', () => ({ default: { template: '<div>Roles tab</div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkNote.vue', () => ({ default: { props: ['note'], template: '<article data-testid="post">{{ note.text }}</article>' } }));
vi.mock('@/i18n.js', () => ({ i18n: {
	ts: {
		explore: 'みつける', featured: 'ハイライト', users: 'ユーザー', roles: 'ロール', showMore: 'もっと見る',
		loadMore: 'もっと読む', retry: '再試行', somethingHappened: '問題が発生しました',
		_hana: {
			_explore: { tabTopics: '話題', showAllTopicNotes: 'この話題の投稿をすべて見る' },
			_trends: { title: 'いま話題', seeAll: 'もっと見る', empty: '話題なし', noTopicNotes: '投稿なし', kindNew: '新しい話題', kindRising: '上昇中', kindSteady: '継続中', sortPopular: '人気順', sortRecent: '新着順' },
		},
	},
	tsx: { _hana: { _trends: {
		authors: ({ n }: { n: number }) => `${n}人`, since: ({ time }: { time: string }) => `${time}〜`, snapshot: ({ time }: { time: string }) => `${time} 更新`,
	} } },
} }));

const appears: Array<() => Promise<void>> = [];
const global = {
	stubs: {
		PageWithHeader: { props: ['tab', 'tabs'], emits: ['update:tab'], template: '<main><nav><button v-for="item in tabs" :key="item.key" role="tab" :aria-selected="tab === item.key" :data-icon="item.icon" @click="$emit(\'update:tab\', item.key)">{{ item.title }}</button></nav><slot/></main>' },
		MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
		MkLoading: { template: '<div data-testid="loading"/>' },
	},
	directives: { appear: { mounted(_element: Element, binding: { value: () => Promise<void> }) { appears.push(binding.value); } } },
};
const post = (id: string) => ({ id, text: `Post ${id}` } as Misskey.entities.Note);
type Trend = Misskey.entities.NotesHanamiTrendsResponse['items'][number];
const trend = (topicId: string, overrides: Partial<Trend> = {}): Trend => ({
	topicId, trendEntryId: topicId, snapshotId: 'snapshot', snapshotGeneratedAt: '2026-10-29T12:00:00Z',
	term: topicId, title: null, relatedTerms: [], startedAt: '2026-10-29T10:00:00Z', distinctAuthors: 10,
	kind: 'rising', series: [{ at: '2026-10-29T11:00:00Z', authors: 5 }, { at: '2026-10-29T12:00:00Z', authors: 10 }],
	representativeNote: null, participants: [], score: 1, ...overrides,
});

function mockTopics(items: Trend[] = [trend('first'), trend('second')], featured: Misskey.entities.Note[] = []): void {
	api.mockImplementation(async (endpoint, params) => {
		if (endpoint === 'notes/hanami-trends') return { items };
		if (endpoint === 'notes/featured') return featured.slice(0, params.limit);
		return Array.from({ length: params.limit }, (_, index) => post(`${params.topicId}-${params.sort}-${index}`));
	});
}

afterEach(() => { cleanup(); api.mockReset(); appears.length = 0; });

describe('explore tabs', () => {
	test('places topics first and opens it by default; all existing tabs still open', async () => {
		mockTopics();
		const view = render(Explore, { global });
		const nav = within(view.getByRole('navigation'));
		expect(nav.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['話題', 'ハイライト', 'ユーザー', 'ロール']);
		expect(nav.getByRole('tab', { name: '話題' }).getAttribute('aria-selected')).toBe('true');
		expect(nav.getByRole('tab', { name: '話題' }).getAttribute('data-icon')).toBe('ti ti-trending-up');
		await view.findByText('Post first-popular-0');
		for (const [label, content] of [['ハイライト', 'Featured tab'], ['ユーザー', 'Users tab'], ['ロール', 'Roles tab']]) {
			await fireEvent.click(nav.getByRole('tab', { name: label }));
			expect(view.getByText(content)).toBeTruthy();
		}
	});

	test('honors an initial featured tab without loading topics', () => {
		const view = render(Explore, { props: { initialTab: 'featured' }, global });
		expect(view.getByRole('tab', { name: 'ハイライト' }).getAttribute('aria-selected')).toBe('true');
		expect(view.getByText('Featured tab')).toBeTruthy();
		expect(api).not.toHaveBeenCalled();
	});

	test('the popular-posts more button switches the parent to featured', async () => {
		mockTopics([trend('first')], [post('featured')]);
		const view = render(Explore, { global });
		const moreFeatured = await view.findByRole('button', { name: 'もっと見る', description: 'ハイライト' });
		const moreTrends = view.getByRole('link', { name: 'もっと見る', description: 'いま話題' });
		expect(moreFeatured.getAttribute('aria-describedby')).toBe(view.getByRole('heading', { level: 2, name: 'ハイライト' }).id);
		expect(moreTrends.getAttribute('aria-describedby')).toBe(view.getByRole('heading', { level: 2, name: 'いま話題' }).id);
		expect(moreTrends.getAttribute('href')).toBe('/hanami/trends');
		await fireEvent.click(moreFeatured);
		expect(view.getByRole('tab', { name: 'ハイライト' }).getAttribute('aria-selected')).toBe('true');
		expect(view.getByText('Featured tab')).toBeTruthy();
	});
});

describe('topic cards', () => {
	test('uses titles, caps source terms at four, omits absent terms and filters null topic IDs', async () => {
		mockTopics([
			trend('legacy', { topicId: null }),
			trend('first', { title: '地域一帯の停電', term: '停電', relatedTerms: ['復旧', '電力', '地域', '除外'] }),
			trend('second', { term: '花火', relatedTerms: ['夜空', '夏', '祭り', '花', '除外'], startedAt: null }),
			trend('third', { term: '単独' }),
		]);
		const view = render(Topics, { global });
		const first = await view.findByRole('button', { name: '1 地域一帯の停電 上昇中' });
		expect(first.getAttribute('aria-expanded')).toBe('true');
		expect(view.getByText('停電・復旧・電力・地域')).toBeTruthy();
		expect(view.getByRole('button', { name: '2 花火 上昇中' })).toBeTruthy();
		expect(view.getByText('夜空・夏・祭り・花')).toBeTruthy();
		expect(view.getByRole('button', { name: '3 単独 上昇中' }).closest('article')?.querySelector('[class*="sourceTerms"]')).toBeNull();
		expect(view.queryByText(/除外|legacy/)).toBeNull();
		expect(view.getAllByText('10人')).toHaveLength(3);
		expect(view.getAllByText('10:00〜')).toHaveLength(2);
		expect(view.getByText('12:00 更新')).toBeTruthy();
		expect(view.container.querySelectorAll('svg')).toHaveLength(3);
		expect(view.getByRole('link', { name: 'もっと見る' }).getAttribute('href')).toBe('/hanami/trends');
		expect(api).toHaveBeenCalledWith('notes/hanami-trends', { history: false, limit: 10 });
	});

	test('opens only one card, connects aria-controls, loads three posts once and links to that topic', async () => {
		mockTopics([trend('first'), trend('second/id')]);
		const view = render(Topics, { global });
		await view.findByText('Post first-popular-0');
		const first = view.getByRole('button', { name: '1 first 上昇中' });
		const second = view.getByRole('button', { name: '2 second/id 上昇中' });
		const panel = document.getElementById(first.getAttribute('aria-controls')!);
		expect(panel?.contains(view.getByText('Post first-popular-0'))).toBe(true);
		expect(second.getAttribute('aria-expanded')).toBe('false');
		expect(first.querySelector('.ti-chevron-up')?.getAttribute('aria-hidden')).toBe('true');
		expect(second.querySelector('.ti-chevron-down')?.getAttribute('aria-hidden')).toBe('true');
		expect(view.getAllByTestId('post')).toHaveLength(3);
		expect(api.mock.calls.filter(([endpoint]) => endpoint === 'notes/hanami-topic-notes')).toEqual([
			['notes/hanami-topic-notes', { topicId: 'first', sort: 'popular', limit: 10, offset: 0 }],
		]);
		expect(view.queryByRole('button', { name: 'もっと読む' })).toBeNull();
		expect(appears).toHaveLength(0);
		expect(view.getByRole('link', { name: 'この話題の投稿をすべて見る' }).getAttribute('href')).toBe('/hanami/trends?topic=first');
		await fireEvent.click(second);
		await view.findByText('Post second/id-popular-0');
		expect(first.getAttribute('aria-expanded')).toBe('false');
		expect(second.getAttribute('aria-expanded')).toBe('true');
		expect(first.querySelector('.ti-chevron-down')).toBeTruthy();
		expect(first.querySelector('.ti-chevron-up')).toBeNull();
		expect(second.querySelector('.ti-chevron-up')).toBeTruthy();
		expect(second.querySelector('.ti-chevron-down')).toBeNull();
		expect(view.queryByText('Post first-popular-0')).toBeNull();
		expect(view.getAllByTestId('post')).toHaveLength(3);
		expect(view.getByRole('link', { name: 'この話題の投稿をすべて見る' }).getAttribute('href')).toBe('/hanami/trends?topic=second%2Fid');
		await fireEvent.click(second);
		expect(second.getAttribute('aria-expanded')).toBe('false');
		expect(second.querySelector('.ti-chevron-down')).toBeTruthy();
		expect(view.queryByTestId('post')).toBeNull();
		expect(api.mock.calls.filter(([endpoint]) => endpoint === 'notes/hanami-topic-notes')).toHaveLength(2);
	});

	test.each(['terms', 'authors', 'sparkline', 'since'])('toggles the whole card summary from %s using the same button', async target => {
		mockTopics([trend('first'), trend('second', { relatedTerms: ['関連語'] })]);
		const view = render(Topics, { global });
		await view.findByText('Post first-popular-0');
		const first = view.getByRole('button', { name: '1 first 上昇中', description: '10人 10:00〜' });
		const second = view.getByRole('button', { name: '2 second 上昇中', description: '関連語 10人 10:00〜' });
		const heading = view.getByRole('heading', { level: 3, name: '2 second 上昇中' });
		expect(heading.contains(second)).toBe(true);
		expect(second.querySelector('div, h3')).toBeNull();
		const summary = within(second);
		const targets = {
			terms: summary.getByText('関連語'),
			authors: summary.getByText('10人'),
			sparkline: second.querySelector('svg')!,
			since: summary.getByText('10:00〜'),
		};
		const clicked = targets[target as keyof typeof targets];
		expect(clicked.closest('button')).toBe(second);
		await fireEvent.click(clicked);
		await view.findByText('Post second-popular-0');
		expect(first.getAttribute('aria-expanded')).toBe('false');
		expect(second.getAttribute('aria-expanded')).toBe('true');
		expect(document.getElementById(second.getAttribute('aria-controls')!)?.contains(view.getByText('Post second-popular-0'))).toBe(true);
		await fireEvent.click(clicked);
		expect(second.getAttribute('aria-expanded')).toBe('false');
		expect(view.queryByTestId('post')).toBeNull();
	});

	test('shows loading, retries a failed trends request and opens the first topic after retry', async () => {
		let reject!: (reason: Error) => void;
		api.mockImplementation(async endpoint => {
			if (endpoint === 'notes/hanami-trends') return new Promise((_resolve, fail) => { reject = fail; });
			return [];
		});
		const view = render(Topics, { global });
		expect(await view.findByTestId('loading')).toBeTruthy();
		reject(new Error('offline'));
		expect(await view.findByRole('alert')).toBeTruthy();
		expect(view.getByText('問題が発生しました')).toBeTruthy();
		mockTopics();
		await fireEvent.click(view.getByRole('button', { name: '再試行' }));
		await view.findByText('Post first-popular-0');
		expect(view.getByRole('button', { name: '1 first 上昇中' }).getAttribute('aria-expanded')).toBe('true');
		expect(api.mock.calls.filter(([endpoint]) => endpoint === 'notes/hanami-trends')).toEqual([
			['notes/hanami-trends', { history: false, limit: 10 }],
			['notes/hanami-trends', { history: false, limit: 10 }],
		]);
	});

	test.each([{ items: [] }, { items: [trend('legacy', { topicId: null })] }])('shows the empty message when no usable topics exist: %j', async ({ items }) => {
		mockTopics(items);
		const view = render(Topics, { global });
		expect(await view.findByText('話題なし')).toBeTruthy();
		expect(view.queryByRole('button', { expanded: true })).toBeNull();
		expect(api.mock.calls.some(([endpoint]) => endpoint === 'notes/hanami-topic-notes')).toBe(false);
	});

	test('ignores a trends response received after leaving the tab', async () => {
		let resolve!: (value: unknown) => void;
		api.mockImplementation(async endpoint => endpoint === 'notes/hanami-trends' ? new Promise(done => { resolve = done; }) : []);
		const view = render(Topics, { global });
		view.unmount();
		resolve({ items: [trend('late')] });
		await new Promise<void>(done => queueMicrotask(done));
		expect(api).toHaveBeenCalledTimes(2);
	});
});

describe('popular posts', () => {
	test('excludes representatives from every topic before taking the first five featured posts', async () => {
		mockTopics(
			Array.from({ length: 10 }, (_, index) => trend(`topic${index}`, { representativeNote: post(`f${index}`) })),
			Array.from({ length: 20 }, (_, index) => post(`f${index}`)),
		);
		const view = render(Topics, { global });
		const heading = await view.findByRole('heading', { name: 'ハイライト' });
		const popular = within(heading.closest('section')!);
		expect(popular.getAllByTestId('post').map(note => note.textContent)).toEqual(['Post f10', 'Post f11', 'Post f12', 'Post f13', 'Post f14']);
		expect(api).toHaveBeenCalledWith('notes/featured', { limit: 20 });
	});

	test.each(['failure', 'empty', 'duplicates'])('omits the entire featured section on %s while showing topics', async state => {
		mockTopics([trend('first', { representativeNote: post('duplicate') })]);
		const implementation = api.getMockImplementation()!;
		api.mockImplementation(async (endpoint, params) => {
			if (endpoint !== 'notes/featured') return implementation(endpoint, params);
			if (state === 'failure') throw new Error('offline');
			return state === 'duplicates' ? [post('duplicate')] : [];
		});
		const view = render(Topics, { global });
		await view.findByText('Post first-popular-0');
		expect(view.queryByRole('heading', { name: 'ハイライト' })).toBeNull();
		expect(view.queryByRole('button', { name: 'もっと見る' })).toBeNull();
		expect(view.queryByRole('alert')).toBeNull();
	});

	test('waits for representatives before displaying an earlier featured response', async () => {
		let resolve!: (value: unknown) => void;
		api.mockImplementation(async endpoint => {
			if (endpoint === 'notes/hanami-trends') return new Promise(done => { resolve = done; });
			return endpoint === 'notes/featured' ? [post('duplicate'), post('keep')] : [];
		});
		const view = render(Topics, { global });
		await new Promise<void>(done => queueMicrotask(done));
		expect(view.queryByRole('heading', { name: 'ハイライト' })).toBeNull();
		resolve({ items: [trend('first', { representativeNote: post('duplicate') })] });
		await view.findByText('Post keep');
		expect(view.queryByText('Post duplicate')).toBeNull();
	});
});

describe('topic timeline preview', () => {
	test('requests ten posts, displays the first three, and fetches once per sort without appear', async () => {
		api.mockImplementation(async (_endpoint, params) => Array.from({ length: params.limit }, (_, index) => post(String(index))));
		const view = render(Timeline, { props: { topicId: 'topic', previewLimit: 3 }, global });
		await view.findByText('Post 0');
		expect(view.getAllByTestId('post').map(note => note.textContent)).toEqual(['Post 0', 'Post 1', 'Post 2']);
		expect(view.queryByText('Post 3')).toBeNull();
		expect(view.queryByRole('button', { name: 'もっと読む' })).toBeNull();
		expect(appears).toHaveLength(0);
		await fireEvent.click(view.getByRole('tab', { name: '人気順' }));
		expect(api).toHaveBeenCalledTimes(1);
		api.mockResolvedValueOnce([post('recent')]);
		await fireEvent.click(view.getByRole('tab', { name: '新着順' }));
		await view.findByText('Post recent');
		expect(api.mock.calls).toEqual([
			['notes/hanami-topic-notes', { topicId: 'topic', sort: 'popular', limit: 10, offset: 0 }],
			['notes/hanami-topic-notes', { topicId: 'topic', sort: 'recent', limit: 10, offset: 0 }],
		]);
		expect(appears).toHaveLength(0);
	});

	test('leaves only the full-topic link when filtering removes every preview post', async () => {
		api.mockImplementation(async endpoint => endpoint === 'notes/hanami-trends' ? { items: [trend('first')] } : []);
		const view = render(Topics, { global });
		const allNotes = await view.findByRole('link', { name: 'この話題の投稿をすべて見る' });
		await waitFor(() => expect(view.queryByTestId('loading')).toBeNull());
		expect(api.mock.calls.filter(([endpoint]) => endpoint === 'notes/hanami-topic-notes')).toEqual([
			['notes/hanami-topic-notes', { topicId: 'first', sort: 'popular', limit: 10, offset: 0 }],
		]);
		expect(view.queryByText('投稿なし')).toBeNull();
		expect(view.queryByTestId('post')).toBeNull();
		expect(view.queryByRole('button', { name: 'もっと読む' })).toBeNull();
		expect(allNotes.getAttribute('href')).toBe('/hanami/trends?topic=first');
		expect(Array.from(allNotes.parentElement!.children)).toEqual([allNotes]);
		expect(appears).toHaveLength(0);
	});

	test('keeps the empty message on normal timelines', async () => {
		api.mockResolvedValueOnce([]);
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		expect(await view.findByText('投稿なし')).toBeTruthy();
		expect(api).toHaveBeenCalledWith('notes/hanami-topic-notes', { topicId: 'topic', sort: 'popular', limit: 20, offset: 0 });
	});

	test('keeps preview error retry at offset zero', async () => {
		api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([post('retry')]);
		const view = render(Timeline, { props: { topicId: 'topic', previewLimit: 3 }, global });
		await fireEvent.click(await view.findByRole('button', { name: '再試行' }));
		await view.findByText('Post retry');
		expect(api.mock.calls[0]).toEqual(api.mock.calls[1]);
		expect(view.queryByRole('button', { name: 'もっと読む' })).toBeNull();
		expect(appears).toHaveLength(0);
	});

	test('keeps normal timelines at twenty with the load-more button and appear pagination', async () => {
		api.mockResolvedValueOnce([post('first')]).mockResolvedValueOnce([]);
		const view = render(Timeline, { props: { topicId: 'topic' }, global });
		await view.findByText('Post first');
		expect(view.getByRole('button', { name: 'もっと読む' })).toBeTruthy();
		expect(appears).toHaveLength(1);
		await appears[0]();
		await waitFor(() => expect(view.queryByRole('button', { name: 'もっと読む' })).toBeNull());
		expect(api.mock.calls).toEqual([
			['notes/hanami-topic-notes', { topicId: 'topic', sort: 'popular', limit: 20, offset: 0 }],
			['notes/hanami-topic-notes', { topicId: 'topic', sort: 'popular', limit: 20, offset: 20 }],
		]);
	});
});
