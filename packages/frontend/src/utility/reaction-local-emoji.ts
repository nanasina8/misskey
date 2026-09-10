/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';

export type ReactionLocalEmojis = NonNullable<Misskey.entities.Note['reactionLocalEmojis']>;

/**
 * リアクション文字列がリモートのカスタム絵文字 (`:name@example.com:`) ならその name / host を返す。
 * ローカルのカスタム絵文字は `:name@.:` の形で流れてくるので、リモート扱いしてはならない。
 */
export function parseRemoteCustomEmojiReaction(reaction: string): { name: string; host: string } | null {
	const matched = reaction.match(/^:([^:@]+)@([^:]+):$/);
	if (matched == null) return null;

	const [, name, host] = matched;
	if (host === '.') return null;

	return { name, host };
}

/**
 * リモートのカスタム絵文字リアクションに対して、画像が同一なローカル絵文字のリアクション文字列 (`:localName@.:`) を返す。
 * リモートのカスタム絵文字でない場合や、対応するローカル絵文字がない場合は null。
 */
export function getLocalEmojiReactionFor(reaction: string, reactionLocalEmojis: ReactionLocalEmojis): string | null {
	const remote = parseRemoteCustomEmojiReaction(reaction);
	if (remote == null) return null;

	const localName = reactionLocalEmojis[`${remote.name}@${remote.host}`];
	return localName != null ? `:${localName}@.:` : null;
}
