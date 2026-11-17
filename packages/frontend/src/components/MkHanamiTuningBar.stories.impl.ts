/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningBar from './MkHanamiTuningBar.vue';

export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningBar },
			setup() {
				return { args };
			},
			template: '<div style="width: 360px; max-width: 100%"><MkHanamiTuningBar v-bind="args"/></div>',
		};
	},
	args: {
		counts: { close: 7, buzz: 2, fresh: 1 },
		shares: { close: 72, buzz: 18, fresh: 10 },
		range: { base: 66, low: 45, high: 84, now: 72 },
		rangeText: '身近な人からは 45〜84% の間で、反応に合わせて動きます。選んだ方向は 66%、いまは 72% です。',
	},
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningBar>;

/** 自動で動かないしかた。動ける幅は出ない。 */
export const Fixed = {
	...Default,
	args: { counts: { close: 5, buzz: 3, fresh: 2 }, note: '自動では変わりません。' },
} satisfies StoryObj<typeof MkHanamiTuningBar>;

export const Compact = {
	...Default,
	args: { counts: { close: 5, buzz: 3, fresh: 2 }, compact: true },
} satisfies StoryObj<typeof MkHanamiTuningBar>;

/** すべて 0% にしたとき。枠だけ残る。 */
export const Empty = {
	...Default,
	args: { counts: { close: 0, buzz: 0, fresh: 0 }, note: '自動では変わりません。' },
} satisfies StoryObj<typeof MkHanamiTuningBar>;
