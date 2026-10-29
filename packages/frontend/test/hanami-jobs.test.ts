/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// @vitest-environment happy-dom

import { defineComponent, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type { entities } from 'misskey-js';
import HanamiJobs from '@/pages/admin/hanami.jobs.vue';
import Hanami from '@/pages/admin/hanami.vue';
import { i18n } from '@/i18n.js';

const api = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: api }));
vi.mock('@/os.js', () => ({ alert }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/i18n.js', async () => {
	const { readFileSync } = await import('node:fs');
	const { load } = await import('js-yaml');
	const locale = load(readFileSync(`${process.cwd()}/../../locales/ja-JP.yml`, 'utf8'));
	const interpolate = (obj: unknown): unknown => typeof obj === 'string' ? (args: Record<string, unknown>) => obj.replace(/\{(\w+)\}/g, (_match, key: string) => String(args[key]))
		: Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([key, value]) => [key, interpolate(value)]));
	return { i18n: { ts: locale, tsx: interpolate(locale) } };
});
vi.mock('@/components/MkButton.vue', () => ({ default: { template: '<button><slot/></button>' } }));
vi.mock('@/components/MkInfo.vue', () => ({ default: { props: ['warn'], template: '<aside :data-warn="warn"><slot/></aside>' } }));
vi.mock('@/components/MkFolder.vue', () => ({ default: { props: ['defaultOpen'], template: '<details :open="defaultOpen"><summary><slot name="label"/></summary><slot/></details>' } }));
vi.mock('@/components/MkKeyValue.vue', () => ({ default: { template: '<div><slot name="key"/>: <slot name="value"/></div>' } }));
vi.mock('@/pages/admin/hanami.overview.vue', () => ({ default: { template: '<p>overview</p>' } }));
vi.mock('@/pages/admin/hanami.stats.vue', () => ({ default: { template: '<p>stats</p>' } }));
vi.mock('@/pages/admin/hanami.axes.vue', () => ({ default: { template: '<p>axes</p>' } }));
vi.mock('@/pages/admin/hanami.judge.vue', () => ({ default: { template: '<p>judge</p>' } }));
vi.mock('@/pages/admin/hanami.trends.vue', () => ({ default: { template: '<p>trends</p>' } }));
vi.mock('@/pages/admin/hanami.taste.vue', () => ({ default: { template: '<p>taste</p>' } }));
const global = { stubs: {
	SearchMarker: { template: '<div><slot/></div>' }, MkTime: { props: ['time'], template: '<time :datetime="time">{{time}}</time>' }, MkLoading: true,
	PageWithHeader: { props: ['tabs', 'tab'], emits: ['update:tab'], template: '<div><nav><button v-for="item in tabs" :key="item.key" @click="$emit(\'update:tab\', item.key)">{{item.title}}</button></nav><slot/></div>' },
} };
const at = '2026-10-29T12:00:00.000Z';
const j = i18n.ts._hana._admin._jobs;

function snapshot(): entities.AdminHanamiJobsStatusResponse {
	const run = { status: 'ready', startedAt: at, finishedAt: at, processedCount: 7, failure: null, interrupted: false, skippedReason: null };
	return { gpu: { available: true, device: 'cuda', deviceName: 'Test GPU', reason: null, probedAt: at }, lock: { held: false, kind: null, acquiredAt: null, expiresInMs: null }, topicJudgeWaiting: false,
		queue: { truncated: false, jobs: [{ name: 'hanamiNoteJudge', active: 1, wait: 2, delayed: 3, failed: 4, oldestWaitingAt: at }] },
		runs: (['note-judge', 'als', 'embedding'] as const).map(kind => ({ kind, latest: { ...run, processedCount: 0 }, latestWork: run, last24h: { ready: 5, failed: 2, interrupted: 1, empty: 3 } })),
		noteJudge: { backlog: 99, secPerNote: 1.25 }, topicJudge: { at, outcome: 'partial', requested: { daily: 3, pairs: 2, titles: 1 }, saved: { daily: 2, same: 1, titles: 0 }, rejectedTitles: 1, lastSuccessAt: at },
		recentFailures: [], warnings: [], events: [] };
}

const settle = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at); api.mockReset().mockResolvedValue(snapshot()); alert.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Hanami jobs tab', () => {
	test('renders healthy status, the queue and four cards with work distinct from empty latest', async () => {
		const view = render(HanamiJobs, { global }); await settle();
		expect(view.getByText(j.healthy)).toBeTruthy();
		expect(view.getByRole('table').textContent).toContain('投稿の判定1234');
		for (const name of ['投稿の判定', '話題の判定', 'おすすめの計算', '好みの学習']) expect(view.getByRole('region', { name })).toBeTruthy();
		const note = view.getByRole('region', { name: '投稿の判定' });
		expect(note.textContent).toContain('7 件'); expect(note.textContent).toContain('空振り');
		expect(note.textContent).toContain('99'); expect(note.textContent).toContain('1.25');
		const topic = view.getByRole('region', { name: '話題の判定' });
		expect(topic.textContent).toContain('一部完了'); expect(topic.textContent).toContain('日常: 3・同じ話題: 2・見出し: 1');
		expect(view.getByRole('region', { name: j.queue }).getAttribute('tabindex')).toBe('0');
	});
	test.each(Object.entries(j._warning))('localizes warning %s instead of showing the healthy message', async (code, message) => {
		api.mockResolvedValue({ ...snapshot(), warnings: [code] });
		const view = render(HanamiJobs, { global }); await settle();
		expect(view.getByText(message).getAttribute('data-warn')).not.toBeNull();
		expect(view.queryByText(j.healthy)).toBeNull();
	});
	test('shows lock metadata, failures, collapsed newest 30 events and absolute time on click', async () => {
		const data = snapshot(); data.lock = { held: true, kind: 'als', acquiredAt: at, expiresInMs: 89000 }; data.topicJudgeWaiting = true;
		data.queue.truncated = true;
		data.recentFailures = [{ kind: 'als', startedAt: at, failure: '<script>bad()</script>' }];
		data.events = Array.from({ length: 31 }, (_, n) => ({ at, job: 'topicJudge', event: 'failed', durationMs: 1000, error: { name: 'Error', message: `failure-${n}`, stderrTail: 'python traceback' } }));
		api.mockResolvedValue(data);
		const view = render(HanamiJobs, { global }); await settle();
		expect(view.getByText(j.truncated)).toBeTruthy(); expect(view.container.textContent).toContain('あと 89 秒');
		expect(view.getByText('<script>bad()</script>')).toBeTruthy(); expect(view.container.querySelector('script')).toBeNull();
		const events = view.getByText(j.events).closest('details')!; expect(events.hasAttribute('open')).toBe(false);
		expect(events.textContent).toContain('話題の判定 · 処理に失敗'); expect(events.textContent).toContain('failure-29'); expect(events.textContent).not.toContain('failure-30');
		await fireEvent.click(view.container.querySelector('time')!.closest('button')!);
		expect(alert).toHaveBeenCalledWith({ type: 'info', text: new Date(at).toLocaleString() });
	});
	test('polls every 15 seconds, refreshes manually, then stops and aborts when leaving the tab', async () => {
		const view = render(Hanami, { global });
		// The shell polls a one-event status for its attention dot; only the jobs tab asks for 30 events.
		const tabCalls = () => api.mock.calls.filter(call => (call[1] as { eventsLimit?: number }).eventsLimit === 30);
		const tabs = Array.from(view.container.querySelectorAll('nav button')).map(el => el.textContent?.trim());
		expect(tabs.slice(0, 4)).toEqual(['概要', '統計', 'ジョブ', 'トレンド']);
		await fireEvent.click(view.getByRole('button', { name: 'ジョブ' })); await settle(); expect(tabCalls()).toHaveLength(1);
		expect(view.getByRole('button', { name: 'ジョブ' }).getAttribute('aria-current')).toBe('page');
		await vi.advanceTimersByTimeAsync(14999); expect(tabCalls()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1); await settle(); expect(tabCalls()).toHaveLength(2);
		expect(view.container.textContent).toContain(j.lastFetched);
		api.mockImplementationOnce(() => new Promise(() => undefined));
		await fireEvent.click(view.getByRole('button', { name: '更新' })); await settle(); expect(tabCalls()).toHaveLength(3);
		const signal = tabCalls()[2][3] as AbortSignal;
		await fireEvent.click(view.getByRole('button', { name: '概要' })); expect(signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(60000); expect(tabCalls()).toHaveLength(3);
	});
	test('marks the jobs section when the shell status has warnings', async () => {
		api.mockResolvedValue({ ...snapshot(), warnings: ['gpuUnavailable'] });
		const view = render(Hanami, { global }); await settle();
		expect(api).toHaveBeenCalledWith('admin/hanami/jobs-status', { eventsLimit: 1 }, undefined, expect.any(AbortSignal));
		expect(view.getByRole('button', { name: `ジョブ ${i18n.ts._hana._admin.attention}` })).toBeTruthy();
		expect(view.getByRole('button', { name: '概要' }).textContent).not.toContain(i18n.ts._hana._admin.attention);
	});
	test('does not overlap slow requests and drops late completion after unmount', async () => {
		let resolve!: (value: entities.AdminHanamiJobsStatusResponse) => void;
		api.mockImplementation(() => new Promise(done => { resolve = done; }));
		const view = render(HanamiJobs, { global });
		await vi.advanceTimersByTimeAsync(45000); expect(api).toHaveBeenCalledTimes(1);
		const signal = api.mock.calls[0][3] as AbortSignal; view.unmount(); expect(signal.aborted).toBe(true);
		resolve(snapshot()); await settle(); await vi.advanceTimersByTimeAsync(30000); expect(api).toHaveBeenCalledTimes(1);
	});
	test('stops while the route is cached in KeepAlive and restarts exactly once on return', async () => {
		const visible = ref(true);
		const host = defineComponent({ components: { HanamiJobs }, setup: () => ({ visible }), template: '<KeepAlive><HanamiJobs v-if="visible"/></KeepAlive>' });
		api.mockImplementationOnce(() => new Promise(() => undefined));
		render(host, { global }); await settle(); expect(api).toHaveBeenCalledTimes(1);
		const signal = api.mock.calls[0][3] as AbortSignal;
		visible.value = false; await settle(); expect(signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(30000); expect(api).toHaveBeenCalledTimes(1);
		visible.value = true; await settle(); expect(api).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(15000); expect(api).toHaveBeenCalledTimes(3);
	});
});
