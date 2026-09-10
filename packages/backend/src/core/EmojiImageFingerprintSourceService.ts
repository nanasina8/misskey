/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type { MiEmoji } from '@/models/Emoji.js';
import { DownloadService } from '@/core/DownloadService.js';
import { EmojiImageFingerprintError } from '@/core/EmojiImageFingerprintService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { MetaService } from '@/core/MetaService.js';
import { S3Service } from '@/core/S3Service.js';

function isFetchableHttpUrl(url: string): boolean {
	if (url === '') return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/** Resolves only an emoji's persisted displayed source; never accepts client URLs. */
@Injectable()
export class EmojiImageFingerprintSourceService {
	constructor(
		@Inject(DI.config) private config: Config,
		@Inject(DI.driveFilesRepository) private driveFilesRepository: DriveFilesRepository,
		private internalStorageService: InternalStorageService,
		private s3Service: S3Service,
		private metaService: MetaService,
		private downloadService: DownloadService,
	) {}

	public async read(emoji: Pick<MiEmoji, 'host' | 'publicUrl'> & Partial<Pick<MiEmoji, 'originalUrl'>>): Promise<Buffer> {
		// publicUrlは古いレコードでは空文字になりうるので、表示URLの解決と同じくoriginalUrlへフォールバックする
		// （publicUrlはstringなので??はだめ）。
		const url = emoji.publicUrl || (emoji.originalUrl ?? '');
		if (!isFetchableHttpUrl(url)) throw new EmojiImageFingerprintError('INVALID_IMAGE', 'Emoji has no usable image URL');

		if (emoji.host !== null) return this.downloadService.downloadFingerprintImage(url);
		const file = await this.driveFilesRepository.findOne({ where: [{ webpublicUrl: url }, { url: url }] });
		if (file == null || file.isLink) return this.downloadService.downloadFingerprintImage(url);
		const key = file.webpublicUrl === url && file.webpublicAccessKey ? file.webpublicAccessKey : file.accessKey;
		if (key == null) return this.downloadService.downloadFingerprintImage(url);
		if (file.storedInternal) return this.internalStorageService.readBytes(key);
		const meta = await this.metaService.fetch();
		if (meta.objectStorageBucket == null) throw new Error('Object storage bucket is not configured');
		return this.s3Service.readBytes(meta, { Bucket: meta.objectStorageBucket, Key: key });
	}
}
