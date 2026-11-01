/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Brackets, In, IsNull, Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type {
	AiModerationScanItemRepository,
	AiModerationScanRepository,
	FollowingsRepository,
	MiAiModerationScan,
	MiAiModerationScanItem,
	MiMeta,
	MiNote,
	MiUser,
	NotesRepository,
	UsersRepository,
} from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { AiModerationService } from '@/core/AiModerationService.js';
import { AiModerationCriteriaService } from '@/core/AiModerationCriteriaService.js';
import { HanamiGpuQueueService, type HanamiGpuQueueTakenItem } from '@/core/hanami/HanamiGpuQueueService.js';
import { HanamiGpuDispatcherService } from '@/core/hanami/HanamiGpuDispatcherService.js';
import {
	collectAiModerationSpamSignals,
	computeAiModerationTextFingerprint,
	computeAiModerationTriggers,
	decideAiModerationAutoHide,
	decideAiModerationFlag,
	extractAiModerationLinksFromNote,
	AI_MODERATION_SCAN_UNLIMITED,
	aiModerationScanWallSeconds,
	type AiModerationScores,
} from '@/misc/ai-moderation.js';

/** 1回の判定（Python 起動1回）に入れる件数。モデルの読み込みが毎回かかるので GPU では大きめにする */
/** スキャンの分の待ちがこれを下回ったら補充する。1回に足すのは REFILL_SIZE 件まで */
const REFILL_LOW_WATER = 64;
const REFILL_SIZE = 128;
/** 見積もりのために投稿を調べる箇所と、1箇所あたりの件数（期間の中で均等に散らす） */
const SAMPLE_SLICES = 5;
const SAMPLE_PER_SLICE = 600;
const PAGE_SIZE = 500;
const MAX_PAGES_PER_BATCH = 20;
const NOTE_TEXT_MAX_LENGTH = 1024;
/** 残しておくスキャンの数（新しく始めたとき、これより古いものは消す） */
const KEEP_SCANS = 5;
const DEFAULT_SECONDS_PER_POST = { cuda: 0.15, cpu: 10 } as const;
/** いつもの絞り込みに当たりうる投稿だけを DB で先に絞る（リンク・メンション・リプライ・DM） */
const LINK_LIKE_SQL = `'https?://|[a-z0-9-]+\\.[a-z]{2,}/'`;
const LINK_LIKE_RE = /https?:\/\/|[a-z0-9-]+\.[a-z]{2,}\//i;

/** GPU キュー（spamScan）に入れる1件。受け取り係はこれだけで保存できる（投稿を読み直さない） */
type ScanQueuePayload = {
	scanId: string;
	noteId: string;
	userId: string;
	userHost: string | null;
	visibility: string;
	noteText: string | null;
	cw: string | null;
	/** 判定係に渡す文（CW＋本文） */
	text: string;
	triggers: string[];
	avatarId: string | null;
};

const exhaustedKey = (scanId: string) => `aiModeration:scan:exhausted:${scanId}`;
const REFILL_LOCK_KEY = 'aiModeration:scan:refillLock';

type Candidate = {
	note: MiNote;
	triggers: string[];
	author: { id: string; host: string | null; avatarId: string | null };
};

function buildNoteText(cw: string | null, text: string | null): string {
	const parts: string[] = [];
	if (cw != null && cw.length > 0) parts.push(`[CW] ${cw}`);
	if (text != null && text.length > 0) parts.push(text);
	return parts.join('\n').slice(0, NOTE_TEXT_MAX_LENGTH);
}

const TRAILING_NOISE_RE = /\s+[a-z]{2,6}$/;

export class AiModerationScanAlreadyRunningError extends Error {}

/**
 * 「全体を調べる」。既にある投稿を古い順に少しずつ判定し、結果を ai_moderation_scan_item に残す。
 * 参考用なので、隠す・通知・Webhook は一切しない（「自動モードなら隠していたか」だけ記録する）。
 * いつもの判定（processPending）のあと、同じ定期実行で GPU のロックを取れたときだけ進める。
 */
@Injectable()
export class AiModerationScanService implements OnModuleInit {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redis: Redis.Redis,

		@Inject(DI.aiModerationScanRepository)
		private aiModerationScanRepository: AiModerationScanRepository,

		@Inject(DI.aiModerationScanItemRepository)
		private aiModerationScanItemRepository: AiModerationScanItemRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private idService: IdService,
		private roleService: RoleService,
		private moderationLogService: ModerationLogService,
		private aiModerationService: AiModerationService,
		private aiModerationCriteriaService: AiModerationCriteriaService,
		private loggerService: LoggerService,
		private hanamiGpuQueueService: HanamiGpuQueueService,
		private hanamiGpuDispatcherService: HanamiGpuDispatcherService,
	) {
		this.logger = this.loggerService.getLogger('ai-moderation-scan');
	}

	/** 配り役に受け取り係と補充係を登録する */
	@bindThis
	public onModuleInit(): void {
		this.hanamiGpuDispatcherService.registerHandler('spamScan', async (items, results, _errors, durationMs) => {
			await this.handleJudged(items, results, durationMs);
		});
		this.hanamiGpuDispatcherService.registerRefill('spamScan', async () => {
			await this.refill();
		});
	}

	/** 補充は配り役と定期実行の両方から呼ばれるので、同時に走らないようにする（同じ投稿を二重に数えない） */
	@bindThis
	public async refill(): Promise<void> {
		const got = await this.redis.set(REFILL_LOCK_KEY, String(process.pid), 'EX', 120, 'NX');
		if (got == null) return;
		try {
			await this.processScan();
		} finally {
			await this.redis.del(REFILL_LOCK_KEY);
		}
	}

	/** 見張り用: 実行中のスキャンがあるか、期間の終わりまで足し終えたか */
	@bindThis
	public async queueInfo(): Promise<{ running: boolean; exhausted: boolean; scanId: string | null }> {
		const scan = await this.findRunning();
		if (scan == null) return { running: false, exhausted: false, scanId: null };
		return { running: true, exhausted: await this.redis.exists(exhaustedKey(scan.id)) === 1, scanId: scan.id };
	}

	@bindThis
	public async findRunning(): Promise<MiAiModerationScan | null> {
		return await this.aiModerationScanRepository.findOne({ where: { status: 'running' }, order: { id: 'DESC' } });
	}

	@bindThis
	public async start(params: {
		mode: 'filtered' | 'all';
		target: 'all' | 'local' | 'remote';
		days: number | null;
		/** null なら上限なし */
		maxJudged: number | null;
	}, moderator: { id: MiUser['id'] }): Promise<MiAiModerationScan> {
		if (await this.findRunning() != null) throw new AiModerationScanAlreadyRunningError();

		const now = Date.now();
		const sinceNoteId = params.days != null ? this.idService.gen(now - params.days * 24 * 60 * 60 * 1000) : null;
		const { version } = await this.aiModerationCriteriaService.current();
		const scan = await this.aiModerationScanRepository.insertOne({
			id: this.idService.gen(now),
			status: 'running',
			mode: params.mode,
			target: params.target,
			sinceNoteId,
			untilNoteId: this.idService.gen(now),
			cursor: null,
			maxJudged: params.maxJudged ?? AI_MODERATION_SCAN_UNLIMITED,
			scannedCount: 0,
			judgedCount: 0,
			flaggedCount: 0,
			wouldHideCount: 0,
			judgeSeconds: 0,
			startedById: moderator.id,
			finishedAt: null,
			lastError: null,
			criteriaVersion: version,
		});

		// 古いスキャンは消す（項目は CASCADE で消える）
		const old = await this.aiModerationScanRepository.find({ select: { id: true }, order: { id: 'DESC' }, skip: KEEP_SCANS, take: 100 });
		if (old.length > 0) await this.aiModerationScanRepository.delete({ id: In(old.map(s => s.id)) });

		await this.moderationLogService.log(moderator, 'startAiModerationScan', {
			scanId: scan.id,
			mode: params.mode,
			target: params.target,
			days: params.days,
			maxJudged: params.maxJudged,
			criteriaVersion: version,
		});
		return scan;
	}

	@bindThis
	public async cancel(scanId: string, moderator: { id: MiUser['id'] }): Promise<boolean> {
		const scan = await this.aiModerationScanRepository.findOneBy({ id: scanId, status: 'running' });
		if (scan == null) return false;
		await this.aiModerationScanRepository.update(scan.id, { status: 'canceled', finishedAt: new Date() });
		await this.hanamiGpuQueueService.removeWhere('spamScan', payload => (payload as ScanQueuePayload | null)?.scanId === scan.id);
		await this.moderationLogService.log(moderator, 'cancelAiModerationScan', {
			scanId: scan.id,
			judgedCount: scan.judgedCount,
			flaggedCount: scan.flaggedCount,
		});
		return true;
	}

	/**
	 * 始める前の見積もり。投稿を数えきると大きなサーバーでは数分かかるので、抜き出した投稿から割合で出す。
	 * - 期間が短い（90日以内）: 期間の投稿数を ID の範囲で数え、期間の中の数か所から抜き出す
	 * - 期間が長い・最初から: 表全体から無作為に抜き出す（TABLESAMPLE）。投稿数は表の行数の見込みから出す
	 */
	@bindThis
	public async estimate(params: { mode: 'filtered' | 'all'; target: 'all' | 'local' | 'remote'; days: number | null }): Promise<{
		notes: number;
		sampled: number;
		sampledCandidates: number;
		candidates: number;
		secondsPerPost: number;
		batchSize: number;
		postsPerHour: number;
		estimatedSeconds: number;
	}> {
		const now = Date.now();
		const sinceNoteId = params.days != null ? this.idService.gen(now - params.days * 24 * 60 * 60 * 1000) : null;
		const untilNoteId = this.idService.gen(now);

		const { rows, scopeRows } = await this.sampleNotes(sinceNoteId, untilNoteId, params.days);
		const inScope = rows.filter(note => this.matchesBase(note, params.mode, params.target));
		const sampledCandidates = inScope.length === 0 ? 0 : (await this.selectCandidates(inScope, params.mode)).length;
		const ratio = (n: number) => rows.length === 0 ? 0 : Math.round(scopeRows * n / rows.length);

		const { secondsPerPost, batchSize } = await this.speed();
		const candidates = ratio(sampledCandidates);
		return {
			notes: ratio(inScope.length),
			sampled: rows.length,
			sampledCandidates,
			candidates,
			secondsPerPost,
			batchSize,
			postsPerHour: Math.round(3600 / Math.max(secondsPerPost, 0.001)),
			estimatedSeconds: aiModerationScanWallSeconds(candidates, secondsPerPost),
		};
	}

	/** 見積もり用に投稿を抜き出す。scopeRows は期間内の投稿（文の有無を問わない）の数の見込み */
	private async sampleNotes(sinceNoteId: string | null, untilNoteId: string, days: number | null): Promise<{ rows: MiNote[]; scopeRows: number }> {
		if (sinceNoteId != null && days != null && days <= 90) {
			const scopeRows = await this.notesRepository.createQueryBuilder('note')
				.where('note.id >= :sinceNoteId', { sinceNoteId })
				.andWhere('note.id < :untilNoteId', { untilNoteId })
				.getCount();
			const since = this.idService.parse(sinceNoteId).date.getTime();
			const until = this.idService.parse(untilNoteId).date.getTime();
			const rows: MiNote[] = [];
			for (let i = 0; i < SAMPLE_SLICES; i++) {
				const at = since + (until - since) * i / SAMPLE_SLICES;
				rows.push(...await this.notesRepository.createQueryBuilder('note')
					.where('note.id >= :from', { from: this.idService.gen(at) })
					.andWhere('note.id < :untilNoteId', { untilNoteId })
					.orderBy('note.id', 'ASC')
					.limit(SAMPLE_PER_SLICE)
					.getMany());
			}
			return { rows: [...new Map(rows.map(note => [note.id, note])).values()], scopeRows };
		}

		// 表全体から無作為にページを選んで抜き出す。行数は統計情報の見込み（数えない）
		const stat = await this.notesRepository.query('SELECT reltuples::bigint AS "rows" FROM pg_class WHERE relname = \'note\'') as Array<{ rows: string }>;
		const tableRows = Math.max(Number(stat[0]?.rows ?? 0), 1);
		const percent = Math.min(100, (SAMPLE_SLICES * SAMPLE_PER_SLICE * 2) / tableRows * 100);
		const sampled = await this.notesRepository.query(
			'SELECT "id", "userId", "userHost", "text", "cw", "visibility", "mentions", "visibleUserIds", "replyUserId" FROM "note" TABLESAMPLE SYSTEM ($1)',
			[percent],
		) as MiNote[];
		const inRange = sampled.filter(note => note.id < untilNoteId && (sinceNoteId == null || note.id >= sinceNoteId));
		return {
			rows: inRange,
			scopeRows: sampled.length === 0 ? 0 : Math.round(tableRows * inRange.length / sampled.length),
		};
	}

	/** baseQuery と同じ条件（文がある・どこの投稿・絞り込み）を、抜き出した投稿に当てる */
	private matchesBase(note: MiNote, mode: 'filtered' | 'all', target: 'all' | 'local' | 'remote'): boolean {
		if (note.text == null && note.cw == null) return false;
		if (target === 'local' && note.userHost != null) return false;
		if (target === 'remote' && note.userHost == null) return false;
		if (mode === 'all') return true;
		return LINK_LIKE_RE.test(note.text ?? '') || LINK_LIKE_RE.test(note.cw ?? '')
			|| note.mentions.length > 0 || note.replyUserId != null || note.visibility === 'specified';
	}

	/** 残りの件数を判定し終えるまでの実時間 */
	@bindThis
	public wallSeconds(posts: number, secondsPerPost: number): number {
		return aiModerationScanWallSeconds(posts, secondsPerPost);
	}

	@bindThis
	public async speed(): Promise<{ secondsPerPost: number; batchSize: number; device: 'cuda' | 'cpu' | null }> {
		const runtime = await this.aiModerationService.loadRuntime();
		const device = runtime?.device ?? null;
		const last = await this.aiModerationScanRepository.findOne({ where: { judgedCount: Not(0) }, order: { id: 'DESC' } });
		const measured = last != null && last.judgedCount > 0 ? last.judgeSeconds / last.judgedCount : null;
		const secondsPerPost = measured ?? (device === 'cpu' ? DEFAULT_SECONDS_PER_POST.cpu : DEFAULT_SECONDS_PER_POST.cuda);
		return { secondsPerPost, batchSize: 32, device };
	}

	/**
	 * 補充係。実行中のスキャンがあり、GPU キューのスキャン分が少なくなったら、次の候補を足す。
	 * 配り役（キューが空いたとき）と2分ごとの定期実行の両方から呼ばれる。判定と保存は受け取り係（handleJudged）。
	 */
	@bindThis
	public async processScan(): Promise<void> {
		const scan = await this.findRunning();
		if (scan == null) return;

		// 列に残っている分＋判定中の分（判定中は列から外れているが、まだ judgedCount に数えていない）
		const queued = await this.hanamiGpuQueueService.pending('spamScan');
		if (queued >= REFILL_LOW_WATER) return;

		// 上限まで残りが無ければ、もう足さない（届いた分を受け取り係が数え終えたら終わる）
		const room = Math.min(REFILL_SIZE, scan.maxJudged - scan.judgedCount - queued);
		if (room <= 0) {
			if (queued === 0) await this.finish(scan);
			return;
		}
		if (await this.redis.exists(exhaustedKey(scan.id)) === 1) {
			if (queued === 0) await this.finish(scan);
			return;
		}

		let cursor = scan.cursor;
		let scanned = 0;
		let exhausted = false;
		const candidates: Candidate[] = [];

		for (let page = 0; page < MAX_PAGES_PER_BATCH && candidates.length < room; page++) {
			const notes = await this.baseQuery(scan.mode, scan.target, scan.sinceNoteId, scan.untilNoteId, cursor)
				.orderBy('note.id', 'ASC')
				.limit(PAGE_SIZE)
				.getMany();
			if (notes.length === 0) {
				exhausted = true;
				break;
			}
			const selected = new Map((await this.selectCandidates(notes, scan.mode)).map(c => [c.note.id, c]));
			for (const note of notes) {
				scanned++;
				cursor = note.id;
				const candidate = selected.get(note.id);
				if (candidate != null) candidates.push(candidate);
				if (candidates.length >= room) break;
			}
		}

		for (const c of candidates) {
			await this.hanamiGpuQueueService.enqueue('spamScan', `${scan.id}:${c.note.id}`, {
				scanId: scan.id,
				noteId: c.note.id,
				userId: c.note.userId,
				userHost: c.note.userHost,
				visibility: c.note.visibility,
				noteText: c.note.text,
				cw: c.note.cw,
				text: buildNoteText(c.note.cw, c.note.text),
				triggers: c.triggers,
				avatarId: c.author.avatarId,
			} satisfies ScanQueuePayload);
		}

		await this.aiModerationScanRepository.update(scan.id, {
			cursor,
			scannedCount: scan.scannedCount + scanned,
			lastError: null,
		});
		await this.hanamiGpuQueueService.recordEvent({ type: 'refill', kind: 'spamScan', count: candidates.length, detail: `scan=${scan.id} scanned=${scanned}${exhausted ? ' exhausted' : ''}` });

		if (exhausted) {
			await this.redis.set(exhaustedKey(scan.id), '1', 'EX', 30 * 24 * 60 * 60);
			if (queued + candidates.length === 0) await this.finish(scan);
		}
	}

	/** 受け取り係（spamScan）。判定係の結果を保存し、件数を進める */
	@bindThis
	public async handleJudged(items: readonly HanamiGpuQueueTakenItem[], results: ReadonlyMap<string, AiModerationScores>, durationMs: number | null): Promise<void> {
		const byScan = new Map<string, Array<{ itemId: string; payload: ScanQueuePayload }>>();
		for (const item of items) {
			const payload = item.payload as ScanQueuePayload;
			const list = byScan.get(payload.scanId) ?? [];
			list.push({ itemId: item.itemId, payload });
			byScan.set(payload.scanId, list);
		}

		for (const [scanId, entries] of byScan) {
			const scan = await this.aiModerationScanRepository.findOneBy({ id: scanId });
			if (scan == null || scan.status !== 'running') continue; // 中止・終わったスキャンの残りは捨てる

			const candidates: Candidate[] = entries.map(({ payload }) => ({
				note: {
					id: payload.noteId,
					userId: payload.userId,
					userHost: payload.userHost,
					visibility: payload.visibility,
					text: payload.noteText,
					cw: payload.cw,
				} as MiNote,
				triggers: payload.triggers,
				author: { id: payload.userId, host: payload.userHost, avatarId: payload.avatarId },
			}));
			// 判定係の結果は itemId（scanId:noteId）で届くので noteId に直す
			const scores = new Map<string, AiModerationScores>();
			for (const { itemId, payload } of entries) {
				const score = results.get(itemId);
				if (score != null) scores.set(payload.noteId, score);
			}

			const saved = await this.saveItems(scan, candidates, scores);
			const flaggedItems = saved.filter(item => item.flagged);
			const wouldHide = await this.annotate(flaggedItems, candidates);
			const judgeSeconds = durationMs != null ? durationMs / 1000 * (entries.length / items.length) : 0;

			await this.aiModerationScanRepository.increment({ id: scan.id }, 'judgedCount', saved.length);
			await this.aiModerationScanRepository.increment({ id: scan.id }, 'flaggedCount', flaggedItems.length);
			await this.aiModerationScanRepository.increment({ id: scan.id }, 'wouldHideCount', wouldHide);
			await this.aiModerationScanRepository.increment({ id: scan.id }, 'judgeSeconds', judgeSeconds);

			const fresh = await this.aiModerationScanRepository.findOneByOrFail({ id: scan.id });
			// この回の分は列から外れている（判定中の数にだけ入っている）ので、列の残りだけを見る
			const queued = await this.hanamiGpuQueueService.length('spamScan');
			const exhausted = await this.redis.exists(exhaustedKey(scan.id)) === 1;
			if (fresh.judgedCount >= fresh.maxJudged || (exhausted && queued === 0)) {
				await this.finish(fresh);
			}
		}
	}

	private baseQuery(mode: 'filtered' | 'all', target: 'all' | 'local' | 'remote', sinceNoteId: string | null, untilNoteId: string, cursor: string | null) {
		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id < :untilNoteId', { untilNoteId })
			.andWhere(new Brackets(qb => qb.where('note.text IS NOT NULL').orWhere('note.cw IS NOT NULL')));
		if (cursor != null) {
			query.andWhere('note.id > :cursor', { cursor });
		} else if (sinceNoteId != null) {
			query.andWhere('note.id >= :sinceNoteId', { sinceNoteId });
		}
		if (target === 'local') query.andWhere('note.userHost IS NULL');
		if (target === 'remote') query.andWhere('note.userHost IS NOT NULL');
		if (mode === 'filtered') {
			query.andWhere(new Brackets(qb => qb
				.where(`note.text ~* ${LINK_LIKE_SQL}`)
				.orWhere(`note.cw ~* ${LINK_LIKE_SQL}`)
				.orWhere('cardinality(note.mentions) > 0')
				.orWhere('note.replyUserId IS NOT NULL')
				.orWhere('note.visibility = \'specified\''),
			));
		}
		return query;
	}

	/**
	 * 判定に回す投稿を選ぶ。凍結済み・モデレーターの投稿は除く。
	 * filtered はいつもの絞り込み（computeAiModerationTriggers、新しいアカウントかは投稿時点で見る）に当たるものだけ。
	 */
	private async selectCandidates(notes: readonly MiNote[], mode: 'filtered' | 'all'): Promise<Candidate[]> {
		const withText = notes.filter(note => (note.text?.trim().length ?? 0) > 0 || (note.cw?.trim().length ?? 0) > 0);
		if (withText.length === 0) return [];

		const authorIds = [...new Set(withText.map(note => note.userId))];
		const authors = await this.usersRepository.find({
			where: { id: In(authorIds) },
			select: { id: true, host: true, avatarId: true, isSuspended: true },
		});
		// 1人ずつロールを引くと遅いので、モデレーター・管理者の一覧を1回だけ取る
		const moderatorIds = new Set(await this.roleService.getModeratorIds({ includeAdmins: true, includeRoot: true }));
		const authorById = new Map<string, { id: string; host: string | null; avatarId: string | null }>();
		for (const author of authors) {
			if (author.isSuspended) continue;
			if (moderatorIds.has(author.id)) continue;
			authorById.set(author.id, { id: author.id, host: author.host, avatarId: author.avatarId });
		}

		// 宛先（このサーバーのユーザーだけ）
		const contactIdsByNote = new Map<string, string[]>();
		const allContactIds = new Set<string>();
		for (const note of withText) {
			const ids = new Set<string>([...note.mentions, ...note.visibleUserIds, ...(note.replyUserId != null ? [note.replyUserId] : [])]);
			ids.delete(note.userId);
			contactIdsByNote.set(note.id, [...ids]);
			for (const id of ids) allContactIds.add(id);
		}
		const localContacts = new Set<string>();
		if (allContactIds.size > 0) {
			const contacts = await this.usersRepository.find({ where: { id: In([...allContactIds]), host: IsNull() }, select: { id: true } });
			for (const c of contacts) localContacts.add(c.id);
		}

		const follows = new Set<string>();
		const liveAuthorIds = [...authorById.keys()];
		if (localContacts.size > 0 && liveAuthorIds.length > 0) {
			const rows = await this.followingsRepository.find({
				where: { followeeId: In(liveAuthorIds), followerId: In([...localContacts]) },
				select: { followeeId: true, followerId: true },
			});
			for (const row of rows) follows.add(`${row.followeeId}:${row.followerId}`);
		}
		const followed = new Set<string>();
		if (liveAuthorIds.length > 0) {
			const rows = await this.followingsRepository.createQueryBuilder('following')
				.select('DISTINCT following.followeeId', 'followeeId')
				.where('following.followeeId IN (:...ids)', { ids: liveAuthorIds })
				.andWhere('following.followerHost IS NULL')
				.getRawMany<{ followeeId: string }>();
			for (const row of rows) followed.add(row.followeeId);
		}

		const result: Candidate[] = [];
		for (const note of withText) {
			const author = authorById.get(note.userId);
			if (author == null) continue;
			const contacts = (contactIdsByNote.get(note.id) ?? []).filter(id => localContacts.has(id));
			const triggers = computeAiModerationTriggers({
				authorIsRemote: author.host != null,
				authorFirstSeenAt: this.idService.parse(author.id).date,
				authorHasLocalFollowers: followed.has(author.id),
				contacts: contacts.map(id => ({ userId: id, followsAuthor: follows.has(`${author.id}:${id}`) })),
				text: note.text,
				cw: note.cw,
				newAuthorDays: this.meta.aiModerationNewAuthorDays,
				localHost: this.config.hostname,
				now: this.idService.parse(note.id).date,
			});
			if (mode === 'filtered' && triggers.length === 0) continue;
			result.push({ note, triggers, author });
		}
		return result;
	}

	private async saveItems(scan: MiAiModerationScan, candidates: readonly Candidate[], scores: ReadonlyMap<string, AiModerationScores>): Promise<MiAiModerationScanItem[]> {
		const { version } = await this.aiModerationCriteriaService.current();
		const rows: MiAiModerationScanItem[] = [];
		for (const c of candidates) {
			const localScores = scores.get(c.note.id);
			if (localScores == null) continue;
			const { flagged, localLabel } = decideAiModerationFlag(localScores, null, this.meta.aiModerationLocalThreshold);
			rows.push({
				id: this.idService.gen(),
				scanId: scan.id,
				scan: null,
				noteId: c.note.id,
				noteUserId: c.note.userId,
				noteUserHost: c.note.userHost,
				noteVisibility: c.note.visibility,
				noteText: buildNoteText(c.note.cw, c.note.text),
				triggers: c.triggers,
				links: extractAiModerationLinksFromNote(c.note.text, c.note.cw, this.config.hostname),
				textFingerprint: computeAiModerationTextFingerprint(c.note.text, this.config.hostname),
				localLabel,
				localScores,
				flagged,
				spamSignals: [],
				wouldHide: false,
				criteriaVersion: version,
			});
		}
		if (rows.length > 0) {
			await this.aiModerationScanItemRepository.insert(rows.map(({ scan: _scan, ...row }) => row));
		}
		return rows;
	}

	/**
	 * 引っかけた項目に行動の目印を付け、自動で隠すモードなら隠していたかを記録する。
	 * 時間の窓は使わず、このスキャンの中で数える。隠していた件数を返す。
	 */
	private async annotate(items: readonly MiAiModerationScanItem[], candidates: readonly Candidate[]): Promise<number> {
		if (items.length === 0) return 0;
		const authorIds = [...new Set(items.map(item => item.noteUserId))];
		const followedRows = await this.followingsRepository.createQueryBuilder('following')
			.select('DISTINCT following.followeeId', 'followeeId')
			.where('following.followeeId IN (:...ids)', { ids: authorIds })
			.andWhere('following.followerHost IS NULL')
			.getRawMany<{ followeeId: string }>();
		const followed = new Set(followedRows.map(r => r.followeeId));
		const avatarByUser = new Map<string, string | null>(candidates.map(c => [c.author.id, c.author.avatarId]));
		const missing = authorIds.filter(id => !avatarByUser.has(id));
		if (missing.length > 0) {
			const users = await this.usersRepository.find({ where: { id: In(missing) }, select: { id: true, avatarId: true } });
			for (const u of users) avatarByUser.set(u.id, u.avatarId);
		}
		const newAuthorMs = this.meta.aiModerationNewAuthorDays * 24 * 60 * 60 * 1000;

		let wouldHideCount = 0;
		for (const item of items) {
			const avatarId = avatarByUser.get(item.noteUserId) ?? null;
			const counts = await this.countRelated(item);
			const signals = collectAiModerationSpamSignals({
				strangerContact: item.triggers.includes('unsolicitedContact') || item.triggers.includes('newLocalContact'),
				strangers24h: 0,
				sameTextOtherAccounts: counts.sameTextOtherAccounts,
				sameTextSameAccount: counts.sameTextSameAccount,
				sameLinkOtherAccounts: counts.sameLinkOtherAccounts,
				hostOtherFlaggedAccounts: counts.hostOtherFlaggedAccounts,
				noAvatar: avatarId == null,
				trailingNoise: TRAILING_NOISE_RE.test(item.noteText),
			});
			const postedAt = this.idService.parse(item.noteId).date.getTime();
			const wouldHide = decideAiModerationAutoHide({
				flagged: true,
				localScores: item.localScores as AiModerationScores | null,
				externalFlagged: null,
				threshold: this.meta.aiModerationAutoHideThreshold,
				signals,
				authorIsRemote: item.noteUserHost != null,
				authorIsNew: postedAt - this.idService.parse(item.noteUserId).date.getTime() < newAuthorMs,
				authorHasLocalFollowers: followed.has(item.noteUserId),
			});
			if (wouldHide) wouldHideCount++;
			await this.aiModerationScanItemRepository.update(item.id, { spamSignals: signals, wouldHide });
		}
		return wouldHideCount;
	}

	private async countRelated(item: MiAiModerationScanItem) {
		let sameTextOtherAccounts = 0;
		let sameTextSameAccount = 0;
		if (item.textFingerprint != null) {
			const row = await this.aiModerationScanItemRepository.createQueryBuilder('item')
				.select('COUNT(DISTINCT item.noteUserId) FILTER (WHERE item.noteUserId != :userId AND item.flagged = true)', 'others')
				.addSelect('COUNT(*) FILTER (WHERE item.noteUserId = :userId)', 'mine')
				.where('item.scanId = :scanId', { scanId: item.scanId })
				.andWhere('item.textFingerprint = :fingerprint', { fingerprint: item.textFingerprint })
				.setParameter('userId', item.noteUserId)
				.getRawOne<{ others: string; mine: string }>();
			sameTextOtherAccounts = Number(row?.others ?? 0);
			sameTextSameAccount = Number(row?.mine ?? 0);
		}
		let sameLinkOtherAccounts = 0;
		if (item.links.length > 0) {
			const row = await this.aiModerationScanItemRepository.createQueryBuilder('item')
				.select('COUNT(DISTINCT item.noteUserId)', 'count')
				.where('item.scanId = :scanId', { scanId: item.scanId })
				.andWhere('item.links && ARRAY[:...links]::varchar[]', { links: item.links })
				.andWhere('item.noteUserId != :userId', { userId: item.noteUserId })
				.andWhere('item.flagged = true')
				.getRawOne<{ count: string }>();
			sameLinkOtherAccounts = Number(row?.count ?? 0);
		}
		let hostOtherFlaggedAccounts = 0;
		if (item.noteUserHost != null) {
			const row = await this.aiModerationScanItemRepository.createQueryBuilder('item')
				.select('COUNT(DISTINCT item.noteUserId)', 'count')
				.where('item.scanId = :scanId', { scanId: item.scanId })
				.andWhere('item.noteUserHost = :host', { host: item.noteUserHost })
				.andWhere('item.noteUserId != :userId', { userId: item.noteUserId })
				.andWhere('item.flagged = true')
				.getRawOne<{ count: string }>();
			hostOtherFlaggedAccounts = Number(row?.count ?? 0);
		}
		return { sameTextOtherAccounts, sameTextSameAccount, sameLinkOtherAccounts, hostOtherFlaggedAccounts };
	}

	/** 終わり。あとから来た同じ文・同じリンクも数えるため、引っかけた項目の目印を付け直す */
	private async finish(scan: Pick<MiAiModerationScan, 'id'>): Promise<void> {
		const flagged = await this.aiModerationScanItemRepository.findBy({ scanId: scan.id, flagged: true });
		const wouldHide = await this.annotate(flagged, []);
		await this.aiModerationScanRepository.update(scan.id, {
			status: 'done',
			finishedAt: new Date(),
			wouldHideCount: wouldHide,
		});
		// 上限に届いて終わったときに列へ残っている、このスキャンの分は片付ける
		await this.hanamiGpuQueueService.removeWhere('spamScan', payload => (payload as ScanQueuePayload | null)?.scanId === scan.id);
		await this.redis.del(exhaustedKey(scan.id));
	}

	@bindThis
	public async packScan(scan: MiAiModerationScan) {
		const startedBy = scan.startedById != null
			? await this.usersRepository.findOne({ where: { id: scan.startedById }, select: { id: true, username: true } })
			: null;
		return {
			id: scan.id,
			createdAt: this.idService.parse(scan.id).date.toISOString(),
			status: scan.status,
			mode: scan.mode,
			target: scan.target,
			since: scan.sinceNoteId != null ? this.idService.parse(scan.sinceNoteId).date.toISOString() : null,
			until: this.idService.parse(scan.untilNoteId).date.toISOString(),
			cursorAt: scan.cursor != null ? this.idService.parse(scan.cursor).date.toISOString() : null,
			maxJudged: scan.maxJudged >= AI_MODERATION_SCAN_UNLIMITED ? null : scan.maxJudged,
			scannedCount: scan.scannedCount,
			judgedCount: scan.judgedCount,
			flaggedCount: scan.flaggedCount,
			wouldHideCount: scan.wouldHideCount,
			judgeSeconds: scan.judgeSeconds,
			startedBy: startedBy?.username ?? null,
			finishedAt: scan.finishedAt?.toISOString() ?? null,
			lastError: scan.lastError,
			criteriaVersion: scan.criteriaVersion,
		};
	}

	@bindThis
	public async packItems(items: readonly MiAiModerationScanItem[]) {
		const existing = items.length === 0 ? new Set<string>() : new Set((await this.notesRepository.find({
			where: { id: In(items.map(item => item.noteId)) },
			select: { id: true },
		})).map(note => note.id));
		return items.map(item => ({
			id: item.id,
			noteId: item.noteId,
			noteCreatedAt: this.idService.parse(item.noteId).date.toISOString(),
			noteExists: existing.has(item.noteId),
			noteUserId: item.noteUserId,
			noteUserHost: item.noteUserHost,
			noteVisibility: item.noteVisibility,
			noteText: item.noteText,
			triggers: item.triggers,
			links: item.links,
			localLabel: item.localLabel,
			localScores: item.localScores as { normal: number; spam: number; scam: number; abuse: number } | null,
			flagged: item.flagged,
			spamSignals: item.spamSignals,
			wouldHide: item.wouldHide,
			criteriaVersion: item.criteriaVersion,
		}));
	}
}
