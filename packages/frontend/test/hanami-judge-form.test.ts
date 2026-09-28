/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// @vitest-environment happy-dom

import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import { createJudgeDebounce, judgeFormToSettings, judgeFormValid, judgePromptChanged, judgeRegexRows, judgeRejudgeEstimate, judgeSecondsPerNote, judgeSettingsToForm, judgeTrialAvailable } from '../src/scripts/hanami-judge-form.js';
import type { JudgeSettings } from '../src/scripts/hanami-judge-form.js';
import HanamiJudge from '@/pages/admin/hanami.judge.vue';

const apiMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: apiMock }));
vi.mock('@/os.js', () => ({ confirm: confirmMock, alert: vi.fn() }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { _hana: { _admin: new Proxy({}, { get: (_target, key) => key === '_dimensionValue' ? { unjudged: '未判定' } : key }), _recommendation: { _reason: {} } } } } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { template: '<section><slot name="label"/><slot/><slot name="footer"/></section>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { template: '<aside><slot/></aside>' } }));
vi.mock('@/components/MkKeyValue.vue', () => ({ default: { template: '<div><slot name="key"/><slot name="value"/></div>' } }));
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkFormFooter.vue', () => ({ default: {
	props: ['form', 'canSaving'], template: '<button :disabled="!canSaving || !form.modified.value" @click="form.save()">save-settings</button>',
} }));
vi.mock('@/components/MkInput.vue', () => ({ default: {
	props: ['modelValue'], emits: ['update:modelValue'],
	template: '<label><slot name="label"/><input type="number" :value="modelValue" @input="$emit(\'update:modelValue\', Number($event.target.value))"/></label>',
} }));
vi.mock('@/components/MkTextarea.vue', () => ({ default: {
	props: ['modelValue'], emits: ['update:modelValue'],
	template: '<label><slot name="label"/><textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/></label>',
} }));
vi.mock('@/components/MkRange.vue', () => ({ default: { template: '<div><slot name="label"/></div>' } }));
vi.mock('@/components/MkSwitch.vue', () => ({ default: { template: '<div><slot/></div>' } }));

function settings(): JudgeSettings {
	return {
		schemaVersion: 1, promptVersion: 7,
		ephemeralThreshold: 0, interestThreshold: 2.95, reactionMax: 3, interestMax: 10,
		basis: { ephemeralA: 'A', ephemeralB: 'B', interest1: '1', interest2: '2', interest3: '3', interest4: '4', interest5: '5' },
		examples: ['a\nmultiline example', 'another example', 'another example'],
		templatePatterns: ['^hello$', 'with spaces '], contentTypeBonus: [0, 1, 2, 2, 2, 2, 0, 0, 0, 0],
	};
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in judge unit tests'); })));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Hanami judge draft', () => {
	test('round-trips one examples list without merging, deduplicating or splitting multiline examples', () => {
		const original = settings();
		const form = judgeSettingsToForm(original);
		expect(judgeFormToSettings(form)).toEqual(original);
		form.examples.splice(1, 1);
		form.basis.ephemeralA = 'changed';
		expect(original.examples).toHaveLength(3);
		expect(original.basis.ephemeralA).toBe('A');
		expect(judgeFormToSettings(form).examples).toEqual(['a\nmultiline example', 'another example']);
	});

	test('only basis, examples and template patterns require prompt confirmation', () => {
		const original = settings();
		for (const patch of [{ ephemeralThreshold: 1 }, { interestThreshold: 3.5 }, { reactionMax: 4 }, { interestMax: 12 }, { contentTypeBonus: Array(10).fill(3) }, { promptVersion: 8 }]) {
			expect(judgePromptChanged(original, { ...original, ...patch })).toBe(false);
		}
		for (const patch of [{ basis: { ...original.basis, interest3: 'new' } }, { examples: ['new'] }, { templatePatterns: ['new'] }]) {
			expect(judgePromptChanged(original, { ...original, ...patch })).toBe(true);
		}
	});

	test('validates regex with backend iu flags and preserves original row indexes', () => {
		const rows = judgeRegexRows('^ok$\n\n[\n\\a\n日本語');
		expect(rows.filter(row => row.invalid).map(row => row.index)).toEqual([2, 3]);
		expect(rows[4]).toEqual({ index: 4, pattern: '日本語', invalid: false });
		const form = judgeSettingsToForm(settings());
		form.templatePatternsText = '^ok$\r\n\r\nwith spaces ';
		expect(judgeFormToSettings(form).templatePatterns).toEqual(['^ok$', 'with spaces ']);
		expect(judgeFormValid(form)).toBe(true);
		form.templatePatternsText += '\n[';
		expect(judgeFormValid(form)).toBe(false);
	});

	test('rejects incomplete drafts and out-of-range bonuses before trial/save', () => {
		const form = judgeSettingsToForm(settings());
		form.contentTypeBonus[3] = 11;
		expect(judgeFormValid(form)).toBe(false);
		form.contentTypeBonus[3] = 2;
		form.examples.push('');
		expect(judgeFormValid(form)).toBe(false);
	});

	test('requires both backend availability and a GPU for interactive trials', () => {
		expect(judgeTrialAvailable({ available: true, device: 'cpu' })).toBe(false);
		expect(judgeTrialAvailable({ available: true, device: 'cuda' })).toBe(true);
		expect(judgeTrialAvailable({ available: false, device: 'cuda' })).toBe(false);
		expect(judgeTrialAvailable({ available: true })).toBe(false);
		expect(judgeTrialAvailable(null)).toBe(false);
	});

	test('never invents timing or candidate counts', () => {
		expect(judgeSecondsPerNote({ wallDurationMs: 3000, processedCount: 2 })).toBe(1.5);
		expect(judgeSecondsPerNote({ processedCount: 0 })).toBeNull();
		expect(judgeRejudgeEstimate(12, undefined, 1.5)).toEqual({ count: null, seconds: null });
		expect(judgeRejudgeEstimate(12, 20, 1.5)).toEqual({ count: 32, seconds: 48 });
	});

	test('debounces to 600ms and cancels pending work on disposal', () => {
		vi.useFakeTimers();
		const run = vi.fn();
		const debounce = createJudgeDebounce(run);
		debounce.schedule();
		vi.advanceTimersByTime(400);
		debounce.schedule();
		vi.advanceTimersByTime(599);
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledTimes(1);
		debounce.schedule();
		debounce.cancel();
		vi.runAllTimers();
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe('Hanami judge save and what-if lifecycle', () => {
	const pending: { resolve: (value: unknown) => void; signal: AbortSignal }[] = [];
	beforeEach(() => {
		vi.useFakeTimers();
		pending.length = 0;
		apiMock.mockReset();
		confirmMock.mockReset().mockResolvedValue({ canceled: false });
		apiMock.mockImplementation((endpoint: string, params?: { settings?: JudgeSettings }, _token?: string, signal?: AbortSignal) => {
			if (endpoint === 'admin/hanami/judge-settings') return Promise.resolve(params?.settings ?? settings());
			if (endpoint === 'admin/hanami/judge-status') return Promise.resolve({ promptVersion: 7, backlog: 12, candidateCount: 20, secPerNote: 1.5, runtime: { available: false } });
			if (endpoint === 'admin/hanami/judge-aggregate') return Promise.resolve({ judged: 0, ruleExcluded: 0, ephemeral: 0, interestFiltered: 0, typeBreakdown: [], topServed: [] });
			if (endpoint === 'admin/hanami/metrics/opportunities') return Promise.resolve({ hiddenCost: [], suppressed: [], unavailable: [] });
			if (endpoint === 'admin/hanami/metrics/what-if') return new Promise(resolve => pending.push({ resolve, signal: signal! }));
			throw new Error(`Unexpected endpoint: ${endpoint}`);
		});
	});
	const mount = () => render(HanamiJudge, { global: { stubs: { SearchMarker: { template: '<div><slot/></div>' }, MkA: true } } });
	const settle = async () => { await nextTick(); await nextTick(); await nextTick(); };
	const whatIf = (passed: number) => ({ range: { from: '2026-09-01', to: '2026-09-20' }, interest: [{ theta: 2.95, passed, passedEngagementRate: null }], contentTypeBonus: [], unavailable: [], suppressed: [] });

	test('separates rule counts, removes enabled, and replaces empty what-if tables', async () => {
		const implementation = apiMock.getMockImplementation()!;
		apiMock.mockImplementation((endpoint: string, ...args: unknown[]) => endpoint === 'admin/hanami/judge-aggregate'
			? Promise.resolve({ judged: 15, ruleExcluded: 1446, ephemeral: 2, interestFiltered: 3, typeBreakdown: [{ contentType: 2, count: 15 }], topServed: [{ noteId: 'n1', text: 'Note', reactionScore: null, ephemeralScore: null, interest: null }] })
			: implementation(endpoint, ...args));
		const view = mount();
		await settle();
		expect(view.container.textContent).toContain('llmJudged15');
		expect(view.container.textContent).toContain(`ruleExcluded${(1446).toLocaleString()}`);
		expect(view.getAllByText('未判定')).toHaveLength(2);
		expect(view.queryByText('enabled')).toBeNull();
		await vi.advanceTimersByTimeAsync(600);
		pending[0].resolve({ ...whatIf(0), interest: [{ theta: 2.95, passed: null, passedEngagementRate: null }], unavailable: ['served.missing', 'usage.missing', 'snapshot.missing'], suppressed: ['series.old'] });
		await settle();
		expect(view.getByText('whatIfNotReady')).toBeTruthy();
		expect(view.queryByRole('columnheader', { name: 'passed' })).toBeNull();
		expect(view.container.textContent).not.toMatch(/\b(series|served|hiddenCost|usage|demand|snapshot)\./);
	});

	test.each([
		{ suppressed: ['hiddenCost.fof'], unavailable: [], total: '42' },
		{ suppressed: [], unavailable: ['hiddenCost.fof.comparison'], total: '—' },
		{ suppressed: [], unavailable: ['hiddenCost.normalExposureDenominator'], total: '42' },
	])('hidden-cost count does not present incomplete cohorts as a total: %j', async ({ suppressed, unavailable, total }) => {
		const implementation = apiMock.getMockImplementation()!;
		apiMock.mockImplementation((endpoint: string, ...args: unknown[]) => endpoint === 'admin/hanami/metrics/opportunities'
			? Promise.resolve({ hiddenCost: [{ axis: 'exploration', hidden: 42 }], suppressed, unavailable })
			: implementation(endpoint, ...args));
		const view = mount();
		await settle();
		expect(view.container.textContent).toContain(`hiddenCost (30d)${total}`);
		expect(view.container.textContent).toContain('hiddenCost 42');
		expect(view.container.textContent).not.toMatch(/\b(series|served|hiddenCost|usage|demand|snapshot)\./);
	});

	test('saved bonuses invalidate in-flight and displayed results without a prompt confirmation', async () => {
		const view = mount();
		await settle();
		await vi.advanceTimersByTimeAsync(600);
		expect(pending).toHaveLength(1);
		await fireEvent.update(view.getAllByRole('spinbutton')[3], '4');
		await fireEvent.click(view.getByRole('button', { name: 'save-settings' }));
		await settle();
		expect(confirmMock).not.toHaveBeenCalled();
		expect(pending[0].signal.aborted).toBe(true);
		pending[0].resolve(whatIf(123));
		await settle();
		expect(view.queryByText('123')).toBeNull();
		await vi.advanceTimersByTimeAsync(599);
		expect(pending).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(pending).toHaveLength(2);
		pending[1].resolve(whatIf(321));
		await settle();
		expect(view.getByText('321')).toBeTruthy();
		await fireEvent.update(view.getAllByRole('spinbutton')[3], '5');
		// The endpoint still uses saved settings, so an unsaved bonus must not rerun it.
		await vi.advanceTimersByTimeAsync(600);
		expect(pending).toHaveLength(2);
		expect(view.getByText('321')).toBeTruthy();
		await fireEvent.click(view.getByRole('button', { name: 'save-settings' }));
		await settle();
		expect(view.queryByText('321')).toBeNull();
	});

	test('a prompt confirmation resolved after unmount cannot save settings', async () => {
		let confirm!: (result: { canceled: boolean }) => void;
		confirmMock.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
		const view = mount();
		await settle();
		await fireEvent.update(view.getAllByRole('textbox')[0], 'Changed basis');
		await fireEvent.click(view.getByRole('button', { name: 'save-settings' }));
		expect(confirmMock).toHaveBeenCalledTimes(1);
		view.unmount();
		confirm({ canceled: false });
		await settle();
		expect(apiMock.mock.calls.filter(([endpoint, params]) => endpoint === 'admin/hanami/judge-settings' && params?.settings)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(600);
		expect(pending).toHaveLength(0);
	});
});
