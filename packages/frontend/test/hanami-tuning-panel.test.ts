/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/vue';
import locales from 'i18n';
import MkHanamiTuningPanel from '@/components/MkHanamiTuningPanel.vue';
import MkHanamiTuningQuick from '@/components/MkHanamiTuningQuick.vue';
import { i18n, updateI18n } from '@/i18n.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { clearHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import { HANAMI_FOR_YOU_AXES, hanamiDriftFactors, hanamiGroupComposition, hanamiTenTiles, resetHanamiTuning } from '@/utility/hanami-tuning.js';
import type { HanamiTuning, HanamiTuningUpdate } from '@/utility/hanami-tuning.js';

const api = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({ globalPopular: { default: false }, fof: { available: false } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/hanami-tuning-client.js', async () => {
	const { shallowRef } = await import('vue');
	const { resetHanamiTuning } = await import('@/utility/hanami-tuning.js');
	const state = shallowRef(resetHanamiTuning());
	return { useHanamiTuning: () => ({ state, config, update: (patch: HanamiTuningUpdate) => { state.value = patch; save(patch); } }) };
});
vi.mock('@/components/MkFolder.vue', () => ({ default: {
	template: '<section data-folder><div><slot name="label"/></div><slot/></section>',
} }));
vi.mock('@/components/MkButton.vue', () => ({ default: { props: ['disabled'], template: '<button :disabled="disabled"><slot/></button>' } }));
vi.mock('@/components/MkRadios.vue', () => ({ default: { template: '<div><slot name="label"/></div>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div><slot name="label"/></div>' } }));
vi.mock('@/components/MkHanamiTuningRange.vue', () => ({ default: {
	props: ['disabled', 'label', 'modelValue', 'max'], emits: ['update:modelValue'],
	template: '<input type="range" :disabled="disabled" :aria-label="label" :data-value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))"/>',
} }));

const t = () => i18n.ts._hana._tuning;

function suggestion(patch: Record<string, unknown> = {}) {
	const factors: Record<string, number> = { neighborTrending: 1.5, catchup: 1.4, fof: 1.3, globalPopular: 0.6, trending: 0.6, exploration: 1, reactionSimilar: 0.8 };
	return {
		eligible: true, minSeen: 200, minReactions: 10, totalSeen: 600, totalReactions: 60,
		axes: HANAMI_FOR_YOU_AXES.map(axis => ({ axis, seen: axis === 'fof' ? 0 : 100, reactions: axis === 'neighborTrending' ? 30 : 5, rate: .1, factor: factors[axis], current: 1, suggested: factors[axis] })),
		groups: { close: 4, buzz: 1, fresh: 3 },
		...patch,
	};
}

function setTuning(patch: Partial<HanamiTuning>): void {
	const { state } = useHanamiTuning();
	state.value = { ...resetHanamiTuning(), hanamiTuning: { ...resetHanamiTuning().hanamiTuning, ...patch } };
}

beforeEach(() => {
	updateI18n(locales['ja-JP']);
	api.mockReset();
	save.mockReset();
	clearHanamiTuningSuggestion();
	setTuning({});
});
afterEach(() => { cleanup(); updateI18n(locales['en-US']); });

const errorStub = { emits: ['retry'], template: '<button data-testid="retry" @click="$emit(\'retry\')">retry</button>' };
const mount = (props = {}) => render(MkHanamiTuningPanel, { props, global: { stubs: { MkLoading: { template: '<p data-testid="loading"/>' }, MkError: errorStub } } });

function modeButton(view: ReturnType<typeof mount>, mode: HanamiTuning['mode']): HTMLElement {
	return view.container.querySelector(`[data-mode="${mode}"]`)!;
}

function tileCounts(root: HTMLElement) {
	const count = (group: string) => root.querySelectorAll(`[role="img"] [data-group="${group}"]`).length;
	return { close: count('close'), buzz: count('buzz'), fresh: count('fresh') };
}

describe('Hanami tuning panel', () => {
	test('shows the four ways to tune, with the current one pressed', () => {
		api.mockResolvedValue(suggestion());
		const view = mount();
		for (const mode of ['auto', 'direction', 'recommend', 'manual'] as const) {
			expect(within(modeButton(view, mode)).getByText(t()._modes[mode])).toBeTruthy();
			expect(modeButton(view, mode).getAttribute('aria-pressed')).toBe(String(mode === 'auto'));
		}
		expect(view.getByText(t().autoDescription)).toBeTruthy();
	});

	test('switching modes saves the new shape (mode, direction, drift, groups, manual)', async () => {
		api.mockResolvedValue(suggestion());
		const view = mount();
		await waitFor(() => expect(view.queryByTestId('loading')).toBeNull());

		await fireEvent.click(modeButton(view, 'direction'));
		expect(save.mock.lastCall![0].hanamiTuning).toEqual({ mode: 'direction', direction: 1, drift: 1, groups: { close: 2, buzz: 2, fresh: 2 } });
		await fireEvent.click(view.getByRole('button', { name: new RegExp(t()._directions.close) }));
		await fireEvent.click(view.getByRole('button', { name: t()._drifts.strong }));
		expect(save.mock.lastCall![0].hanamiTuning).toMatchObject({ mode: 'direction', direction: 0, drift: 2 });
		expect(view.getByTestId('direction-band')).toBeTruthy();

		await fireEvent.click(modeButton(view, 'manual'));
		const manual = save.mock.lastCall![0].hanamiTuning;
		expect(manual.mode).toBe('manual');
		expect(Object.keys(manual.manual.amounts).sort()).toEqual([...HANAMI_FOR_YOU_AXES].sort());
		expect(manual.manual.authorCap).toBe(2);
		// サーバーで使えない種類（友達の友達）は出さない。
		expect(view.queryByRole('slider', { name: t()._axis.fof })).toBeNull();
		expect(view.getByRole('slider', { name: t()._axis.trending })).toBeTruthy();

		await fireEvent.click(modeButton(view, 'auto'));
		expect(save.mock.lastCall![0].hanamiTuning).toMatchObject({ mode: 'auto', direction: 0, drift: 2 });
	});

	test('switching to recommend fills in the suggested groups from the API, and editing does not get overwritten', async () => {
		api.mockResolvedValue(suggestion());
		const view = mount();
		await waitFor(() => expect(api).toHaveBeenCalledWith('i/hanami-tuning-suggestion', {}));
		await waitFor(() => expect(view.queryByTestId('loading')).toBeNull());
		await fireEvent.click(modeButton(view, 'recommend'));
		expect(save.mock.lastCall![0].hanamiTuning).toMatchObject({ mode: 'recommend', groups: { close: 4, buzz: 1, fresh: 3 } });
		await fireEvent.input(view.getByRole('slider', { name: t()._groups.buzz }), { target: { value: '3' } });
		expect(save.mock.lastCall![0].hanamiTuning.groups).toEqual({ close: 4, buzz: 3, fresh: 3 });
		await fireEvent.click(view.getByRole('button', { name: t().resetRecommend }));
		expect(save.mock.lastCall![0].hanamiTuning.groups).toEqual({ close: 4, buzz: 1, fresh: 3 });
	});

	test('switching to recommend before the API answers keeps the current groups', async () => {
		api.mockReturnValue(new Promise(() => {}));
		setTuning({ groups: { close: 1, buzz: 3, fresh: 2 } });
		const view = mount();
		await fireEvent.click(modeButton(view, 'recommend'));
		expect(save.mock.lastCall![0].hanamiTuning).toMatchObject({ mode: 'recommend', groups: { close: 1, buzz: 3, fresh: 2 } });
	});

	test('the ten tiles match the calculation, including the drift from reactions', async () => {
		const response = suggestion();
		api.mockResolvedValue(response);
		const view = mount();
		const tiles = view.getByTestId('tiles');
		const tuning = useHanamiTuning().state.value!.hanamiTuning;
		expect(tileCounts(tiles)).toEqual(hanamiTenTiles(hanamiGroupComposition(tuning, config)));
		await waitFor(() => expect(view.queryByTestId('loading')).toBeNull());
		const expected = hanamiTenTiles(hanamiGroupComposition(tuning, config, hanamiDriftFactors(response.axes)));
		expect(tileCounts(tiles)).toEqual(expected);
		expect(expected.close + expected.buzz + expected.fresh).toBe(10);
		expect(within(tiles).getByText(i18n.tsx._hana._tuning.tilesDrifted({ groups: t()._groups.close }))).toBeTruthy();

		await fireEvent.click(modeButton(view, 'recommend'));
		const recommend = useHanamiTuning().state.value!.hanamiTuning;
		expect(tileCounts(tiles)).toEqual(hanamiTenTiles(hanamiGroupComposition(recommend, config)));
		expect(within(tiles).getByText(t().tilesFixed)).toBeTruthy();
	});

	test('"from your reactions" is shown without opening anything and marks what the drift does', async () => {
		api.mockResolvedValue(suggestion());
		const view = mount();
		const section = view.getByTestId('reactions');
		expect(section.closest('[data-folder]')).toBeNull();
		await waitFor(() => expect(section.querySelectorAll('[data-group]')).toHaveLength(3));
		const chip = (group: string) => section.querySelector(`[data-group="${group}"] [data-part="chip"]`)!.textContent!.trim();
		expect(chip('close')).toBe(t().trendUp);
		expect(chip('buzz')).toBe(t().trendDown);
		expect(within(section).getByText(i18n.tsx._hana._tuning.shares({ seen: 33, reactions: 67 }))).toBeTruthy();

		await fireEvent.click(modeButton(view, 'recommend'));
		expect(chip('close')).toBe(i18n.tsx._hana._tuning.recommendChip({ level: t()._levels.veryMany }));
		await fireEvent.click(modeButton(view, 'manual'));
		expect(chip('close')).toBe(t().referenceChip);
		expect(within(section).getByText(t().perAxis)).toBeTruthy();
	});

	test('still shows the reactions when there are not enough of them yet, with a note', async () => {
		api.mockResolvedValue(suggestion({ eligible: false, totalReactions: 3 }));
		const view = mount();
		const section = view.getByTestId('reactions');
		expect(await within(section).findByTestId('ineligible')).toBeTruthy();
		expect(section.querySelectorAll('[data-group]')).toHaveLength(3);
	});

	test('shows an empty message for no activity and a retry on failure', async () => {
		api.mockRejectedValueOnce(new Error('offline'));
		const view = mount();
		api.mockResolvedValueOnce(suggestion({ totalSeen: 0, totalReactions: 0, eligible: false, axes: HANAMI_FOR_YOU_AXES.map(axis => ({ axis, seen: 0, reactions: 0, rate: 0, factor: 1, current: 1, suggested: 1 })) }));
		await fireEvent.click(await view.findByTestId('retry'));
		expect(await view.findByText(t().noActivity)).toBeTruthy();
	});

	test('"put in the suggested amounts" switches to manual with the suggested amounts', async () => {
		api.mockResolvedValue(suggestion());
		setTuning({ mode: 'manual', manual: { amounts: Object.fromEntries(HANAMI_FOR_YOU_AXES.map(axis => [axis, 1])), authorCap: 3 } });
		const view = mount();
		await waitFor(() => expect(view.getByRole('button', { name: t().applySuggestion }).hasAttribute('disabled')).toBe(false));
		await fireEvent.click(view.getByRole('button', { name: t().applySuggestion }));
		expect(save.mock.lastCall![0].hanamiTuning.manual).toEqual({ amounts: expect.objectContaining({ neighborTrending: 1.5, trending: 0.6, fof: 0 }), authorCap: 3 });
	});

	test('blocks edits and suggestion loading while disabled', async () => {
		const view = mount({ disabled: true });
		expect(view.container.querySelector('[inert]')).toBeTruthy();
		await fireEvent.click(modeButton(view, 'manual'));
		await fireEvent.click(view.getByText(t().reset));
		expect(save).not.toHaveBeenCalled();
		expect(api).not.toHaveBeenCalled();
		api.mockResolvedValue(suggestion());
		await view.rerender({ disabled: false });
		await waitFor(() => expect(api).toHaveBeenCalledOnce());
		await fireEvent.click(modeButton(view, 'manual'));
		expect(save).toHaveBeenCalledOnce();
	});
});

describe('Hanami tuning popup content', () => {
	const mountQuick = () => render(MkHanamiTuningQuick, { global: { stubs: { MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' } } } });

	test('switches between the four ways with small buttons and links to the settings page', async () => {
		api.mockResolvedValue(suggestion());
		const view = mountQuick();
		await waitFor(() => expect(api).toHaveBeenCalledOnce());
		expect(view.getByText(t().tilesTitle)).toBeTruthy();
		await fireEvent.click(view.getByRole('button', { name: t()._modeShort.recommend }));
		await waitFor(() => expect(save.mock.lastCall![0].hanamiTuning).toMatchObject({ mode: 'recommend' }));
		await fireEvent.click(view.getByRole('button', { name: t()._modeShort.manual }));
		expect(view.getByText(t().openManual).closest('a')!.getAttribute('href')).toBe('/settings/hanamode');
		expect(view.getByText(t().openSettings).closest('a')!.getAttribute('href')).toBe('/settings/hanamode');
	});
});
