/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import { ref } from 'vue';
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningGroupSliders from './MkHanamiTuningGroupSliders.vue';

export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningGroupSliders },
			setup() {
				const value = ref(args.modelValue);
				return { args, value };
			},
			template: '<div style="width: 360px; max-width: 100%"><MkHanamiTuningGroupSliders v-bind="args" v-model="value"/></div>',
		};
	},
	args: { modelValue: { close: 3, buzz: 1, fresh: 2 }, recommended: { close: 3, buzz: 1, fresh: 2 } },
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningGroupSliders>;

export const Compact = {
	...Default,
	args: { modelValue: { close: 2, buzz: 2, fresh: 2 }, compact: true },
} satisfies StoryObj<typeof MkHanamiTuningGroupSliders>;
