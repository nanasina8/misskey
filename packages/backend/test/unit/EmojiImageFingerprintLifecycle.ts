/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import sharp from 'sharp';
import { IsNull } from 'typeorm';
import { AppLockService } from '@/core/AppLockService.js';
import { EmojiImageFingerprintError, EmojiImageFingerprintService } from '@/core/EmojiImageFingerprintService.js';
import { StatusError } from '@/misc/status-error.js';
import { EmojiImageFingerprintSourceService } from '@/core/EmojiImageFingerprintSourceService.js';
import { EmojiImageFingerprintProcessorService } from '@/queue/processors/EmojiImageFingerprintProcessorService.js';

describe('EmojiImageFingerprintProcessorService', () => {
	function makeProcessor(deps: { sourceService?: unknown; fingerprintService?: unknown } = {}) {
		const emojisRepository = {
			findOneBy: jest.fn<(...args: any[]) => Promise<unknown>>(),
			update: jest.fn<(...args: any[]) => Promise<unknown>>(),
			createQueryBuilder: jest.fn<(...args: any[]) => unknown>(),
		};
		const appLockService = {
			getEmojiImageFingerprintLock: jest.fn<(...args: any[]) => Promise<() => void>>(),
		};
		const queueService = {
			createEmojiImageFingerprintJob: jest.fn<(...args: any[]) => Promise<unknown>>(),
			createEmojiImageFingerprintBackfillJob: jest.fn<(...args: any[]) => Promise<unknown>>(),
		};
		const queueLoggerService = { logger: { info: jest.fn(), warn: jest.fn() } };
		const sourceService: any = deps.sourceService ?? { read: jest.fn<(...args: any[]) => Promise<unknown>>() };
		const fingerprintService: any = deps.fingerprintService ?? { compute: jest.fn<(...args: any[]) => Promise<unknown>>() };
		const processor = new EmojiImageFingerprintProcessorService(
			emojisRepository as never,
			sourceService as never,
			fingerprintService as never,
			appLockService as never,
			queueService as never,
			queueLoggerService as never,
		);
		return { processor, emojisRepository, sourceService, fingerprintService, appLockService, queueService, queueLoggerService };
	}

	describe('process', () => {
		test('acquires the emoji lock and releases it after a successful update', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, sourceService, fingerprintService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' });
			sourceService.read.mockResolvedValue(Buffer.from('img'));
			fingerprintService.compute.mockResolvedValue('pix-v1:deadbeef');

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: 'example.com' } } as never);

			expect(appLockService.getEmojiImageFingerprintLock).toHaveBeenCalledWith('e1');
			expect(sourceService.read).toHaveBeenCalledWith({ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' });
			expect(fingerprintService.compute).toHaveBeenCalledWith(Buffer.from('img'));
			expect(emojisRepository.update).toHaveBeenCalledWith(
				{ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' },
				{ imageFingerprint: 'pix-v1:deadbeef', imageFingerprintAttemptedAt: expect.any(Date), imageFingerprintErrorCode: null },
			);
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('persists a real pix-v1 fingerprint from the resolved source', async () => {
			const codec = new EmojiImageFingerprintService();
			const png = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
			const unlock = jest.fn();
			const { processor, emojisRepository, appLockService } = makeProcessor({
				fingerprintService: codec,
				sourceService: { read: jest.fn<(...args: any[]) => Promise<unknown>>(async () => png) },
			});
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: null });

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: null } } as never);

			const [criteria, patch] = emojisRepository.update.mock.calls[0];
			expect(criteria.id).toBe('e1');
			expect(criteria.publicUrl).toBe('https://example.com/a.png');
			expect(criteria.host).toEqual(IsNull());
			expect(patch.imageFingerprint).toMatch(/^pix-v1:[0-9a-f]{64}$/);
			expect(patch.imageFingerprintErrorCode).toBeNull();
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('suppresses a job whose emoji has been deleted', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, sourceService, fingerprintService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue(null);

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: 'example.com' } } as never);

			expect(sourceService.read).not.toHaveBeenCalled();
			expect(fingerprintService.compute).not.toHaveBeenCalled();
			expect(emojisRepository.update).not.toHaveBeenCalled();
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('suppresses a stale job whose publicUrl changed since enqueue', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, sourceService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/new.png', host: 'example.com' });

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/old.png', host: 'example.com' } } as never);

			expect(sourceService.read).not.toHaveBeenCalled();
			expect(emojisRepository.update).not.toHaveBeenCalled();
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('suppresses a stale job whose host changed since enqueue', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, sourceService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'other.example' });

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: 'example.com' } } as never);

			expect(sourceService.read).not.toHaveBeenCalled();
			expect(emojisRepository.update).not.toHaveBeenCalled();
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('clears the fingerprint on a permanent codec error without rethrowing', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, fingerprintService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' });
			fingerprintService.compute.mockRejectedValue(new EmojiImageFingerprintError('INVALID_IMAGE', 'Image cannot be decoded'));

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: 'example.com' } } as never);

			expect(emojisRepository.update).toHaveBeenCalledWith(
				{ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' },
				{ imageFingerprint: null, imageFingerprintAttemptedAt: expect.any(Date), imageFingerprintErrorCode: 'INVALID_IMAGE' },
			);
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('clears the fingerprint on a permanent source error without computing', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, sourceService, fingerprintService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' });
			sourceService.read.mockRejectedValue(new EmojiImageFingerprintError('INPUT_TOO_LARGE', 'Image exceeds the 16 MiB fingerprint input limit'));

			await processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: 'example.com' } } as never);

			expect(fingerprintService.compute).not.toHaveBeenCalled();
			expect(emojisRepository.update).toHaveBeenCalledWith(
				{ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' },
				{ imageFingerprint: null, imageFingerprintAttemptedAt: expect.any(Date), imageFingerprintErrorCode: 'INPUT_TOO_LARGE' },
			);
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test('rethrows transient errors, records the reason, and keeps the row retryable', async () => {
			const unlock = jest.fn();
			const { processor, emojisRepository, fingerprintService, appLockService, queueLoggerService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' });
			const failure = Object.assign(new Error('no such file'), { code: 'ENOENT' });
			fingerprintService.compute.mockRejectedValue(failure);

			await expect(processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: 'example.com' } } as never)).rejects.toThrow('no such file');

			// attemptedAt は立てない（再試行の対象に残す）が、理由は残す。
			// 残さないとDB上は永遠に pending のままで、未着手なのか失敗なのかが区別できない。
			expect(emojisRepository.update).toHaveBeenCalledWith(
				{ id: 'e1', publicUrl: 'https://example.com/a.png', host: 'example.com' },
				{ imageFingerprintErrorCode: 'ENOENT' },
			);
			expect(queueLoggerService.logger.warn).toHaveBeenCalledWith('emoji-image-fingerprint-transient-failure', expect.objectContaining({ emojiId: 'e1', code: 'ENOENT' }));
			expect(unlock).toHaveBeenCalledTimes(1);
		});

		test.each([
			[Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
			[new StatusError('forbidden', 403, 'Forbidden'), 'HTTP_403'],
			[new TypeError('bad'), 'TypeError'],
			['plain string', 'UNKNOWN'],
		])('一過性エラーを短いコードに落とす', async (thrown, expected) => {
			const unlock = jest.fn();
			const { processor, emojisRepository, fingerprintService, appLockService } = makeProcessor();
			appLockService.getEmojiImageFingerprintLock.mockResolvedValue(unlock);
			emojisRepository.findOneBy.mockResolvedValue({ id: 'e1', publicUrl: 'https://example.com/a.png', host: null });
			fingerprintService.compute.mockRejectedValue(thrown);

			await expect(processor.process({ data: { emojiId: 'e1', sourceUrl: 'https://example.com/a.png', host: null } } as never)).rejects.toBeDefined();

			expect(emojisRepository.update).toHaveBeenCalledWith(expect.anything(), { imageFingerprintErrorCode: expected });
		});
	});

	describe('processBackfill', () => {
		function makeQueryBuilder(rows: unknown[]) {
			const where = jest.fn<(...args: any[]) => unknown>();
			const andWhere = jest.fn<(...args: any[]) => unknown>();
			const orderBy = jest.fn<(...args: any[]) => unknown>();
			const take = jest.fn<(...args: any[]) => unknown>();
			const getMany = jest.fn<() => Promise<unknown[]>>(async () => rows);
			const builder = { where, andWhere, orderBy, take, getMany };
			where.mockReturnValue(builder);
			andWhere.mockReturnValue(builder);
			orderBy.mockReturnValue(builder);
			take.mockReturnValue(builder);
			return builder;
		}

		function emoji(id: string): unknown {
			return { id, publicUrl: `https://example.com/${id}.png`, host: null };
		}

		test('enqueues a compute job per row and pages on a full page', async () => {
			const rows = Array.from({ length: 100 }, (_, i) => emoji(`e${i}`));
			const builder = makeQueryBuilder(rows);
			const { processor, emojisRepository, queueService, queueLoggerService } = makeProcessor();
			emojisRepository.createQueryBuilder.mockReturnValue(builder);

			await processor.processBackfill({ data: {} } as never);

			expect(emojisRepository.createQueryBuilder).toHaveBeenCalledWith('emoji');
			expect(builder.where).toHaveBeenCalledWith('emoji."imageFingerprint" IS NULL');
			expect(builder.andWhere).toHaveBeenCalledWith('emoji."imageFingerprintAttemptedAt" IS NULL');
			expect(builder.andWhere).toHaveBeenCalledWith('1=1', {});
			// scope 未指定は全件なのでホスト条件は付かない
			expect(builder.andWhere).not.toHaveBeenCalledWith('emoji.host IS NULL');
			expect(builder.orderBy).toHaveBeenCalledWith('emoji.id', 'ASC');
			expect(builder.take).toHaveBeenCalledWith(100);

			expect(queueService.createEmojiImageFingerprintJob).toHaveBeenCalledTimes(100);
			expect(queueService.createEmojiImageFingerprintJob).toHaveBeenNthCalledWith(1, { emojiId: 'e0', sourceUrl: 'https://example.com/e0.png', host: null });
			expect(queueService.createEmojiImageFingerprintJob).toHaveBeenLastCalledWith({ emojiId: 'e99', sourceUrl: 'https://example.com/e99.png', host: null });
			expect(queueService.createEmojiImageFingerprintBackfillJob).toHaveBeenCalledWith({ scope: 'all', host: undefined, cursor: 'e99' });
			expect(queueLoggerService.logger.info).toHaveBeenCalledWith('emoji-image-fingerprint-backfill', expect.objectContaining({ status: 'seeded', count: 100, pending: 'more', cursor: null, durationMs: expect.any(Number) }));
		});

		test('does not schedule a continuation when fewer than a page is returned', async () => {
			const rows = [emoji('e0'), emoji('e1'), emoji('e2')];
			const builder = makeQueryBuilder(rows);
			const { processor, emojisRepository, queueService } = makeProcessor();
			emojisRepository.createQueryBuilder.mockReturnValue(builder);

			await processor.processBackfill({ data: {} } as never);

			expect(queueService.createEmojiImageFingerprintJob).toHaveBeenCalledTimes(3);
			expect(queueService.createEmojiImageFingerprintBackfillJob).not.toHaveBeenCalled();
		});

		test('scopes the query by the supplied cursor and pages from the last row', async () => {
			const rows = Array.from({ length: 100 }, (_, i) => emoji(`e${i}`));
			const builder = makeQueryBuilder(rows);
			const { processor, emojisRepository, queueService } = makeProcessor();
			emojisRepository.createQueryBuilder.mockReturnValue(builder);

			await processor.processBackfill({ data: { cursor: 'e42' } } as never);

			expect(builder.andWhere).toHaveBeenCalledWith('emoji.id > :cursor', { cursor: 'e42' });
			expect(queueService.createEmojiImageFingerprintBackfillJob).toHaveBeenCalledWith({ scope: 'all', host: undefined, cursor: 'e99' });
		});

		test('scope local narrows to local emojis and keeps the scope while paging', async () => {
			const rows = Array.from({ length: 100 }, (_, i) => emoji(`e${i}`));
			const builder = makeQueryBuilder(rows);
			const { processor, emojisRepository, queueService } = makeProcessor();
			emojisRepository.createQueryBuilder.mockReturnValue(builder);

			await processor.processBackfill({ data: { scope: 'local' } } as never);

			// ローカルは自ホストのストレージしか読まず件数も桁違いに少ないので、全体走査と分けて先に完走させる
			expect(builder.andWhere).toHaveBeenCalledWith('emoji.host IS NULL');
			expect(queueService.createEmojiImageFingerprintBackfillJob).toHaveBeenCalledWith({ scope: 'local', host: undefined, cursor: 'e99' });
		});

		test('a host-scoped backfill filters by host and keeps it while paging', async () => {
			const rows = Array.from({ length: 100 }, (_, i) => emoji(`e${i}`));
			const builder = makeQueryBuilder(rows);
			const { processor, emojisRepository, queueService } = makeProcessor();
			emojisRepository.createQueryBuilder.mockReturnValue(builder);

			await processor.processBackfill({ data: { host: 'remote.example' } } as never);

			expect(builder.andWhere).toHaveBeenCalledWith('emoji.host = :host', { host: 'remote.example' });
			expect(queueService.createEmojiImageFingerprintBackfillJob).toHaveBeenCalledWith({ scope: 'all', host: 'remote.example', cursor: 'e99' });
		});

		test('schedules nothing for an empty result set', async () => {
			const builder = makeQueryBuilder([]);
			const { processor, emojisRepository, queueService } = makeProcessor();
			emojisRepository.createQueryBuilder.mockReturnValue(builder);

			await processor.processBackfill({ data: {} } as never);

			expect(queueService.createEmojiImageFingerprintJob).not.toHaveBeenCalled();
			expect(queueService.createEmojiImageFingerprintBackfillJob).not.toHaveBeenCalled();
		});
	});
});

describe('EmojiImageFingerprintSourceService', () => {
	function makeSource() {
		const driveFilesRepository = {
			findOne: jest.fn<(...args: any[]) => Promise<unknown>>(),
		};
		const internalStorageService = {
			readBytes: jest.fn<(...args: any[]) => Promise<unknown>>(),
		};
		const s3Service = {
			readBytes: jest.fn<(...args: any[]) => Promise<unknown>>(),
		};
		const metaService = {
			fetch: jest.fn<(...args: any[]) => Promise<unknown>>(),
		};
		const downloadService = {
			downloadFingerprintImage: jest.fn<(...args: any[]) => Promise<unknown>>(),
		};
		const source = new EmojiImageFingerprintSourceService(
			{} as never,
			driveFilesRepository as never,
			internalStorageService as never,
			s3Service as never,
			metaService as never,
			downloadService as never,
		);
		return { source, driveFilesRepository, internalStorageService, s3Service, metaService, downloadService };
	}

	test('downloads remote emoji directly without consulting the drive', async () => {
		const { source, driveFilesRepository, downloadService } = makeSource();
		downloadService.downloadFingerprintImage.mockResolvedValue(Buffer.from('remote'));

		const result = await source.read({ host: 'example.com', publicUrl: 'https://example.com/a.png' });

		expect(result).toEqual(Buffer.from('remote'));
		expect(downloadService.downloadFingerprintImage).toHaveBeenCalledWith('https://example.com/a.png');
		expect(driveFilesRepository.findOne).not.toHaveBeenCalled();
	});

	test('falls back to download when no drive file matches', async () => {
		const { source, driveFilesRepository, downloadService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue(null);
		downloadService.downloadFingerprintImage.mockResolvedValue(Buffer.from('fallback'));

		const result = await source.read({ host: null, publicUrl: 'https://example.com/a.png' });

		expect(result).toEqual(Buffer.from('fallback'));
		expect(downloadService.downloadFingerprintImage).toHaveBeenCalledWith('https://example.com/a.png');
	});

	test('falls back to download when the drive file is a link', async () => {
		const { source, driveFilesRepository, downloadService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ isLink: true });
		downloadService.downloadFingerprintImage.mockResolvedValue(Buffer.from('linked'));

		const result = await source.read({ host: null, publicUrl: 'https://example.com/a.png' });

		expect(result).toEqual(Buffer.from('linked'));
	});

	test('reads internal storage with the webpublic key for a matched webpublic URL', async () => {
		const publicUrl = 'https://example.com/a.png';
		const { source, driveFilesRepository, internalStorageService, metaService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ webpublicUrl: publicUrl, url: publicUrl, isLink: false, webpublicAccessKey: 'webkey', accessKey: 'ackey', storedInternal: true });
		internalStorageService.readBytes.mockResolvedValue(Buffer.from('internal'));

		const result = await source.read({ host: null, publicUrl });

		expect(result).toEqual(Buffer.from('internal'));
		expect(internalStorageService.readBytes).toHaveBeenCalledWith('webkey');
		expect(metaService.fetch).not.toHaveBeenCalled();
	});

	test('reads object storage with the webpublic key when not stored internally', async () => {
		const publicUrl = 'https://example.com/a.png';
		const meta = { objectStorageBucket: 'emoji-bucket' };
		const { source, driveFilesRepository, s3Service, metaService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ webpublicUrl: publicUrl, url: publicUrl, isLink: false, webpublicAccessKey: 'webkey', accessKey: 'ackey', storedInternal: false });
		metaService.fetch.mockResolvedValue(meta);
		s3Service.readBytes.mockResolvedValue(Buffer.from('s3'));

		const result = await source.read({ host: null, publicUrl });

		expect(result).toEqual(Buffer.from('s3'));
		expect(metaService.fetch).toHaveBeenCalledTimes(1);
		expect(s3Service.readBytes).toHaveBeenCalledWith(meta, { Bucket: 'emoji-bucket', Key: 'webkey' });
	});

	test('uses the access key when the webpublic URL does not match', async () => {
		const { source, driveFilesRepository, internalStorageService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ webpublicUrl: null, url: 'https://example.com/a.png', isLink: false, webpublicAccessKey: null, accessKey: 'ackey', storedInternal: true });
		internalStorageService.readBytes.mockResolvedValue(Buffer.from('internal'));

		const result = await source.read({ host: null, publicUrl: 'https://example.com/a.png' });

		expect(result).toEqual(Buffer.from('internal'));
		expect(internalStorageService.readBytes).toHaveBeenCalledWith('ackey');
	});

	test('falls back to download when there is no usable access key', async () => {
		const { source, driveFilesRepository, downloadService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ webpublicUrl: null, url: 'https://example.com/a.png', isLink: false, webpublicAccessKey: null, accessKey: null, storedInternal: true });
		downloadService.downloadFingerprintImage.mockResolvedValue(Buffer.from('downloaded'));

		const result = await source.read({ host: null, publicUrl: 'https://example.com/a.png' });

		expect(result).toEqual(Buffer.from('downloaded'));
		expect(downloadService.downloadFingerprintImage).toHaveBeenCalledWith('https://example.com/a.png');
	});

	test('falls back to originalUrl when publicUrl is empty on a legacy row', async () => {
		const { source, driveFilesRepository, downloadService } = makeSource();
		downloadService.downloadFingerprintImage.mockResolvedValue(Buffer.from('legacy'));

		const result = await source.read({ host: 'example.com', publicUrl: '', originalUrl: 'https://example.com/original.png' });

		expect(result).toEqual(Buffer.from('legacy'));
		expect(downloadService.downloadFingerprintImage).toHaveBeenCalledWith('https://example.com/original.png');
		expect(driveFilesRepository.findOne).not.toHaveBeenCalled();
	});

	test('resolves the drive file by the fallback URL for a local legacy row', async () => {
		const { source, driveFilesRepository, internalStorageService } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ webpublicUrl: 'https://example.com/original.png', url: 'https://example.com/original.png', isLink: false, webpublicAccessKey: 'webkey', accessKey: 'ackey', storedInternal: true });
		internalStorageService.readBytes.mockResolvedValue(Buffer.from('internal'));

		const result = await source.read({ host: null, publicUrl: '', originalUrl: 'https://example.com/original.png' });

		expect(result).toEqual(Buffer.from('internal'));
		expect(internalStorageService.readBytes).toHaveBeenCalledWith('webkey');
	});

	test.each([
		['no URL at all', { host: 'example.com', publicUrl: '', originalUrl: '' }],
		['a non-HTTP URL', { host: 'example.com', publicUrl: 'data:image/png;base64,AAAA', originalUrl: '' }],
		['an unparsable URL', { host: 'example.com', publicUrl: 'not a url', originalUrl: '' }],
	])('rejects %s as a permanent fingerprint error instead of throwing a raw TypeError', async (_label, emoji) => {
		const { source, downloadService } = makeSource();

		// EmojiImageFingerprintError でないとキューが再スローし、リトライを使い切って failed に積み上がる
		await expect(source.read(emoji)).rejects.toBeInstanceOf(EmojiImageFingerprintError);
		expect(downloadService.downloadFingerprintImage).not.toHaveBeenCalled();
	});

	test('throws when object storage is required but not configured', async () => {
		const publicUrl = 'https://example.com/a.png';
		const { source, driveFilesRepository, metaService, s3Service } = makeSource();
		driveFilesRepository.findOne.mockResolvedValue({ webpublicUrl: publicUrl, url: publicUrl, isLink: false, webpublicAccessKey: 'webkey', accessKey: 'ackey', storedInternal: false });
		metaService.fetch.mockResolvedValue({ objectStorageBucket: null });

		await expect(source.read({ host: null, publicUrl })).rejects.toThrow('Object storage bucket is not configured');
		expect(s3Service.readBytes).not.toHaveBeenCalled();
	});
});

describe('AppLockService fingerprint lock', () => {
	test('derives the lock key from the emoji id with a 30 second default timeout', async () => {
		const service = Object.create(AppLockService.prototype) as AppLockService;
		const lock = jest.fn<(...args: any[]) => Promise<() => void>>(async () => () => {});
		(service as unknown as { lock: unknown }).lock = lock;

		await service.getEmojiImageFingerprintLock('emoji-1');
		expect(lock).toHaveBeenCalledWith('emoji-image-fingerprint:emoji-1', 30_000);

		await service.getEmojiImageFingerprintLock('emoji-1', 1234);
		expect(lock).toHaveBeenLastCalledWith('emoji-image-fingerprint:emoji-1', 1234);
	});
});
