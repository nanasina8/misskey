/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import locales from 'i18n';
import MkHanamiTuningPanel from '@/components/MkHanamiTuningPanel.vue';
import { i18n, updateI18n } from '@/i18n.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { HANAMI_FOR_YOU_AXES, resetHanamiTuning } from '@/utility/hanami-tuning.js';
import type { HanamiTuningUpdate } from '@/utility/hanami-tuning.js';

const api = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/hanami-tuning-client.js', async () => {
	const { shallowRef } = await import('vue');
	const { resetHanamiTuning } = await import('@/utility/hanami-tuning.js');
	const state = shallowRef(resetHanamiTuning());
	const config = { globalPopular: { default: false }, fof: { available: false } };
	return { useHanamiTuning: () => ({ state, config, update: (patch: HanamiTuningUpdate) => { state.value = patch; save(patch); } }) };
});
vi.mock('@/components/MkFolder.vue', () => ({ default: {
	emits: ['opened'], template: '<section><button @click="$emit(\'opened\')"><slot name="label"/></button><slot/></section>',
} }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkRadios.vue', () => ({ default: { template: '<div><slot name="label"/></div>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div><slot name="label"/></div>' } }));
vi.mock('@/components/MkHanamiTuningRange.vue', () => ({ default: {
	props: ['disabled', 'label'], emits: ['update:modelValue'],
	template: '<input type="range" :disabled="disabled" :aria-label="label" @input="$emit(\'update:modelValue\', 2)"/>',
} }));

beforeEach(() => {
	updateI18n(locales['ja-JP']);
	api.mockReset();
	save.mockReset();
	useHanamiTuning().state.value = { ...resetHanamiTuning(), hanamiTuning: {
		...resetHanamiTuning().hanamiTuning, mode: 'manual', manual: {
			amounts: Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, 1])),
			freshWeights: [1, 1, 1], closeWeights: [1, 1, 1], authorCap: 2,
		},
	} };
});
afterEach(() => { cleanup(); updateI18n(locales['en-US']); });

function suggestion(changed: boolean) {
	return { eligible: true, minSeen: 200, minReactions: 10, totalSeen: 600, totalReactions: 60,
		axes: HANAMI_FOR_YOU_AXES.map(axis => ({ axis, seen: axis === 'fof' ? 0 : 100, reactions: axis === 'fof' ? 0 : 10,
			rate: changed ? axis === 'globalPopular' ? .10 : axis === 'trending' ? .12 : .11 : .1, current: 1, suggested: 1 })) };
}

const mount = (props = {}) => render(MkHanamiTuningPanel, { props, global: { stubs: { MkLoading: true, MkError: true } } });

describe('Hanami tuning suggestion presentation', () => {
	test('shows the title by default and can hide it when embedded', async () => {
		const view = mount();
		expect(view.getByRole('heading', { name: i18n.ts._hana._tuning.title })).toBeTruthy();
		await view.rerender({ showTitle: false });
		expect(view.queryByRole('heading', { name: i18n.ts._hana._tuning.title })).toBeNull();
	});
	test.each(['auto', 'manual'] as const)('blocks edits and suggestion loading while the %s panel is disabled', async mode => {
		const { state } = useHanamiTuning();
		state.value = { ...state.value!, hanamiTuning: { ...state.value!.hanamiTuning, mode } };
		const view = mount({ disabled: true });
		expect(view.container.querySelector('[inert][aria-disabled="true"]')).toBeTruthy();
		for (const range of view.getAllByRole('slider', { hidden: true })) {
			expect(range.hasAttribute('disabled')).toBe(true);
			// Even a synthetic event from a child must not save a disabled panel.
			await fireEvent.input(range);
		}
		await fireEvent.click(view.getByText(i18n.ts._hana._tuning.reset));
		await fireEvent.click(view.getByText(i18n.ts._hana._tuning.suggestion));
		expect(save).not.toHaveBeenCalled();
		expect(api).not.toHaveBeenCalled();
		await view.rerender({ disabled: false });
		await fireEvent.input(view.getAllByRole('slider')[0]);
		expect(save).toHaveBeenCalledOnce();
	});
	test('lists only changed axes, including a 0.05 boundary, and keeps default-off manual controls enabled', async () => {
		api.mockResolvedValue(suggestion(true));
		const view = mount();
		const t = i18n.ts._hana._tuning;
		const labels = i18n.ts._hana._tuning._axis;
		await fireEvent.click(view.getByRole('button', { name: t.suggestion }));
		const summary = await view.findByText(/^提案：/);
		expect(summary.textContent).toContain(`${labels.globalPopular} 100→95%`);
		expect(summary.textContent).toContain(`${labels.trending} 100→105%`);
		expect(summary.textContent).not.toContain(labels.neighborTrending);
		expect(summary.textContent).not.toContain(labels.fof);
		expect(view.getByRole('slider', { name: labels.globalPopular }).hasAttribute('disabled')).toBe(false);
		expect(view.getByRole('slider', { name: labels.fof }).hasAttribute('disabled')).toBe(true);
		await fireEvent.click(view.getByRole('button', { name: t.applySuggestion }));
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0][0].hanamiTuning.manual.amounts).toMatchObject({ globalPopular: 0.95, trending: 1.05, neighborTrending: 1, fof: 0 });
		// The suggestion scales the auto amounts, so once applied it does not compound on repeated clicks.
		expect(await view.findByText(t.suggestionUnchanged)).toBeTruthy();
		expect(view.queryByRole('button', { name: t.applySuggestion })).toBeNull();
	});
	test('suggests from the auto amounts rather than compounding manual amounts, and keeps turned-off axes off', async () => {
		const { state } = useHanamiTuning();
		const manual = state.value!.hanamiTuning.manual!;
		state.value = { ...state.value!, hanamiTuning: { ...state.value!.hanamiTuning, manual: { ...manual, amounts: { ...manual.amounts, trending: 3, catchup: 0 } } } };
		api.mockResolvedValue(suggestion(true));
		const view = mount();
		const t = i18n.ts._hana._tuning;
		await fireEvent.click(view.getByRole('button', { name: t.suggestion }));
		await view.findByText(/^提案：/);
		await fireEvent.click(view.getByRole('button', { name: t.applySuggestion }));
		expect(save.mock.calls[0][0].hanamiTuning.manual.amounts).toMatchObject({ trending: 1.05, catchup: 0 });
	});
	test('shows the balanced message and hides apply when every suggested amount is unchanged', async () => {
		api.mockResolvedValue(suggestion(false));
		const view = mount();
		const t = i18n.ts._hana._tuning;
		await fireEvent.click(view.getByRole('button', { name: t.suggestion }));
		expect(await view.findByText('いまの量で、見た割合と反応した割合はほぼ揃っています。')).toBeTruthy();
		expect(view.queryByText(/^提案：/)).toBeNull();
		expect(view.queryByRole('button', { name: t.applySuggestion })).toBeNull();
		expect(save).not.toHaveBeenCalled();
	});
});
