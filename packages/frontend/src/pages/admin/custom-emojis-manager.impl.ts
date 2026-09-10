/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';

/**
 * 照合状態の表示文字列。導出そのものはバックエンドが持っているので、ここは文言の選択だけ。
 *
 * 理由コードは failed だけでなく pending にも付く。一過性の失敗で再試行待ちになっている場合、
 * 状態は pending のままだがコードが入るため、「未着手」と「失敗して待っている」を区別できる。
 */
export function fingerprintStateLabel(
	emoji: Pick<Misskey.entities.EmojiDetailedAdmin, 'imageFingerprintState' | 'imageFingerprintErrorCode'>,
): string {
	const label = i18n.ts._customEmojisManager._fingerprint[emoji.imageFingerprintState];
	return emoji.imageFingerprintErrorCode != null ? `${label}(${emoji.imageFingerprintErrorCode})` : label;
}

/**
 * 再照合を依頼する。実際の算出はキューで非同期に行われるので、ここでは受け付けた件数だけ返す。
 */
export async function refingerprint(params: Misskey.entities.AdminEmojiRefingerprintRequest): Promise<void> {
	const result = await misskeyApi('admin/emoji/refingerprint', params);
	os.toast(i18n.tsx._customEmojisManager._fingerprint.refingerprintQueued({ count: result.reset }));
}

export type RequestLogItem = {
	failed: boolean;
	url: string;
	name: string;
	error?: string;
};

export const gridSortOrderKeys = [
	'name',
	'category',
	'aliases',
	'type',
	'license',
	'host',
	'uri',
	'publicUrl',
	'isSensitive',
	'localOnly',
	'updatedAt',
] as const satisfies string[];

export type GridSortOrderKey = typeof gridSortOrderKeys[number];

export function emptyStrToUndefined(value: string | null) {
	return value ? value : undefined;
}

export function emptyStrToNull(value: string) {
	return value === '' ? null : value;
}

export function emptyStrToEmptyArray(value: string) {
	return value === '' ? [] : value.split(' ').map(it => it.trim());
}

export function roleIdsParser(text: string): { id: string, name: string }[] {
	// idとnameのペア配列をJSONで受け取る。それ以外の形式は許容しない
	try {
		const obj = JSON.parse(text);
		if (!Array.isArray(obj)) {
			return [];
		}
		if (!obj.every(it => typeof it === 'object' && 'id' in it && 'name' in it)) {
			return [];
		}

		return obj.map(it => ({ id: it.id, name: it.name }));
	} catch (ex) {
		console.warn(ex);
		return [];
	}
}
