/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import locales from 'i18n';
import HanamiSettings from '@/pages/settings/hanamode.vue';
import { i18n, updateI18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';

const api = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
const success = vi.hoisted(() => vi.fn());
const apiWithDialog = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => ({ hanamiRecommendationEnabled: false, hanamiShowRecommendationReason: false, exploreMediaFilter: 'all' }));
vi.mock('@/i.js', () => ({ ensureSignin: () => account }));
vi.mock('@/accounts.js', () => ({ updateCurrentAccount: (patch: object) => Object.assign(account, patch) }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/utility/hanami-tuning-client.js', () => ({ refreshHanamiTuning: refresh }));
vi.mock('@/utility/haptic.js', () => ({ haptic: vi.fn() }));
vi.mock('@/os.js', () => ({ alert, success, apiWithDialog }));
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	const dateSeparators = ref(false);
	return { prefer: { model: () => dateSeparators } };
});
vi.mock('@/components/MkPreferenceContainer.vue', () => ({ default: { template: '<div><slot/></div>' } }));
vi.mock('@/components/MkHanamiTuningPanel.vue', () => ({ default: {
	props: ['showTitle', 'disabled'], template: '<div data-testid="tuning" :aria-disabled="disabled" :data-show-title="showTitle"/>',
} }));

beforeEach(() => {
	updateI18n(locales['ja-JP']);
	vi.clearAllMocks();
	Object.assign(account, { hanamiRecommendationEnabled: false, hanamiShowRecommendationReason: false, exploreMediaFilter: 'all' });
	prefer.model('showHanamiTimelineDateSeparators').value = false;
	api.mockReset().mockImplementation(async endpoint => endpoint === 'i/hanami-taste-clusters' ? [{
		clusterId: 1, labelTerms: ['花'], size: 3, ownRate: 0, weight: 'normal', isMention: false, examples: [],
	}] : {});
});
afterEach(() => { cleanup(); updateI18n(locales['en-US']); });

const mount = () => render(HanamiSettings, { global: {
	stubs: { SearchMarker: { template: '<div><slot/></div>' }, MkLoading: true },
	directives: { tooltip: {}, 'adaptive-border': {} },
} });

describe('Hanami timeline settings', () => {
	test('enables tuning and immediately saves display, date, taste and media changes without success dialogs', async () => {
		const view = mount();
		const recommendation = i18n.ts._hana._recommendation;
		const taste = i18n.ts._hana._tasteClusters;
		expect(view.queryByText(i18n.ts._hana.hanaMode)).toBeNull();
		expect(view.getByText(recommendation.description)).toBeTruthy();
		expect(view.getByText(recommendation.enableDescription)).toBeTruthy();
		expect(view.getByText(recommendation.showReasonDescription)).toBeTruthy();
		expect(view.getByTestId('tuning').getAttribute('data-show-title')).toBe('false');
		expect(view.getByTestId('tuning').getAttribute('aria-disabled')).toBe('true');
		expect(view.getByText(i18n.ts._hana._tuning.enableForYou)).toBeTruthy();
		await fireEvent.click(view.getByText(recommendation.enable));
		await waitFor(() => expect(account.hanamiRecommendationEnabled).toBe(true));
		expect(view.getByTestId('tuning').getAttribute('aria-disabled')).toBe('false');
		expect(view.queryByText(i18n.ts._hana._tuning.enableForYou)).toBeNull();
		await fireEvent.click(view.getByText(recommendation.showReason));
		await waitFor(() => expect(account.hanamiShowRecommendationReason).toBe(true));
		await fireEvent.click(view.getByText(i18n.ts._hana.showHanamiTimelineDateSeparators));
		expect(prefer.model('showHanamiTimelineDateSeparators').value).toBe(true);
		await fireEvent.click(await view.findByText(taste.weightReduce));
		expect(api).toHaveBeenCalledWith('i/update-hanami-taste-cluster', { clusterId: 1, weight: 'reduce' });
		await fireEvent.click(view.getByText(i18n.ts._hana._explore.mediaFilterHideMedia));
		await waitFor(() => expect(account.exploreMediaFilter).toBe('hideMedia'));
		expect(api).toHaveBeenCalledWith('i/update', { exploreMediaFilter: 'hideMedia' });
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(alert).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
		expect(apiWithDialog).not.toHaveBeenCalled();
	});
	test('keeps tuning disabled during a flag save and restores the saved flags on failure', async () => {
		const view = mount();
		await view.findByText(i18n.ts._hana._tasteClusters.weightNormal);
		let rejectSave!: (error: Error) => void;
		api.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
		await fireEvent.click(view.getByText(i18n.ts._hana._recommendation.enable));
		expect(view.getByTestId('tuning').getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(view.getByText(i18n.ts._hana._recommendation.showReason));
		expect(api.mock.calls.filter(([endpoint]) => endpoint === 'i/update')).toHaveLength(1);
		rejectSave(new Error('save failed'));
		await waitFor(() => expect(alert).toHaveBeenCalledWith({ type: 'error', text: 'save failed' }));
		expect(view.getByText(i18n.ts._hana._tuning.enableForYou)).toBeTruthy();
		expect(account.hanamiRecommendationEnabled).toBe(false);
		expect(refresh).not.toHaveBeenCalled();
	});
	test('restores taste and media selections and shows only errors when saves fail', async () => {
		const view = mount();
		const taste = i18n.ts._hana._tasteClusters;
		await view.findByText(taste.weightNormal);
		api.mockRejectedValue({ message: 'save failed' });
		await fireEvent.click(view.getByText(taste.weightHide));
		await waitFor(() => expect(view.getByText(taste.weightNormal).closest('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true'));
		await fireEvent.click(view.getByText(i18n.ts._hana._explore.mediaFilterHideSensitive));
		await waitFor(() => expect(view.getByText(i18n.ts._hana._explore.mediaFilterAll).closest('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true'));
		expect(alert).toHaveBeenCalledTimes(2);
		expect(account.exploreMediaFilter).toBe('all');
		expect(success).not.toHaveBeenCalled();
		expect(apiWithDialog).not.toHaveBeenCalled();
	});
});
