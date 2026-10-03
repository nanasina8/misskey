/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import type { Component } from 'vue';
import MkOffscreenKeeper from '@/components/MkOffscreenKeeper.vue';

const observers: {
	callback: IntersectionObserverCallback;
	options: IntersectionObserverInit;
	observe: ReturnType<typeof vi.fn>;
	unobserve: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
}[] = [];
const cleanups: (() => void)[] = [];

beforeEach(() => {
	vi.stubGlobal('IntersectionObserver', vi.fn((callback: IntersectionObserverCallback, options: IntersectionObserverInit) => {
		const observer = { callback, options, observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
		observers.push(observer);
		return observer;
	}));
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	observers.length = 0;
	window.document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mountKeeper(options: { parent?: HTMLElement; child?: Component; disabled?: boolean } = {}) {
	const host = window.document.createElement('div');
	(options.parent ?? window.document.body).append(host);
	const disabled = ref(options.disabled ?? false);
	const app = createApp({
		render: () => h(MkOffscreenKeeper, { disabled: disabled.value, class: 'note-wrapper', 'data-scroll-anchor': 'note-id' }, {
			default: () => options.child ? h(options.child) : h('button', 'note'),
		}),
	});
	app.mount(host);
	const root = host.firstElementChild as HTMLElement;
	let mounted = true;
	const unmount = () => {
		if (mounted) app.unmount();
		mounted = false;
		host.remove();
	};
	cleanups.push(unmount);
	return { root, disabled, unmount };
}

async function notify(root: HTMLElement, isIntersecting: boolean, height = 123.5) {
	const observer = observers.find(candidate => candidate.observe.mock.calls.some(([el]) => el === root))!;
	observer.callback([{
		target: root,
		isIntersecting,
		boundingClientRect: new DOMRect(0, 0, 0, height),
		intersectionRatio: isIntersecting ? 1 : 0,
		intersectionRect: new DOMRect(),
		rootBounds: null,
		time: 0,
	}], observer as unknown as IntersectionObserver);
	await nextTick();
	await nextTick();
}

describe('MkOffscreenKeeper', () => {
	test('starts active, parks at the observed height, and restores without measuring layout', async () => {
		const { root } = mountKeeper();
		const measure = vi.spyOn(root, 'getBoundingClientRect');
		const offsetHeight = vi.spyOn(root, 'offsetHeight', 'get');
		expect(root.querySelector('button')).not.toBeNull();
		expect(root.style.height).toBe('');
		await notify(root, false);
		expect(root.style.height).toBe('123.5px');
		expect(root.style.boxSizing).toBe('border-box');
		expect(root.querySelector('button')).toBeNull();
		await notify(root, true);
		expect(root.querySelector('button')).not.toBeNull();
		expect(root.style.height).toBe('');
		expect(measure).not.toHaveBeenCalled();
		expect(offsetHeight).not.toHaveBeenCalled();
	});

	test('retains child state and multiple slot roots through KeepAlive', async () => {
		const child = defineComponent({
			setup() {
				const count = ref(0);
				return () => [h('span', 'date'), h('button', { onClick: () => count.value++ }, String(count.value))];
			},
		});
		const { root } = mountKeeper({ child });
		root.querySelector('button')!.click();
		await nextTick();
		expect(root.textContent).toBe('date1');
		await notify(root, false);
		expect(root.textContent).toBe('');
		await notify(root, true);
		expect(root.textContent).toBe('date1');
	});

	test('does not park a focused item', async () => {
		const { root } = mountKeeper();
		const button = root.querySelector('button')!;
		button.focus();
		await notify(root, false);
		expect(window.document.activeElement).toBe(button);
		expect(root.contains(button)).toBe(true);
		expect(root.style.height).toBe('');
	});

	test('does not park a disabled item', async () => {
		const { root } = mountKeeper({ disabled: true });
		await notify(root, false);
		expect(root.querySelector('button')).not.toBeNull();
		expect(root.style.height).toBe('');
	});

	test('restores an already parked item when disabled becomes true', async () => {
		const { root, disabled } = mountKeeper();
		await notify(root, false);
		disabled.value = true;
		// Flush the parent prop update, activation, and then height removal.
		await nextTick();
		await nextTick();
		await nextTick();
		expect(root.querySelector('button')).not.toBeNull();
		expect(root.style.height).toBe('');
	});

	test('does not park a zero-height item', async () => {
		const { root } = mountKeeper();
		await notify(root, false, 0);
		expect(root.querySelector('button')).not.toBeNull();
		expect(root.style.height).toBe('');
	});

	test('inherits anchor and class on its single focus-container root', async () => {
		const { root } = mountKeeper();
		await notify(root, false);
		expect(root.tagName).toBe('DIV');
		expect(root.dataset.scrollAnchor).toBe('note-id');
		expect(root.classList.contains('note-wrapper')).toBe(true);
		expect(root.hasAttribute('data-focus-container')).toBe(true);
	});

	test.each([false, true])('shares an observer and disposes the final registration (scroll container: %s)', async (scrollable) => {
		const parent = window.document.createElement('div');
		if (scrollable) parent.style.overflowY = 'auto';
		window.document.body.append(parent);
		const keepers = Array.from({ length: 3 }, () => mountKeeper({ parent }));
		expect(observers).toHaveLength(1);
		const observer = observers[0];
		expect(observer.options).toEqual({ root: scrollable ? parent : null, rootMargin: '200% 0px' });
		expect(observer.observe).toHaveBeenCalledTimes(3);
		await notify(keepers[1].root, false);
		expect(keepers[0].root.querySelector('button')).not.toBeNull();
		expect(keepers[1].root.querySelector('button')).toBeNull();
		keepers[0].unmount();
		expect(observer.disconnect).not.toHaveBeenCalled();
		keepers[1].unmount();
		keepers[2].unmount();
		expect(observer.unobserve).toHaveBeenCalledTimes(3);
		expect(observer.disconnect).toHaveBeenCalledTimes(1);
		mountKeeper({ parent });
		expect(observers).toHaveLength(2);
	});

	test('uses separate observers for separate scroll containers', () => {
		for (let i = 0; i < 2; i++) {
			const parent = window.document.createElement('div');
			parent.style.overflowY = 'auto';
			window.document.body.append(parent);
			mountKeeper({ parent });
		}
		expect(observers).toHaveLength(2);
		expect(observers[0].options.root).not.toBe(observers[1].options.root);
	});
});
