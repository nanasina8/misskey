/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningPopup from './MkHanamiTuningPopup.vue';
export const Default = {
	render: args => ({ components: { MkHanamiTuningPopup }, setup: () => ({ args }), template: '<div style="width: 320px; max-width: 100%"><MkHanamiTuningPopup v-bind="args"/></div>' }),
	args: {},
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningPopup>;
