/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import History from '@/pages/hanami-trends-history.vue';
import Widget from '@/widgets/WidgetHanamiTrends.vue';
import Row from '@/components/HanamiTrendRow.vue';
import type * as Misskey from 'misskey-js';

describe('HanamiTrendRow', () => {
	const base = { trendEntryId: 't1', snapshotId: 's1', snapshotGeneratedAt: '2026-09-14T12:40:00Z', term: '停電', distinctAuthors: 41, score: 9876 };
	const note = { id: 'n1', createdAt: '2026-09-14T12:10:00Z', text: 'うち一帯まだ復旧してない', user: { id: 'u1', username: 'maruko', name: 'まるこ' } } as unknown as Misskey.entities.Note;

	test('renders term (linked to search), author count, rank and one representative note line, never the score', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: note }, rank: 1 }, global: { stubs: rowStubs } });
		expect(view.getByText('停電').getAttribute('href')).toBe('/search?q=%E5%81%9C%E9%9B%BB');
		expect(view.getByText('41 people')).toBeTruthy();
		expect(view.getByText('1')).toBeTruthy();
		expect(view.getByText('うち一帯まだ復旧してない').closest('a')?.getAttribute('href')).toBe('/notes/n1');
		expect(view.container.textContent).not.toContain('9876');
	});

	test('shows the muted fallback when there is no representative note', () => {
		const view = render(Row, { props: { item: { ...base, representativeNote: null }, rank: 4 }, global: { stubs: rowStubs } });
		expect(view.getByText('No note')).toBeTruthy();
		expect(view.container.querySelector('a[href^="/notes/"]')).toBeNull();
	});
});

// Exercise cursor recovery against the mounted history page as well as the row contract above.
const api = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApiGet: api }));
vi.mock('@@/js/intl-const.js', () => ({ versatileLang: 'ja-JP' }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i18n.js', () => ({
	i18n: {
		ts: { reload: 'Reload', _widgets: { hanamiTrends: 'Word trends' }, somethingHappened: 'Error', retry: 'Retry', _hana: { _trends: { history: 'History', empty: 'Empty', older: 'Older', noRepresentativeNote: 'No note' } } },
		tsx: { _hana: { _trends: { snapshot: ({ time }: { time: string }) => time, group: ({ n }: { n: number }) => `${n} words`, authors: ({ n }: { n: number }) => `${n} people` } } },
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
	MkLoading: true,
	MkAvatar: true,
	MkUserName: true,
	MkTime: true,
	Mfm: true,
};
const item = (id: string, snapshotId: string) => ({ trendEntryId: id, snapshotId, snapshotGeneratedAt: '2026-09-14T12:40:00Z', term: id, distinctAuthors: 2, score: 9876, representativeNote: null });
afterEach(() => { cleanup(); api.mockReset(); });

describe('Hanami trends history pagination', () => {
	test('advances cursors and merges a snapshot split across pages', async () => {
		api.mockResolvedValueOnce({ items: [item('one', 'a')], nextCursor: 'next', hasMore: true });
		api.mockResolvedValueOnce({ items: [item('two', 'a'), item('three', 'b')], nextCursor: null, hasMore: false });
		const view = render(History, { global: { stubs } });
		await fireEvent.click(await view.findByText('Older'));
		await waitFor(() => expect(view.getAllByRole('heading').map(el => el.textContent)).toEqual(['2 words', '1 words']));
		expect(api.mock.calls).toEqual([
			['notes/hanami-trends', { history: true, limit: 30 }],
			['notes/hanami-trends', { history: true, limit: 30, cursor: 'next' }],
		]);
		expect(view.queryByText('Older')).toBeNull();
		expect(view.container.textContent).not.toContain('9876');
	});

	test.each(['CURSOR_EXPIRED', 'INVALID_CURSOR'])('recovers from %s by discarding old items and the cursor', async (code) => {
		api.mockResolvedValueOnce({ items: [item('old', 'a')], nextCursor: 'corrupted', hasMore: true });
		api.mockRejectedValueOnce({ code });
		api.mockResolvedValueOnce({ items: [item('fresh', 'b')], nextCursor: null, hasMore: false });
		const view = render(History, { global: { stubs } });
		await fireEvent.click(await view.findByText('Older'));
		await view.findByText('fresh');
		expect(view.queryByText('old')).toBeNull();
		expect(api).toHaveBeenLastCalledWith('notes/hanami-trends', { history: true, limit: 30 });
	});

	test('renders an inline error and permits retry when the reset request fails', async () => {
		api.mockResolvedValueOnce({ items: [item('old', 'a')], nextCursor: 'expired', hasMore: true });
		api.mockRejectedValueOnce({ code: 'CURSOR_EXPIRED' });
		api.mockRejectedValueOnce(new Error('offline'));
		api.mockResolvedValueOnce({ items: [], nextCursor: null, hasMore: false });
		const view = render(History, { global: { stubs } });
		await fireEvent.click(await view.findByText('Older'));
		await fireEvent.click(await view.findByText('Retry'));
		await view.findByText('Empty');
		expect(api).toHaveBeenLastCalledWith('notes/hanami-trends', { history: true, limit: 30 });
	});
});

const interval = vi.hoisted(() => vi.fn());
vi.mock('@@/js/use-interval.js', () => ({ useInterval: interval }));
vi.mock('@/filters/date.js', () => ({ dateString: (value: string) => value }));
vi.mock('@/widgets/widget.js', () => ({ useWidgetPropsManager: () => ({ widgetProps: { showHeader: true }, configure: vi.fn() }) }));
vi.mock('@/components/MkContainer.vue', () => ({ default: { template: '<div><slot name="header"/><slot name="func" /><slot/></div>' } }));

describe('Hanami trends widget requests', () => {
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
