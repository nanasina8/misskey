/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import Cloud from '@/components/HanamiConnectionCloud.vue';
import Tooltip from '@/components/HanamiConnectionTooltip.vue';
import * as os from '@/os.js';
import { buildConnectionLayout, cloudCamera, connectionAvatarSize, connectionCloseness, connectionDistanceBand, normalizeConnectionCount, selectConnectionItems, projectCloudPoint } from '@/utility/hanami-connection-layout.js';

vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })), pageWindow: vi.fn() }));
vi.mock('@/utility/hanami-connection-layout.js', async importOriginal => {
	const actual = await importOriginal<typeof import('@/utility/hanami-connection-layout.js')>();
	return { ...actual, cloudCamera: vi.fn(actual.cloudCamera) };
});
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
beforeEach(() => vi.clearAllMocks());
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
				const expected = full.get(point.item.user.id);
				expect(point.item).toBe(expected?.item);
				expect(point.closeness).toBe(expected?.closeness);
				expect(point.radius).toBe(expected?.radius);
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

// Drive the rendering loop independently of timers and real browser frames.
function setupCloud(mock = false) {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	let visibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
	const callbacks = new Map<number, FrameRequestCallback>();
	let frame = 0;
	vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callbacks.set(++frame, callback); return frame; }));
	vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
	vi.stubGlobal('IntersectionObserver', class {
		constructor(callback: typeof visibility) { visibility = callback; }
		observe() { visibility([{ isIntersecting: true }]); }
		disconnect() {}
	});
	vi.stubGlobal('ResizeObserver', class {
		constructor(private callback: (entries: { contentRect: { width: number } }[]) => void) {}
		observe() { this.callback([{ contentRect: { width: 300 } }]); }
		disconnect() {}
	});
	const view = render(Cloud, { props: { items, self: fixtureUsers[0], mock }, global: { stubs } });
	const peer = view.container.querySelector(`[data-user-id="${items[0].user.id}"]`) as HTMLElement;
	const stage = peer.parentElement as HTMLElement;
	Object.defineProperties(stage, {
		setPointerCapture: { value: vi.fn() },
		hasPointerCapture: { value: () => false },
	});
	let hit: Element | null = stage;
	vi.spyOn(window.document, 'elementFromPoint').mockImplementation(() => hit);
	const angles = () => {
		const calls = vi.mocked(cloudCamera).mock.calls;
		return calls[calls.length - 1];
	};
	const tick = async (ms = 40) => {
		await vi.advanceTimersByTimeAsync(ms);
		for (const [id, callback] of [...callbacks]) {
			callbacks.delete(id);
			callback(performance.now());
		}
	};
	const mouse = async (x: number, y: number, target: HTMLElement = stage) => {
		hit = target;
		await fireEvent.pointerMove(target, { pointerType: 'mouse', clientX: x, clientY: y });
	};
	const play = () => fireEvent.click(view.getByRole('button', { name: '回転を再開' }));
	let gesturePointerType = 'touch';
	const down = (target = stage, pointerType = 'touch') => {
		gesturePointerType = pointerType;
		return fireEvent.pointerDown(target, { pointerType, pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100 });
	};
	const move = (x: number, y = 100) => fireEvent.pointerMove(stage, { pointerType: gesturePointerType, pointerId: 1, clientX: x, clientY: y });
	const up = () => fireEvent.pointerUp(stage, { pointerType: gesturePointerType, pointerId: 1 });
	return { view, peer, stage, callbacks, angles, tick, mouse, play, down, move, up, visibility: (value: boolean) => visibility([{ isIntersecting: value }]), hit: (element: Element | null) => { hit = element; } };
}

function angularDelta(current: number, previous: number) {
	return Math.atan2(Math.sin(current - previous), Math.cos(current - previous));
}

async function frameVelocity(cloud: ReturnType<typeof setupCloud>, ms = 40) {
	const [yaw, pitch] = cloud.angles();
	await cloud.tick(ms);
	return {
		yaw: angularDelta(cloud.angles()[0], yaw) / (ms / 1000),
		pitch: angularDelta(cloud.angles()[1], pitch) / (ms / 1000),
	};
}

// Closed-form speed at a given frame: decay only up to the first threshold crossing.
function settlingSpeed(initial: number, frames: number, ms = 40) {
	if (Math.abs(initial) <= 0.18) return initial;
	const factor = Math.pow(0.95, ms / 16.7);
	const crossing = Math.ceil(Math.log(0.18 / Math.abs(initial)) / Math.log(factor));
	return initial * Math.pow(factor, Math.min(frames, crossing));
}

function popupProps() {
	const call = vi.mocked(os.popup).mock.calls.at(-1);
	expect(call?.[0]).toBe(Tooltip);
	return call?.[1] as { showing: { value: boolean }; anchorElement: HTMLElement; item: typeof items[number]; closeness: number };
}

describe('native connection cloud', () => {
	test('cursor position and pointerleave never alter the initial rotation velocity', async () => {
		const c = setupCloud();
		await c.play();
		for (const [frame, [x, y]] of [[300, 0], [0, 300], [150, 150], [153, 153]].entries()) {
			await c.mouse(x, y);
			const velocity = await frameVelocity(c);
			expect(velocity.yaw).toBeCloseTo(settlingSpeed(-1.8, frame + 1), 8);
			expect(velocity.pitch).toBeCloseTo(settlingSpeed(-0.6, frame + 1), 8);
		}
		await fireEvent.pointerLeave(c.stage, { pointerType: 'mouse' });
		const velocity = await frameVelocity(c);
		expect(velocity.yaw).toBeCloseTo(settlingSpeed(-1.8, 5), 8);
		expect(velocity.pitch).toBeCloseTo(settlingSpeed(-0.6, 5), 8);
	});

	test.each([-0.08, -0.0004, 0, 0.0004, 0.0012, 0.08])('a drag ending at %s rad/s preserves subthreshold speed and rounds only tiny speeds to zero', async speed => {
		const c = setupCloud();
		await c.play();
		await c.down(c.stage, 'mouse');
		await vi.advanceTimersByTimeAsync(100);
		await c.move(104, 104);
		await vi.advanceTimersByTimeAsync(50);
		await c.move(104 + speed * 0.05 / 0.016, 104 - speed * 0.05 / 0.016);
		await c.up();
		const expected = Math.abs(speed) < 0.001 ? 0 : speed;
		for (let frame = 0; frame < 20; frame++) {
			const velocity = await frameVelocity(c);
			expect(velocity.yaw).toBeCloseTo(expected, 8);
			// Moving up (negative y) pulls the near side up: pitch velocity matches the yaw sign here.
			expect(velocity.pitch).toBeCloseTo(expected, 8);
		}
	});

	test('touch drag started on an avatar survives the capture handoff from the button to the stage', async () => {
		const c = setupCloud();
		const [yaw] = c.angles();
		await c.down(c.peer, 'touch');
		await vi.advanceTimersByTimeAsync(34);
		await c.move(150);
		// Browsers implicitly capture touch on the pressed button; moving capture to the stage
		// fires lostpointercapture on the button, which bubbles and must not end the gesture.
		await fireEvent.lostPointerCapture(c.peer, { pointerId: 1 });
		await c.move(200);
		expect(c.angles()[0] - yaw).toBeCloseTo(1.6);
		await fireEvent.lostPointerCapture(c.stage, { pointerId: 1 });
		await c.move(250);
		expect(c.angles()[0] - yaw).toBeCloseTo(1.6);
		expect(os.pageWindow).not.toHaveBeenCalled();
	});

	test.each(['mouse', 'touch', 'pen'])('%s stops after holding still for exactly 100ms before release', async pointerType => {
		const c = setupCloud();
		await c.play();
		await c.down(c.stage, pointerType);
		await vi.advanceTimersByTimeAsync(200);
		await c.move(110, 90);
		const stopped = [...c.angles()];
		expect(c.callbacks.size).toBe(0);
		await c.tick(100);
		expect(c.angles()).toEqual(stopped);
		await c.up();
		await c.mouse(300, 0);
		for (let frame = 0; frame < 20; frame++) await c.tick();
		expect(c.angles()).toEqual(stopped);
	});

	test('initial rotation starts on both axes and settles independently below 0.18 rad/s', async () => {
		const c = setupCloud();
		await c.play();
		for (let frame = 1; frame <= 100; frame++) {
			const velocity = await frameVelocity(c);
			expect(velocity.yaw).toBeCloseTo(settlingSpeed(-1.8, frame), 8);
			expect(velocity.pitch).toBeCloseTo(settlingSpeed(-0.6, frame), 8);
			expect(velocity.yaw).toBeLessThan(0);
			expect(velocity.pitch).toBeLessThan(0);
		}
		const settled = await frameVelocity(c);
		expect(Math.abs(settled.yaw)).toBeLessThan(0.18);
		expect(Math.abs(settled.pitch)).toBeLessThan(0.18);
		expect(Math.abs(settled.yaw)).toBeGreaterThan(0.18 * Math.pow(0.95, 40 / 16.7));
		expect(Math.abs(settled.pitch)).toBeGreaterThan(0.18 * Math.pow(0.95, 40 / 16.7));
	});

	test.each(['mouse', 'touch', 'pen'])('%s rotates 1.6 rad per 100px and uses the same per-axis decay after release', async pointerType => {
		const c = setupCloud();
		await c.play();
		const [yaw] = c.angles();
		await c.down(c.stage, pointerType);
		await vi.advanceTimersByTimeAsync(34);
		await c.move(200);
		expect(c.callbacks.size).toBe(0);
		expect(c.stage.dataset.dragging).toBe('true');
		expect(c.stage.setPointerCapture).toHaveBeenCalledWith(1);
		expect(c.angles()[0] - yaw).toBeCloseTo(1.6);
		await c.up();
		expect(c.stage.hasAttribute('data-dragging')).toBe(false);
		for (let frame = 1; frame <= 100; frame++) {
			const velocity = await frameVelocity(c);
			expect(velocity.yaw).toBeCloseTo(settlingSpeed(1.6 / 0.034, frame), 8);
			expect(velocity.pitch).toBeCloseTo(0, 8);
		}
		expect(os.pageWindow).not.toHaveBeenCalled();
	});

	test.each([
		{ pointerType: 'mouse', x: 200, y: 0, yaw: 16, pitch: -16 },
		{ pointerType: 'touch', x: 0, y: 200, yaw: -16, pitch: 16 },
		{ pointerType: 'pen', x: 200, y: 100.5, yaw: 16, pitch: 0.08 },
	])('$pointerType flick to ($x, $y) decays each axis independently for 100 frames', async ({ pointerType, x, y, yaw, pitch }) => {
		const c = setupCloud();
		await c.play();
		await c.down(c.stage, pointerType);
		await vi.advanceTimersByTimeAsync(100);
		await c.move(x, y);
		await c.up();
		for (let frame = 1; frame <= 100; frame++) {
			const velocity = await frameVelocity(c);
			expect(velocity.yaw).toBeCloseTo(settlingSpeed(yaw, frame), 8);
			expect(velocity.pitch).toBeCloseTo(settlingSpeed(-pitch, frame), 8);
		}
	});

	test.each([30, 60, 120])('touch velocity decays equally at %s fps and stops decaying at each axis threshold', async fps => {
		const c = setupCloud();
		await c.play();
		await c.down();
		await vi.advanceTimersByTimeAsync(34);
		await c.move(200, 200);
		await c.up();
		let elapsed = 0;
		for (let i = 1; i <= fps; i++) {
			const next = Math.round(i * 1000 / fps);
			await c.tick(next - elapsed);
			elapsed = next;
		}
		const velocity = await frameVelocity(c, 16);
		const expected = 1.6 / 0.034 * Math.pow(0.95, 1016 / 16.7);
		expect(velocity.yaw).toBeCloseTo(expected, 8);
		expect(velocity.pitch).toBeCloseTo(-expected, 8);
		for (let i = 0; i < 240; i++) await c.tick(16);
		const settled = await frameVelocity(c, 16);
		expect(settled.yaw).toBeCloseTo(settlingSpeed(expected, 241, 16), 8);
		expect(settled.pitch).toBeCloseTo(settlingSpeed(-expected, 241, 16), 8);
	});

	test.each(['mouse', 'touch', 'pen'])('paused %s dragging starts at 3px and wraps pitch across both poles', async pointerType => {
		const c = setupCloud();
		const [yaw] = c.angles();
		await c.down(c.stage, pointerType);
		await c.move(102);
		expect(c.angles()[0]).toBe(yaw);
		await c.move(103);
		expect(c.angles()[0] - yaw).toBeCloseTo(0.048);
		await c.move(200, 1000);
		expect(c.angles()[1]).toBeCloseTo((-0.35 - 900 * 0.016) % (Math.PI * 2));
		await c.move(200, -1000);
		expect(angularDelta(c.angles()[1], -0.35 - (-1000 - 100) * 0.016)).toBeCloseTo(0);
		await c.up();
		await c.mouse(300, 0);
		const still = [...c.angles()];
		await c.tick();
		expect(c.angles()).toEqual(still);
		expect(c.callbacks.size).toBe(0);
	});

	test('300ms hover opens an anchored tooltip and slows rotation to one quarter without stopping frames', async () => {
		const c = setupCloud();
		await c.play();
		for (let frame = 0; frame < 100; frame++) await c.tick();
		const base = await frameVelocity(c);
		await c.mouse(300, 150, c.peer);
		await vi.advanceTimersByTimeAsync(299);
		expect(os.popup).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		const props = popupProps();
		expect(props.anchorElement).toBe(c.peer);
		expect(props.item).toEqual(items[0]);
		expect(props.showing.value).toBe(true);
		expect(c.view.container.querySelectorAll('svg line')).toHaveLength(1);
		expect(c.callbacks.size).toBe(1);
		await c.tick();
		const [yaw] = c.angles();
		await c.tick();
		expect(c.angles()[0] - yaw).toBeCloseTo(base.yaw * 0.04 / 4);
		await c.mouse(150, 150, c.peer);
		const [centerYaw] = c.angles();
		await c.tick(16);
		expect(c.angles()[0] - centerYaw).toBeCloseTo(base.yaw * 0.016 / 4, 8);
		await fireEvent.pointerLeave(c.stage, { pointerType: 'mouse' });
		expect(props.showing.value).toBe(false);
		expect(c.view.container.querySelector('svg')).toBeNull();
		expect(c.callbacks.size).toBe(1);
		const dispose = vi.mocked(os.popup).mock.results.at(-1)?.value.dispose;
		const events = vi.mocked(os.popup).mock.calls.at(-1)?.[2] as { closed: () => void };
		events.closed();
		expect(dispose).toHaveBeenCalledOnce();
	});

	test('changing avatars restarts the delay and rotation under a stationary cursor closes the tooltip', async () => {
		const c = setupCloud();
		await c.play();
		await c.mouse(300, 150, c.peer);
		await vi.advanceTimersByTimeAsync(200);
		const other = c.view.container.querySelector(`[data-user-id="${items[1].user.id}"]`) as HTMLElement;
		await c.mouse(300, 150, other);
		await vi.advanceTimersByTimeAsync(200);
		expect(os.popup).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		const props = popupProps();
		expect(props.anchorElement).toBe(other);
		c.hit(c.stage);
		await c.tick();
		await vi.advanceTimersByTimeAsync(99);
		expect(props.showing.value).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(props.showing.value).toBe(false);
	});

	test('mouse short click below 3px opens once, while drag clicks never open a profile', async () => {
		const c = setupCloud();
		await c.down(c.peer, 'mouse');
		await vi.advanceTimersByTimeAsync(100);
		await c.move(102);
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		expect(os.pageWindow).toHaveBeenCalledExactlyOnceWith(`/@${items[0].user.username}`);
		vi.mocked(os.pageWindow).mockClear();
		await c.down(c.peer, 'mouse');
		await vi.advanceTimersByTimeAsync(50);
		await c.move(103);
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		expect(os.pageWindow).not.toHaveBeenCalled();
		// A subsequent real click is not suppressed by the previous drag.
		await c.down(c.peer, 'mouse');
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		expect(os.pageWindow).toHaveBeenCalledTimes(1);
	});

	test.each(['mouse', 'touch'])('mock %s clicks do not open profiles', async pointerType => {
		const c = setupCloud(true);
		await c.down(c.peer, pointerType);
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		await c.down(c.peer, pointerType);
		await c.up();
		expect(os.pageWindow).not.toHaveBeenCalled();
	});

	test.each(['mouse', 'touch', 'pen'])('%s dragging closes the tooltip and suspends all hit testing until release', async pointerType => {
		const c = setupCloud();
		await c.play();
		await c.mouse(100, 100, c.peer);
		await vi.advanceTimersByTimeAsync(300);
		const props = popupProps();
		// Queue a 100ms hit test, then begin dragging before it runs.
		await c.tick(16);
		await c.down(c.peer, pointerType);
		await c.move(103);
		expect(props.showing.value).toBe(false);
		expect(c.callbacks.size).toBe(0);
		const hitTests = vi.mocked(window.document.elementFromPoint).mock.calls.length;
		await c.tick(200);
		await c.move(110);
		await c.tick(200);
		expect(window.document.elementFromPoint).toHaveBeenCalledTimes(hitTests);
		expect(os.popup).toHaveBeenCalledTimes(1);
		await c.up();
		await c.mouse(150, 150);
		await c.tick(16);
		await vi.advanceTimersByTimeAsync(100);
		expect(window.document.elementFromPoint).toHaveBeenCalledTimes(hitTests + 1);
	});

	test('a mouse hold is not a touch long press or a short click', async () => {
		const c = setupCloud();
		await c.down(c.peer, 'mouse');
		await vi.advanceTimersByTimeAsync(450);
		expect(os.popup).not.toHaveBeenCalled();
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		expect(os.pageWindow).not.toHaveBeenCalled();
	});

	test.each(['touch', 'pen'])('%s tap keeps details after release, retap opens the profile, another person switches details and blank space closes them', async pointerType => {
		const c = setupCloud();
		await c.play();
		await c.down(c.peer, pointerType);
		await vi.advanceTimersByTimeAsync(100);
		await c.move(102);
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		const first = popupProps();
		expect(first.anchorElement).toBe(c.peer);
		expect(first.showing.value).toBe(true);
		expect(c.view.container.querySelectorAll('svg line')).toHaveLength(1);
		expect(os.pageWindow).not.toHaveBeenCalled();
		await fireEvent.lostPointerCapture(c.peer, { pointerId: 1 });
		await fireEvent.pointerLeave(c.stage, { pointerType });
		await c.tick(500);
		expect(first.showing.value).toBe(true);
		await c.down(c.peer, pointerType);
		expect(first.showing.value).toBe(true);
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		expect(os.pageWindow).toHaveBeenCalledExactlyOnceWith(`/@${items[0].user.username}`);
		expect(os.popup).toHaveBeenCalledTimes(1);
		const other = c.view.container.querySelector(`[data-user-id="${items[1].user.id}"]`) as HTMLElement;
		await c.down(other, pointerType);
		await c.up();
		// Browsers move focus after touch release, blurring the previously focused avatar.
		await fireEvent.blur(c.peer, { relatedTarget: other });
		await fireEvent.focus(other, { relatedTarget: c.peer });
		const second = popupProps();
		expect(first.showing.value).toBe(false);
		expect(second.anchorElement).toBe(other);
		expect(second.showing.value).toBe(true);
		expect(os.pageWindow).toHaveBeenCalledTimes(1);
		await c.down(c.stage, pointerType);
		await c.up();
		expect(second.showing.value).toBe(false);
		expect(c.view.container.querySelector('svg')).toBeNull();
	});

	test.each(['touch', 'pen'])('%s long press persists after release; cancellation and slow taps do not navigate', async pointerType => {
		const c = setupCloud();
		await c.down(c.peer, pointerType);
		await vi.advanceTimersByTimeAsync(450);
		const props = popupProps();
		expect(props.showing.value).toBe(true);
		await c.up();
		await fireEvent.click(c.peer, { detail: 1 });
		await c.tick(500);
		expect(props.showing.value).toBe(true);
		await c.down(c.peer, pointerType);
		await fireEvent.pointerCancel(c.stage, { pointerId: 1 });
		await vi.advanceTimersByTimeAsync(500);
		expect(props.showing.value).toBe(false);
		expect(os.popup).toHaveBeenCalledTimes(1);
		await c.down(c.peer, pointerType);
		await vi.advanceTimersByTimeAsync(350);
		await c.up();
		await vi.advanceTimersByTimeAsync(500);
		expect(os.popup).toHaveBeenCalledTimes(1);
		expect(os.pageWindow).not.toHaveBeenCalled();
	});

	test.each(['drag', 'escape', 'offscreen', 'hidden'])('persistent touch details close on %s', async action => {
		const c = setupCloud();
		await c.down(c.peer);
		await c.up();
		const props = popupProps();
		if (action === 'drag') {
			await c.down(c.peer);
			expect(props.showing.value).toBe(true);
			await c.move(103);
		} else if (action === 'escape') {
			await fireEvent.keyDown(c.peer, { key: 'Escape' });
		} else if (action === 'offscreen') {
			c.visibility(false);
		} else {
			vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);
			await fireEvent(window.document, new Event('visibilitychange'));
		}
		expect(props.showing.value).toBe(false);
		expect(os.pageWindow).not.toHaveBeenCalled();
	});

	test.each(['peer', 'blank'])('mouse hover replaces persistent touch details over %s', async target => {
		const c = setupCloud();
		await c.down(c.peer);
		await c.up();
		const props = popupProps();
		await c.mouse(100, 100, target === 'peer' ? c.peer : c.stage);
		expect(props.showing.value).toBe(false);
		await vi.advanceTimersByTimeAsync(299);
		expect(os.popup).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(os.popup).toHaveBeenCalledTimes(target === 'peer' ? 2 : 1);
		if (target === 'peer') {
			const hover = popupProps();
			await fireEvent.pointerLeave(c.stage, { pointerType: 'mouse' });
			expect(hover.showing.value).toBe(false);
		}
	});

	test('distance colors are opt-in, match every distance band and can be toggled off without changing positions', async () => {
		const c = setupCloud(true);
		const peers = Array.from(c.view.container.querySelectorAll<HTMLElement>('[data-user-id]'));
		const transforms = peers.map(peer => peer.style.transform);
		expect(c.view.container.querySelector('[data-band]')).toBeNull();
		for (const peer of peers) expect(peer.style.getPropertyValue('--cloud-ring')).toBe('');
		expect(c.view.queryByText('近め')).toBeNull();
		await c.view.rerender({ distanceColors: true });
		const layout = buildConnectionLayout(items);
		for (const point of layout) {
			const peer = c.view.container.querySelector(`[data-user-id="${point.item.user.id}"]`);
			expect(peer?.getAttribute('data-band')).toBe(String(connectionDistanceBand(point.closeness)));
		}
		for (const label of ['近め', '中ほど', '遠め']) expect(c.view.getByText(label)).toBeTruthy();
		expect(peers.map(peer => peer.style.transform)).toEqual(transforms);
		await c.view.rerender({ distanceColors: false });
		expect(c.view.container.querySelector('[data-band]')).toBeNull();
		expect(c.view.queryByText('近め')).toBeNull();
	});

	test('keyboard focus opens details; blur and Escape close them and native button activation opens the profile', async () => {
		const c = setupCloud();
		vi.spyOn(c.peer, 'matches').mockImplementation(selector => selector === ':focus-visible');
		await fireEvent.focus(c.peer);
		const first = popupProps();
		await fireEvent.keyDown(c.peer, { key: 'Escape' });
		expect(first.showing.value).toBe(false);
		await fireEvent.focus(c.peer);
		const second = popupProps();
		await fireEvent.blur(c.peer);
		expect(second.showing.value).toBe(false);
		await fireEvent.click(c.peer, { detail: 0 });
		expect(os.pageWindow).toHaveBeenCalledWith(`/@${items[0].user.username}`);
	});

	test('tooltip uses the existing identity and four count labels, distance, direction and relative time', () => {
		const view = render(Tooltip, {
			props: { showing: true, anchorElement: window.document.createElement('button'), item: items[0], closeness: 1 },
			global: { stubs: { ...stubs, MkTooltip: { template: '<div><slot/></div>' } } },
		});
		for (const text of ['返信', 'メンション', 'リノート', 'リアクション', '24', '30', '近め · やりとりが多い', items[0].user.username]) expect(view.getByText(text)).toBeTruthy();
		expect(view.getAllByText('0')).toHaveLength(2);
		expect(view.container.textContent).toContain('双方向のやりとり ·');
		expect(view.container.querySelector('a, button')).toBeNull();
	});
});

describe('cloud rendering lifecycle', () => {
	test('explicit Play overrides the initial animation preference; pause, offscreen and hidden tabs cancel all frames', async () => {
		const c = setupCloud(true);
		const original = c.peer.style.transform;
		expect(c.callbacks.size).toBe(0);
		await c.play();
		expect(c.callbacks.size).toBe(1);
		await c.tick();
		expect(c.peer.style.transform).not.toBe(original);
		await c.mouse(300, 150, c.peer);
		await vi.advanceTimersByTimeAsync(300);
		const props = popupProps();
		expect(c.callbacks.size).toBe(1);
		c.visibility(false);
		expect(c.callbacks.size).toBe(0);
		expect(props.showing.value).toBe(false);
		c.visibility(true);
		expect(c.callbacks.size).toBe(1);
		const hidden = vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(true);
		await fireEvent(window.document, new Event('visibilitychange'));
		expect(c.callbacks.size).toBe(0);
		hidden.mockReturnValue(false);
		await fireEvent(window.document, new Event('visibilitychange'));
		expect(c.callbacks.size).toBe(1);
		await fireEvent.click(c.view.getByRole('button', { name: '回転を一時停止' }));
		expect(c.callbacks.size).toBe(0);
		await c.play();
		await c.mouse(300, 150, c.peer);
		c.view.unmount();
		await vi.advanceTimersByTimeAsync(500);
		expect(c.callbacks.size).toBe(0);
		expect(os.popup).toHaveBeenCalledTimes(1);
	});

	test('cursor hit testing runs only every 100ms and offscreen cancels pending checks', async () => {
		const c = setupCloud();
		await c.play();
		await c.mouse(300, 150);
		for (let i = 0; i < 10; i++) await c.tick(10);
		expect(window.document.elementFromPoint).not.toHaveBeenCalled();
		await c.tick(10);
		expect(window.document.elementFromPoint).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 10; i++) await c.tick(10);
		expect(window.document.elementFromPoint).toHaveBeenCalledTimes(2);
		c.visibility(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(window.document.elementFromPoint).toHaveBeenCalledTimes(2);
	});

	test('every native animation frame renders, including high refresh rates, while stalled frames cannot jump arbitrarily far', async () => {
		const c = setupCloud();
		await c.play();
		await c.mouse(300, 150);
		let elapsed = 0;
		for (const ms of [16, 17, 8, 7]) {
			const [yaw] = c.angles();
			const calls = vi.mocked(cloudCamera).mock.calls.length;
			await c.tick(ms);
			elapsed += ms;
			expect(c.angles()[0] - yaw).toBeCloseTo(-1.8 * Math.pow(0.95, elapsed / 16.7) * ms / 1000, 8);
			expect(vi.mocked(cloudCamera).mock.calls.length).toBe(calls + 1);
		}
		const before = c.angles()[0];
		await c.tick(1000);
		expect(c.angles()[0] - before).toBeCloseTo(-1.8 * Math.pow(0.95, (elapsed + 1000) / 16.7) * 0.08, 8);
	});
});
