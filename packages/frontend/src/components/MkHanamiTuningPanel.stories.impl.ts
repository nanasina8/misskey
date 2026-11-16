/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable import/no-default-export */
import type { StoryObj } from '@storybook/vue3';
import MkHanamiTuningPanel from './MkHanamiTuningPanel.vue';
import { useHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { primeHanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import type { HanamiTuningSuggestion } from '@/utility/hanami-tuning-suggestion.js';
import { HANAMI_FOR_YOU_AXES, resetHanamiTuning } from '@/utility/hanami-tuning.js';
import type { HanamiTuning } from '@/utility/hanami-tuning.js';

/** 身近な人からの反応が多く、人気への反応が少ない人の例。 */
export const sampleHanamiTuningSuggestion: HanamiTuningSuggestion = {
	eligible: true, minSeen: 200, minReactions: 10, totalSeen: 640, totalReactions: 52,
	axes: HANAMI_FOR_YOU_AXES.map(axis => {
		const seen = { globalPopular: 150, neighborTrending: 240, reactionSimilar: 30, catchup: 90, trending: 30, fof: 60, exploration: 40 }[axis];
		const reactions = { globalPopular: 6, neighborTrending: 26, reactionSimilar: 2, catchup: 9, trending: 1, fof: 5, exploration: 3 }[axis];
		const factor = { globalPopular: 0.62, neighborTrending: 1.21, reactionSimilar: 0.86, catchup: 1.17, trending: 0.6, fof: 1.06, exploration: 1 }[axis];
		return { axis, seen, reactions, rate: reactions / seen, factor, current: 1, suggested: factor };
	}),
	groups: { close: 3, buzz: 1, fresh: 2 },
};

export function setHanamiStoryTuning(patch: Partial<HanamiTuning>, suggestion: HanamiTuningSuggestion | null = sampleHanamiTuningSuggestion): void {
	const { state } = useHanamiTuning();
	const base = resetHanamiTuning();
	state.value = { ...base, hanamiTuning: { ...base.hanamiTuning, ...patch } };
	if (suggestion) primeHanamiTuningSuggestion(suggestion);
}

function story(patch: Partial<HanamiTuning>, args: { disabled?: boolean } = {}, suggestion: HanamiTuningSuggestion | null = sampleHanamiTuningSuggestion) {
	return {
		render(storyArgs) {
			return {
				components: { MkHanamiTuningPanel },
				setup() {
					setHanamiStoryTuning(patch, suggestion);
					return { args: storyArgs };
				},
				template: '<div style="width: 420px; max-width: 100%"><MkHanamiTuningPanel v-bind="args"/></div>',
			};
		},
		args,
		parameters: { layout: 'centered' },
	} satisfies StoryObj<typeof MkHanamiTuningPanel>;
}

export const Default = story({ mode: 'auto' });
export const Direction = story({ mode: 'direction', direction: 0, drift: 2 });
export const Recommend = story({ mode: 'recommend', groups: { close: 3, buzz: 1, fresh: 2 } });
export const Manual = story({ mode: 'manual', manual: { amounts: { neighborTrending: 1.5, catchup: 1.25, fof: 1.5, globalPopular: 0.75, trending: 0.5, exploration: 1, reactionSimilar: 0.5 }, authorCap: 2 } });
const fewAxes = sampleHanamiTuningSuggestion.axes.map(axis => ({ ...axis, seen: Math.round(axis.seen / 16), reactions: axis.axis === 'neighborTrending' ? 2 : 0 }));
export const FewReactions = story({ mode: 'auto' }, {}, {
	...sampleHanamiTuningSuggestion, eligible: false, axes: fewAxes,
	totalSeen: fewAxes.reduce((sum, axis) => sum + axis.seen, 0), totalReactions: 2,
});
export const Disabled = story({ mode: 'auto' }, { disabled: true });
