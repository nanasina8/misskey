/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { computed, shallowRef } from 'vue';
import type * as Misskey from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { hanamiDriftFactors } from '@/utility/hanami-tuning.js';

export type HanamiTuningSuggestion = Misskey.entities.IHanamiTuningSuggestionResponse;
export type HanamiTuningSuggestionStatus = 'idle' | 'loading' | 'error' | 'ready';

/** 調整パネルとポップアップで共有する。API は 1 分 10 回までなので、しばらくは読み直さない。 */
const REUSE_MS = 60 * 1000;
const suggestion = shallowRef<HanamiTuningSuggestion | null>(null);
const status = shallowRef<HanamiTuningSuggestionStatus>('idle');
const factors = computed(() => hanamiDriftFactors(suggestion.value?.axes));
let loadedAt = 0;
let inflight: Promise<void> | null = null;

async function load(force = false): Promise<void> {
	if (inflight) return inflight;
	if (!force && status.value === 'ready' && Date.now() - loadedAt < REUSE_MS) return;
	status.value = 'loading';
	inflight = (async () => {
		try {
			suggestion.value = await misskeyApi('i/hanami-tuning-suggestion', {});
			loadedAt = Date.now();
			status.value = 'ready';
		} catch {
			status.value = 'error';
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

export function useHanamiTuningSuggestion() {
	return { suggestion, status, factors, load };
}

/** Storybook・テスト用。読み込んだことにして、しばらくは API を呼ばない。 */
export function primeHanamiTuningSuggestion(value: HanamiTuningSuggestion): void {
	suggestion.value = value;
	status.value = 'ready';
	loadedAt = Date.now();
	inflight = null;
}

/** テスト用。読み込んだ内容を捨てる。 */
export function clearHanamiTuningSuggestion(): void {
	suggestion.value = null;
	status.value = 'idle';
	loadedAt = 0;
	inflight = null;
}
