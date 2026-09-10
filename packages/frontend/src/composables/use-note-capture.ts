/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onUnmounted, reactive } from 'vue';
import * as Misskey from 'misskey-js';
import { EventEmitter } from 'eventemitter3';
import type { Reactive } from 'vue';
import { useStream } from '@/stream.js';
import { $i } from '@/i.js';
import { store } from '@/store.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { globalEvents } from '@/events.js';

export const noteEvents = new EventEmitter<{
	[ev: `reacted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; }; }) => void;
	[ev: `unreacted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; }; }) => void;
	[ev: `pollVoted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; choice: string; }) => void;
}>();

const fetchEvent = new EventEmitter<{
	[id: string]: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis' | 'reactionLocalEmojis'>;
}>();

const pollingQueue = new Map<string, {
	referenceCount: number;
}>();

function pollingEnqueue(note: Pick<Misskey.entities.Note, 'id'>) {
	if (pollingQueue.has(note.id)) {
		const data = pollingQueue.get(note.id)!;
		pollingQueue.set(note.id, {
			...data,
			referenceCount: data.referenceCount + 1,
		});
	} else {
		pollingQueue.set(note.id, {
			referenceCount: 1,
		});
	}
}

function pollingDequeue(note: Pick<Misskey.entities.Note, 'id'>) {
	const data = pollingQueue.get(note.id);
	if (data == null) return;

	if (data.referenceCount === 1) {
		pollingQueue.delete(note.id);
	} else {
		pollingQueue.set(note.id, {
			...data,
			referenceCount: data.referenceCount - 1,
		});
	}
}

const CAPTURE_MAX = 30;
const MIN_POLLING_INTERVAL = 1000 * 10;
const POLLING_INTERVAL =
	prefer.s.pollingInterval === 1 ? MIN_POLLING_INTERVAL * 1.5 * 1.5 :
	prefer.s.pollingInterval === 2 ? MIN_POLLING_INTERVAL * 1.5 :
	prefer.s.pollingInterval === 3 ? MIN_POLLING_INTERVAL :
	MIN_POLLING_INTERVAL;

window.setInterval(() => {
	const ids = [...pollingQueue.keys()]
		.sort((a, b) => (a > b ? -1 : 1)) // 新しいものを優先するためにIDで降順ソート
		.slice(0, CAPTURE_MAX);

	if (ids.length === 0) return;
	if (window.document.hidden) return;

	// まとめてリクエストするのではなく、個別にHTTPリクエスト投げてCDNにキャッシュさせた方がサーバーの負荷低減には良いかもしれない？
	misskeyApi('notes/show-partial-bulk', {
		noteIds: ids,
	}).then((items) => {
		for (const item of items) {
			fetchEvent.emit(item.id, {
				reactions: item.reactions,
				reactionEmojis: item.reactionEmojis,
				reactionLocalEmojis: item.reactionLocalEmojis ?? {},
			});
		}
	});
}, POLLING_INTERVAL);

function pollingSubscribe(props: {
	note: Pick<Misskey.entities.Note, 'id'>;
	$note: ReactiveNoteData;
}): () => void {
	const { note, $note } = props;

	function onFetched(data: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis' | 'reactionLocalEmojis'>): void {
		$note.reactions = data.reactions;
		$note.reactionCount = Object.values(data.reactions).reduce((a, b) => a + b, 0);
		$note.reactionEmojis = data.reactionEmojis;
		$note.reactionLocalEmojis = data.reactionLocalEmojis ?? {};
	}

	pollingEnqueue(note);
	fetchEvent.on(note.id, onFetched);

	return () => {
		pollingDequeue(note);
		fetchEvent.off(note.id, onFetched);
	};
}

// 同時にリアルタイム購読するノート数の上限(超過分はポーリングにフォールバック)
// バックエンド側にも接続ごとの購読数上限があるため、それを超えない値にすること
const REALTIME_CAPTURE_MAX = 50;
let realtimeCaptureCount = 0;

function realtimeSubscribe(props: {
	note: Pick<Misskey.entities.Note, 'id'>;
}): () => void {
	const note = props.note;
	const connection = useStream();

	function onStreamNoteUpdated(noteData): void {
		const { type, id, body } = noteData;

		if (id !== note.id) return;

		switch (type) {
			case 'reacted': {
				noteEvents.emit(`reacted:${id}`, {
					userId: body.userId,
					reaction: body.reaction,
					emoji: body.emoji,
				});
				break;
			}

			case 'unreacted': {
				noteEvents.emit(`unreacted:${id}`, {
					userId: body.userId,
					reaction: body.reaction,
					emoji: body.emoji,
				});
				break;
			}

			case 'pollVoted': {
				noteEvents.emit(`pollVoted:${id}`, {
					userId: body.userId,
					choice: body.choice,
				});
				break;
			}

			case 'deleted': {
				globalEvents.emit('noteDeleted', id);
				break;
			}
		}
	}

	function capture(withHandler = false): void {
		connection.send('sr', { id: note.id });
		if (withHandler) connection.on('noteUpdated', onStreamNoteUpdated);
	}

	function decapture(withHandler = false): void {
		connection.send('un', { id: note.id });
		if (withHandler) connection.off('noteUpdated', onStreamNoteUpdated);
	}

	function onStreamConnected() {
		capture(false);
	}

	capture(true);
	connection.on('_connected_', onStreamConnected);
	realtimeCaptureCount++;

	return () => {
		decapture(true);
		connection.off('_connected_', onStreamConnected);
		realtimeCaptureCount--;
	};
}

export type ReactiveNoteData = {
	reactions: Misskey.entities.Note['reactions'];
	reactionCount: Misskey.entities.Note['reactionCount'];
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	reactionLocalEmojis: NonNullable<Misskey.entities.Note['reactionLocalEmojis']>;
	myReaction: Misskey.entities.Note['myReaction'];
	pollChoices: NonNullable<Misskey.entities.Note['poll']>['choices'];
};

const noReaction = Symbol();

/**
 * ノートのリアクション等の更新イベントを購読する。
 * 購読の開始・解除のタイミングは呼び出し側が制御する:
 * - MkNote(タイムライン等)はビューポート内に表示されている間だけ購読する
 * - MkNoteDetailed(詳細ページ)は表示中ずっと購読する
 * subscribe/unsubscribeは冪等で、何度呼んでも多重購読にはならない。
 * アンマウント時には自動で購読解除される。
 */
export function useNoteCapture(props: {
	note: Misskey.entities.Note;
	mock?: boolean;
}): {
		$note: Reactive<ReactiveNoteData>;
		subscribe: () => void;
		unsubscribe: () => void;
	} {
	const { note, mock } = props;

	const $note = reactive<ReactiveNoteData>({
		reactions: Object.entries(note.reactions).reduce((acc, [name, count]) => {
			// Normalize reactions
			const normalizedName = name.replace(/^:(\w+):$/, ':$1@.:');
			if (acc[normalizedName] == null) {
				acc[normalizedName] = count;
			} else {
				acc[normalizedName] += count;
			}
			return acc;
		}, {} as Misskey.entities.Note['reactions']),
		reactionCount: note.reactionCount,
		reactionEmojis: note.reactionEmojis,
		reactionLocalEmojis: note.reactionLocalEmojis ?? {},
		myReaction: note.myReaction,
		pollChoices: note.poll?.choices ?? [],
	});

	noteEvents.on(`reacted:${note.id}`, onReacted);
	noteEvents.on(`unreacted:${note.id}`, onUnreacted);
	noteEvents.on(`pollVoted:${note.id}`, onPollVoted);

	// 操作がダブっていないかどうかを簡易的に記録するためのMap
	const reactionUserMap = new Map<Misskey.entities.User['id'], string | typeof noReaction>();
	let latestPollVotedKey: string | null = null;

	function onReacted(ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; }; }): void {
		let normalizedName = ctx.reaction.replace(/^:(\w+):$/, ':$1@.:');
		normalizedName = normalizedName.match('\u200d') ? normalizedName : normalizedName.replace(/\ufe0f/g, '');
		if (reactionUserMap.has(ctx.userId) && reactionUserMap.get(ctx.userId) === normalizedName) return;
		reactionUserMap.set(ctx.userId, normalizedName);

		if (ctx.emoji && !(ctx.emoji.name in $note.reactionEmojis)) {
			$note.reactionEmojis[ctx.emoji.name] = ctx.emoji.url;
		}

		const currentCount = $note.reactions[normalizedName] || 0;

		$note.reactions[normalizedName] = currentCount + 1;
		$note.reactionCount += 1;

		if ($i && (ctx.userId === $i.id)) {
			$note.myReaction = normalizedName;
		}
	}

	function onUnreacted(ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; }; }): void {
		let normalizedName = ctx.reaction.replace(/^:(\w+):$/, ':$1@.:');
		normalizedName = normalizedName.match('\u200d') ? normalizedName : normalizedName.replace(/\ufe0f/g, '');

		// 確実に一度リアクションされて取り消されている場合のみ処理をとめる（APIで初回読み込み→Streamでアップデート等の場合、reactionUserMapに情報がないため）
		if (reactionUserMap.has(ctx.userId) && reactionUserMap.get(ctx.userId) === noReaction) return;
		reactionUserMap.set(ctx.userId, noReaction);

		const currentCount = $note.reactions[normalizedName] || 0;

		$note.reactions[normalizedName] = Math.max(0, currentCount - 1);
		$note.reactionCount = Math.max(0, $note.reactionCount - 1);
		if ($note.reactions[normalizedName] === 0) delete $note.reactions[normalizedName];

		if ($i && (ctx.userId === $i.id)) {
			$note.myReaction = null;
		}
	}

	function onPollVoted(ctx: { userId: Misskey.entities.User['id']; choice: string; }): void {
		const newPollVotedKey = `${ctx.userId}:${ctx.choice}`;
		if (newPollVotedKey === latestPollVotedKey) return;
		latestPollVotedKey = newPollVotedKey;

		const choices = [...$note.pollChoices];
		choices[ctx.choice] = {
			...choices[ctx.choice],
			votes: choices[ctx.choice].votes + 1,
			...($i && (ctx.userId === $i.id) ? {
				isVoted: true,
			} : {}),
		};

		$note.pollChoices = choices;
	}

	let unsubscriber: (() => void) | null = null;

	function subscribe() {
		if (mock) {
			// モックモードでは購読しない
			return;
		}

		if (unsubscriber != null) return; // すでに購読している

		if ($i && store.s.realtimeMode && realtimeCaptureCount < REALTIME_CAPTURE_MAX) {
			unsubscriber = realtimeSubscribe({ note });
		} else {
			unsubscriber = pollingSubscribe({ note, $note });
		}
	}

	function unsubscribe() {
		if (unsubscriber == null) return;
		unsubscriber();
		unsubscriber = null;
	}

	onUnmounted(() => {
		noteEvents.off(`reacted:${note.id}`, onReacted);
		noteEvents.off(`unreacted:${note.id}`, onUnreacted);
		noteEvents.off(`pollVoted:${note.id}`, onPollVoted);
		unsubscribe();
	});

	return {
		$note,
		subscribe,
		unsubscribe,
	};
}
