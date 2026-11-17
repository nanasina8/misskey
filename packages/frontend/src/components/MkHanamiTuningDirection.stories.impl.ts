/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import { ref } from 'vue';
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningDirection from './MkHanamiTuningDirection.vue';

export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningDirection },
			setup() {
				const value = ref(args.modelValue);
				return { args, value };
			},
			template: '<div style="width: 360px; max-width: 100%"><MkHanamiTuningDirection v-bind="args" v-model="value"/></div>',
		};
	},
	args: { modelValue: 1, previews: [{ close: 79, buzz: 12, fresh: 9 }, { close: 66, buzz: 23, fresh: 11 }, { close: 50, buzz: 30, fresh: 20 }] },
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningDirection>;

export const Compact = {
	...Default,
	args: { ...Default.args, modelValue: 0, compact: true },
} satisfies StoryObj<typeof MkHanamiTuningDirection>;
