/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taiyme 由来: 既存ノートから notes/create のパラメータを再構成する（パクる/数字引用 用）
import { toASCII } from 'punycode.js';
import * as Misskey from 'misskey-js';
import * as mfm from 'mfm-js';
import { $i } from '@/i.js';
import { unique } from '@/utility/array.js';
import { deepClone } from '@/utility/clone.js';
import { getAccountFromId } from '@/utility/get-account-from-id.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { TmsError } from '@/utility/tms/error.js';
import { getAppearNote } from '@/utility/get-appear-note.js';

const errors = {
	meIdIsRequired: {
		message: 'meId is required.',
		code: 'MEID_IS_REQUIRED',
		id: '6024ed6b-9ab0-4905-8cac-36f5c75aea59',
		kind: 'toParameters',
	},
	tokenIsRequired: {
		message: 'token is required.',
		code: 'TOKEN_IS_REQUIRED',
		id: '34825d40-8c57-43b8-ac75-04a7bb9bd56d',
		kind: 'toParameters',
	},
	noSuchNote: {
		message: 'No such note.',
		code: 'NO_SUCH_NOTE',
		id: 'c756e6b2-b56c-45b6-8978-7d178fb3862e',
		kind: 'toParameters',
	},
} as const;

export type NoteEntity = Misskey.entities.Note;
export type NoteEntityOrId = NoteEntity | string;
export type NoteParameters = Misskey.Endpoints['notes/create']['req'];

export type MeEntity = {
	readonly meId: string;
	readonly token: string;
};

export const toParameters = async (noteEntityOrId: NoteEntityOrId, fromId?: string | null): Promise<{
	readonly parameters: NoteParameters;
	readonly me: MeEntity;
}> => {
	const me = await toMeEntity(fromId);
	const note = await toNoteEntity(noteEntityOrId, me);

	const text = makeText(note);
	const cw = makeCw(note);
	const fileIds = makeFileIds(note, me);
	const visibleUserIds = makeVisibleUserIds(note, me);
	const poll = makePoll(note);
	const { visibility, localOnly, replyId, renoteId, channelId, reactionAcceptance } = note;

	const parameters: NoteParameters = { text, cw, fileIds, visibleUserIds, poll, visibility, localOnly, replyId, renoteId, channelId, reactionAcceptance };

	const cleanup = parameters as Record<string, unknown>;
	for (const k of Object.keys(cleanup)) {
		const v = cleanup[k];
		if (v == null || (Array.isArray(v) && v.length === 0)) {
			delete cleanup[k];
		}
	}

	return { parameters, me } as const;
};

const toMeEntity = async (fromId?: string | null): Promise<MeEntity> => {
	const meId = fromId ?? $i?.id ?? null;
	if (meId == null) {
		throw new TmsError(errors.meIdIsRequired);
	}

	const token = await getAccountToken(meId);
	if (token == null) {
		throw new TmsError(errors.tokenIsRequired);
	}

	return { meId, token } as const satisfies MeEntity;
};

const getAccountToken = async (meId: MeEntity['meId']): Promise<MeEntity['token'] | null> => {
	if ($i?.token != null && $i.id === meId) {
		return $i.token;
	}
	return getAccountFromId(meId).then(x => x?.token ?? null);
};

const toNoteEntity = async (noteEntityOrId: NoteEntityOrId, { token }: MeEntity): Promise<NoteEntity> => {
	if (typeof noteEntityOrId === 'string') {
		const fetchedNote = await misskeyApi('notes/show', { noteId: noteEntityOrId }, token).catch(() => null);
		if (fetchedNote == null) {
			throw new TmsError(errors.noSuchNote);
		}
		const appearNote = getAppearNote(fetchedNote);
		if (appearNote == null) {
			throw new TmsError(errors.noSuchNote);
		}
		return appearNote;
	}
	const appearNote = getAppearNote(noteEntityOrId);
	if (appearNote == null) {
		throw new TmsError(errors.noSuchNote);
	}
	return deepClone(appearNote);
};

const adjustRemoteMentions = (str: string, host: string): string => {
	const ast = mfm.parse(str);
	const fixMentionNode = (node: mfm.MfmNode): void => {
		if (node.type === 'mention') {
			if (node.props.host == null) {
				node.props.host = toASCII(host);
				node.props.acct = `@${node.props.username}@${node.props.host}`;
			}
		}
		if (node.children) {
			for (const child of node.children) {
				fixMentionNode(child);
			}
		}
	};
	for (const node of ast) {
		fixMentionNode(node);
	}
	return mfm.toString(ast);
};

const makeText = ({ text, user: { host } }: NoteEntity): NoteParameters['text'] => {
	if (text == null || text === '') return text;
	if (host == null) return text;
	return adjustRemoteMentions(text, host);
};

const makeCw = ({ cw, user: { host } }: NoteEntity): NoteParameters['cw'] => {
	if (cw == null) return cw;
	if (cw === '') return '​';
	if (host == null) return cw;
	return adjustRemoteMentions(cw, host);
};

const makeFileIds = ({ files, fileIds, userId }: NoteEntity, { meId }: MeEntity): NoteParameters['fileIds'] => {
	if (files == null || files.length === 0) return undefined;
	if (fileIds == null || fileIds.length === 0) return undefined;
	// 自分のファイルのみ再利用可能。
	// 他ユーザーのファイルは notes/create が受け付けず、現行の drive/files/upload-from-url も
	// 非同期化（戻り値なし）で同期的な再ホストができないため除外する。
	if (userId === meId) return fileIds;
	return undefined;
};

const makeVisibleUserIds = ({ visibility, visibleUserIds, userId }: NoteEntity, { meId }: MeEntity): NoteParameters['visibleUserIds'] => {
	if (visibility !== 'specified') return undefined;
	const uniqueUserIds = unique([...visibleUserIds ?? [], userId, meId]);
	if (uniqueUserIds.length === 0) return undefined;
	return uniqueUserIds;
};

const makePoll = ({ poll, createdAt }: NoteEntity): NoteParameters['poll'] => {
	if (poll == null) return null;
	const choices = poll.choices.map(choice => choice.text);
	const multiple = poll.multiple;
	const expiresAt = null;
	let expiredAfter: number | null = null;
	if (poll.expiresAt) {
		expiredAfter = (Date.parse(poll.expiresAt) - Date.parse(createdAt)) || 1000 * 60;
	}
	return { choices, multiple, expiresAt, expiredAfter };
};
