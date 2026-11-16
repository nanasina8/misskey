/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import locales from 'i18n';
import type * as Misskey from 'misskey-js';
import { i18n, updateI18n } from '@/i18n.js';
import { showHanamiReasonMenuForNote } from '@/utility/hanami-tuning-reason.js';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { clearHanamiTuningSuggestion, primeHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import { HANAMI_FOR_YOU_AXES, resetHanamiTuning } from '@/utility/hanami-tuning.js';
import type { HanamiTuning, HanamiTuningUpdate } from '@/utility/hanami-tuning.js';
import type { MenuItem } from '@/types/menu.js';

const save = vi.hoisted(() => vi.fn());
const popupMenu = vi.hoisted(() => vi.fn());
const popup = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
vi.mock('@/i.js', () => ({ $i: { id: 'me', hanamiShowRecommendationReason: true } }));
vi.mock('@/os.js', () => ({ popupMenu, popup, apiWithDialog: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/utility/get-user-menu.js', () => ({ getUserMenu: vi.fn() }));
vi.mock('@/utility/hanami-tuning-client.js', async () => {
	const { shallowRef } = await import('vue');
	const { resetHanamiTuning } = await import('@/utility/hanami-tuning.js');
	const state = shallowRef(resetHanamiTuning());
	return {
		useHanamiTuning: () => ({ state, config: {}, update: (patch: HanamiTuningUpdate) => { state.value = patch; save(patch); } }),
		refreshHanamiTuning: vi.fn(),
	};
});

const note = { id: 'n1', userId: 'someone' } as Misskey.entities.Note;

function openMenu(): MenuItem[] {
	showHanamiReasonMenuForNote(note, { reason: 'trending' }, document.createElement('button'));
	return popupMenu.mock.lastCall![0] as MenuItem[];
}

function clickItem(items: MenuItem[], text: string): void {
	const item = items.find(entry => entry && typeof entry === 'object' && 'text' in entry && entry.text === text);
	if (item && typeof item === 'object' && 'action' in item && typeof item.action === 'function') void item.action(new PointerEvent('click'));
	else throw new Error(`menu item not found: ${text}`);
}

beforeEach(() => {
	updateI18n(locales['ja-JP']);
	save.mockReset();
	popupMenu.mockReset();
	popup.mockClear();
	clearHanamiTuningSuggestion();
	useHanamiTuning().state.value = resetHanamiTuning();
});
afterEach(() => updateI18n(locales['en-US']));

describe('はなみTL の理由ラベルからの増減', () => {
	test.each(['auto', 'direction', 'recommend'] as const)('%s から増やすと「すべて自分で」に切り替わり、その旨を知らせる', mode => {
		const { state } = useHanamiTuning();
		state.value = { ...resetHanamiTuning(), hanamiTuning: { ...resetHanamiTuning().hanamiTuning, mode } };
		const t = i18n.ts._hana._tuning;
		clickItem(openMenu(), i18n.tsx._hana._tuning.increase({ axis: t._axis.trending }));
		const next: HanamiTuning = save.mock.lastCall![0].hanamiTuning;
		expect(next.mode).toBe('manual');
		expect(Object.keys(next.manual!.amounts).sort()).toEqual([...HANAMI_FOR_YOU_AXES].sort());
		const message = (popup.mock.lastCall as unknown as [unknown, { message: string }])[1].message;
		expect(message).toBe(i18n.tsx._hana._tuning.switchedAndAdjusted({ axis: t._axis.trending, amount: Math.round(next.manual!.amounts.trending! * 100) }));
		expect(message.startsWith('「すべて自分で」に切り替えて')).toBe(true);
	});

	test('「すべて自分で」のままなら量だけ変えて、取り消せる', () => {
		const { state } = useHanamiTuning();
		const manual: HanamiTuning = { ...resetHanamiTuning().hanamiTuning, mode: 'manual', manual: { amounts: { trending: 1 }, authorCap: 2 } };
		state.value = { ...resetHanamiTuning(), hanamiTuning: manual };
		const t = i18n.ts._hana._tuning;
		clickItem(openMenu(), i18n.tsx._hana._tuning.decrease({ axis: t._axis.trending }));
		expect(save.mock.lastCall![0].hanamiTuning.manual.amounts.trending).toBe(0.75);
		const [, props, handlers] = popup.mock.lastCall as unknown as [unknown, { message: string }, { action: () => void }];
		expect(props.message).toBe(i18n.tsx._hana._tuning.adjusted({ axis: t._axis.trending, amount: 75 }));
		handlers.action();
		expect(save.mock.lastCall![0].hanamiTuning).toEqual(manual);
	});

	test('反応からの倍率を読み込み済みなら、寄せたあとの量から増やす', () => {
		primeHanamiTuningSuggestion({
			eligible: true, minSeen: 200, minReactions: 10, totalSeen: 0, totalReactions: 0, groups: { close: 2, buzz: 2, fresh: 2 },
			axes: HANAMI_FOR_YOU_AXES.map(axis => ({ axis, seen: 0, reactions: 0, rate: 0, factor: axis === 'trending' ? 0.5 : 1, current: 1, suggested: 1 })),
		});
		clickItem(openMenu(), i18n.tsx._hana._tuning.increase({ axis: i18n.ts._hana._tuning._axis.trending }));
		// おまかせ（寄せ方ふつう）の下限 0.7 まで下がった量に +25%。
		expect(save.mock.lastCall![0].hanamiTuning.manual.amounts.trending).toBe(0.95);
	});
});
