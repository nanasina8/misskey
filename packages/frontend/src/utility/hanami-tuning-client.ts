/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineAsyncComponent, shallowRef } from 'vue';
import { $i } from '@/i.js';
import { instance } from '@/instance.js';
import { updateCurrentAccount } from '@/accounts.js';
import { globalEvents } from '@/events.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { generateHanamiRefreshToken } from '@/utility/hanami-timeline-paginator.js';
import { normalizeHanamiTuning, HanamiTuningSaveQueue } from '@/utility/hanami-tuning.js';
import type { HanamiTuningUpdate } from '@/utility/hanami-tuning.js';
import * as os from '@/os.js';

const state = shallowRef<HanamiTuningUpdate | null>(null);
let accountId: string | undefined;

export function refreshHanamiTuning(): void {
	const token = generateHanamiRefreshToken();
	if (globalEvents.listenerCount('hanamiTuningChanged') > 0) globalEvents.emit('hanamiTuningChanged', token);
	else void misskeyApi('notes/hanami-timeline', { refresh: true, refreshToken: token, reason: 'tuning', limit: 15 }).catch(showError);
}

function showError(error: unknown): void {
	void os.alert({ type: 'error', text: error instanceof Error ? error.message : String(error) });
}

const queue = new HanamiTuningSaveQueue(async patch => {
	await misskeyApi('i/update', patch);
	updateCurrentAccount(patch);
}, refreshHanamiTuning, showError);

export function useHanamiTuning() {
	if (state.value == null || accountId !== $i?.id) {
		accountId = $i?.id;
		state.value = { hanamiTuning: normalizeHanamiTuning($i ?? {}, instance.hanamiRecommendationAxisConfig ?? {}), hanamiReduceEphemeralPosts: $i?.hanamiReduceEphemeralPosts ?? true };
	}
	return {
		state,
		config: instance.hanamiRecommendationAxisConfig ?? {},
		update: (patch: HanamiTuningUpdate): void => { state.value = patch; queue.enqueue(patch); },
	};
}

export function openHanamiTuning(anchorElement?: HTMLElement | null): void {
	const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkHanamiTuningPopup.vue')), { anchorElement }, { closed: () => dispose() });
}
