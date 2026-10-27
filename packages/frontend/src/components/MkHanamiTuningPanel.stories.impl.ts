/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningPanel from './MkHanamiTuningPanel.vue';
export const Default = {
	render: args => ({ components: { MkHanamiTuningPanel }, setup: () => ({ args }), template: '<div style="width: 320px; max-width: 100%"><MkHanamiTuningPanel v-bind="args"/></div>' }),
	args: {},
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningPanel>;

export const Embedded = {
	...Default,
	args: { showTitle: false },
} satisfies StoryObj<typeof MkHanamiTuningPanel>;

export const Disabled = {
	...Default,
	args: { showTitle: false, disabled: true },
} satisfies StoryObj<typeof MkHanamiTuningPanel>;
