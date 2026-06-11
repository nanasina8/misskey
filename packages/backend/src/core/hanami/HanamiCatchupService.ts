/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { NotesRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { IdService } from '@/core/IdService.js';

// 「見逃し」と言える時間窓。新しすぎるものはまだTL上部にいる（見逃しでない）、
// 古すぎるものはエンゲージランキング窓(72h)の外で score が無い。
const CATCHUP_MIN_AGE_MS = 1000 * 60 * 60 * 2; // 2時間
const CATCHUP_MAX_AGE_MS = 1000 * 60 * 60 * 72; // 72時間
// ホームTLに流れたノートのうち、推薦に値する最小エンゲージ（リアクション2相当）。
const CATCHUP_MIN_ENGAGEMENT = 2;
// DBで作者/リプライ判定する候補数の上限。
const CATCHUP_DB_CHECK_LIMIT = 300;

export type CatchupNote = { noteId: string; userId: string; score: number };
export type CatchupOptions = {
	// はなみTLで実際に表示確認済みのホームノート（hanami:rec:homeSeen）。見たものは「見逃し」ではない。
	homeSeenNoteIds?: ReadonlySet<string>;
};

/**
 * 見逃し回収（catchup）軸。
 *
 * 自分のホームTL（フォロイーのノート）に流れたのに見ていない高反応ノートを拾い直す。
 * 他軸（popular/trending/reactionSimilar/fof）が「知らない人の発掘」なのに対し、
 * この軸だけは自分のグラフ内の回収を担当する。TLを離れていた人ほど価値が出る。
 *
 * - 候補源: FTT の homeTimeline Redis リスト（FTT無効サーバーでは候補ゼロ）
 * - エンゲージ: FeaturedService のグローバルスコア（純粋RNのラッパーIDにはスコアが付かないため自然に落ちる）
 * - 除外: homeSeen済み / 自分のノート / 他人へのリプライ（自分スレッドの続きは可）
 * - スコア: エンゲージそのまま（「どれだけ伸びたか」が回収価値。鮮度は意図的に見ない）
 */
@Injectable()
export class HanamiCatchupService {
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private fanoutTimelineService: FanoutTimelineService,
		private featuredService: FeaturedService,
		private idService: IdService,
	) {
	}

	@bindThis
	public async getCatchupNoteIds(meId: MiUser['id'], limit: number, opts?: CatchupOptions): Promise<CatchupNote[]> {
		const homeSeen = opts?.homeSeenNoteIds;
		const now = Date.now();
		const maxId = this.idService.gen(now - CATCHUP_MIN_AGE_MS);
		const minId = this.idService.gen(now - CATCHUP_MAX_AGE_MS);

		const [homeIds, globalScores] = await Promise.all([
			this.fanoutTimelineService.get(`homeTimeline:${meId}`, maxId, minId),
			this.featuredService.getGlobalNotesScoresWithCache(),
		]);
		if (homeIds.length === 0) return [];

		const scored: { noteId: string; score: number }[] = [];
		for (const noteId of homeIds) {
			if (homeSeen?.has(noteId)) continue;
			const eng = globalScores.get(noteId) ?? 0;
			if (eng < CATCHUP_MIN_ENGAGEMENT) continue;
			scored.push({ noteId, score: eng });
		}
		if (scored.length === 0) return [];
		scored.sort((a, b) => b.score - a.score);
		const candidates = scored.slice(0, Math.min(CATCHUP_DB_CHECK_LIMIT, Math.max(limit * 2, 50)));

		// 作者と返信種別の確認（自分のノート・他人へのリプライを外す）。可視性等の最終フィルタは pack 段。
		const rows = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.addSelect('note.userId', 'userId')
			.addSelect('note.replyId', 'replyId')
			.addSelect('note.replyUserId', 'replyUserId')
			.where('note.id IN (:...noteIds)', { noteIds: candidates.map(c => c.noteId) })
			.getRawMany<{ id: string; userId: string; replyId: string | null; replyUserId: string | null }>();
		const infoByNoteId = new Map(rows.map(r => [r.id, r]));

		const out: CatchupNote[] = [];
		for (const c of candidates) {
			const info = infoByNoteId.get(c.noteId);
			if (info == null) continue; // 削除済み等
			if (info.userId === meId) continue;
			if (info.replyId != null && info.replyUserId !== info.userId) continue; // 他人へのリプライは文脈が無いので回収しない
			out.push({ noteId: c.noteId, userId: info.userId, score: c.score });
			if (out.length >= limit) break;
		}
		return out;
	}
}
