/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import * as Path from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
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
	HANAMI_PYTHON_THREAD_ENV,
	prepareHanamiPythonCommand,
	probeHanamiNoteJudgeRuntime,
	resolveHanamiSpamJudgeScript,
	type HanamiNoteJudgeRuntimeStatus,
} from '@/core/hanami/HanamiPythonRuntime.js';
import { acquireHanamiLocalLlmLock, type HanamiLocalLlmLock } from '@/core/hanami/HanamiLocalLlmLock.js';

const execFileAsync = promisify(execFile);

export const AI_MODERATION_PENDING_KEY = 'aiModeration:pending';
export const AI_MODERATION_TRIGGERS_KEY = 'aiModeration:triggers';
export const AI_MODERATION_MAX_BATCH = 32;
export { AI_MODERATION_LOCAL_MODEL };
const SPAM_JUDGE_TIMEOUT_MS = 35 * 60 * 1000;
const NOTE_TEXT_MAX_LENGTH = 1024;

type MentionCandidate = {
	id: MiUser['id'];
	host: MiUser['host'];
};

type SpamJudgeOutput = {
	status?: string;
	error?: string;
	runtime?: { device?: string; dtype?: string; deviceName?: string } | null;
	judgements?: Array<{ noteId: string; scores: { normal: number; spam: number; scam: number; abuse: number } }>;
	errors?: Array<{ noteId?: string; error?: string }>;
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
export class AiModerationService {
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
	) {
		this.logger = this.loggerService.getLogger('ai-moderation');
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
	 * 待ち行列から古い順に最大32件を取り出して判定し、`ai_moderation_queue` に保存する。
	 */
	@bindThis
	public async processPending(): Promise<void> {
		const items = await this.redis.zpopmin(AI_MODERATION_PENDING_KEY, AI_MODERATION_MAX_BATCH);
		if (items.length === 0) return;

		const noteIds = items.map(([member]) => member);
		const triggersByNote = await this.redis.hmget(AI_MODERATION_TRIGGERS_KEY, ...noteIds);
		if (noteIds.length > 0) await this.redis.hdel(AI_MODERATION_TRIGGERS_KEY, ...noteIds);

		const requeueAll = async (): Promise<void> => {
			const pipeline = this.redis.multi();
			for (let i = 0; i < items.length; i++) {
				pipeline.zadd(AI_MODERATION_PENDING_KEY, items[i][1], items[i][0]);
				const rawTriggers = triggersByNote[i];
				if (rawTriggers != null) pipeline.hset(AI_MODERATION_TRIGGERS_KEY, items[i][0], rawTriggers);
			}
			await pipeline.exec();
		};

		const localEnabled = this.meta.aiModerationLocalEnabled;
		let runtime: HanamiNoteJudgeRuntimeStatus | null = null;
		if (localEnabled) {
			runtime = await probeHanamiNoteJudgeRuntime();
		}
		const runLocal = localEnabled && (runtime?.available ?? false);

		let lock: HanamiLocalLlmLock | null = null;
		if (runLocal) {
			lock = await acquireHanamiLocalLlmLock(this.redis, 'spamJudge');
			if (lock == null) {
				// ロックが取れなければ元の score で待ち行列に戻して次回に回す
				this.logger.warn('AI moderation skipped: Hanami local LLM lock is busy');
				await requeueAll();
				return;
			}
		}

		try {
			const notes = await this.notesRepository.findBy({ id: In(noteIds) });
			const noteById = new Map(notes.map(note => [note.id, note]));

			// 投稿が消えたものを捨てる
			const existingNotes = noteIds
				.map(noteId => noteById.get(noteId))
				.filter((note): note is MiNote => note != null);

			// Qwen（1回の入力でまとめて判定）。失敗してもその回だけ Qwen 無しとして保存を続ける。
			let spamScores: ReadonlyMap<string, AiModerationScores> = new Map();
			if (runLocal && existingNotes.length > 0) {
				try {
					spamScores = await this.runSpamJudge(existingNotes.map(note => ({
						noteId: note.id,
						text: buildNoteText(note.cw, note.text),
					})));
				} catch (err) {
					this.logger.error('AI moderation spam judge failed; saving without local scores', { err });
				}
			}

			const { version: criteriaVersion } = await this.aiModerationCriteriaService.current();

			const flaggedItems: Array<{ noteId: string; userHost: string | null; label: string | null }> = [];
			const autoHideCandidates: AutoHideCandidate[] = [];

			for (const note of existingNotes) {
				try {
					const noteText = buildNoteText(note.cw, note.text);
					const rawMeta = (() => {
						const index = noteIds.indexOf(note.id);
						return index >= 0 ? triggersByNote[index] : null;
					})();
					const pending = parsePendingMeta(rawMeta);
					const triggers = pending.triggers;

					// 外部 API（1件ずつ送る。送らない/失敗は null のまま）
					let externalResult = null;
					if (this.meta.aiModerationExternalEnabled) {
						externalResult = await this.aiModerationExternalService.moderate(note.visibility, noteText);
					}

					let localScores: AiModerationScores | null = null;
					let localLabel: string | null;
					if (!localEnabled) {
						localLabel = 'skipped';
					} else if (!runLocal) {
						localLabel = 'unavailable';
					} else {
						localScores = spamScores.get(note.id) ?? null;
						localLabel = localScores == null ? 'unavailable' : null;
					}

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
		} catch (err) {
			this.logger.error('AI moderation processing failed', { err });
		} finally {
			if (lock != null) await lock.release();
		}
	}

	public async runSpamJudge(notes: Array<{ noteId: string; text: string }>): Promise<ReadonlyMap<string, AiModerationScores>> {
		let dir: string | null = null;
		try {
			dir = await mkdtemp(Path.join(tmpdir(), 'hanami-spam-judge-'));
			const inputPath = Path.join(dir, 'input.json');
			const outputPath = Path.join(dir, 'output.json');
			await writeFile(inputPath, JSON.stringify({ notes }), 'utf8');
			const command = prepareHanamiPythonCommand([resolveHanamiSpamJudgeScript(), inputPath, outputPath], { env: this.spamJudgePythonEnv() });
			await execFileAsync(command.file, command.args, { env: command.env, timeout: SPAM_JUDGE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
			const output = JSON.parse(await readFile(outputPath, 'utf8')) as SpamJudgeOutput;
			if (output.status === 'unavailable') throw new Error(`Hanami spam judge unavailable: ${output.error ?? 'unknown error'}`);
			if (output.status !== 'ok' && output.status !== 'partial') throw new Error(`Hanami spam judge returned invalid status: ${String(output.status)}`);

			const requested = new Set(notes.map(note => note.noteId));
			const result = new Map<string, AiModerationScores>();
			for (const judgement of output.judgements ?? []) {
				if (!requested.has(judgement.noteId)) continue;
				if (!Number.isFinite(judgement.scores.normal) || !Number.isFinite(judgement.scores.spam) || !Number.isFinite(judgement.scores.scam) || !Number.isFinite(judgement.scores.abuse)) continue;
				result.set(judgement.noteId, judgement.scores);
			}
			return result;
		} finally {
			if (dir != null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private spamJudgePythonEnv(): NodeJS.ProcessEnv {
		const configured = Number(process.env.HANAMI_LLM_MAX_THREADS);
		const maximum = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : Math.max(1, Math.floor(cpus().length / 2));
		return { ...process.env, ...HANAMI_PYTHON_THREAD_ENV, HANAMI_LLM_MAX_THREADS: String(maximum) };
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
