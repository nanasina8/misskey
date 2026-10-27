/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { IEndpointMeta } from './endpoints.js';

/** Tuning-only writes have their own budget; mixed profile edits retain the profile limit. */
export function resolveHanamiTuningUpdateLimit(name: string, data: Record<string, unknown>, fallback: IEndpointMeta['limit']): IEndpointMeta['limit'] {
	const keys = Object.keys(data);
	if (name === 'i/update' && keys.length > 0 && keys.every(key => key === 'hanamiTuning' || key === 'hanamiReduceEphemeralPosts')) {
		return { key: 'i/update:hanami-tuning', duration: 60_000, max: 10 };
	}
	return fallback;
}
