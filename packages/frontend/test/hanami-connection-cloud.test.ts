/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import Cloud from '@/components/HanamiConnectionCloud.vue';
import type * as Misskey from 'misskey-js';
import { buildConnectionLayout, cloudCamera, connectionAvatarSize, connectionCloseness, connectionDistanceBand, normalizeConnectionCount, selectConnectionItems, projectCloudPoint } from '@/utility/hanami-connection-layout.js';

vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false } } }));
vi.mock('@/filters/user.js', () => ({ userPage: (user: { username: string }) => `/@${user.username}` }));
vi.mock('@/i18n.js', async () => {
	const { default: locales } = await import('../../../locales/index.js');
	return { i18n: { ts: locales['ja-JP'], tsx: { _hana: { _affinity: { counts: ({ reply, reaction }: { reply: number; reaction: number }) => `返信 ${reply} · リアクション ${reaction}` } } } } };
});
const stubs = {
	MkAvatar: { props: ['user'], template: '<span :data-avatar="user.id"></span>' },
	MkUserName: { props: ['user'], template: '<span>{{ user.name }}</span>' },
	MkAcct: { props: ['user'], template: '<span>{{ user.username }}</span>' },
	MkTime: { props: ['time'], template: '<span>{{ time }}</span>' },
	MkA: { props: ['to'], template: '<a :href="to"><slot/></a>' },
};
// Fixed test data, independent of the preview page, image assets and the DB.
const fixtureUsers: Misskey.entities.UserLite[] = Array.from({ length: 73 }, (_, index) => ({
	id: `user-${index}`, username: `user${index}`, name: `User ${index}`, host: null,
	avatarUrl: '/avatar.png', avatarBlurhash: null, avatarDecorations: [], emojis: {}, onlineStatus: 'unknown',
}));
const candidates: Misskey.entities.UsersHanamiAffinityResponse['items'] = fixtureUsers.slice(1).map((user, index) => ({
	user,
	// 10 close, 19 middle and 43 distant people, spanning the full score range.
	score: index < 10 ? 100 - index * 3.5 : index < 29 ? 66 - (index - 10) * 1.7 : 33 - (index - 29) * 33 / 42,
	mutualInteraction: true,
	lastInteractionAt: '2026-09-15T00:00:00Z',
	counts: { reply: { out: 24, in: 0 }, mention: { out: 0, in: 0 }, renote: { out: 0, in: 0 }, reaction: { out: 30, in: 0 } },
}));
const items = selectConnectionItems(candidates, 30);
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('connection distance', () => {
	test('each distance band covers the sphere at every count and input order does not matter', () => {
		for (let count = 24; count <= 72; count++) {
			const subset = selectConnectionItems(candidates, count);
			const layout = buildConnectionLayout(subset);
			expect(layout).toHaveLength(count);
			expect(buildConnectionLayout([...subset].reverse())).toEqual(layout);
			for (const point of layout) expect(Math.hypot(point.x, point.y, point.z)).toBeCloseTo(point.radius);
			for (const band of [0, 1, 2]) {
				const members = layout.filter(point => connectionDistanceBand(point.closeness) === band);
				if (!members.length) continue;
				expect(members.reduce((sum, point) => sum + point.y / point.radius, 0)).toBeCloseTo(0);
				for (let i = 0; i < members.length; i++) {
					for (let j = i + 1; j < members.length; j++) {
						const a = members[i], b = members[j];
						expect(Math.hypot(a.x / a.radius - b.x / b.radius, a.y / a.radius - b.y / b.radius, a.z / a.radius - b.z / b.radius)).toBeGreaterThan(1.8 / Math.sqrt(members.length));
					}
				}
			}
		}
	});

	test('near people occupy the interior, with continuous radii and unchanged interaction data', () => {
		const before = structuredClone(items);
		const original = buildConnectionLayout(items);
		const ordered = [...original].sort((a, b) => (b.item.score ?? 0) - (a.item.score ?? 0));
		for (let i = 1; i < ordered.length; i++) expect(ordered[i].radius).toBeGreaterThan(ordered[i - 1].radius);
		expect(ordered[0].radius).toBeCloseTo(0.34);
		expect(ordered.at(-1)?.radius).toBeCloseTo(0.95);
		expect(items).toEqual(before);
		expect([0, 1, 2].map(band => original.filter(point => connectionDistanceBand(point.closeness) === band).length)).toEqual([4, 8, 18]);
		expect(projectCloudPoint(original[0], cloudCamera(0, 0)).x).not.toBe(projectCloudPoint(original[0], cloudCamera(1, 0)).x);
		expect(connectionAvatarSize(30)).toBe(40);
		expect(connectionAvatarSize(72)).toBe(30);
	});

	test('changing sample count preserves each person’s score, counts and radial distance', () => {
		const full = new Map(buildConnectionLayout(candidates).map(point => [point.item.user.id, point]));
		for (let count = 24; count <= 72; count++) {
			const layout = buildConnectionLayout(selectConnectionItems(candidates, count));
			expect(new Set(layout.map(point => point.item.user.id)).size).toBe(count);
			for (const point of layout) {
				const expected = full.get(point.item.user.id)!;
				expect(point.item).toBe(expected.item);
				expect(point.closeness).toBe(expected.closeness);
				expect(point.radius).toBe(expected.radius);
			}
		}
	});

	test('real candidates handle empty or sparse populations and ties without fabricating users', () => {
		expect(selectConnectionItems([], 30)).toEqual([]);
		expect(selectConnectionItems(items.slice(0, 1), 30)).toEqual(items.slice(0, 1));
		const tied = candidates.map(item => ({ ...item, score: 10 }));
		expect(selectConnectionItems(tied, 30)).toEqual(selectConnectionItems([...tied].reverse(), 30));
		const selected = selectConnectionItems(tied, 30);
		expect(selected).toHaveLength(30);
		expect(new Set(selected.map(item => item.user.id)).size).toBe(30);
		for (const point of buildConnectionLayout(selected)) expect(point.closeness).toBe(0.5);
	});

	test('count input stays within limits and rounds to whole people', () => {
		expect(normalizeConnectionCount(24)).toBe(24);
		expect(normalizeConnectionCount(24.8)).toBe(25);
		expect(normalizeConnectionCount(0)).toBe(24);
		expect(normalizeConnectionCount(100)).toBe(72);
		expect(normalizeConnectionCount(NaN)).toBe(30);
	});

	test('equal and missing scores do not create artificial differences or invalid positions', () => {
		const equal = items.map(item => ({ ...item, score: 0 }));
		for (const item of equal) {
			expect(connectionCloseness(item, equal)).toBe(0.5);
			expect(Number.isFinite(projectCloudPoint(buildConnectionLayout([item])[0], cloudCamera(0, 0)).x)).toBe(true);
		}
	});
});

describe('native connection cloud', () => {
	test('hover shows distance and counts; click pins, Escape dismisses; sample users have no profile links', async () => {
		const view = render(Cloud, { props: { items, self: fixtureUsers[0], mock: true }, global: { stubs } });
		const peer = view.container.querySelector(`[data-user-id="${items[0].user.id}"]`) as HTMLElement;
		expect(view.container.querySelector('svg')).toBeNull();
		await fireEvent.pointerMove(peer, { pointerType: 'mouse' });
		expect(view.getByText('近め · やりとりが多い')).toBeTruthy();
		expect(view.getByText('返信 24 · リアクション 30')).toBeTruthy();
		expect(view.container.querySelectorAll('svg line')).toHaveLength(1);
		await fireEvent.click(peer);
		expect(view.getByText('固定中 · ×で解除')).toBeTruthy();
		expect(view.container.querySelector('a')).toBeNull();
		await fireEvent.keyDown(peer, { key: 'Escape' });
		expect(view.queryByTestId('connection-detail')).toBeNull();
		expect(view.container.querySelector('svg')).toBeNull();
	});

	test('long press pins details; pointer cancellation prevents a subsequent long press', async () => {
		vi.useFakeTimers();
		const view = render(Cloud, { props: { items, mock: true }, global: { stubs } });
		const peer = view.container.querySelector(`[data-user-id="${items[0].user.id}"]`) as HTMLElement;
		Object.defineProperty(peer.parentElement, 'hasPointerCapture', { value: () => false });
		await fireEvent.pointerDown(peer, { pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100 });
		await vi.advanceTimersByTimeAsync(460);
		expect(view.getByText('固定中 · ×で解除')).toBeTruthy();
		await fireEvent.click(view.getByRole('button', { name: '閉じる' }));
		await fireEvent.pointerDown(peer, { pointerType: 'touch', pointerId: 2, isPrimary: true, button: 0, clientX: 100, clientY: 100 });
		await fireEvent.pointerCancel(peer, { pointerId: 2 });
		await vi.advanceTimersByTimeAsync(500);
		expect(view.queryByTestId('connection-detail')).toBeNull();
	});
});


describe('cloud rendering lifecycle', () => {
	test('explicit Play overrides the initial animation preference; pause and offscreen cancel all frames', async () => {
		let visibility: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
		const callbacks = new Map<number, FrameRequestCallback>();
		let frame = 0;
		vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callbacks.set(++frame, callback); return frame; }));
		vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: typeof visibility) { visibility = callback; }
			observe() { visibility?.([{ isIntersecting: true }]); }
			disconnect() {}
		});
		const view = render(Cloud, { props: { items, mock: true }, global: { stubs } });
		const peer = view.container.querySelector(`[data-user-id="${items[0].user.id}"]`) as HTMLElement;
		const original = peer.style.transform;
		expect(callbacks.size).toBe(0);
		await fireEvent.click(view.getByRole('button', { name: '回転を再開' }));
		expect(callbacks.size).toBe(1);
		const [id, callback] = [...callbacks][0];
		callbacks.delete(id);
		callback(performance.now() + 40);
		expect(peer.style.transform).not.toBe(original);
		await fireEvent.pointerMove(peer, { pointerType: 'mouse' });
		expect(callbacks.size).toBe(0);
		await fireEvent.pointerLeave(peer);
		expect(callbacks.size).toBe(1);
		await fireEvent.click(peer);
		expect(callbacks.size).toBe(1); // Pinning the detail does not freeze the globe.

		visibility?.([{ isIntersecting: false }]);
		expect(callbacks.size).toBe(0);
		visibility?.([{ isIntersecting: true }]);
		expect(callbacks.size).toBe(1);
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);
		await fireEvent(window.document, new Event('visibilitychange'));
		expect(callbacks.size).toBe(0);
		hidden.mockReturnValue(false);
		await fireEvent(window.document, new Event('visibilitychange'));
		expect(callbacks.size).toBe(1);
		await fireEvent.click(view.getByRole('button', { name: '回転を一時停止' }));
		expect(callbacks.size).toBe(0);
		await fireEvent.click(view.getByRole('button', { name: '回転を再開' }));
		view.unmount();
		expect(callbacks.size).toBe(0);
	});
});


describe('vertical cloud rotation', () => {
	test('dragging crosses both poles, completes a revolution and keeps rotating in either direction', async () => {
		vi.stubGlobal('IntersectionObserver', class {
			constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
			observe() { this.callback([{ isIntersecting: true }]); }
			disconnect() {}
		});
		const view = render(Cloud, { props: { items, mock: true }, global: { stubs } });
		const peer = view.container.querySelector('[data-user-id]') as HTMLElement;
		const stage = peer.parentElement as HTMLElement;
		Object.defineProperty(stage, 'setPointerCapture', { value: () => {} });
		Object.defineProperty(stage, 'hasPointerCapture', { value: () => false });
		const original = peer.style.transform;
		await fireEvent.pointerDown(stage, { pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100 });
		let previous = original;
		for (let step = 1; step <= 16; step++) {
			await fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 100 + step * (Math.PI * 2 / 0.008 / 8) });
			expect(peer.style.transform).not.toBe(previous);
			previous = peer.style.transform;
			if (step % 8 === 0) expect(peer.style.transform).toBe(original);
		}
		for (let step = 15; step >= -8; step--) {
			await fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 100 + step * (Math.PI * 2 / 0.008 / 8) });
			expect(peer.style.transform).not.toBe(previous);
			previous = peer.style.transform;
			if (step % 8 === 0) expect(peer.style.transform).toBe(original);
		}
		await fireEvent.pointerUp(stage, { pointerId: 1 });
	});
});
