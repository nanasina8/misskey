/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { EntityManager, QueryRunner } from 'typeorm';
import type { HanamiCommonFeedHeadSnapshot } from './HanamiUserFeedContracts.js';

type QueryScope = Pick<EntityManager | QueryRunner, 'query'>;

type CommonFeedStateRow = {
	epoch_id: string | null;
	generation_id: string | null;
	head_sequence: string;
};

@Injectable()
export class HanamiCommonHeadQueries {
	public async lockLatestReadyCommonHead(scope: QueryScope): Promise<HanamiCommonFeedHeadSnapshot | null> {
		return await this.getLatestReadyCommonHead(scope, true);
	}

	public async readLatestReadyCommonHead(scope: QueryScope): Promise<HanamiCommonFeedHeadSnapshot | null> {
		return await this.getLatestReadyCommonHead(scope, false);
	}

	private async getLatestReadyCommonHead(scope: QueryScope, lock: boolean): Promise<HanamiCommonFeedHeadSnapshot | null> {
		const states = await scope.query(`
			SELECT s."epochId" AS epoch_id,
				s."latestReadyGenerationId" AS generation_id,
				s."latestSequence"::text AS head_sequence
			FROM "hanami_common_feed_state" s
			WHERE s."singletonId" = 'singleton'
			${lock ? 'FOR UPDATE OF s' : ''}
		`) as CommonFeedStateRow[];
		const state = states.at(0);
		if (state == null) return null;
		if (state.generation_id == null) {
			if (state.epoch_id != null || state.head_sequence !== '0') {
				throw new Error('Hanami common feed state has no ready generation but contains a non-empty ready head');
			}
			return null;
		}
		if (state.epoch_id == null || !/^[1-9]\d*$/.test(state.head_sequence)) {
			throw new Error(`Hanami common feed state has an invalid ready head for generation ${state.generation_id}`);
		}

		const generations = await scope.query(`
			SELECT g."id" AS id, g."status" AS status
			FROM "hanami_common_generation" g
			WHERE g."id" = $1
			${lock ? 'FOR UPDATE OF g' : ''}
		`, [state.generation_id]) as Array<{ id: string; status: string }>;
		const generation = generations.at(0);
		if (generation == null) throw new Error(`Hanami common feed state references missing generation ${state.generation_id}`);
		if (generation.status !== 'ready') {
			throw new Error(`Hanami common feed state references generation ${state.generation_id} with status ${generation.status}, expected ready`);
		}

		return {
			epochId: state.epoch_id,
			generationId: state.generation_id,
			headSequence: state.head_sequence,
		};
	}
}
