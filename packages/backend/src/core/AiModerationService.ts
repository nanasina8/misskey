/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { AiModerationQueueRepository, FollowingsRepository, MiMeta, MiNote, MiUser, NotesRepository, UsersRepository } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { SystemWebhookService } from '@/core/SystemWebhookService.js';
import { AiModerationExternalService } from '@/core/AiModerationExternalService.js';
import { AiModerationHiddenService } from '@/core/AiModerationHiddenService.js';
import { AI_MODERATION_LOCAL_MODEL, AiModerationCriteriaService } from '@/core/AiModerationCriteriaService.js';
import {
	AI_MODERATION_STRONG_MIN_ACCOUNTS,
	collectAiModerationSpamSignals,
	computeAiModerationTextFingerprint,
	computeAiModerationTriggers,
	decideAiModerationAutoHide,
	decideAiModerationFlag,
	extractAiModerationLinksFromNote,
	type AiModerationLocalLabel,
	type AiModerationScores,
	type AiModerationTrigger,
} from '@/misc/ai-moderation.js';
import {
	probeHanamiNoteJudgeRuntime,
	type HanamiNoteJudgeRuntimeStatus,
} from '@/core/hanami/HanamiPythonRuntime.js';
import { HANAMI_GPU_QUEUE_RESULT_PREFIX, HanamiGpuQueueService, type HanamiGpuQueueTakenItem } from '@/core/hanami/HanamiGpuQueueService.js';
import { HanamiGpuDispatcherService } from '@/core/hanami/HanamiGpuDispatcherService.js';
import type { HanamiGpuSpamScores } from '@/misc/hanami-gpu-queue.js';

export const AI_MODERATION_PENDING_KEY = 'aiModeration:pending';
export const AI_MODERATION_TRIGGERS_KEY = 'aiModeration:triggers';
/** 1回の定期実行で待ち行列から取り出す上限（GPU キューに積むだけなので大きくしてよい） */
export const AI_MODERATION_MAX_PENDING = 200;
/** 判定の実行環境（定期実行のプロセスで確かめた結果）。API のプロセスはここから読む */
export const AI_MODERATION_RUNTIME_KEY = 'aiModeration:runtime';
/** 定期実行（aiModerationCheck）が最後に動いた時刻 */
export const AI_MODERATION_LAST_TICK_KEY = 'aiModeration:lastTickAt';
export { AI_MODERATION_LOCAL_MODEL };
const NOTE_TEXT_MAX_LENGTH = 1024;
/** 試す（judgeTrial）の結果を置いておく時間 */
const TRIAL_RESULT_TTL_SECONDS = 120;

type MentionCandidate = {
	id: MiUser['id'];
	host: MiUser['host'];
};

/** GPU キュー（spamJudge）に入れる1件。meta は待ち行列に保存していた triggers 等の生の JSON */
type SpamJudgeQueuePayload = {
	noteId: string;
	meta: string | null;
	text: string;
};

function buildNoteText(cw: string | null, text: string | null): string {
	const parts: string[] = [];
	if (cw != null && cw.length > 0) parts.push(`[CW] ${cw}`);
	if (text != null && text.length > 0) parts.push(text);
	return parts.join('\n').slice(0, NOTE_TEXT_MAX_LENGTH);
}

type PendingMeta = {
	triggers: AiModerationTrigger[];
	contactUserIds: string[];
	contactKind: 'dm' | 'mention' | 'reply' | null;
};

/**
 * Redis に保存した待ち行列メタを解釈する。新しい形式は
 * `{ triggers, contactUserIds, contactKind }`、古い形式は triggers の配列だけ。
 */
function parsePendingMeta(raw: string | null): PendingMeta {
	const empty: PendingMeta = { triggers: [], contactUserIds: [], contactKind: null };
	if (raw == null) return empty;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return {
				triggers: parsed.filter((t): t is AiModerationTrigger => typeof t === 'string'),
				contactUserIds: [],
				contactKind: null,
			};
		}
		if (parsed != null && typeof parsed === 'object') {
			const obj = parsed as { triggers?: unknown; contactUserIds?: unknown; contactKind?: unknown };
			const triggers = Array.isArray(obj.triggers)
				? obj.triggers.filter((t): t is AiModerationTrigger => typeof t === 'string')
				: [];
			const contactUserIds = Array.isArray(obj.contactUserIds)
				? obj.contactUserIds.filter((id): id is string => typeof id === 'string')
				: [];
			const contactKind = obj.contactKind === 'dm' || obj.contactKind === 'mention' || obj.contactKind === 'reply'
				? obj.contactKind
				: null;
			return { triggers, contactUserIds, contactKind };
		}
	} catch {
		// 壊れた値は空として扱う
	}
	return empty;
}

type AutoHideCandidate = {
	queueId: string;
	note: MiNote;
	triggers: readonly string[];
	localScores: AiModerationScores | null;
	externalFlagged: boolean | null;
	signals: string[];
};

const TRAILING_NOISE_RE = /\s+[a-z]{2,6}$/;
const HOUR_MS = 60 * 60 * 1000;

function jstDayKey(now: Date = new Date()): string {
	const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	return jst.toISOString().slice(0, 10).replace(/-/g, '');
}

export { jstDayKey as aiModerationJstDayKey };

@Injectable()
export class AiModerationService implements OnModuleInit {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redis: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.aiModerationQueueRepository)
		private aiModerationQueueRepository: AiModerationQueueRepository,

		private idService: IdService,
		private roleService: RoleService,
		private aiModerationExternalService: AiModerationExternalService,
		private aiModerationHiddenService: AiModerationHiddenService,
		private aiModerationCriteriaService: AiModerationCriteriaService,
		private systemWebhookService: SystemWebhookService,
		private loggerService: LoggerService,
		private hanamiGpuQueueService: HanamiGpuQueueService,
		private hanamiGpuDispatcherService: HanamiGpuDispatcherService,
	) {
		this.logger = this.loggerService.getLogger('ai-moderation');
	}

	/** 配り役に受け取り係を登録する（いつもの判定と、管理者の「試す」） */
	@bindThis
	public onModuleInit(): void {
		this.hanamiGpuDispatcherService.registerHandler('spamJudge', async (items, results) => {
			await this.handleJudged(items, results);
		});
		this.hanamiGpuDispatcherService.registerHandler('judgeTrial', async (items, results, errors) => {
			for (const item of items) {
				await this.redis.set(`${HANAMI_GPU_QUEUE_RESULT_PREFIX}${item.itemId}`, JSON.stringify({
					scores: results.get(item.itemId) ?? null,
					error: errors.get(item.itemId) ?? null,
				}), 'EX', TRIAL_RESULT_TTL_SECONDS);
			}
		});
	}

	/**
	 * 管理者の「試す」。GPU キューにいちばん高い優先度で入れ、結果が届くまで最大 timeoutMs 待つ。
	 * 届かなければ null（GPU が使えない・混んでいる）。
	 */
	@bindThis
	public async judgeTrialText(text: string, timeoutMs = 60_000): Promise<AiModerationScores | null> {
		const itemId = randomUUID();
		await this.hanamiGpuQueueService.enqueue('judgeTrial', itemId, { text: text.slice(0, NOTE_TEXT_MAX_LENGTH) });
		const key = `${HANAMI_GPU_QUEUE_RESULT_PREFIX}${itemId}`;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const raw = await this.redis.get(key);
			if (raw != null) {
				await this.redis.del(key);
				const parsed = JSON.parse(raw) as { scores: AiModerationScores | null };
				return parsed.scores;
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		return null;
	}

	/**
	 * NoteCreateService.create() から await せずに呼ばれる。絞り込みに当たった投稿を待ち行列へ入れるだけ。
	 */
	@bindThis
	public async considerNote(note: MiNote, input: {
		user: { id: MiUser['id']; host: MiUser['host']; };
		text: string | null;
		cw: string | null;
		mentions: readonly MentionCandidate[];
		visibleUsers: readonly MentionCandidate[] | null;
		reply: { userId: MiUser['id']; userHost: MiUser['host']; } | null;
	}): Promise<void> {
		if (!this.meta.aiModerationEnabled) return;

		const text = input.text?.trim() ?? '';
		const cw = input.cw?.trim() ?? '';
		if (text.length === 0 && cw.length === 0) return;

		// このサーバーの宛先（投稿者本人を除く）を集める。ここまでは DB / Redis に触らない。
		const contacts: Array<{ userId: string; host: string | null }> = [];
		const seen = new Set<string>();
		const pushContact = (id: string | null | undefined, host: string | null | undefined) => {
			if (id == null || id.length === 0) return;
			if (id === input.user.id) return;
			if (host != null) return; // このサーバーのユーザーのみ
			if (seen.has(id)) return;
			seen.add(id);
			contacts.push({ userId: id, host: null });
		};
		for (const mention of input.mentions) pushContact(mention.id, mention.host);
		for (const visibleUser of input.visibleUsers ?? []) pushContact(visibleUser.id, visibleUser.host);
		if (input.reply != null) pushContact(input.reply.userId, input.reply.userHost);

		// 宛先が無く、本文・CW のいずれにもリンクが無ければ対象外（DB / Redis に触れずに return）
		if (contacts.length === 0 && extractAiModerationLinksFromNote(text, cw, this.config.hostname).length === 0) {
			return;
		}

		// ここから本当に必要なときだけ DB 参照（凍結・モデレーター判定）
		const author = await this.usersRepository.findOneBy({ id: input.user.id });
		if (author == null || author.isSuspended) return;
		if (await this.roleService.isModerator({ id: author.id })) return;

		// 宛先ごとのフォロー関係を1回で取得
		const contactIds = contacts.map(contact => contact.userId);
		const followings = await this.followingsRepository.findBy({
			followeeId: author.id,
			followerId: In(contactIds),
		});
		const followingIds = new Set(followings.map(following => following.followerId));

		// 自鯖フォロワーの有無（1回）
		const authorHasLocalFollowers = await this.followingsRepository.exists({
			where: { followeeId: author.id, followerHost: IsNull() },
		});

		const triggers = computeAiModerationTriggers({
			authorIsRemote: author.host != null,
			authorFirstSeenAt: this.idService.parse(author.id).date,
			authorHasLocalFollowers,
			contacts: contacts.map(contact => ({ userId: contact.userId, followsAuthor: followingIds.has(contact.userId) })),
			text: text.length > 0 ? text : null,
			cw: cw.length > 0 ? cw : null,
			newAuthorDays: this.meta.aiModerationNewAuthorDays,
			localHost: this.config.hostname,
		});

		if (triggers.length === 0) return;

		const contactKind: 'dm' | 'mention' | 'reply' | null = (() => {
			if (note.visibility === 'specified') return 'dm';
			if (input.mentions.length > 0) return 'mention';
			if (input.reply != null) return 'reply';
			return null;
		})();

		await this.enqueuePending(note.id, triggers, contacts.map(contact => contact.userId), contactKind);
	}

	private async enqueuePending(
		noteId: string,
		triggers: readonly AiModerationTrigger[],
		contactUserIds: readonly string[],
		contactKind: 'dm' | 'mention' | 'reply' | null,
	): Promise<void> {
		// 同じ noteId は二重に入れない
		const added = await this.redis.zadd(AI_MODERATION_PENDING_KEY, 'NX', Date.now(), noteId);
		if (added === 0) return;

		const day = jstDayKey();
		const dailyKey = `aiModeration:daily:${day}`;
		const count = await this.redis.incr(dailyKey);
		if (count === 1) {
			// 2日で失効
			await this.redis.expire(dailyKey, 2 * 24 * 60 * 60);
		}
		if (count > this.meta.aiModerationDailyLimit) {
			await this.redis.incr(`aiModeration:dropped:${day}`);
			await this.redis.zrem(AI_MODERATION_PENDING_KEY, noteId);
			return;
		}

		await this.redis.hset(AI_MODERATION_TRIGGERS_KEY, noteId, JSON.stringify({
			triggers,
			contactUserIds,
			contactKind,
		}));
	}

	/**
	 * 2分ごと。待ち行列から古い順に取り出し、Qwen を使えるなら GPU キュー（spamJudge）に1件ずつ入れる。
	 * 判定と保存は、配り役が判定係の結果を持ってきたときに受け取り係（handleJudged）で行う。
	 * Qwen を使わない・使えないときは、その場で Qwen 無しとして保存まで進める。
	 */
	@bindThis
	public async processPending(): Promise<void> {
		// ioredis の zpopmin は [member, score, member, score, ...] の平らな配列を返す
		const popped = await this.redis.zpopmin(AI_MODERATION_PENDING_KEY, AI_MODERATION_MAX_PENDING);
		const noteIds = popped.filter((_, i) => i % 2 === 0);
		if (noteIds.length === 0) return;

		const triggersByNote = await this.redis.hmget(AI_MODERATION_TRIGGERS_KEY, ...noteIds);
		if (noteIds.length > 0) await this.redis.hdel(AI_MODERATION_TRIGGERS_KEY, ...noteIds);
		const metaByNote = new Map(noteIds.map((noteId, i) => [noteId, triggersByNote[i] ?? null]));

		const localEnabled = this.meta.aiModerationLocalEnabled;
		let runtime: HanamiNoteJudgeRuntimeStatus | null = null;
		if (localEnabled) {
			runtime = await probeHanamiNoteJudgeRuntime();
			await this.saveRuntime(runtime);
		}

		try {
			if (localEnabled && (runtime?.available ?? false)) {
				const notes = await this.notesRepository.findBy({ id: In(noteIds) });
				for (const note of notes) {
					await this.hanamiGpuQueueService.enqueue('spamJudge', note.id, {
						noteId: note.id,
						meta: metaByNote.get(note.id) ?? null,
						text: buildNoteText(note.cw, note.text),
					} satisfies SpamJudgeQueuePayload);
				}
				return;
			}
			await this.finalizeJudged(noteIds, metaByNote, new Map(), localEnabled ? 'unavailable' : 'skipped');
		} catch (err) {
			this.logger.error('AI moderation processing failed', { err });
		}
	}

	/** 受け取り係（spamJudge）。判定係の結果を受け取り、いつもどおり保存・自動で隠す・Webhook まで行う */
	@bindThis
	public async handleJudged(items: readonly HanamiGpuQueueTakenItem[], results: ReadonlyMap<string, HanamiGpuSpamScores>): Promise<void> {
		const payloads = items.map(item => item.payload as SpamJudgeQueuePayload);
		const metaByNote = new Map(payloads.map(p => [p.noteId, p.meta]));
		await this.finalizeJudged(payloads.map(p => p.noteId), metaByNote, results, 'unavailable');
	}

	/**
	 * 判定の結果（Qwen の点数。無いものは missingLabel）から、外部 API → 引っかけるか → 保存 →
	 * 行動の目印 → 自動で隠す → Webhook までを行う。投稿が消えていれば捨てる。
	 */
	private async finalizeJudged(
		noteIds: readonly string[],
		metaByNote: ReadonlyMap<string, string | null>,
		scores: ReadonlyMap<string, AiModerationScores>,
		missingLabel: 'unavailable' | 'skipped',
	): Promise<void> {
		const notes = await this.notesRepository.findBy({ id: In(noteIds) });
		const noteById = new Map(notes.map(note => [note.id, note]));

		// 投稿が消えたものを捨てる
		const existingNotes = noteIds
			.map(noteId => noteById.get(noteId))
			.filter((note): note is MiNote => note != null);

		const { version: criteriaVersion } = await this.aiModerationCriteriaService.current();

		const flaggedItems: Array<{ noteId: string; userHost: string | null; label: string | null }> = [];
		const autoHideCandidates: AutoHideCandidate[] = [];

		for (const note of existingNotes) {
			try {
				const noteText = buildNoteText(note.cw, note.text);
				const rawMeta = metaByNote.get(note.id) ?? null;
				const pending = parsePendingMeta(rawMeta);
				const triggers = pending.triggers;

				// 外部 API（1件ずつ送る。送らない/失敗は null のまま）
				let externalResult = null;
				if (this.meta.aiModerationExternalEnabled) {
					externalResult = await this.aiModerationExternalService.moderate(note.visibility, noteText);
				}

				// Qwen の結果が無い（Qwen を使わない・判定に失敗した）ときは missingLabel で保存する
				const localScores: AiModerationScores | null = scores.get(note.id) ?? null;
				let localLabel: string | null = localScores == null ? missingLabel : null;

				const { flagged, localLabel: decidedLabel } = decideAiModerationFlag(
					localScores,
					externalResult?.flagged ?? null,
					this.meta.aiModerationLocalThreshold,
				);
				if (decidedLabel != null) localLabel = decidedLabel;

				const queueId = await this.saveQueueRow({
					note,
					noteText,
					triggers,
					contactUserIds: pending.contactUserIds,
					contactKind: pending.contactKind,
					localLabel: localLabel as AiModerationLocalLabel | 'unavailable' | 'skipped' | null,
					localScores,
					localModel: localScores != null ? AI_MODERATION_LOCAL_MODEL : null,
					externalFlagged: externalResult?.flagged ?? null,
					externalCategories: externalResult?.categories ?? [],
					externalScores: externalResult?.scores ?? null,
					externalModel: externalResult?.model ?? null,
					flagged,
					criteriaVersion,
				});

				if (flagged) {
					flaggedItems.push({ noteId: note.id, userHost: note.userHost, label: localLabel });
					autoHideCandidates.push({ queueId, note, triggers, localScores, externalFlagged: externalResult?.flagged ?? null, signals: [] });
				}
			} catch (err) {
				// 1件の保存失敗で残りが失われないよう、個別に握りつぶす
				this.logger.error('AI moderation failed to process a note', { noteId: note.id, err });
			}
		}

		if (autoHideCandidates.length > 0) {
			try {
				await this.annotateSpamSignals(autoHideCandidates);
			} catch (err) {
				this.logger.error('AI moderation failed to collect spam signals', { err });
			}
		}

		if (autoHideCandidates.length > 0 && this.meta.aiModerationAutoHideMode !== 'off') {
			try {
				await this.applyAutoHide(autoHideCandidates);
			} catch (err) {
				this.logger.error('AI moderation auto hide failed', { err });
			}
		}

		if (flaggedItems.length > 0) {
			await this.systemWebhookService.enqueueSystemWebhook('aiModerationFlagged', {
				count: flaggedItems.length,
				items: flaggedItems.slice(0, 5),
			});
		}
	}

	/** 確かめた実行環境を Redis に残す（API と定期実行は別のプロセスで動くことがあるため） */
	@bindThis
	public async saveRuntime(runtime: HanamiNoteJudgeRuntimeStatus): Promise<void> {
		await this.redis.set(AI_MODERATION_RUNTIME_KEY, JSON.stringify(runtime), 'EX', 24 * 60 * 60);
	}

	/** 管理画面用。定期実行が残した結果を優先し、無ければこのプロセスで確かめる（10分キャッシュ） */
	@bindThis
	public async loadRuntime(): Promise<HanamiNoteJudgeRuntimeStatus | null> {
		const raw = await this.redis.get(AI_MODERATION_RUNTIME_KEY);
		if (raw != null) {
			try {
				return JSON.parse(raw) as HanamiNoteJudgeRuntimeStatus;
			} catch {
				// 壊れていれば確かめ直す
			}
		}
		if (!this.meta.aiModerationLocalEnabled) return null;
		const runtime = await probeHanamiNoteJudgeRuntime();
		await this.saveRuntime(runtime);
		return runtime;
	}

	private async saveQueueRow(input: {
		note: MiNote;
		noteText: string;
		triggers: string[];
		contactUserIds: string[];
		contactKind: 'dm' | 'mention' | 'reply' | null;
		localLabel: AiModerationLocalLabel | 'unavailable' | 'skipped' | null;
		localScores: AiModerationScores | null;
		localModel: string | null;
		externalFlagged: boolean | null;
		externalCategories: string[];
		externalScores: Record<string, number> | null;
		externalModel: string | null;
		flagged: boolean;
		criteriaVersion: string;
	}): Promise<string> {
		const existing = await this.aiModerationQueueRepository.findOneBy({ noteId: input.note.id });
		const fields = {
			noteUserId: input.note.userId,
			noteUserHost: input.note.userHost,
			noteVisibility: input.note.visibility,
			noteText: input.noteText,
			triggers: input.triggers,
			links: extractAiModerationLinksFromNote(input.note.text, input.note.cw, this.config.hostname),
			textFingerprint: computeAiModerationTextFingerprint(input.note.text, this.config.hostname),
			contactUserIds: input.contactUserIds,
			contactKind: input.contactKind,
			localLabel: input.localLabel,
			localScores: input.localScores,
			localModel: input.localModel,
			externalFlagged: input.externalFlagged,
			externalCategories: input.externalCategories,
			externalScores: input.externalScores,
			externalModel: input.externalModel,
			flagged: input.flagged,
			criteriaVersion: input.criteriaVersion,
			judgedAt: new Date(),
		};

		if (existing != null) {
			await this.aiModerationQueueRepository.update(existing.id, fields);
			return existing.id;
		} else {
			const id = this.idService.gen();
			await this.aiModerationQueueRepository.insertOne({
				id,
				noteId: input.note.id,
				resolved: false,
				assigneeId: null,
				moderationNote: '',
				autoAction: null,
				spamSignals: [],
				...fields,
			});
			return id;
		}
	}

	/**
	 * 引っかかった投稿ごとに、行動からスパムらしさの根拠を集めて記録する（今回の判定分も含めて数える）。
	 */
	private async annotateSpamSignals(candidates: AutoHideCandidate[]): Promise<void> {
		const authorIds = [...new Set(candidates.map(c => c.note.userId))];
		const authors = await this.usersRepository.find({ where: { id: In(authorIds) }, select: { id: true, avatarId: true } });
		const avatarById = new Map(authors.map(a => [a.id, a.avatarId]));
		const since24h = new Date(Date.now() - 24 * HOUR_MS);
		const since72h = new Date(Date.now() - 72 * HOUR_MS);

		for (const c of candidates) {
			const userId = c.note.userId;
			const fingerprint = computeAiModerationTextFingerprint(c.note.text, this.config.hostname);
			const links = extractAiModerationLinksFromNote(c.note.text, c.note.cw, this.config.hostname);

			const contactRows = await this.aiModerationQueueRepository.createQueryBuilder('queue')
				.select('queue.contactUserIds', 'contactUserIds')
				.where('queue.noteUserId = :userId', { userId })
				.andWhere('queue.judgedAt >= :since', { since: since24h })
				.andWhere('(\'unsolicitedContact\' = ANY(queue.triggers) OR \'newLocalContact\' = ANY(queue.triggers))')
				.getRawMany<{ contactUserIds: string[] }>();
			const strangers = new Set(contactRows.flatMap(r => r.contactUserIds));

			let sameTextOtherAccounts = 0;
			let sameTextSameAccount = 0;
			if (fingerprint != null) {
				const row = await this.aiModerationQueueRepository.createQueryBuilder('queue')
					.select('COUNT(DISTINCT queue.noteUserId) FILTER (WHERE queue.noteUserId != :userId AND queue.flagged = true)', 'others')
					.addSelect('COUNT(*) FILTER (WHERE queue.noteUserId = :userId)', 'mine')
					.where('queue.textFingerprint = :fingerprint', { fingerprint })
					.andWhere('queue.judgedAt >= :since', { since: since72h })
					.setParameter('userId', userId)
					.getRawOne<{ others: string; mine: string }>();
				sameTextOtherAccounts = Number(row?.others ?? 0);
				sameTextSameAccount = Number(row?.mine ?? 0);
			}

			let sameLinkOtherAccounts = 0;
			if (links.length > 0) {
				const row = await this.aiModerationQueueRepository.createQueryBuilder('queue')
					.select('COUNT(DISTINCT queue.noteUserId)', 'count')
					.where('queue.links && ARRAY[:...links]::varchar[]', { links })
					.andWhere('queue.noteUserId != :userId', { userId })
					.andWhere('queue.flagged = true')
					.andWhere('queue.judgedAt >= :since', { since: since72h })
					.getRawOne<{ count: string }>();
				sameLinkOtherAccounts = Number(row?.count ?? 0);
			}

			let hostOtherFlaggedAccounts = 0;
			if (c.note.userHost != null) {
				const row = await this.aiModerationQueueRepository.createQueryBuilder('queue')
					.select('COUNT(DISTINCT queue.noteUserId)', 'count')
					.where('queue.noteUserHost = :host', { host: c.note.userHost })
					.andWhere('queue.noteUserId != :userId', { userId })
					.andWhere('queue.flagged = true')
					.andWhere('queue.judgedAt >= :since', { since: since24h })
					.getRawOne<{ count: string }>();
				hostOtherFlaggedAccounts = Number(row?.count ?? 0);
			}

			c.signals = collectAiModerationSpamSignals({
				strangerContact: c.triggers.includes('unsolicitedContact') || c.triggers.includes('newLocalContact'),
				strangers24h: strangers.size,
				sameTextOtherAccounts,
				sameTextSameAccount,
				sameLinkOtherAccounts,
				hostOtherFlaggedAccounts,
				noAvatar: avatarById.has(userId) && avatarById.get(userId) == null,
				trailingNoise: c.note.text != null && TRAILING_NOISE_RE.test(c.note.text),
			});
			await this.aiModerationQueueRepository.update(c.queueId, { spamSignals: c.signals });
		}
	}

	/**
	 * 自動で隠すモード。on なら隠し、trial なら「隠すはずだった」と記録だけする。
	 * アカウント単位は decideAiModerationAutoHide（AI の点数＋行動の根拠）、サーバー単位（設定オン時）は下記。
	 */
	private async applyAutoHide(candidates: AutoHideCandidate[]): Promise<void> {
		const mode = this.meta.aiModerationAutoHideMode;
		const trial = mode === 'trial';
		const authorIds = [...new Set(candidates.map(c => c.note.userId))];
		const followedRows = await this.followingsRepository.createQueryBuilder('following')
			.select('DISTINCT following.followeeId', 'followeeId')
			.where('following.followeeId IN (:...ids)', { ids: authorIds })
			.andWhere('following.followerHost IS NULL')
			.getRawMany<{ followeeId: string }>();
		const followed = new Set(followedRows.map(r => r.followeeId));
		const newAuthorMs = this.meta.aiModerationNewAuthorDays * 24 * 60 * 60 * 1000;
		const dailyKey = `aiModeration:autoHide:${jstDayKey()}`;
		const decidedUsers = new Set<string>();

		for (const c of candidates) {
			const userId = c.note.userId;
			if (decidedUsers.has(userId)) continue;
			if (this.aiModerationHiddenService.isHiddenAuthor(userId, c.note.userHost)) continue;
			const hide = decideAiModerationAutoHide({
				flagged: true,
				localScores: c.localScores,
				externalFlagged: c.externalFlagged,
				threshold: this.meta.aiModerationAutoHideThreshold,
				signals: c.signals,
				authorIsRemote: c.note.userHost != null,
				authorIsNew: Date.now() - this.idService.parse(userId).date.getTime() < newAuthorMs,
				authorHasLocalFollowers: followed.has(userId),
			});
			if (!hide) continue;
			decidedUsers.add(userId);

			const count = await this.redis.incr(dailyKey);
			if (count === 1) await this.redis.expire(dailyKey, 2 * 24 * 60 * 60);
			if (count > this.meta.aiModerationAutoHideDailyLimit) {
				this.logger.warn('AI moderation auto hide skipped: daily limit reached', { userId });
				continue;
			}

			if (!trial) {
				await this.aiModerationHiddenService.hide({ targetType: 'user', userId }, { moderator: null, sourceQueueId: c.queueId });
			}
			await this.aiModerationQueueRepository.update(c.queueId, { autoAction: trial ? 'wouldHide' : 'hidden' });
		}

		if (!this.meta.aiModerationAutoHideHosts) return;

		// サーバー単位: 根拠の点数を満たして（試運転なら隠すはずだった）アカウントが24時間で3人以上、かつこのサーバーのフォロワー0
		const hosts = [...new Set(candidates.map(c => c.note.userHost).filter((h): h is string => h != null))];
		const since = new Date(Date.now() - 24 * HOUR_MS);
		for (const host of hosts) {
			if (this.aiModerationHiddenService.isHiddenHost(host)) continue;
			const stats = await this.aiModerationQueueRepository.createQueryBuilder('queue')
				.select('COUNT(DISTINCT queue.noteUserId)', 'accounts')
				.where('queue.noteUserHost = :host', { host })
				.andWhere('queue.autoAction IN (:...actions)', { actions: ['hidden', 'wouldHide', 'hiddenHost', 'wouldHideHost'] })
				.andWhere('queue.judgedAt >= :since', { since })
				.getRawOne<{ accounts: string }>();
			if (Number(stats?.accounts ?? 0) < AI_MODERATION_STRONG_MIN_ACCOUNTS) continue;
			const localFollowersCount = await this.followingsRepository.countBy({ followeeHost: host, followerHost: IsNull() });
			if (localFollowersCount > 0) continue;

			const hostQueueIds = candidates.filter(c => c.note.userHost === host).map(c => c.queueId);
			if (!trial) {
				await this.aiModerationHiddenService.hide({ targetType: 'host', host }, { moderator: null, sourceQueueId: hostQueueIds[0] ?? null });
			}
			await this.aiModerationQueueRepository.update({ id: In(hostQueueIds), autoAction: IsNull() }, { autoAction: trial ? 'wouldHideHost' : 'hiddenHost' });
		}
	}
}
