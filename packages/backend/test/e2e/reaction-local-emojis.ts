/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import type { Repository } from 'typeorm';
import type * as misskey from 'misskey-js';
import { MiEmoji } from '@/models/Emoji.js';
import { MiNote } from '@/models/Note.js';
import { MiNoteReaction } from '@/models/NoteReaction.js';
import { api, initTestDb, post, signup } from '../utils.js';

describe('reactionLocalEmojis', () => {
	let emojis: Repository<MiEmoji>;
	let notes: Repository<MiNote>;
	let noteReactions: Repository<MiNoteReaction>;
	let author: misskey.entities.SignupResponse;
	let viewer: misskey.entities.SignupResponse;
	let noteId: string;

	beforeAll(async () => {
		const db = await initTestDb(true);
		emojis = db.getRepository(MiEmoji);
		notes = db.getRepository(MiNote);
		noteReactions = db.getRepository(MiNoteReaction);
		author = await signup({ username: 'reaction_author' });
		viewer = await signup({ username: 'reaction_viewer' });

		const fingerprint = `pix-v1:${'a'.repeat(64)}`;
		await emojis.insert([{
			id: 'a'.repeat(32),
			updatedAt: new Date(),
			name: 'same_image_local',
			host: null,
			category: null,
			originalUrl: 'https://local.example/emoji.png',
			publicUrl: 'https://local.example/emoji.png',
			uri: null,
			type: 'image/png',
			aliases: [],
			license: null,
			localOnly: false,
			isSensitive: false,
			roleIdsThatCanBeUsedThisEmojiAsReaction: [],
			remarks: null,
			imageFingerprint: fingerprint,
		}, {
			id: 'b'.repeat(32),
			updatedAt: new Date(),
			name: 'same_image_remote',
			host: 'remote.example',
			category: null,
			originalUrl: 'https://remote.example/emoji.png',
			publicUrl: 'https://remote.example/emoji.png',
			uri: null,
			type: 'image/png',
			aliases: [],
			license: null,
			localOnly: false,
			isSensitive: false,
			roleIdsThatCanBeUsedThisEmojiAsReaction: [],
			remarks: null,
			imageFingerprint: fingerprint,
		}, {
			id: 'c'.repeat(32),
			updatedAt: new Date(),
			name: 'unmatched_remote',
			host: 'remote.example',
			category: null,
			originalUrl: 'https://remote.example/unmatched.png',
			publicUrl: 'https://remote.example/unmatched.png',
			uri: null,
			type: 'image/png',
			aliases: [],
			license: null,
			localOnly: false,
			isSensitive: false,
			roleIdsThatCanBeUsedThisEmojiAsReaction: [],
			remarks: null,
			imageFingerprint: `pix-v1:${'b'.repeat(64)}`,
		}]);

		const note = await post(author, { text: 'remote custom reaction mapping' });
		noteId = note.id;
		await notes.update(noteId, {
			reactions: {
				':same_image_remote@remote.example:': 1,
				':unmatched_remote@remote.example:': 1,
			},
		});
	}, 1000 * 60 * 2);

	test('maps an exact fingerprint match and leaves unmatched remote reactions unmapped', async () => {
		const res = await api('notes/show', { noteId }, viewer);

		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(res.body.reactions, {
			':same_image_remote@remote.example:': 1,
			':unmatched_remote@remote.example:': 1,
		});
		assert.deepStrictEqual(res.body.reactionLocalEmojis, {
			'same_image_remote@remote.example': 'same_image_local',
		});

		const react = await api('notes/reactions/create', {
			noteId,
			reaction: ':same_image_local@.:',
		}, viewer);
		assert.strictEqual(react.status, 204);

		const storedReaction = await noteReactions.findOneByOrFail({ noteId, userId: viewer.id });
		assert.strictEqual(storedReaction.reaction, ':same_image_local:');
	});
});
