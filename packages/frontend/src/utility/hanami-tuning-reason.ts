/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineAsyncComponent } from 'vue';
import type * as Misskey from 'misskey-js';
import { HANAMI_FOR_YOU_AXES, adjustHanamiAmount, createHanamiTuningUndo } from '@/utility/hanami-tuning.js';
import type { HanamiAxis } from '@/utility/hanami-tuning.js';
import { useHanamiTuning, refreshHanamiTuning } from '@/utility/hanami-tuning-client.js';
import { getUserMenu } from '@/utility/get-user-menu.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { $i } from '@/i.js';
import * as os from '@/os.js';
import type { MenuItem } from '@/types/menu.js';

export function showHanamiReasonMenuForNote(note: Misskey.entities.Note, reason: { reason: string; clusterId?: number }, anchor: HTMLElement): void {
	if (!$i || $i.hanamiShowRecommendationReason === false) return;
	const axis = (reason.reason === 'popular' ? 'globalPopular' : reason.reason) as HanamiAxis;
	if (!HANAMI_FOR_YOU_AXES.includes(axis)) return;
	const client = useHanamiTuning();
	const labels = i18n.ts._hana._tuning._axis;
	const t = i18n.ts._hana._tuning;
	const descriptions = { globalPopular: t.reasonGlobalPopular, neighborTrending: t.reasonNeighborTrending, reactionSimilar: t.reasonReactionSimilar, trending: t.reasonTrending, catchup: t.reasonCatchup, fof: t.reasonFof, exploration: t.reasonExploration };

	function adjust(delta: number): void {
		const previous = client.state.value!.hanamiTuning;
		const next = adjustHanamiAmount(previous, axis, delta, client.config);
		client.update({ ...client.state.value!, hanamiTuning: next });
		const undo = createHanamiTuningUndo(previous, restored => client.update({ ...client.state.value!, hanamiTuning: restored }));
		const params = { axis: labels[axis], amount: Math.round((next.manual!.amounts[axis] ?? 1) * 100) };
		const message = previous.mode === 'auto' ? i18n.tsx._hana._tuning.switchedAndAdjusted(params) : i18n.tsx._hana._tuning.adjusted(params);
		const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkToast.vue')), { message, actionLabel: t.undo, duration: 8000 }, {
			action: () => { if (client.state.value!.hanamiTuning === next) undo(); }, closed: () => dispose(),
		});
	}

	const items: MenuItem[] = [
		{ type: 'label', text: descriptions[axis] },
		{ text: i18n.tsx._hana._tuning.increase({ axis: labels[axis] }), icon: 'ti ti-plus', action: () => adjust(0.25) },
		{ text: i18n.tsx._hana._tuning.decrease({ axis: labels[axis] }), icon: 'ti ti-minus', action: () => adjust(-0.25) },
	];
	if (reason.clusterId != null) items.push({ text: t.reduceCluster, icon: 'ti ti-adjustments-down', action: async () => {
		await os.apiWithDialog('i/update-hanami-taste-cluster', { clusterId: reason.clusterId!, weight: 'reduce' });
		refreshHanamiTuning();
	} });
	if (note.userId !== $i.id) items.push({ text: t.muteAuthor, icon: 'ti ti-eye-off', action: async () => {
		const user = await misskeyApi('users/show', { userId: note.userId });
		const menu = getUserMenu(user);
		try {
			const mute = menu.menu.find(item => item && typeof item === 'object' && 'text' in item && item.text === i18n.ts.mute);
			if (mute && typeof mute === 'object' && 'action' in mute) await mute.action(new PointerEvent('click'));
		} finally { menu.cleanup(); }
	} });
	void os.popupMenu(items, anchor);
}
