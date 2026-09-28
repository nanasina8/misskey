/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// @vitest-environment happy-dom

import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/vue';
import Hanami from '@/pages/admin/hanami.vue';

vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _hana: { hanamiTimeline: 'はなみ', _admin: { overview: '概要', stats: '統計', axes: 'おすすめの種類', judge: '判定器', trends: 'トレンド', taste: '嗜好クラスタ', ops: '運用' } } } } }));
vi.mock('@/pages/admin/hanami.overview.vue', () => ({ default: { template: '<p>overview content</p>' } }));
vi.mock('@/pages/admin/hanami.stats.vue', () => ({ default: { template: '<p>stats content</p>' } }));
vi.mock('@/pages/admin/hanami.axes.vue', () => ({ default: { template: '<p>axes content</p>' } }));
vi.mock('@/pages/admin/hanami.judge.vue', () => ({ default: { template: '<p>judge content</p>' } }));
vi.mock('@/pages/admin/hanami.trends.vue', () => ({ default: { template: '<p>trends content</p>' } }));
vi.mock('@/pages/admin/hanami.taste.vue', () => ({ default: { template: '<p>taste content</p>' } }));

describe('Hanami admin tabs', () => {
	test('keeps the trend tab navigable and removes operations', async () => {
		const view = render(Hanami, { global: { stubs: {
			PageWithHeader: { props: ['tabs', 'tab'], emits: ['update:tab'], template: '<div><button v-for="item in tabs" :key="item.key" @click="$emit(\'update:tab\', item.key)">{{ item.title }}</button><slot/></div>' },
			SearchMarker: { template: '<div><slot/></div>' }, MkLoading: true,
		} } });
		expect(view.queryByRole('button', { name: '運用' })).toBeNull();
		await fireEvent.click(view.getByRole('button', { name: 'トレンド' }));
		expect(view.getByText('trends content')).toBeTruthy();
		expect(view.container.textContent).not.toMatch(/\b(series|served|hiddenCost|usage|demand|snapshot)\./);
		view.unmount();
	});
});
