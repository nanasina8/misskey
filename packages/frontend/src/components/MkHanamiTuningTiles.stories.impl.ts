/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningTiles from './MkHanamiTuningTiles.vue';

export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningTiles },
			setup() {
				return { args };
			},
			template: '<div style="width: 360px; max-width: 100%"><MkHanamiTuningTiles v-bind="args"/></div>',
		};
	},
	args: { counts: { close: 7, buzz: 2, fresh: 1 }, note: '反応に合わせて、身近な人からが増えています。' },
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningTiles>;

export const Compact = {
	...Default,
	args: { counts: { close: 5, buzz: 3, fresh: 2 }, compact: true },
} satisfies StoryObj<typeof MkHanamiTuningTiles>;

/** すべて 0% にしたとき。枠だけ残る。 */
export const Empty = {
	...Default,
	args: { counts: { close: 0, buzz: 0, fresh: 0 }, note: '自動では変わりません。' },
} satisfies StoryObj<typeof MkHanamiTuningTiles>;
