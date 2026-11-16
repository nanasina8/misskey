/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import { action } from 'storybook/actions';
import MkHanamiTuningQuick from './MkHanamiTuningQuick.vue';
import { setHanamiStoryTuning } from './MkHanamiTuningPanel.stories.impl.js';
import type { HanamiTuning } from '@/utility/hanami-tuning.js';

function story(patch: Partial<HanamiTuning>) {
	return {
		render(args) {
			return {
				components: { MkHanamiTuningQuick },
				setup() {
					setHanamiStoryTuning(patch);
					return { args, events: { close: action('close') } };
				},
				template: '<div class="_popup" style="width: 360px; max-width: 100%; padding: 16px; box-sizing: border-box"><MkHanamiTuningQuick v-bind="args" v-on="events"/></div>',
			};
		},
		args: {},
		parameters: { layout: 'centered' },
	} satisfies StoryObj<typeof MkHanamiTuningQuick>;
}

export const Default = story({ mode: 'auto' });
export const Direction = story({ mode: 'direction', direction: 1 });
export const Recommend = story({ mode: 'recommend', groups: { close: 3, buzz: 1, fresh: 2 } });
export const Manual = story({ mode: 'manual' });
