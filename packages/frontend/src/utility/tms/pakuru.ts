/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taiyme 由来: 「パクる」（既存ノートを自分の投稿として複製）
import * as Misskey from 'misskey-js';
import { misskeyApi } from '@/utility/misskey-api.js';
import type { NoteEntityOrId } from '@/utility/tms/to-parameters.js';
import { toParameters } from '@/utility/tms/to-parameters.js';

export const pakuru = async (noteEntityOrId: NoteEntityOrId, fromId?: string | null): Promise<Misskey.Endpoints['notes/create']['res']> => {
	const { parameters, me } = await toParameters(noteEntityOrId, fromId);
	return misskeyApi('notes/create', parameters, me.token);
};
