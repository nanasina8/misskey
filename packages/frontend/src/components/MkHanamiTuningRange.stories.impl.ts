/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningRange from './MkHanamiTuningRange.vue';
export const Default = {
	render: args => ({ components: { MkHanamiTuningRange }, setup: () => ({ args }), template: '<div style="width: 320px; max-width: 100%"><MkHanamiTuningRange v-bind="args"/></div>' }),
	args: { modelValue: 2, max: 4, label: '身近 ⇄ 広く', valueText: 'ふつう' },
	parameters: { layout: 'centered' },
} satisfies StoryObj<typeof MkHanamiTuningRange>;
