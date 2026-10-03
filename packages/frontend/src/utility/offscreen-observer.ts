/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getScrollContainer } from '@@/js/scroll.js';

export const OFFSCREEN_KEEPER_ENABLED = true;

type Callback = (entry: IntersectionObserverEntry) => void;
type ObserverGroup = {
	observer: IntersectionObserver;
	callbacks: Map<Element, Callback>;
};

const observers = new Map<HTMLElement | null, ObserverGroup>();
const registrations = new Map<HTMLElement, HTMLElement | null>();

export function register(el: HTMLElement, callback: Callback): void {
	unregister(el);
	if (!OFFSCREEN_KEEPER_ENABLED) return;

	const root = getScrollContainer(el);
	let group = observers.get(root);
	if (!group) {
		const callbacks = new Map<Element, Callback>();
		const observer = new IntersectionObserver(entries => {
			for (const entry of entries) {
				callbacks.get(entry.target)?.(entry);
			}
		}, { root, rootMargin: '200% 0px' });
		group = { observer, callbacks };
		observers.set(root, group);
	}
	group.callbacks.set(el, callback);
	registrations.set(el, root);
	group.observer.observe(el);
}

export function unregister(el: HTMLElement): void {
	const root = registrations.get(el);
	if (root === undefined) return;
	const group = observers.get(root)!;
	group.observer.unobserve(el);
	group.callbacks.delete(el);
	registrations.delete(el);
	if (group.callbacks.size === 0) {
		group.observer.disconnect();
		observers.delete(root);
	}
}
