/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { AiModerationQueueRepository, MiAiModerationQueue, MiUser } from '@/models/_.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import { IdService } from '@/core/IdService.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { NoteEntityService } from './NoteEntityService.js';
import { UserEntityService } from './UserEntityService.js';

async function nullIfEntityNotFound<T>(promise: Promise<T>): Promise<T | null> {
	try {
		return await promise;
	} catch (err) {
		if (err instanceof EntityNotFoundError) {
			return null;
		}
		throw err;
	}
}

export type AiModerationQueueComputed = {
	author: {
		createdAt: string;
		notesCount: number;
		followersCount: number;
		followingCount: number;
		hasAvatar: boolean;
		isSuspended: boolean;
		isHidden: boolean;
		isHostHidden: boolean;
	} | null;
	related: {
		sameLinkAccounts: number;
		sameTextCount: number;
		userFlagged: number;
		userJudged: number;
	};
};

@Injectable()
export class AiModerationQueueEntityService {
	constructor(
		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		private noteEntityService: NoteEntityService,
		private userEntityService: UserEntityService,
		private idService: IdService,
	) {
	}

	@bindThis
	public async pack(
		src: MiAiModerationQueue['id'] | MiAiModerationQueue,
		me?: { id: MiUser['id'] } | null,
		computed?: AiModerationQueueComputed | null,
	): Promise<Packed<'AiModerationQueue'>> {
		const queue = typeof src === 'object' ? src : await this.aiModerationQueueRepository.findOneByOrFail({ id: src });

		const note = await nullIfEntityNotFound(
			this.noteEntityService.pack(queue.noteId, me, {
				detail: true,
				skipHide: true,
			}),
		);

		const noteUser = await nullIfEntityNotFound(
			this.userEntityService.pack(queue.noteUserId, null, { schema: 'UserLite' }),
		);

		const assignee = queue.assigneeId
			? await nullIfEntityNotFound(
				this.userEntityService.pack(queue.assignee ?? queue.assigneeId, null, { schema: 'UserLite' }),
			)
			: null;

		return await awaitAll({
			id: queue.id,
			createdAt: this.idService.parse(queue.id).date.toISOString(),
			noteId: queue.noteId,
			note: note ?? null,
			noteUserId: queue.noteUserId,
			noteUser: noteUser ?? null,
			noteUserHost: queue.noteUserHost,
			noteVisibility: queue.noteVisibility,
			noteText: queue.noteText,
			triggers: queue.triggers,
			links: queue.links,
			textFingerprint: queue.textFingerprint,
			contactUserIds: queue.contactUserIds,
			contactKind: queue.contactKind,
			contactCount: queue.contactUserIds.length,
			author: computed?.author ?? null,
			related: computed?.related ?? { sameLinkAccounts: 0, sameTextCount: 0, userFlagged: 0, userJudged: 0 },
			localLabel: queue.localLabel,
			localScores: queue.localScores,
			localModel: queue.localModel,
			externalFlagged: queue.externalFlagged,
			externalCategories: queue.externalCategories,
			externalScores: queue.externalScores,
			externalModel: queue.externalModel,
			flagged: queue.flagged,
			resolved: queue.resolved,
			assigneeId: queue.assigneeId,
			assignee: assignee ?? null,
			moderationNote: queue.moderationNote,
			autoAction: queue.autoAction,
			spamSignals: queue.spamSignals,
			criteriaVersion: queue.criteriaVersion,
			judgedAt: queue.judgedAt != null ? queue.judgedAt.toISOString() : null,
		});
	}

	@bindThis
	public async packMany(
		queues: MiAiModerationQueue[],
		me?: { id: MiUser['id'] } | null,
		computed?: Map<string, AiModerationQueueComputed>,
	): Promise<Packed<'AiModerationQueue'>[]> {
		return await Promise.all(queues.map(queue => this.pack(queue, me, computed?.get(queue.id) ?? null)));
	}
}
