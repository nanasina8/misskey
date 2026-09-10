/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, Not } from 'typeorm';
import { EmojiEntityService } from '@/core/entities/EmojiEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { QueueService } from '@/core/QueueService.js';
import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import { MemoryKVCache, RedisSingleCache } from '@/misc/cache.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import type { EmojisRepository, MiRole, MiUser } from '@/models/_.js';
import type { EmojiImageFingerprintState, MiEmoji } from '@/models/Emoji.js';
import type { Serialized } from '@/types.js';

const parseEmojiStrRegexp = /^([-\w]+)(?:@([\w.-]+))?$/;

/**
 * リモートカスタムリアクションに対するローカル絵文字の候補。
 * imageFingerprint が一致するローカル絵文字を、ノート側のフィルタで選別するために必要な情報だけを持つ。
 */
export type ReactionLocalEmojiCandidate = {
	id: MiEmoji['id'];
	name: MiEmoji['name'];
	localOnly: MiEmoji['localOnly'];
	isSensitive: MiEmoji['isSensitive'];
	roleIdsThatCanBeUsedThisEmojiAsReaction: MiEmoji['roleIdsThatCanBeUsedThisEmojiAsReaction'];
};

export const fetchEmojisHostTypes = [
	'local',
	'remote',
	'all',
] as const;
export type FetchEmojisHostTypes = typeof fetchEmojisHostTypes[number];
export const fetchEmojisSortKeys = [
	'+id',
	'-id',
	'+updatedAt',
	'-updatedAt',
	'+name',
	'-name',
	'+host',
	'-host',
	'+uri',
	'-uri',
	'+publicUrl',
	'-publicUrl',
	'+type',
	'-type',
	'+aliases',
	'-aliases',
	'+category',
	'-category',
	'+license',
	'-license',
	'+isSensitive',
	'-isSensitive',
	'+localOnly',
	'-localOnly',
	'+roleIdsThatCanBeUsedThisEmojiAsReaction',
	'-roleIdsThatCanBeUsedThisEmojiAsReaction',
] as const;
export type FetchEmojisSortKeys = typeof fetchEmojisSortKeys[number];

@Injectable()
export class CustomEmojiService implements OnApplicationShutdown {
	private emojisCache: MemoryKVCache<MiEmoji | null>;
	public localEmojisCache: RedisSingleCache<Map<string, MiEmoji>>;
	/**
	 * `name@host` ごとのローカル絵文字候補。ノートのpackはストリーミング配信のように _hint_ を
	 * 持たない経路でも走るため、キャッシュしないと接続クライアント数ぶんクエリが出る。
	 * ローカル絵文字の変更では明示的に捨て、リモート側のfingerprint更新は寿命で吸収する。
	 */
	private reactionLocalEmojiCandidatesCache: MemoryKVCache<ReactionLocalEmojiCandidate[]>;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,
		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,
		private utilityService: UtilityService,
		private idService: IdService,
		private emojiEntityService: EmojiEntityService,
		private moderationLogService: ModerationLogService,
		private globalEventService: GlobalEventService,
		private queueService: QueueService,
	) {
		this.emojisCache = new MemoryKVCache<MiEmoji | null>(1000 * 60 * 60 * 12); // 12h
		this.reactionLocalEmojiCandidatesCache = new MemoryKVCache<ReactionLocalEmojiCandidate[]>(1000 * 60 * 5); // 5m

		this.localEmojisCache = new RedisSingleCache<Map<string, MiEmoji>>(this.redisClient, 'localEmojis', {
			lifetime: 1000 * 60 * 30, // 30m
			memoryCacheLifetime: 1000 * 60 * 3, // 3m
			fetcher: () => this.emojisRepository.find({ where: { host: IsNull() } }).then(emojis => new Map(emojis.map(emoji => [emoji.name, emoji]))),
			toRedisConverter: (value) => JSON.stringify(Array.from(value.values())),
			fromRedisConverter: (value) => {
				return new Map(JSON.parse(value).map((x: Serialized<MiEmoji>) => [x.name, {
					...x,
					updatedAt: x.updatedAt ? new Date(x.updatedAt) : null,
				}]));
			},
		});
	}

	@bindThis
	public async add(data: {
		originalUrl: string;
		publicUrl: string;
		fileType: string;
		name: string;
		category: string | null;
		aliases: string[];
		host: string | null;
		license: string | null;
		isSensitive: boolean;
		localOnly: boolean;
		roleIdsThatCanBeUsedThisEmojiAsReaction: MiRole['id'][];
		remarks: string | null;
	}, moderator?: MiUser): Promise<MiEmoji> {
		const emoji = await this.emojisRepository.insertOne({
			id: this.idService.gen(),
			updatedAt: new Date(),
			name: data.name,
			category: data.category,
			host: data.host,
			aliases: data.aliases,
			originalUrl: data.originalUrl,
			publicUrl: data.publicUrl,
			type: data.fileType,
			license: data.license,
			isSensitive: data.isSensitive,
			localOnly: data.localOnly,
			roleIdsThatCanBeUsedThisEmojiAsReaction: data.roleIdsThatCanBeUsedThisEmojiAsReaction,
			remarks: data.remarks,
		});
		// ローカル絵文字もキューに載せる。リクエストパスで画像デコードや外向きのフェッチを待たせない。
		await this.queueService.createEmojiImageFingerprintJob({ emojiId: emoji.id, sourceUrl: emoji.publicUrl, host: emoji.host });

		if (data.host == null) {
			this.refreshLocalEmojiCaches();

			this.globalEventService.publishBroadcastStream('emojiAdded', {
				emoji: await this.emojiEntityService.packDetailed(emoji.id),
			});

			if (moderator) {
				this.moderationLogService.log(moderator, 'addCustomEmoji', {
					emojiId: emoji.id,
					emoji: emoji,
				});
			}
		}

		return emoji;
	}

	@bindThis
	public async update(data: (
		{ id: MiEmoji['id'], name?: string; } | { name: string; id?: MiEmoji['id'], }
		) & {
		originalUrl?: string;
		publicUrl?: string;
		fileType?: string;
		category?: string | null;
		aliases?: string[];
		license?: string | null;
		isSensitive?: boolean;
		localOnly?: boolean;
		roleIdsThatCanBeUsedThisEmojiAsReaction?: MiRole['id'][];
		remarks?: string | null;
	}, moderator?: MiUser): Promise<
		null
		| 'NO_SUCH_EMOJI'
		| 'SAME_NAME_EMOJI_EXISTS'
	> {
		const emoji = data.id
			? await this.getEmojiById(data.id)
			: await this.getEmojiByName(data.name!);
		if (emoji === null) return 'NO_SUCH_EMOJI';
		const id = emoji.id;

		// IDと絵文字名が両方指定されている場合は絵文字名の変更を行うため重複チェックが必要
		const doNameUpdate = data.id && data.name && (data.name !== emoji.name);
		if (doNameUpdate) {
			const isDuplicate = await this.checkDuplicate(data.name!);
			if (isDuplicate) return 'SAME_NAME_EMOJI_EXISTS';
		}

		// Fingerprints are computed from the persisted display source (publicUrl).
		// Changing originalUrl alone must neither enqueue a job for a URL which was
		// not persisted nor leave a remote job permanently stale.
		const sourceChanged = data.publicUrl !== undefined && data.publicUrl !== emoji.publicUrl;
		await this.emojisRepository.update(emoji.id, {
			updatedAt: new Date(),
			name: data.name,
			category: data.category,
			aliases: data.aliases,
			license: data.license,
			isSensitive: data.isSensitive,
			localOnly: data.localOnly,
			originalUrl: data.originalUrl,
			publicUrl: data.publicUrl,
			type: data.fileType,
			roleIdsThatCanBeUsedThisEmojiAsReaction: data.roleIdsThatCanBeUsedThisEmojiAsReaction ?? undefined,
			remarks: data.remarks,
			imageFingerprint: sourceChanged ? null : undefined,
			imageFingerprintAttemptedAt: sourceChanged ? null : undefined,
			imageFingerprintErrorCode: sourceChanged ? null : undefined,
		});
		if (sourceChanged) {
			await this.queueService.createEmojiImageFingerprintJob({ emojiId: emoji.id, sourceUrl: data.publicUrl ?? emoji.publicUrl, host: emoji.host });
		}

		this.refreshLocalEmojiCaches();

		const packed = await this.emojiEntityService.packDetailed(emoji.id);

		if (!doNameUpdate) {
			this.globalEventService.publishBroadcastStream('emojiUpdated', {
				emojis: [packed],
			});
		} else {
			this.globalEventService.publishBroadcastStream('emojiDeleted', {
				emojis: [await this.emojiEntityService.packDetailed(emoji)],
			});

			this.globalEventService.publishBroadcastStream('emojiAdded', {
				emoji: packed,
			});
		}

		if (moderator) {
			const updated = await this.emojisRepository.findOneByOrFail({ id: id });
			this.moderationLogService.log(moderator, 'updateCustomEmoji', {
				emojiId: emoji.id,
				before: emoji,
				after: updated,
			});
		}
		return null;
	}

	@bindThis
	public async addAliasesBulk(ids: MiEmoji['id'][], aliases: string[]) {
		const emojis = await this.emojisRepository.findBy({
			id: In(ids),
		});

		for (const emoji of emojis) {
			await this.emojisRepository.update(emoji.id, {
				updatedAt: new Date(),
				aliases: [...new Set(emoji.aliases.concat(aliases))],
			});
		}

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiUpdated', {
			emojis: await this.emojiEntityService.packDetailedMany(ids),
		});
	}

	@bindThis
	public async setAliasesBulk(ids: MiEmoji['id'][], aliases: string[]) {
		await this.emojisRepository.update({
			id: In(ids),
		}, {
			updatedAt: new Date(),
			aliases: aliases,
		});

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiUpdated', {
			emojis: await this.emojiEntityService.packDetailedMany(ids),
		});
	}

	@bindThis
	public async removeAliasesBulk(ids: MiEmoji['id'][], aliases: string[]) {
		const emojis = await this.emojisRepository.findBy({
			id: In(ids),
		});

		for (const emoji of emojis) {
			await this.emojisRepository.update(emoji.id, {
				updatedAt: new Date(),
				aliases: emoji.aliases.filter(x => !aliases.includes(x)),
			});
		}

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiUpdated', {
			emojis: await this.emojiEntityService.packDetailedMany(ids),
		});
	}

	@bindThis
	public async setCategoryBulk(ids: MiEmoji['id'][], category: string | null) {
		await this.emojisRepository.update({
			id: In(ids),
		}, {
			updatedAt: new Date(),
			category: category,
		});

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiUpdated', {
			emojis: await this.emojiEntityService.packDetailedMany(ids),
		});
	}

	@bindThis
	public async setLicenseBulk(ids: MiEmoji['id'][], license: string | null) {
		await this.emojisRepository.update({
			id: In(ids),
		}, {
			updatedAt: new Date(),
			license: license,
		});

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiUpdated', {
			emojis: await this.emojiEntityService.packDetailedMany(ids),
		});
	}

	@bindThis
	public async delete(id: MiEmoji['id'], moderator?: MiUser) {
		const emoji = await this.emojisRepository.findOneByOrFail({ id: id });

		await this.emojisRepository.delete(emoji.id);

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiDeleted', {
			emojis: [await this.emojiEntityService.packDetailed(emoji)],
		});

		if (moderator) {
			this.moderationLogService.log(moderator, 'deleteCustomEmoji', {
				emojiId: emoji.id,
				emoji: emoji,
			});
		}
	}

	@bindThis
	public async deleteBulk(ids: MiEmoji['id'][], moderator?: MiUser) {
		const emojis = await this.emojisRepository.findBy({
			id: In(ids),
		});

		for (const emoji of emojis) {
			await this.emojisRepository.delete(emoji.id);

			if (moderator) {
				this.moderationLogService.log(moderator, 'deleteCustomEmoji', {
					emojiId: emoji.id,
					emoji: emoji,
				});
			}
		}

		this.refreshLocalEmojiCaches();

		this.globalEventService.publishBroadcastStream('emojiDeleted', {
			emojis: await this.emojiEntityService.packDetailedMany(emojis),
		});
	}

	@bindThis
	private normalizeHost(src: string | undefined, noteUserHost: string | null): string | null {
		// クエリに使うホスト
		let host = src === '.' ? null	// .はローカルホスト (ここがマッチするのはリアクションのみ)
			: src === undefined ? noteUserHost	// ノートなどでホスト省略表記の場合はローカルホスト (ここがリアクションにマッチすることはない)
			: this.utilityService.isSelfHost(src) ? null	// 自ホスト指定
			: (src || noteUserHost);	// 指定されたホスト || ノートなどの所有者のホスト (こっちがリアクションにマッチすることはない)

		host = this.utilityService.toPunyNullable(host);

		return host;
	}

	@bindThis
	public parseEmojiStr(emojiName: string, noteUserHost: string | null) {
		const match = emojiName.match(parseEmojiStrRegexp);
		if (!match) return { name: null, host: null };

		const name = match[1];

		// ホスト正規化
		const host = this.utilityService.toPunyNullable(this.normalizeHost(match[2], noteUserHost));

		return { name, host };
	}

	/**
	 * 添付用(リモート)カスタム絵文字URLを解決する
	 * @param emojiName ノートやユーザープロフィールに添付された、またはリアクションのカスタム絵文字名 (:は含めない, リアクションでローカルホストの場合は@.を付ける (これはdecodeReactionで可能))
	 * @param noteUserHost ノートやユーザープロフィールの所有者のホスト
	 * @returns URL, nullは未マッチを意味する
	 */
	@bindThis
	public async populateEmoji(emojiName: string, noteUserHost: string | null): Promise<string | null> {
		const { name, host } = this.parseEmojiStr(emojiName, noteUserHost);
		if (name == null) return null;
		if (host == null) return null;

		const queryOrNull = async () => (await this.emojisRepository.findOneBy({
			name,
			host,
		})) ?? null;

		const emoji = await this.emojisCache.fetch(`${name} ${host}`, queryOrNull);

		if (emoji == null) return null;
		return emoji.publicUrl || emoji.originalUrl; // || emoji.originalUrl してるのは後方互換性のため（publicUrlはstringなので??はだめ）
	}

	/**
	 * 複数の添付用(リモート)カスタム絵文字URLを解決する (キャシュ付き, 存在しないものは結果から除外される)
	 */
	@bindThis
	public async populateEmojis(emojiNames: string[], noteUserHost: string | null): Promise<Record<string, string>> {
		const emojis = await Promise.all(emojiNames.map(x => this.populateEmoji(x, noteUserHost)));
		const res = {} as Record<string, string>;
		for (let i = 0; i < emojiNames.length; i++) {
			const resolvedEmoji = emojis[i];
			if (resolvedEmoji != null) {
				res[emojiNames[i]] = resolvedEmoji;
			}
		}
		return res;
	}

	/**
	 * 与えられた絵文字のリストをデータベースから取得し、キャッシュに追加します
	 */
	@bindThis
	public async prefetchEmojis(emojis: { name: string; host: string | null; }[]): Promise<void> {
		const notCachedEmojis = emojis.filter(emoji => this.emojisCache.get(`${emoji.name} ${emoji.host}`) == null);
		const emojisQuery: any[] = [];
		const hosts = new Set(notCachedEmojis.map(e => e.host));
		for (const host of hosts) {
			if (host == null) continue;
			emojisQuery.push({
				name: In(notCachedEmojis.filter(e => e.host === host).map(e => e.name)),
				host: host,
			});
		}
		const _emojis = emojisQuery.length > 0 ? await this.emojisRepository.find({
			where: emojisQuery,
			select: ['name', 'host', 'originalUrl', 'publicUrl'],
		}) : [];
		for (const emoji of _emojis) {
			this.emojisCache.set(`${emoji.name} ${emoji.host}`, emoji);
		}
	}

	/**
	 * リモートカスタムリアクション参照（`:name@host:` のコロンを外した `name@host`）に対して、
	 * imageFingerprint が完全一致するローカル絵文字の候補一覧を返す。
	 *
	 * リモート絵文字 (host IS NOT NULL) を (name, host) で引いて非nullの imageFingerprint を集め、
	 * その fingerprint を持つローカル絵文字 (host IS NULL) をまとめて取得する。計2回のバウンドされたクエリで完結し、
	 * AP ID・URI・name・source MD5・URL は一切比較しない。
	 *
	 * 返り値のキーは与えられた参照文字列そのもの（正規化済み `name@host`）。候補は note 側でフィルタ・ID順ソートするため、
	 * id / name / localOnly / isSensitive / roleIdsThatCanBeUsedThisEmojiAsReaction を保持する。
	 */
	@bindThis
	public async getReactionLocalEmojiCandidates(
		reactionEmojiNames: string[],
	): Promise<Map<string, ReactionLocalEmojiCandidate[]>> {
		const result = new Map<string, ReactionLocalEmojiCandidate[]>();
		const uniqueNames = [...new Set(reactionEmojiNames)];
		if (uniqueNames.length === 0) return result;

		// 候補が無い参照はキーを立てない（キャッシュヒットでもDBを引いた時と同じ形にする）
		const uncached: string[] = [];
		for (const raw of uniqueNames) {
			const cached = this.reactionLocalEmojiCandidatesCache.get(raw);
			if (cached === undefined) uncached.push(raw);
			else if (cached.length > 0) result.set(raw, cached);
		}
		if (uncached.length === 0) return result;

		const queried = await this.queryReactionLocalEmojiCandidates(uncached);
		// 「候補なし」も必ず入れる。候補が無い参照こそ毎回引き直されるので、そこをキャッシュしないと意味がない。
		for (const raw of uncached) {
			const candidates = queried.get(raw) ?? [];
			this.reactionLocalEmojiCandidatesCache.set(raw, candidates);
			if (candidates.length > 0) result.set(raw, candidates);
		}

		return result;
	}

	private async queryReactionLocalEmojiCandidates(
		uniqueNames: string[],
	): Promise<Map<string, ReactionLocalEmojiCandidate[]>> {
		const result = new Map<string, ReactionLocalEmojiCandidate[]>();

		// 参照文字列を name / host に分解し、正規化（punycode・自ホスト解決）する
		const refs: { raw: string; name: string; host: string }[] = [];
		for (const raw of uniqueNames) {
			const { name, host } = this.parseEmojiStr(raw, null);
			if (name != null && host != null) refs.push({ raw, name, host });
		}
		if (refs.length === 0) return result;

		// 参照を host 単位でグループ化してリモート絵文字を検索（N+1 回避）
		const hostToNames = new Map<string, Set<string>>();
		for (const ref of refs) {
			const names = hostToNames.get(ref.host) ?? new Set<string>();
			names.add(ref.name);
			hostToNames.set(ref.host, names);
		}

		const remoteWhere: any[] = [];
		for (const [host, names] of hostToNames) {
			remoteWhere.push({
				name: In([...names]),
				host,
				imageFingerprint: Not(IsNull()),
			});
		}

		const remoteEmojis = await this.emojisRepository.find({
			where: remoteWhere,
			select: ['name', 'host', 'imageFingerprint'],
		});

		// (name, host) → 参照文字列 と fingerprint → 参照文字列 の対応表
		const pairKeyToRaw = new Map<string, string[]>();
		for (const ref of refs) {
			const key = `${ref.name}\u0000${ref.host}`;
			const raws = pairKeyToRaw.get(key) ?? [];
			raws.push(ref.raw);
			pairKeyToRaw.set(key, raws);
		}

		const fingerprintToRaw = new Map<string, string[]>();
		for (const remote of remoteEmojis) {
			if (remote.imageFingerprint == null) continue;
			const raws = pairKeyToRaw.get(`${remote.name}\u0000${remote.host}`);
			if (raws == null) continue;
			const existing = fingerprintToRaw.get(remote.imageFingerprint) ?? [];
			for (const raw of raws) {
				if (!existing.includes(raw)) existing.push(raw);
			}
			fingerprintToRaw.set(remote.imageFingerprint, existing);
		}

		const fingerprints = [...fingerprintToRaw.keys()];
		if (fingerprints.length === 0) return result;

		// 部分インデックス (host IS NULL AND imageFingerprint IS NOT NULL) を活かすローカル側の検索
		const localEmojis = await this.emojisRepository.find({
			where: {
				host: IsNull(),
				imageFingerprint: In(fingerprints),
			},
			select: ['id', 'name', 'localOnly', 'isSensitive', 'roleIdsThatCanBeUsedThisEmojiAsReaction', 'imageFingerprint'],
		});

		for (const local of localEmojis) {
			if (local.imageFingerprint == null) continue;
			const raws = fingerprintToRaw.get(local.imageFingerprint);
			if (raws == null) continue;
			const candidate: ReactionLocalEmojiCandidate = {
				id: local.id,
				name: local.name,
				localOnly: local.localOnly,
				isSensitive: local.isSensitive,
				roleIdsThatCanBeUsedThisEmojiAsReaction: local.roleIdsThatCanBeUsedThisEmojiAsReaction,
			};
			for (const raw of raws) {
				const list = result.get(raw) ?? [];
				list.push(candidate);
				result.set(raw, list);
			}
		}

		return result;
	}

	/**
	 * ローカル内の絵文字に重複がないかチェックします
	 * @param name 絵文字名
	 */
	@bindThis
	public checkDuplicate(name: string): Promise<boolean> {
		return this.emojisRepository.exists({ where: { name, host: IsNull() } });
	}

	@bindThis
	public getEmojiById(id: string): Promise<MiEmoji | null> {
		return this.emojisRepository.findOneBy({ id });
	}

	@bindThis
	public getEmojiByName(name: string): Promise<MiEmoji | null> {
		return this.emojisRepository.findOneBy({ name, host: IsNull() });
	}

	@bindThis
	public async fetchEmojis(
		params?: {
			query?: {
				updatedAtFrom?: string;
				updatedAtTo?: string;
				name?: string;
				host?: string;
				uri?: string;
				publicUrl?: string;
				type?: string;
				aliases?: string;
				category?: string;
				license?: string;
				isSensitive?: boolean;
				localOnly?: boolean;
				hostType?: FetchEmojisHostTypes;
				imageFingerprintState?: EmojiImageFingerprintState;
				roleIds?: string[];
			},
			sinceId?: string;
			untilId?: string;
		},
		opts?: {
			limit?: number;
			page?: number;
			sortKeys?: FetchEmojisSortKeys[]
		},
	) {
		function multipleWordsToQuery(words: string) {
			return words.split(/\s/).filter(x => x.length > 0).map(x => `%${sqlLikeEscape(x)}%`);
		}

		const builder = this.emojisRepository.createQueryBuilder('emoji');
		if (params?.query) {
			const q = params.query;
			if (q.updatedAtFrom) {
				// noIndexScan
				builder.andWhere('CAST(emoji.updatedAt AS DATE) >= :updateAtFrom', { updateAtFrom: q.updatedAtFrom });
			}
			if (q.updatedAtTo) {
				// noIndexScan
				builder.andWhere('CAST(emoji.updatedAt AS DATE) <= :updateAtTo', { updateAtTo: q.updatedAtTo });
			}
			if (q.name) {
				builder.andWhere('emoji.name ~~ ANY(ARRAY[:...name])', { name: multipleWordsToQuery(q.name) });
			}

			switch (true) {
				case q.hostType === 'local': {
					builder.andWhere('emoji.host IS NULL');
					break;
				}
				case q.hostType === 'remote': {
					if (q.host) {
						// noIndexScan
						builder.andWhere('emoji.host ~~ ANY(ARRAY[:...host])', { host: multipleWordsToQuery(q.host) });
					} else {
						builder.andWhere('emoji.host IS NOT NULL');
					}
					break;
				}
			}

			if (q.uri) {
				// noIndexScan
				builder.andWhere('emoji.uri ~~ ANY(ARRAY[:...uri])', { uri: multipleWordsToQuery(q.uri) });
			}
			if (q.publicUrl) {
				// noIndexScan
				builder.andWhere('emoji.publicUrl ~~ ANY(ARRAY[:...publicUrl])', { publicUrl: multipleWordsToQuery(q.publicUrl) });
			}
			if (q.type) {
				// noIndexScan
				builder.andWhere('emoji.type ~~ ANY(ARRAY[:...type])', { type: multipleWordsToQuery(q.type) });
			}
			if (q.aliases) {
				// noIndexScan
				const subQueryBuilder = builder.subQuery()
					.select('COUNT(0)', 'count')
					.from(
						sq2 => sq2
							.select('unnest(subEmoji.aliases)', 'alias')
							.addSelect('subEmoji.id', 'id')
							.from('emoji', 'subEmoji'),
						'aliasTable',
					)
					.where('"emoji"."id" = "aliasTable"."id"')
					.andWhere('"aliasTable"."alias" ~~ ANY(ARRAY[:...aliases])', { aliases: multipleWordsToQuery(q.aliases) });

				builder.andWhere(`(${subQueryBuilder.getQuery()}) > 0`);
			}
			if (q.category) {
				builder.andWhere('emoji.category ~~ ANY(ARRAY[:...category])', { category: multipleWordsToQuery(q.category) });
			}
			if (q.license) {
				// noIndexScan
				builder.andWhere('emoji.license ~~ ANY(ARRAY[:...license])', { license: multipleWordsToQuery(q.license) });
			}
			if (q.isSensitive != null) {
				// noIndexScan
				builder.andWhere('emoji.isSensitive = :isSensitive', { isSensitive: q.isSensitive });
			}
			if (q.localOnly != null) {
				// noIndexScan
				builder.andWhere('emoji.localOnly = :localOnly', { localOnly: q.localOnly });
			}
			if (q.imageFingerprintState) {
				// pending / failed はローカル・リモート共通。ready はローカル限定、
				// matched / unmatched はリモート限定なので、それぞれ host 条件を自分で付ける。
				switch (q.imageFingerprintState) {
					case 'pending':
						builder.andWhere('emoji."imageFingerprint" IS NULL AND emoji."imageFingerprintAttemptedAt" IS NULL');
						break;
					case 'failed':
						builder.andWhere('emoji."imageFingerprint" IS NULL AND emoji."imageFingerprintAttemptedAt" IS NOT NULL');
						break;
					case 'ready':
						builder.andWhere('emoji.host IS NULL AND emoji."imageFingerprint" IS NOT NULL');
						break;
					case 'matched':
						builder.andWhere('emoji.host IS NOT NULL AND emoji."imageFingerprint" IS NOT NULL AND EXISTS (SELECT 1 FROM "emoji" "lf" WHERE "lf"."host" IS NULL AND "lf"."imageFingerprint" = emoji."imageFingerprint")');
						break;
					case 'unmatched':
						builder.andWhere('emoji.host IS NOT NULL AND emoji."imageFingerprint" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "emoji" "lf" WHERE "lf"."host" IS NULL AND "lf"."imageFingerprint" = emoji."imageFingerprint")');
						break;
				}
			}
			if (q.roleIds && q.roleIds.length > 0) {
				builder.andWhere('emoji.roleIdsThatCanBeUsedThisEmojiAsReaction && ARRAY[:...roleIds]::VARCHAR[]', { roleIds: q.roleIds });
			}
		}

		if (params?.sinceId) {
			builder.andWhere('emoji.id > :sinceId', { sinceId: params.sinceId });
		}
		if (params?.untilId) {
			builder.andWhere('emoji.id < :untilId', { untilId: params.untilId });
		}

		if (opts?.sortKeys && opts.sortKeys.length > 0) {
			for (const sortKey of opts.sortKeys) {
				const direction = sortKey.startsWith('-') ? 'DESC' : 'ASC';
				const key = sortKey.replace(/^[+-]/, '');
				builder.addOrderBy(`emoji.${key}`, direction);
			}
		} else {
			builder.addOrderBy('emoji.id', 'DESC');
		}

		const limit = opts?.limit ?? 10;
		if (opts?.page) {
			builder.skip((opts.page - 1) * limit);
		}

		builder.take(limit);

		const [emojis, count] = await builder.getManyAndCount();

		return {
			emojis,
			count: (count > limit ? emojis.length : count),
			allCount: count,
			allPages: Math.ceil(count / limit),
		};
	}

	/** ローカル絵文字が変わると、fingerprint一致で導かれる候補も古くなる。 */
	@bindThis
	private refreshLocalEmojiCaches(): void {
		this.localEmojisCache.refresh();
		this.reactionLocalEmojiCandidatesCache.clear();
	}

	@bindThis
	public dispose(): void {
		this.emojisCache.dispose();
		this.reactionLocalEmojiCandidatesCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
