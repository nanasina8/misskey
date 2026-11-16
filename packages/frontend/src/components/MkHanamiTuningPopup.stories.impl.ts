/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningPopup from './MkHanamiTuningPopup.vue';
import { setHanamiStoryTuning } from './MkHanamiTuningPanel.stories.impl.js';

export const Default = {
	render(args) {
		return {
			components: { MkHanamiTuningPopup },
			setup() {
				setHanamiStoryTuning({ mode: 'auto' });
				return { args };
			},
			template: '<MkHanamiTuningPopup v-bind="args"/>',
		};
	},
	args: {},
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningPopup>;
