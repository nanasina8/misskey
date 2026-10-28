/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import Widget from '@/widgets/WidgetHanamiTrends.vue';
import Row from '@/components/HanamiTrendRow.vue';
import type * as Misskey from 'misskey-js';

describe('HanamiTrendRow', () => {
	const base = { trendEntryId: 't1', snapshotId: 's1', snapshotGeneratedAt: '2026-09-14T12:40:00Z', term: '停電', topicId: 'topic', relatedTerms: [], startedAt: null, distinctAuthors: 41, score: 9876 };
	const note = { id: 'n1', createdAt: '2026-09-14T12:10:00Z', text: 'うち一帯まだ復旧してない', user: { id: 'u1', username: 'maruko', name: 'まるこ' } } as unknown as Misskey.entities.Note;

	test('renders the topic link, author count, rank and representative link, never the score', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: note }, rank: 1 }, global: { stubs: rowStubs } });
		expect(view.getByText('停電').getAttribute('href')).toBe('/hanami/trends?topic=topic');
		expect(view.queryByText('41 people')).toBeNull();
		expect(view.getAllByText('41')).toHaveLength(1);
		expect(view.getByText('41').getAttribute('aria-label')).toBe('41 people');
		expect(view.getByText('1')).toBeTruthy();
		expect(view.getByText('うち一帯まだ復旧してない').closest('a')?.getAttribute('href')).toBe('/notes/n1');
		expect(view.container.textContent).not.toContain('9876');
	});

	test('V-16: current rows show the author count only in the first line, including participants', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: note, participants: [note.user] }, rank: 1 }, global: { stubs: rowStubs } });
		expect(view.getAllByText('41')).toHaveLength(1);
		expect(view.queryByText('41 people')).toBeNull();
		expect(view.container.querySelectorAll('[aria-label="41 people"]')).toHaveLength(1);
	});

	test.each(['current', 'past'] as const)('renders a title with the source terms below in %s rows', variant => {
		const view = render(Row, { props: { item: { ...base, title: '地域一帯の停電', relatedTerms: ['復旧'], representativeNote: note }, rank: 1, variant }, global: { stubs: rowStubs } });
		expect(view.getByText('地域一帯の停電').getAttribute('href')).toBe('/hanami/trends?topic=topic');
		expect(view.getByText('停電（復旧）')).toBeTruthy();
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
		ts: { reload: 'Reload', _widgets: { hanamiTrends: 'Word trends' }, somethingHappened: 'Error', retry: 'Retry', _hana: { _trends: { kindNew: 'New', kindRising: 'Rising', kindSteady: 'Ongoing', seeAll: 'See more', history: 'History', empty: 'Empty', older: 'Older', noRepresentativeNote: 'No note', blockNight0: '深夜', blockMorning: '朝', blockDaytime: '昼', blockEvening: '夜', continuedFromBefore: 'From earlier', showTopicNotes: 'Show posts on this topic', hideTopicNotes: 'Close', noTopicNotes: 'No posts to show', topicNotesFailed: "Couldn't load posts" } } },
		tsx: { _hana: { _trends: { since: ({ time }: { time: string }) => 'Since ' + time, snapshot: ({ time }: { time: string }) => time, group: ({ n }: { n: number }) => `${n} words`, authors: ({ n }: { n: number }) => `${n} people`, blockHeading: ({ date, name, from, to }: Record<string, string>) => `${date} ${name}（${from}〜${to}）`, period: ({ from, to }: Record<string, string>) => `${from}〜${to}`, peakAuthors: ({ n }: { n: number }) => `Up to ${n} people` } } },
	},
}));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
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
afterEach(() => { cleanup(); api.mockReset(); });

const interval = vi.hoisted(() => vi.fn());
vi.mock('@@/js/use-interval.js', () => ({ useInterval: interval }));
vi.mock('@/filters/date.js', () => ({ dateString: (value: string) => value }));
vi.mock('@/widgets/widget.js', () => ({ useWidgetPropsManager: () => ({ widgetProps: { showHeader: true }, configure: vi.fn() }) }));
vi.mock('@/components/MkContainer.vue', () => ({ default: { template: '<div><slot name="header"/><slot name="func" /><slot/></div>' } }));

describe('Hanami trends widget requests', () => {
	test('V-22: links to the chip page and selected topic, omitting archive links; null IDs stay plain', async () => {
		api.mockResolvedValue({ items: [item('legacy', 'a'), { ...item('linked', 'b'), topicId: 'selected-topic' }], nextCursor: null, hasMore: false });
		const view = render(Widget, { global: { stubs } });
		await interval.mock.calls.at(-1)![0]();
		expect(view.getByText('See more →').getAttribute('href')).toBe('/hanami/trends');
		expect(view.queryByText('History →')).toBeNull();
		expect(view.container.querySelector('a[href*="tab=past"]')).toBeNull();
		expect(view.getByText('linked').getAttribute('href')).toBe('/hanami/trends?topic=selected-topic');
		expect(view.getByText('legacy').tagName).toBe('SPAN');
		expect(view.container.querySelector('a[href^="/search"]')).toBeNull();
	});
	test('U-27: retains the single representative preview and note link without topic controls', async () => {
		api.mockResolvedValue({ items: [{ ...item('word', 'a'), representativeNote: { id: 'preview', text: 'Widget representative', user: { id: 'u', username: 'author' } } }], nextCursor: null, hasMore: false });
		const view = render(Widget, { global: { stubs: { ...stubs, ...rowStubs } } });
		await interval.mock.calls.at(-1)![0]();
		expect((await view.findByText('Widget representative')).closest('a')?.getAttribute('href')).toBe('/notes/preview');
		expect(view.container.querySelectorAll('a[href^="/notes/"]')).toHaveLength(1);
		expect(view.queryByRole('button', { name: 'Show posts on this topic' })).toBeNull();
	});
	test('widget uses the shared title and source-term presentation', async () => {
		api.mockResolvedValue({ items: [{ ...item('停電', 'a'), title: '地域一帯の停電', topicId: 'topic' }], nextCursor: null, hasMore: false });
		const view = render(Widget, { global: { stubs } });
		await interval.mock.calls.at(-1)![0]();
		expect(view.getByText('地域一帯の停電').getAttribute('href')).toBe('/hanami/trends?topic=topic');
		expect(view.getByText('停電')).toBeTruthy();
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
