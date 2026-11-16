/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningRange from './MkHanamiTuningRange.vue';

/** 「すべて自分で」の種類ごとの量（0〜300%）。 */
export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningRange },
			setup() {
				return { args };
			},
			template: '<div style="width: 320px; max-width: 100%"><MkHanamiTuningRange v-bind="args"/></div>',
		};
	},
	args: { modelValue: 1, max: 3, step: 0.05, label: '近くで話題', valueText: '100%' },
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningRange>;

/** 「おすすめから調整」のまとまりの量（5 段階、色見本つき）。 */
export const Levels = {
	...Default,
	args: { modelValue: 3, max: 4, showTicks: true, swatch: 'var(--MI-hanamiGroupClose)', label: '身近な人から', valueText: '多め' },
} satisfies StoryObj<typeof MkHanamiTuningRange>;

export const Disabled = {
	...Default,
	args: { ...Default.args, disabled: true },
} satisfies StoryObj<typeof MkHanamiTuningRange>;
