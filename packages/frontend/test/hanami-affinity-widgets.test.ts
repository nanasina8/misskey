/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import Talked from '@/widgets/WidgetHanamiTalkedUsers.vue';
import Ring from '@/widgets/WidgetHanamiConnectionRing.vue';
import Lapsed from '@/widgets/WidgetHanamiLapsedUsers.vue';
import * as os from '@/os.js';

const api = vi.hoisted(() => vi.fn());
const interval = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })), pageWindow: vi.fn() }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false } } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@@/js/use-interval.js', () => ({ useInterval: interval }));
vi.mock('@/i.js', () => ({ $i: { id: 'me', username: 'me', name: 'Me' } }));
vi.mock('@/filters/user.js', () => ({ userPage: (user: { username: string }) => `/@${user.username}` }));
vi.mock('@/widgets/widget.js', async () => {
	const { reactive } = await import('vue');
	return { useWidgetPropsManager: (_name: string, defs: Record<string, { default: unknown }>, props: { widget?: { data: Record<string, unknown> } }) => {
		settings.current = reactive({ ...Object.fromEntries(Object.entries(defs).map(([key, def]) => [key, def.default])), ...props.widget?.data });
		return { widgetProps: settings.current, configure: vi.fn() };
	} };
});
vi.mock('@/components/MkContainer.vue', () => ({ default: { template: '<div><slot name="header"/><slot name="func"/><slot/></div>' } }));
vi.mock('@/i18n.js', async () => {
	const { default: locales } = await import('../../../locales/index.js');
	return ({
	i18n: {
		ts: {
			reload: 'Reload', somethingHappened: 'Error', close: 'Close', profile: 'Profile',
			_widgets: { hanamiTalkedUsers: 'Talked', hanamiConnectionRing: 'Ring', hanamiLapsedUsers: 'Lapsed' },
			_hana: { _affinity: { _cloud: locales['ja-JP']._hana._affinity._cloud, rankNew: 'new', lastInteraction: 'Last', talkedFooter: 'tf', ringInner: 'Close', ringOuter: 'Sometimes', ringFooter: 'rf', ringEmpty: 'ring empty', talkedEmpty: 'talked empty', lapsedEmpty: 'lapsed empty', lapsedFooter: 'lf', fewPerMonth: 'few per month', recentlyPosted: 'posted', birthdaySoon: 'birthday', viewNotes: 'View', mutual: 'mutual' } },
		},
		tsx: { _hana: { _affinity: { daysAgo: ({ n }: { n: number }) => `${n}d`, perWeek: ({ n }: { n: number }) => `${n}/w`, counts: ({ reply }: { reply: number }) => `r${reply}` } } },
	},
}); });

const stubs = {
	MkLoading: true,
	MkAvatar: { props: ['user'], template: '<span class="avatar" :data-user="user.id"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.name }}</span>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
	MkAcct: { props: ['user'], template: '<span>{{ user.username }}</span>' },
	MkTime: { props: ['time'], template: '<span>{{ time }}</span>' },
};

function user(id: string, name = id) {
	return { id, username: id, name };
}

const counts = { reply: { out: 1, in: 1 }, mention: { out: 0, in: 0 }, renote: { out: 0, in: 0 }, reaction: { out: 0, in: 0 } };

afterEach(() => { cleanup(); api.mockReset(); interval.mockReset(); });

describe('WidgetHanamiTalkedUsers', () => {
	test('renders rank, bar, delta and last interaction and polls every ten minutes', async () => {
		api.mockResolvedValue({ computedAt: 'x', items: [
			{ user: user('a', 'Mizutama'), rank: 1, score: 20, rankDelta: 2, mutualFollow: true, mutualInteraction: true, lastInteractionAt: '2026-09-15T00:00:00Z', counts },
			{ user: user('b', 'Hiiragi'), rank: 2, score: 10, rankDelta: 0, mutualFollow: false, mutualInteraction: false, lastInteractionAt: null, counts },
			{ user: user('c', 'Tamago'), rank: 3, score: 5, rankDelta: null, mutualFollow: false, mutualInteraction: false, lastInteractionAt: null, counts },
		] });
		const view = render(Talked, { global: { stubs } });
		const [fetch, delay, options] = interval.mock.calls.at(-1)!;
		expect(delay).toBe(600000);
		expect(options).toEqual({ immediate: true, afterMounted: true });
		await fetch();
		await view.findByText('Mizutama');
		expect(api).toHaveBeenCalledWith('users/hanami-affinity', { mode: 'top', limit: 5 });
		expect(view.getByText('↑ 2')).toBeTruthy();
		expect(view.getByText('—')).toBeTruthy();
		expect(view.getByText('new')).toBeTruthy();
		const fills = [...view.container.querySelectorAll('[class*="fill"]')].map(el => (el as HTMLElement).style.width);
		expect(fills).toEqual(['100%', '50%', '25%']);
	});

	test('shows the empty state and an inline error', async () => {
		api.mockResolvedValueOnce({ computedAt: 'x', items: [] });
		const view = render(Talked, { global: { stubs } });
		await interval.mock.calls.at(-1)![0]();
		await view.findByText('talked empty');

		api.mockRejectedValueOnce(new Error('offline'));
		const errored = render(Talked, { global: { stubs } });
		await interval.mock.calls.at(-1)![0]();
		await errored.findByText('Error');
	});
});

describe('WidgetHanamiConnectionRing', () => {
	test('upgrades an existing widget, samples the full score range and changes count without refetching', async () => {
		const items = Array.from({ length: 72 }, (_, i) => ({ user: user(`person${i}`), rank: i + 1, score: 100 - i, mutualInteraction: true, counts }));
		api.mockResolvedValue({ computedAt: 'x', items });
		const view = render(Ring, { props: { widget: { id: 'existing-widget', data: { showHeader: true } } }, global: { stubs } });
		const [fetch, delay, options] = interval.mock.calls.at(-1)!;
		expect(delay).toBe(600000);
		expect(options).toEqual({ immediate: true, afterMounted: true });
		await fetch();
		await waitFor(() => expect(view.container.querySelectorAll('[data-user-id]')).toHaveLength(30));
		expect(api).toHaveBeenCalledWith('users/hanami-affinity', { mode: 'top', limit: 72 });
		expect(view.container.querySelector('[data-user-id="person0"]')).toBeTruthy();
		expect(view.container.querySelector('[data-user-id="person71"]')).toBeTruthy();
		settings.current.count = 72;
		await waitFor(() => expect(view.container.querySelectorAll('[data-user-id]')).toHaveLength(72));
		settings.current.count = 24;
		await waitFor(() => expect(view.container.querySelectorAll('[data-user-id]')).toHaveLength(24));
		expect(api).toHaveBeenCalledTimes(1);
		const peer = view.container.querySelector('[data-user-id="person0"]')!;
		await fireEvent.click(peer, { detail: 0 });
		expect(os.pageWindow).toHaveBeenCalledWith('/@person0');
		expect(view.container.textContent).not.toContain('関係の良し悪し');
	});

	test('renders fewer available users, handles empty and error states, and preserves data on refresh failure', async () => {
		const view = render(Ring, { global: { stubs } });
		const fetch = interval.mock.calls.at(-1)![0];
		api.mockResolvedValueOnce({ computedAt: 'x', items: [] });
		await fetch();
		await view.findByText('ring empty');
		api.mockRejectedValueOnce(new Error('offline'));
		await fetch();
		await view.findByRole('alert');
		api.mockResolvedValueOnce({ computedAt: 'x', items: [{ user: user('a'), score: 1, counts }] });
		await fetch();
		await waitFor(() => expect(view.container.querySelectorAll('[data-user-id]')).toHaveLength(1));
		expect(view.queryByRole('alert')).toBeNull();
		api.mockRejectedValueOnce(new Error('offline'));
		await fetch();
		await view.findByRole('alert');
		expect(view.container.querySelectorAll('[data-user-id]')).toHaveLength(1);
	});
});

describe('WidgetHanamiLapsedUsers', () => {
	test('renders days since last, past frequency and hints', async () => {
		api.mockResolvedValue({ computedAt: 'x', items: [
			{ user: user('k', 'Komorebi'), daysSinceLast: 42, pastPerWeek: 3.2, latestNoteAt: new Date().toISOString(), birthdayWithin14d: false },
			{ user: user('y', 'Yukishiro'), daysSinceLast: 27, pastPerWeek: 0.4, latestNoteAt: null, birthdayWithin14d: true },
		] });
		const view = render(Lapsed, { global: { stubs } });
		await interval.mock.calls.at(-1)![0]();
		await view.findByText('Komorebi');
		expect(api).toHaveBeenCalledWith('users/hanami-affinity', { mode: 'lapsed', limit: 3 });
		expect(view.getByText('42d')).toBeTruthy();
		expect(view.getByText('· 3/w')).toBeTruthy();
		expect(view.getByText('· posted')).toBeTruthy();
		expect(view.getByText('· few per month')).toBeTruthy();
		expect(view.getByText('· birthday')).toBeTruthy();
		expect(view.getAllByText('View').map(el => el.getAttribute('href'))).toEqual(['/@k', '/@y']);
	});

	test('shows the empty state', async () => {
		api.mockResolvedValue({ computedAt: 'x', items: [] });
		const view = render(Lapsed, { global: { stubs } });
		await interval.mock.calls.at(-1)![0]();
		await view.findByText('lapsed empty');
	});
});
