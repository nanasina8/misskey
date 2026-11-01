/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
	AiModerationService,
	AI_MODERATION_PENDING_KEY,
	AI_MODERATION_TRIGGERS_KEY,
} from '@/core/AiModerationService.js';
import { computeAiModerationTextFingerprint } from '@/misc/ai-moderation.js';
import type { MiMeta, MiNote } from '@/models/_.js';

vi.mock('@/core/hanami/HanamiPythonRuntime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/core/hanami/HanamiPythonRuntime.js')>();
	return {
		...actual,
		probeHanamiNoteJudgeRuntime: vi.fn(async () => ({
			available: true, device: 'cpu', deviceName: 'cpu', reason: null, probedAt: new Date().toISOString(),
		})),
	};
});

vi.mock('@/core/hanami/HanamiLocalLlmLock.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/core/hanami/HanamiLocalLlmLock.js')>();
	return {
		...actual,
		acquireHanamiLocalLlmLock: vi.fn(async () => ({ token: 'token', release: vi.fn(async () => {}) })),
	};
});

function makeNote(overrides: Partial<MiNote> = {}): MiNote {
	return {
		id: 'note1',
		userId: 'author1',
		userHost: 'remote.example.com',
		visibility: 'public',
		text: 'hello',
		cw: null,
		...overrides,
	} as MiNote;
}

function makeService() {
	const meta = {
		aiModerationEnabled: true,
		aiModerationNewAuthorDays: 7,
		aiModerationDailyLimit: 500,
		aiModerationLocalEnabled: true,
		aiModerationLocalThreshold: 0.6,
		aiModerationExternalEnabled: false,
		aiModerationExternalVisibilities: ['public', 'home', 'followers'],
		aiModerationAutoHideMode: 'off',
		aiModerationAutoHideThreshold: 0.9,
		aiModerationAutoHideDailyLimit: 50,
		aiModerationAutoHideHosts: false,
	} as unknown as MiMeta;

	const config = { hostname: 'misskey.example.com' } as any;

	const redis = {
		zadd: vi.fn(async (..._args: any[]) => 1),
		zrem: vi.fn(async (..._args: any[]) => 1),
		zpopmin: vi.fn(async (..._args: any[]) => ([] as string[])),
		incr: vi.fn(async (..._args: any[]) => 1),
		expire: vi.fn(async (..._args: any[]) => 1),
		hset: vi.fn(async (..._args: any[]) => 1),
		hmget: vi.fn(async (..._args: any[]) => ([] as (string | null)[])),
		hdel: vi.fn(async (..._args: any[]) => 1),
		set: vi.fn(async (..._args: any[]) => 'OK'),
		get: vi.fn(async (..._args: any[]) => null as string | null),
		multi: vi.fn(() => ({ zadd: vi.fn(), hset: vi.fn(), exec: vi.fn(async () => []) })),
	};

	const usersRepository = {
		findOneBy: vi.fn(async (..._args: any[]) => ({ id: 'author1', host: 'remote.example.com', isSuspended: false })),
		find: vi.fn(async (..._args: any[]) => [{ id: 'author1', avatarId: null }]),
	};

	const followingsRepository = {
		findBy: vi.fn(async (..._args: any[]) => []),
		exists: vi.fn(async (..._args: any[]) => false),
		countBy: vi.fn(async (..._args: any[]) => 0),
		createQueryBuilder: vi.fn(() => {
			const qb: any = {
				select: vi.fn(() => qb),
				where: vi.fn(() => qb),
				andWhere: vi.fn(() => qb),
				getRawMany: vi.fn(async () => []),
			};
			return qb;
		}),
	};

	const notesRepository = {
		findBy: vi.fn(async (..._args: any[]) => [makeNote()]),
	};

	const aiModerationQueueRepository = {
		findOneBy: vi.fn(async (..._args: any[]) => null),
		insertOne: vi.fn(async (row: unknown) => row),
		update: vi.fn(async (..._args: any[]) => {}),
		createQueryBuilder: vi.fn(() => {
			const qb: any = {
				select: vi.fn(() => qb),
				addSelect: vi.fn(() => qb),
				where: vi.fn(() => qb),
				andWhere: vi.fn(() => qb),
				setParameter: vi.fn(() => qb),
				getRawMany: vi.fn(async () => []),
				getRawOne: vi.fn(async () => ({ others: '0', mine: '1', count: '0', accounts: '0' })),
			};
			return qb;
		}),
	};

	const idService = {
		parse: vi.fn(() => ({ date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })),
		gen: vi.fn(() => 'queue1'),
	};

	const roleService = {
		isModerator: vi.fn(async (..._args: any[]) => false),
	};

	const aiModerationExternalService = {
		moderate: vi.fn(async (..._args: any[]) => null),
	};

	const systemWebhookService = {
		enqueueSystemWebhook: vi.fn(async (..._args: any[]) => {}),
	};

	const aiModerationHiddenService = {
		isHiddenAuthor: vi.fn((..._args: any[]) => false),
		isHiddenHost: vi.fn((..._args: any[]) => false),
		hide: vi.fn(async (..._args: any[]) => true),
	};

	const aiModerationCriteriaService = {
		current: vi.fn(async () => ({ version: 'crit1', criteria: {} })),
	};

	const loggerService = {
		getLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), succ: vi.fn() })),
	};

	const service = new AiModerationService(
		meta, config, redis as any,
		usersRepository as any, followingsRepository as any, notesRepository as any, aiModerationQueueRepository as any,
		idService as any, roleService as any, aiModerationExternalService as any, aiModerationHiddenService as any, aiModerationCriteriaService as any, systemWebhookService as any, loggerService as any,
	);

	return {
		service, meta, config, redis, usersRepository, followingsRepository, notesRepository,
		aiModerationQueueRepository, idService, roleService, aiModerationExternalService, aiModerationHiddenService, systemWebhookService,
	};
}

type ConsiderInput = Parameters<AiModerationService['considerNote']>[1];

function baseInput(overrides: Partial<ConsiderInput> = {}): ConsiderInput {
	return {
		user: { id: 'author1', host: 'remote.example.com' },
		text: 'こんにちは',
		cw: null,
		mentions: [],
		visibleUsers: null,
		reply: null,
		...overrides,
	};
}

describe('AiModerationService.considerNote', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('宛先0人かつリンク無しでは DB / Redis / RoleService に触れない', async () => {
		const m = makeService();
		await m.service.considerNote(makeNote(), baseInput());

		expect(m.usersRepository.findOneBy).not.toHaveBeenCalled();
		expect(m.roleService.isModerator).not.toHaveBeenCalled();
		expect(m.followingsRepository.findBy).not.toHaveBeenCalled();
		expect(m.followingsRepository.exists).not.toHaveBeenCalled();
		expect(m.redis.zadd).not.toHaveBeenCalled();
		expect(m.redis.hset).not.toHaveBeenCalled();
	});

	test('DM の宛先だけでも unsolicitedContact が付き待ち行列に入る', async () => {
		const m = makeService();
		await m.service.considerNote(makeNote(), baseInput({
			text: 'お知らせ',
			visibleUsers: [{ id: 'local1', host: null }],
		}));

		expect(m.redis.zadd).toHaveBeenCalledWith(AI_MODERATION_PENDING_KEY, 'NX', expect.any(Number), 'note1');
		const hsetCall = m.redis.hset.mock.calls.find(c => c[0] === AI_MODERATION_TRIGGERS_KEY);
		expect(hsetCall).toBeDefined();
		expect(JSON.parse(hsetCall![2]).triggers).toContain('unsolicitedContact');
	});

	test('返信先だけでも unsolicitedContact が付き待ち行列に入る', async () => {
		const m = makeService();
		await m.service.considerNote(makeNote(), baseInput({
			text: '返信です',
			reply: { userId: 'local2', userHost: null },
		}));

		const hsetCall = m.redis.hset.mock.calls.find(c => c[0] === AI_MODERATION_TRIGGERS_KEY);
		expect(hsetCall).toBeDefined();
		expect(JSON.parse(hsetCall![2]).triggers).toContain('unsolicitedContact');
	});

	test('投稿者本人は宛先に数えない', async () => {
		const m = makeService();
		await m.service.considerNote(makeNote(), baseInput({
			text: '自分宛て',
			visibleUsers: [{ id: 'author1', host: null }],
		}));

		expect(m.redis.zadd).not.toHaveBeenCalled();
	});
});

describe('AiModerationService.processPending', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('runSpamJudge が例外でも全件が localLabel=unavailable で保存される', async () => {
		const m = makeService();
		m.redis.zpopmin.mockResolvedValue(['note1', '100']); // ioredis と同じ平らな配列
		m.redis.hmget.mockResolvedValue([JSON.stringify(['unsolicitedContact'])]);
		m.notesRepository.findBy.mockResolvedValue([makeNote({ text: 'セール中 shop.example/sale ormh' })]);
		vi.spyOn(m.service, 'runSpamJudge').mockRejectedValue(new Error('boom'));

		await m.service.processPending();

		expect(m.aiModerationQueueRepository.insertOne).toHaveBeenCalledTimes(1);
		const saved = m.aiModerationQueueRepository.insertOne.mock.calls[0][0] as any;
		expect(saved.noteId).toBe('note1');
		expect(saved.localLabel).toBe('unavailable');
		expect(saved.localScores).toBeNull();
	});

	test('保存時に links / textFingerprint / contactUserIds / contactKind が埋まる', async () => {
		const m = makeService();
		m.redis.zpopmin.mockResolvedValue(['note1', '100']); // ioredis と同じ平らな配列
		m.redis.hmget.mockResolvedValue([JSON.stringify({
			triggers: ['newAuthorLink'],
			contactUserIds: ['local1', 'local2'],
			contactKind: 'dm',
		})]);
		m.notesRepository.findBy.mockResolvedValue([makeNote({ text: 'jmty.io/shop/ 見て ormh' })]);
		vi.spyOn(m.service, 'runSpamJudge').mockResolvedValue(new Map());

		await m.service.processPending();

		const saved = m.aiModerationQueueRepository.insertOne.mock.calls[0][0] as any;
		expect(saved.links).toEqual(['jmty.io/shop']);
		expect(saved.textFingerprint).toBe(computeAiModerationTextFingerprint('jmty.io/shop/ 見て ormh', 'misskey.example.com'));
		expect(saved.contactUserIds).toEqual(['local1', 'local2']);
		expect(saved.contactKind).toBe('dm');
	});

	test('古い形式（配列）の Redis 値も triggers として読める', async () => {
		const m = makeService();
		m.redis.zpopmin.mockResolvedValue(['note1', '100']); // ioredis と同じ平らな配列
		m.redis.hmget.mockResolvedValue([JSON.stringify(['unsolicitedContact'])]);
		m.notesRepository.findBy.mockResolvedValue([makeNote({ text: 'セール中 shop.example/sale ormh' })]);
		vi.spyOn(m.service, 'runSpamJudge').mockResolvedValue(new Map());

		await m.service.processPending();

		const saved = m.aiModerationQueueRepository.insertOne.mock.calls[0][0] as any;
		expect(saved.triggers).toEqual(['unsolicitedContact']);
		expect(saved.contactUserIds).toEqual([]);
		expect(saved.contactKind).toBeNull();
	});
});

describe('AiModerationService.processPending の取り出し', () => {
	test('複数件を正しい投稿 ID で扱う（zpopmin は平らな配列）', async () => {
		const m = makeService();
		m.redis.zpopmin.mockResolvedValue(['noteA', '100', 'noteB', '101']);
		m.redis.hmget.mockResolvedValue([null, null]);
		m.notesRepository.findBy.mockResolvedValue([makeNote({ id: 'noteA' }), makeNote({ id: 'noteB' })]);
		vi.spyOn(m.service, 'runSpamJudge').mockResolvedValue(new Map());

		await m.service.processPending();

		expect(m.redis.hmget).toHaveBeenCalledWith('aiModeration:triggers', 'noteA', 'noteB');
		expect(m.aiModerationQueueRepository.insertOne).toHaveBeenCalledTimes(2);
	});
});

describe('AiModerationService 自動で隠す', () => {
	function flaggedSetup(mode: 'off' | 'trial' | 'on') {
		const m = makeService();
		(m.meta as any).aiModerationAutoHideMode = mode;
		m.redis.zpopmin.mockResolvedValue(['note1', '100']); // ioredis と同じ平らな配列
		m.redis.hmget.mockResolvedValue([JSON.stringify({ triggers: ['unsolicitedContact'], contactUserIds: ['local1'], contactKind: 'dm' })]);
		m.notesRepository.findBy.mockResolvedValue([makeNote({ text: 'セール中 shop.example/sale ormh' })]);
		vi.spyOn(m.service, 'runSpamJudge').mockResolvedValue(new Map([['note1', { normal: 0.01, spam: 0.9, scam: 0.08, abuse: 0.01 }]]));
		return m;
	}

	test('off では隠さないが、根拠は記録する', async () => {
		const m = flaggedSetup('off');
		await m.service.processPending();
		expect(m.aiModerationHiddenService.hide).not.toHaveBeenCalled();
		expect(m.aiModerationQueueRepository.update).toHaveBeenCalledWith('queue1', { spamSignals: ['strangerContact', 'noAvatar', 'trailingNoise'] });
		expect(m.aiModerationQueueRepository.update).not.toHaveBeenCalledWith('queue1', expect.objectContaining({ autoAction: expect.anything() }));
	});

	test('リンクだけの投稿（知らない人へ送っていない）は on でも隠さない', async () => {
		const m = flaggedSetup('on');
		m.redis.hmget.mockResolvedValue([JSON.stringify({ triggers: ['newAuthorLink'], contactUserIds: [], contactKind: null })]);
		await m.service.processPending();
		expect(m.aiModerationHiddenService.hide).not.toHaveBeenCalled();
	});

	test('trial では隠さず wouldHide と記録する', async () => {
		const m = flaggedSetup('trial');
		await m.service.processPending();
		expect(m.aiModerationHiddenService.hide).not.toHaveBeenCalled();
		expect(m.aiModerationQueueRepository.update).toHaveBeenCalledWith('queue1', { autoAction: 'wouldHide' });
	});

	test('on ではアカウントを自動で隠し hidden と記録する', async () => {
		const m = flaggedSetup('on');
		await m.service.processPending();
		expect(m.aiModerationHiddenService.hide).toHaveBeenCalledWith({ targetType: 'user', userId: 'author1' }, { moderator: null, sourceQueueId: 'queue1' });
		expect(m.aiModerationQueueRepository.update).toHaveBeenCalledWith('queue1', { autoAction: 'hidden' });
	});

	test('1日の上限を超えたら隠さない', async () => {
		const m = flaggedSetup('on');
		(m.meta as any).aiModerationAutoHideDailyLimit = 0;
		await m.service.processPending();
		expect(m.aiModerationHiddenService.hide).not.toHaveBeenCalled();
	});

	test('すでに隠している相手には何もしない', async () => {
		const m = flaggedSetup('on');
		m.aiModerationHiddenService.isHiddenAuthor.mockReturnValue(true);
		await m.service.processPending();
		expect(m.aiModerationHiddenService.hide).not.toHaveBeenCalled();
	});
});

describe('AiModerationService 実行環境の記録', () => {
	test('判定のたびに確かめた実行環境を Redis に残す（API のプロセスから読めるように）', async () => {
		const m = makeService();
		m.redis.zpopmin.mockResolvedValue(['note1', '100']); // ioredis と同じ平らな配列
		m.redis.hmget.mockResolvedValue([JSON.stringify({ triggers: ['unsolicitedContact'], contactUserIds: [], contactKind: null })]);
		vi.spyOn(m.service, 'runSpamJudge').mockResolvedValue(new Map());
		await m.service.processPending();
		expect(m.redis.set).toHaveBeenCalledWith('aiModeration:runtime', expect.stringContaining('"available":true'), 'EX', 86400);
	});

	test('loadRuntime は Redis に残った結果を優先する', async () => {
		const m = makeService();
		m.redis.get.mockResolvedValue(JSON.stringify({ available: false, device: null, deviceName: null, reason: 'no gpu', probedAt: '2026-11-01T00:00:00.000Z' }));
		expect(await m.service.loadRuntime()).toMatchObject({ available: false, reason: 'no gpu' });
	});
});
