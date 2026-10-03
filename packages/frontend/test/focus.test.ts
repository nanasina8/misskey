/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { focusNext, focusPrev } from '@/utility/focus.js';

afterEach(() => {
	window.document.body.replaceChildren();
});

function setup(html: string) {
	window.document.body.innerHTML = html;
	return (id: string) => window.document.getElementById(id)!;
}

describe('focus containers', () => {
	test('moves between wrapped notes in both directions, skipping empty keepers and separators', () => {
		const el = setup(`
			<div data-focus-container><button id="a">a</button><div>ad</div></div>
			<div data-focus-container></div>
			<div data-focus-container><div>date</div><button id="b">b</button></div>
		`);
		focusNext(el('a'), false, false);
		expect(window.document.activeElement).toBe(el('b'));
		focusPrev(el('b'), false, false);
		expect(window.document.activeElement).toBe(el('a'));
	});

	test('selects the first or last focusable child according to direction', () => {
		const el = setup(`
			<button id="before"></button>
			<div data-focus-container><div></div><button id="first"></button><button id="last"></button><div></div></div>
			<button id="after"></button>
		`);
		focusNext(el('before'), false, false);
		expect(window.document.activeElement).toBe(el('first'));
		focusPrev(el('after'), false, false);
		expect(window.document.activeElement).toBe(el('last'));
	});

	test('traverses nested opt-in containers', () => {
		const el = setup(`
			<div data-focus-container><div data-focus-container><button id="a"></button></div></div>
			<div data-focus-container><div data-focus-container><button id="b"></button></div></div>
		`);
		focusNext(el('a'), false, false);
		expect(window.document.activeElement).toBe(el('b'));
		focusPrev(el('b'), false, false);
		expect(window.document.activeElement).toBe(el('a'));
	});

	test('focuses a focusable container itself before considering children', () => {
		const el = setup('<button id="a"></button><div id="box" tabindex="0" data-focus-container><button></button></div>');
		focusNext(el('a'), false, false);
		expect(window.document.activeElement).toBe(el('box'));
	});

	test('preserves sibling traversal and self without opt-in', () => {
		const el = setup('<button id="a"></button><div><button id="nested"></button></div><button disabled></button><button id="b"></button>');
		focusNext(el('a'), false, false);
		expect(window.document.activeElement).toBe(el('b'));
		focusPrev(el('b'), false, false);
		expect(window.document.activeElement).toBe(el('a'));
		focusNext(el('b'), true, false);
		expect(window.document.activeElement).toBe(el('b'));
		focusPrev(el('a'), true, false);
		expect(window.document.activeElement).toBe(el('a'));
	});

	test('does not escape an ordinary parent without opt-in', () => {
		const el = setup('<button></button><div><button id="inside"></button></div><button></button>');
		el('inside').focus();
		focusNext(el('inside'), false, false);
		expect(window.document.activeElement).toBe(el('inside'));
		focusPrev(el('inside'), false, false);
		expect(window.document.activeElement).toBe(el('inside'));
	});
});
