/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import { ref } from 'vue';
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningModes from './MkHanamiTuningModes.vue';

export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningModes },
			setup() {
				const value = ref(args.modelValue);
				return { args, value };
			},
			template: '<div style="width: 360px; max-width: 100%"><MkHanamiTuningModes v-bind="args" v-model="value"/></div>',
		};
	},
	args: { modelValue: 'direction' },
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningModes>;

export const Compact = {
	...Default,
	args: { modelValue: 'auto', compact: true },
} satisfies StoryObj<typeof MkHanamiTuningModes>;
