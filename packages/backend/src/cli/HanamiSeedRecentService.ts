/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 開発用: 古いダンプの直近 N 日分のノート/リアクションを「いま」の時刻へずらして複製し、
// トレンド索引（Redis）にも再生する。関係値・トレンド・はなみTLのウィジェットに中身を出すためのもの。
// 複製は hanami_seed_clone に記録し、--cleanup で全部消せる。本番で使う想定は無い。
//
//   pnpm --filter backend cli hanami-seed-recent            # 直近14日分を複製
//   pnpm --filter backend cli hanami-seed-recent --days 7
//   pnpm --filter backend cli hanami-seed-recent --cleanup

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import type { MiNote } from '@/models/Note.js';

const BATCH = 5000;
const TREND_REPLAY_HOURS = 74; // HanamiTrendService の 72h 窓＋バッファ

@Injectable()
export class HanamiSeedRecentService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private idService: IdService,
		private hanamiTrendService: HanamiTrendService,
		private featuredService: FeaturedService,
	) {}

	@bindThis
	public async seed(days: number): Promise<void> {
		await this.db.query(`CREATE TABLE IF NOT EXISTS "hanami_seed_clone" (
			"origId" varchar(32) NOT NULL,
			"cloneId" varchar(32) NOT NULL,
			"kind" varchar(16) NOT NULL,
			PRIMARY KEY ("kind", "origId"),
			UNIQUE ("cloneId")
		)`);

		const existing = await this.db.query('SELECT count(*)::int AS c FROM "hanami_seed_clone"') as { c: number }[];
		if (existing[0].c > 0) {
			console.log(`hanami_seed_clone already has ${existing[0].c} rows. Run --cleanup first.`);
			return;
		}

		// 複製元: 記録されている最新ノートまでの N 日。ずらし幅 = いま - 最新ノート時刻 - 1h（最新の複製が1時間前に来る）
		const latest = await this.db.query('SELECT id FROM note ORDER BY id DESC LIMIT 1') as { id: string }[];
		if (latest.length === 0) {
			console.log('no notes');
			return;
		}
		const latestAt = this.idService.parse(latest[0].id).date.getTime();
		const offset = Date.now() - latestAt - 60 * 60 * 1000;
		const since = this.idService.gen(latestAt - days * 86_400_000);
		console.log(`source window: ${new Date(latestAt - days * 86_400_000).toISOString()} .. ${new Date(latestAt).toISOString()}, shift +${(offset / 86_400_000).toFixed(2)} days`);

		// 1. ノート id の対応表
		const noteIds = await this.db.query('SELECT id FROM note WHERE id > $1 ORDER BY id', [since]) as { id: string }[];
		console.log(`notes to clone: ${noteIds.length}`);
		await this.insertMapping(noteIds.map(row => row.id), 'note', offset);

		// 2. ノート本体（reply/renote は複製があればそちらへ、無ければ元のまま）。uri/url は unique なので落とす。poll は複製しない。
		await this.db.query(`
			INSERT INTO note (id, "replyId", "renoteId", text, name, cw, "userId", "localOnly", "renoteCount", "repliesCount", reactions, visibility,
				uri, "fileIds", "attachedFileTypes", "visibleUserIds", mentions, "mentionedRemoteUsers", emojis, tags, "hasPoll", "userHost",
				"replyUserId", "replyUserHost", "renoteUserId", "renoteUserHost", url, "channelId", "threadId", "reactionAcceptance", "clippedCount",
				"reactionAndUserPairCache", "deleteAt", "isNoteInHanaMode", "pageCount", "renoteChannelId")
			SELECT m."cloneId", COALESCE(rp."cloneId", n."replyId"), COALESCE(rn."cloneId", n."renoteId"), n.text, n.name, n.cw, n."userId", n."localOnly", n."renoteCount", n."repliesCount", n.reactions, n.visibility,
				NULL, n."fileIds", n."attachedFileTypes", n."visibleUserIds", n.mentions, n."mentionedRemoteUsers", n.emojis, n.tags, FALSE, n."userHost",
				n."replyUserId", n."replyUserHost", n."renoteUserId", n."renoteUserHost", NULL, NULL, NULL, n."reactionAcceptance", 0,
				n."reactionAndUserPairCache", NULL, n."isNoteInHanaMode", n."pageCount", NULL
			FROM "hanami_seed_clone" m
			JOIN note n ON n.id = m."origId"
			LEFT JOIN "hanami_seed_clone" rp ON rp.kind = 'note' AND rp."origId" = n."replyId"
			LEFT JOIN "hanami_seed_clone" rn ON rn.kind = 'note' AND rn."origId" = n."renoteId"
			WHERE m.kind = 'note'
			ON CONFLICT DO NOTHING
		`);
		console.log('notes inserted');

		// 3. リアクション（複製したノートに付いていたものを、同じずらし幅で）
		const reactionIds = await this.db.query('SELECT id FROM note_reaction WHERE id > $1 ORDER BY id', [since]) as { id: string }[];
		console.log(`reactions to clone: ${reactionIds.length}`);
		await this.insertMapping(reactionIds.map(row => row.id), 'reaction', offset);
		await this.db.query(`
			INSERT INTO note_reaction (id, "userId", "noteId", reaction)
			SELECT m."cloneId", r."userId", nm."cloneId", r.reaction
			FROM "hanami_seed_clone" m
			JOIN note_reaction r ON r.id = m."origId"
			JOIN "hanami_seed_clone" nm ON nm.kind = 'note' AND nm."origId" = r."noteId"
			WHERE m.kind = 'reaction'
			ON CONFLICT DO NOTHING
		`);
		console.log('reactions inserted');

		// 4. トレンド索引の再生（直近 74h の public/home・本文あり・非bot・非チャンネル）
		const replaySince = this.idService.gen(Date.now() - TREND_REPLAY_HOURS * 3_600_000);
		const rows = await this.db.query(`
			SELECT n.id, n."userId", n.text FROM note n
			JOIN "hanami_seed_clone" m ON m.kind = 'note' AND m."cloneId" = n.id
			JOIN "user" u ON u.id = n."userId"
			WHERE n.id > $1 AND n.text IS NOT NULL AND n."channelId" IS NULL AND n.visibility IN ('public', 'home') AND u."isBot" = FALSE
			ORDER BY n.id
		`, [replaySince]) as { id: string; userId: string; text: string }[];
		console.log(`trend replay: ${rows.length} notes`);
		let done = 0;
		for (const row of rows) {
			await this.hanamiTrendService.indexNote({ id: row.id, userId: row.userId, text: row.text } as MiNote, this.idService.parse(row.id).date.getTime());
			done++;
			if (done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
		}
		await this.redisClient.del('hanami:trend:terms');

		// 5. 人気ランキング（featuredGlobalNotesRanking）の再生: 直近 74h の複製リアクションを ReactionService と同じ条件で加点
		await this.replayFeatured(replaySince);
		console.log('done. hanami_seed_clone rows:', (await this.db.query('SELECT count(*)::int AS c FROM "hanami_seed_clone"') as { c: number }[])[0].c);
	}

	/** トレンド索引と人気ランキングだけ、いまを終端にして再生し直す（複製済みデータが古くなったとき用） */
	@bindThis
	public async replayOnly(): Promise<void> {
		// 複製データは時間が経つと「直近2時間」から外れるので、最新ノートが「いま」に来るようにずらして索引だけ積み直す
		const latest = await this.db.query('SELECT id FROM note ORDER BY id DESC LIMIT 1') as { id: string }[];
		const shift = latest.length === 0 ? 0 : Math.max(0, Date.now() - this.idService.parse(latest[0].id).date.getTime());
		const replaySince = this.idService.gen(Date.now() - shift - TREND_REPLAY_HOURS * 3_600_000);
		console.log(`replay shift +${(shift / 60_000).toFixed(1)} min`);
		const rows = await this.db.query(`
			SELECT n.id, n."userId", n.text FROM note n
			JOIN "user" u ON u.id = n."userId"
			WHERE n.id > $1 AND n.text IS NOT NULL AND n."channelId" IS NULL AND n.visibility IN ('public', 'home') AND u."isBot" = FALSE
			ORDER BY n.id
		`, [replaySince]) as { id: string; userId: string; text: string }[];
		console.log(`trend replay: ${rows.length} notes`);
		for (const row of rows) {
			await this.hanamiTrendService.indexNote({ id: row.id, userId: row.userId, text: row.text } as MiNote, this.idService.parse(row.id).date.getTime() + shift);
		}
		await this.redisClient.del('hanami:trend:terms');
		await this.replayFeatured(replaySince, shift);
	}

	private async replayFeatured(replaySince: string, shift = 0): Promise<void> {
		const reactions = await this.db.query(`
			SELECT r.id, r."noteId" FROM note_reaction r
			JOIN note n ON n.id = r."noteId"
			WHERE r.id > $1 AND n."userId" <> r."userId" AND n."channelId" IS NULL AND n."replyId" IS NULL AND n.visibility IN ('public', 'home')
			ORDER BY r.id
		`, [replaySince]) as { id: string; noteId: string }[];
		console.log(`featured replay: ${reactions.length} reactions`);
		for (const reaction of reactions) {
			await this.featuredService.updateGlobalNotesRanking(reaction.noteId, 1, this.idService.parse(reaction.id).date.getTime() + shift);
		}
		await this.redisClient.del('featuredGlobalNotesScoresCache');
	}

	@bindThis
	public async cleanup(): Promise<void> {
		const exists = await this.db.query('SELECT to_regclass(\'"hanami_seed_clone"\') AS t') as { t: string | null }[];
		if (exists[0].t == null) {
			console.log('nothing to clean');
			return;
		}
		const r = await this.db.query('DELETE FROM note_reaction WHERE id IN (SELECT "cloneId" FROM "hanami_seed_clone" WHERE kind = \'reaction\')');
		const n = await this.db.query('DELETE FROM note WHERE id IN (SELECT "cloneId" FROM "hanami_seed_clone" WHERE kind = \'note\')');
		await this.db.query('DROP TABLE "hanami_seed_clone"');
		// ioredis の keyPrefix は KEYS の戻り値には付いたままなので剥がしてから DEL する
		const prefix = this.redisClient.options.keyPrefix ?? '';
		const keys = (await this.redisClient.keys('hanami:trend:*')).map(key => key.startsWith(prefix) ? key.slice(prefix.length) : key);
		if (keys.length > 0) await this.redisClient.del(...keys);
		console.log(`deleted reactions=${JSON.stringify(r[1] ?? r)} notes=${JSON.stringify(n[1] ?? n)} trendKeys=${keys.length}`);
	}

	private async insertMapping(ids: string[], kind: 'note' | 'reaction', offset: number): Promise<void> {
		for (let i = 0; i < ids.length; i += BATCH) {
			const chunk = ids.slice(i, i + BATCH);
			const clones = chunk.map(id => this.idService.gen(this.idService.parse(id).date.getTime() + offset));
			await this.db.query(
				'INSERT INTO "hanami_seed_clone" ("origId", "cloneId", kind) SELECT o, c, $3 FROM unnest($1::varchar[], $2::varchar[]) AS t(o, c) ON CONFLICT DO NOTHING',
				[chunk, clones, kind],
			);
		}
	}
}
